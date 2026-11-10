/** Finance domain: fee plans, invoices, payments, allocations and the immutable ledger (SRS §12). */
import { Prisma } from '#prisma';
import { prisma } from '../lib/prisma';
import { badRequest, conflict, notFound } from '../lib/http';
import { nextNumber } from '../lib/sequence';
import { getSettings } from '../lib/settings';
import { money } from '../lib/util';
import { addMonthsClamped, endOfDayUtc, parseIsoDate, toCalendarDate, type CalendarDate } from '../lib/caldate';
import { type Tx, type ReadDb } from '../lib/db';


/** Installments that still carry an unpaid amount. SUPERSEDED ones (replaced by a custom plan) and PAID ones never do. */
export const OPEN_INSTALLMENT_STATUSES = ['DUE', 'PARTIAL'];
export const openInstallment = { in: OPEN_INSTALLMENT_STATUSES };

export async function ledger(tx: Tx, e: { studentId: string; type: string; debit?: number; credit?: number; refType?: string; refId?: string; narration: string; userId?: string }) {
  return tx.ledgerEntry.create({ data: { ...e, debit: e.debit ?? 0, credit: e.credit ?? 0 } });
}

export async function studentBalance(studentId: string, tx: ReadDb = prisma) {
  const agg = await tx.ledgerEntry.aggregate({ where: { studentId }, _sum: { debit: true, credit: true } });
  return money(Number(agg._sum.debit ?? 0) - Number(agg._sum.credit ?? 0));
}

/** Integer paise arithmetic for splitting amounts (no floating-point drift). */
const toPaise = (n: number) => Math.round(n * 100);
const fromPaise = (p: number) => p / 100;

/**
 * FIN-03 installment schedule (pure, unit-tested):
 *  - legacy policy (dueDay = null): the first installment is due on the start date, installment n is due n months
 *    later on the same day-of-month;
 *  - fixed due day (dueDay = 10): the first installment is due on the first 10th on or after the start date, every
 *    later one on the 10th of the following months;
 *  - either way the day is clamped to the month's last day ("anchor day, clamped": 31 Jan → 28/29 Feb → 31 Mar …,
 *    never rolling into the next month), and each due date is the END of that calendar day in the academy zone,
 *    stored in UTC; feeMonth is the due date's month ("YYYY-MM");
 *  - amounts are split in whole paise; the last installment absorbs the remainder.
 */
export function buildInstallmentSchedule(grossAmount: number, count: number, start: CalendarDate, timeZone: string, dueDay: number | null = null) {
  const n = Math.max(1, Math.floor(count));
  const total = toPaise(grossAmount);
  const base = Math.floor(total / n);
  const first = firstDueDate(start, dueDay);
  const anchor = dueDay ?? start.d;
  return Array.from({ length: n }, (_, i) => {
    const date = addMonthsClamped(first, i, anchor);
    return { seq: i + 1, amount: fromPaise(i === n - 1 ? total - base * (n - 1) : base), calendarDate: date, dueDate: endOfDayUtc(date, timeZone), feeMonth: feeMonthOf(date) };
  });
}

/** First due date: the start date itself (legacy), or the first `dueDay` of a month on or after it. */
export function firstDueDate(start: CalendarDate, dueDay: number | null): CalendarDate {
  if (dueDay == null) return start;
  const thisMonth = addMonthsClamped({ ...start, d: 1 }, 0, dueDay);
  return start.d <= thisMonth.d ? thisMonth : addMonthsClamped({ ...start, d: 1 }, 1, dueDay);
}

/** "YYYY-MM" of a calendar date. */
export const feeMonthOf = (c: CalendarDate) => `${c.y}-${String(c.m).padStart(2, '0')}`;

/** Fee month of an installment: the stored value, else (older installments) its due date's month in the zone. */
export const installmentFeeMonth = (i: { feeMonth?: string | null; dueDate: Date }, tz: string) => i.feeMonth ?? feeMonthOf(toCalendarDate(i.dueDate, tz));

/** "2026-12" → "December 2026". */
export function feeMonthLabel(m: string) {
  const [y, mo] = m.split('-').map(Number);
  return `${['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][mo - 1]} ${y}`;
}

/** The configured fixed due day (1–28), or null for the legacy start-day policy. */
export const validDueDay = (d: unknown) => (Number.isInteger(d) && (d as number) >= 1 && (d as number) <= 28 ? (d as number) : null);

/** Start date for a plan: an ISO calendar date ("YYYY-MM-DD") is taken as-is; an instant is converted to the academy zone. */
export function planStartDate(input: Date | string | undefined, timeZone: string): CalendarDate {
  if (typeof input === 'string') {
    const c = parseIsoDate(input);
    if (!c) throw badRequest('Start date must be a valid date (YYYY-MM-DD).');
    return c;
  }
  return toCalendarDate(input ?? new Date(), timeZone);
}

/** FIN-01: the course's current fee components (with tax) and their gross total, as a new plan would bill them. */
export async function courseFee(tx: Tx, courseId: string) {
  const comps = await tx.feeComponent.findMany({ where: { courseId, isActive: true, effectiveFrom: { lte: new Date() } } });
  const components = comps.map((c) => {
    const tax = money((Number(c.amount) * Number(c.taxPercent)) / 100);
    return { name: c.name, amount: Number(c.amount), tax, total: money(Number(c.amount) + tax) };
  });
  return { components, gross: fromPaise(components.reduce((s, c) => s + toPaise(c.total), 0)) };
}

/** FIN-02/03: build a fee plan from the course fee structure, split into installments, invoice each. */
export async function createFeePlan(tx: Tx, p: { studentId: string; courseId: string; installments?: number; startDate?: Date | string; userId?: string; enrollmentId?: string | null }) {
  const { components, gross } = await courseFee(tx, p.courseId);
  const course = await tx.course.findUniqueOrThrow({ where: { id: p.courseId } });
  const s = await getSettings();
  const tz = s.academy.timeZone;
  const start = planStartDate(p.startDate, tz);
  const dueDay = validDueDay(s.finance.dueDayOfMonth);
  const schedule = buildInstallmentSchedule(gross, p.installments ?? course.defaultInstallments, start, tz, dueDay);
  // Link to the enrollment being billed: given explicitly, else the student's current enrollment in this course.
  const enrollmentId = p.enrollmentId ?? (await tx.enrollment.findFirst({ where: { studentId: p.studentId, courseId: p.courseId, status: { in: ['ACTIVE', 'ON_HOLD'] } }, select: { id: true } }))?.id ?? null;
  const plan = await tx.feePlan.create({ data: { studentId: p.studentId, courseId: p.courseId, grossAmount: gross, components, dueAnchorDay: dueDay ?? start.d, dueTimeZone: tz, enrollmentId } });
  for (const it of schedule) {
    const inst = await tx.installment.create({ data: { feePlanId: plan.id, seq: it.seq, amount: it.amount, dueDate: it.dueDate, feeMonth: it.feeMonth } });
    const number = await nextNumber('invoice:{year}', s.ids.invoice, tx);
    await tx.invoice.create({ data: { number, studentId: p.studentId, feePlanId: plan.id, installmentId: inst.id, amount: it.amount, dueDate: it.dueDate } });
  }
  if (gross > 0) await ledger(tx, { studentId: p.studentId, type: 'FEE', debit: gross, refType: 'fee_plan', refId: plan.id, narration: `Course fee — ${course.name}`, userId: p.userId });
  return plan;
}

export async function outstandingInstallments(tx: Tx, studentId: string) {
  return tx.installment.findMany({ where: { feePlan: { studentId }, status: openInstallment }, orderBy: [{ dueDate: 'asc' }, { seq: 'asc' }] });
}

/** FIN-05/06: record a payment, allocate FIFO to installments, post ledger, issue receipt number. */
/** Serialises all money movements on one student account (FIN-05/13, 8.4): prevents parallel overpayment. */
export async function lockStudentAccount(tx: Tx, studentId: string) {
  await tx.lock(`student:${studentId}`); // serialises money changes for one student (was SELECT … FOR UPDATE)
}

export async function recordPayment(
  tx: Tx,
  p: { studentId: string; amount: number; mode: string; reference?: string; payer?: string; paidAt?: Date; idempotencyKey?: string; gatewayRef?: string; userId?: string },
) {
  await lockStudentAccount(tx, p.studentId);
  if (p.idempotencyKey) {
    const dup = await tx.payment.findUnique({ where: { idempotencyKey: p.idempotencyKey } });
    if (dup) return dup;
  }
  const amount = money(p.amount);
  if (amount <= 0) throw badRequest('Payment amount must be greater than zero.');
  const insts = await outstandingInstallments(tx, p.studentId);
  const due = money(insts.reduce((s, i) => s + Number(i.amount) - Number(i.paidAmount), 0));
  if (amount > due + 0.001) throw conflict(`Amount exceeds the outstanding balance of ${due.toFixed(2)}.`);
  const s = await getSettings();
  const receiptNumber = await nextNumber('receipt:{year}', s.ids.receipt, tx);
  const payment = await tx.payment.create({
    data: { receiptNumber, studentId: p.studentId, amount, mode: p.mode, reference: p.reference, payer: p.payer, paidAt: p.paidAt ?? new Date(), idempotencyKey: p.idempotencyKey, gatewayRef: p.gatewayRef, recordedById: p.userId },
  });
  let left = amount;
  for (const i of insts) {
    if (left <= 0) break;
    const open = money(Number(i.amount) - Number(i.paidAmount));
    const take = Math.min(open, left);
    const paid = money(Number(i.paidAmount) + take);
    await tx.paymentAllocation.create({ data: { paymentId: payment.id, installmentId: i.id, amount: take } });
    await tx.installment.update({ where: { id: i.id }, data: { paidAmount: paid, status: paid >= Number(i.amount) - 0.001 ? 'PAID' : 'PARTIAL' } });
    left = money(left - take);
  }
  await ledger(tx, { studentId: p.studentId, type: 'PAYMENT', credit: amount, refType: 'payment', refId: payment.id, narration: `Payment ${receiptNumber} (${p.mode})`, userId: p.userId });
  await tx.studentHistory.create({ data: { studentId: p.studentId, type: 'FEE', message: `Payment of ${amount.toFixed(2)} received (${receiptNumber})`, userId: p.userId } });
  return payment;
}

/** Refunds that still count against money received (R8): requested, approved or paid. */
export const ACTIVE_REFUND_STATUSES = ['PENDING_APPROVAL', 'APPROVED', 'PAID'];

/**
 * B1 / R8 (FIN-06, FIN-11, 22.5): a receipt may be cancelled only if the refunds that are pending, approved or paid
 * stay covered by the receipts that remain. Call with the student account locked.
 */
export async function assertCancellationKeepsRefundsCovered(tx: Tx, pay: { id: string; studentId: string; receiptNumber: string }) {
  const [remaining, refunds] = await Promise.all([
    tx.payment.aggregate({ where: { studentId: pay.studentId, id: { not: pay.id }, status: { not: 'CANCELLED' } }, _sum: { amount: true } }),
    tx.refund.aggregate({ where: { studentId: pay.studentId, status: { in: ACTIVE_REFUND_STATUSES } }, _sum: { amount: true } }),
  ]);
  const left = money(Number(remaining._sum.amount ?? 0));
  const refunded = money(Number(refunds._sum.amount ?? 0));
  if (refunded > left + 0.001)
    throw conflict(`Receipt ${pay.receiptNumber} cannot be cancelled: refunds of ${refunded.toFixed(2)} (pending, approved or paid) would exceed the ${left.toFixed(2)} left in other receipts. Resolve the refund first.`, { refunds: refunded, remainingReceipts: left });
}

/** Executed after PAYMENT_CANCELLATION approval: reverse allocations + reversing ledger entry. */
export async function cancelPayment(tx: Tx, paymentId: string, userId: string) {
  const pay = await tx.payment.findUnique({ where: { id: paymentId }, include: { allocations: true } });
  if (!pay) throw notFound('Payment not found');
  await lockStudentAccount(tx, pay.studentId);
  if (pay.status === 'CANCELLED') return;
  // Re-checked at approval time: a refund may have been recorded since the request (nothing changes if refused).
  await assertCancellationKeepsRefundsCovered(tx, pay);
  for (const a of pay.allocations) {
    const i = await tx.installment.findUniqueOrThrow({ where: { id: a.installmentId } });
    const paid = money(Number(i.paidAmount) - Number(a.amount));
    await tx.installment.update({ where: { id: i.id }, data: { paidAmount: paid, status: paid <= 0 ? 'DUE' : 'PARTIAL' } });
  }
  await tx.payment.update({ where: { id: paymentId }, data: { status: 'CANCELLED' } });
  await ledger(tx, { studentId: pay.studentId, type: 'REVERSAL', debit: Number(pay.amount), refType: 'payment', refId: pay.id, narration: `Reversal of receipt ${pay.receiptNumber}`, userId });
  await tx.studentHistory.create({ data: { studentId: pay.studentId, type: 'FEE', message: `Receipt ${pay.receiptNumber} cancelled`, userId } });
}

/** Executed after DISCOUNT approval: reduce installments from the last one backwards, post credit. */
export async function applyDiscount(tx: Tx, discountId: string, userId: string) {
  const d = await tx.discount.findUniqueOrThrow({ where: { id: discountId } });
  await lockStudentAccount(tx, d.studentId);
  if (d.status === 'APPLIED') return;
  let left = Number(d.amount);
  const insts = await tx.installment.findMany({ where: { feePlanId: d.feePlanId }, orderBy: { seq: 'desc' } });
  for (const i of insts) {
    if (left <= 0) break;
    const reducible = money(Number(i.amount) - Number(i.paidAmount));
    const take = Math.min(reducible, left);
    if (take <= 0) continue;
    const amount = money(Number(i.amount) - take);
    await tx.installment.update({ where: { id: i.id }, data: { amount, status: Number(i.paidAmount) >= amount - 0.001 ? 'PAID' : i.status } });
    left = money(left - take);
  }
  await tx.feePlan.update({ where: { id: d.feePlanId }, data: { discount: { increment: d.amount } } });
  await tx.discount.update({ where: { id: d.id }, data: { status: 'APPLIED' } });
  await ledger(tx, { studentId: d.studentId, type: d.kind === 'SCHOLARSHIP' ? 'SCHOLARSHIP' : 'DISCOUNT', credit: Number(d.amount), refType: 'discount', refId: d.id, narration: `${d.kind === 'SCHOLARSHIP' ? 'Scholarship' : 'Discount'}: ${d.reason}`, userId });
  await tx.studentHistory.create({ data: { studentId: d.studentId, type: 'FEE', message: `Discount of ${Number(d.amount).toFixed(2)} applied — ${d.reason}`, userId } });
}
