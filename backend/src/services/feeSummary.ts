/**
 * Pending-fee views (Finance Dashboard and per-student ledger), computed from stored installments, whose paid
 * amounts move only with successful (posted) payments: a cancelled receipt gives its allocation back, a discount
 * or approved waiver lowers the installment amount. Nothing here writes.
 */
import { prisma } from '../lib/prisma';
import { getSettings } from '../lib/settings';
import { money } from '../lib/util';
import { dayDiff, toCalendarDate, zonedTimeToUtc } from '../lib/caldate';
import { feeMonthOf, installmentFeeMonth } from './finance';

export type FeeStatus = 'PAID' | 'PARTIAL' | 'UNPAID';

/** UTC range [from, to) of a fee month in the academy zone. */
export function monthRange(month: string, tz: string) {
  const [y, m] = month.split('-').map(Number);
  return { from: zonedTimeToUtc({ y, m, d: 1 }, tz), to: zonedTimeToUtc({ y: m === 12 ? y + 1 : y, m: m === 12 ? 1 : m + 1, d: 1 }, tz) };
}

export const isFeeMonth = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(s);

const statusOf = (amount: number, paid: number): FeeStatus => (paid >= amount - 0.001 ? 'PAID' : paid > 0.001 ? 'PARTIAL' : 'UNPAID');

/**
 * Finance Dashboard for one fee month: expected, collected and outstanding; paid / partially paid / unpaid
 * students; overdue amounts (this month and all months). `studentWhere` narrows to a collection scope.
 */
export async function monthSummary(month: string | undefined, studentWhere: object = {}, now = new Date()) {
  const s = await getSettings();
  const tz = s.academy.timeZone;
  const today = toCalendarDate(now, tz);
  const m = isFeeMonth(month) ? month : feeMonthOf(today);
  const { from, to } = monthRange(m, tz);
  const insts = await prisma.installment.findMany({
    where: {
      status: { not: 'SUPERSEDED' },
      feePlan: { student: studentWhere },
      OR: [{ feeMonth: m }, { feeMonth: null, dueDate: { gte: from, lt: to } }],
    },
    include: { feePlan: { select: { student: { select: { id: true, fullName: true, studentCode: true, status: true, financeOwnerId: true, course: { select: { name: true } }, batch: { select: { code: true } } } } } } },
  });
  type Row = { studentId: string; name: string; studentCode: string; course: string; batch: string | null; studentStatus: string; financeOwnerId: string | null; expected: number; paid: number; outstanding: number; dueDate: Date; overdueDays: number; status: FeeStatus };
  const byStudent = new Map<string, Row>();
  for (const i of insts) {
    const st = i.feePlan.student;
    const amount = Number(i.amount);
    if (amount <= 0) continue;
    const paid = Number(i.paidAmount);
    const r = byStudent.get(st.id) ?? { studentId: st.id, name: st.fullName, studentCode: st.studentCode, course: st.course.name, batch: st.batch?.code ?? null, studentStatus: st.status, financeOwnerId: st.financeOwnerId, expected: 0, paid: 0, outstanding: 0, dueDate: i.dueDate, overdueDays: 0, status: 'UNPAID' as FeeStatus };
    r.expected = money(r.expected + amount);
    r.paid = money(r.paid + paid);
    r.outstanding = money(r.expected - r.paid);
    if (i.dueDate < r.dueDate) r.dueDate = i.dueDate;
    const late = dayDiff(toCalendarDate(i.dueDate, tz), today);
    if (amount - paid > 0.001 && late > 0) r.overdueDays = Math.max(r.overdueDays, late);
    r.status = statusOf(r.expected, r.paid);
    byStudent.set(st.id, r);
  }
  const items = [...byStudent.values()].sort((a, b) => b.overdueDays - a.overdueDays || b.outstanding - a.outstanding || a.name.localeCompare(b.name));
  const sum = (f: (r: Row) => number, rows = items) => money(rows.reduce((a, r) => a + f(r), 0));
  const overdueRows = items.filter((r) => r.overdueDays > 0);

  // Overdue across all months (anything due before today and still open).
  const open = await prisma.installment.findMany({
    where: { status: { in: ['DUE', 'PARTIAL'] }, dueDate: { lt: zonedTimeToUtc(today, tz) }, feePlan: { student: studentWhere } },
    select: { amount: true, paidAmount: true, dueDate: true, feePlan: { select: { studentId: true } } },
  });
  const lateOpen = open.filter((i) => dayDiff(toCalendarDate(i.dueDate, tz), today) > 0);

  return {
    month: m,
    totals: { expected: sum((r) => r.expected), collected: sum((r) => r.paid), outstanding: sum((r) => r.outstanding), overdue: sum((r) => r.outstanding, overdueRows) },
    students: { total: items.length, paid: items.filter((r) => r.status === 'PAID').length, partial: items.filter((r) => r.status === 'PARTIAL').length, unpaid: items.filter((r) => r.status === 'UNPAID').length, overdue: overdueRows.length },
    allMonthsOverdue: { amount: money(lateOpen.reduce((a, i) => a + Number(i.amount) - Number(i.paidAmount), 0)), students: new Set(lateOpen.map((i) => i.feePlan.studentId)).size },
    items,
  };
}

/**
 * Per-student ledger by fee month: each installment with its total, amount paid, outstanding balance, due date,
 * status and the receipts that paid it (cancelled receipts are listed and marked, but count for nothing).
 */
export async function feeMonthLedger(studentId: string, now = new Date()) {
  const s = await getSettings();
  const tz = s.academy.timeZone;
  const today = toCalendarDate(now, tz);
  const insts = await prisma.installment.findMany({
    where: { feePlan: { studentId }, status: { not: 'SUPERSEDED' } },
    orderBy: [{ dueDate: 'asc' }, { seq: 'asc' }],
    include: { allocations: { include: { payment: { select: { id: true, receiptNumber: true, paidAt: true, mode: true, status: true } } } }, feePlan: { select: { id: true, courseId: true } } },
  });
  const rows = insts
    .filter((i) => Number(i.amount) > 0 || i.allocations.length)
    .map((i) => {
      const amount = Number(i.amount);
      const paid = Number(i.paidAmount);
      const outstanding = money(amount - paid);
      const late = dayDiff(toCalendarDate(i.dueDate, tz), today);
      const payments = i.allocations
        .map((a) => ({ paymentId: a.payment.id, receiptNumber: a.payment.receiptNumber, paidAt: a.payment.paidAt, mode: a.payment.mode, status: a.payment.status, amount: Number(a.amount) }))
        .sort((a, b) => a.paidAt.getTime() - b.paidAt.getTime());
      const counted = payments.filter((p) => p.status !== 'CANCELLED');
      return {
        installmentId: i.id, feePlanId: i.feePlan.id, seq: i.seq, feeMonth: installmentFeeMonth(i, tz), dueDate: i.dueDate,
        total: amount, paid, outstanding, status: statusOf(amount, paid), overdue: outstanding > 0.001 && late > 0, overdueDays: outstanding > 0.001 && late > 0 ? late : 0,
        lastPaymentDate: counted.length ? counted[counted.length - 1].paidAt : null, payments,
      };
    });
  return {
    rows,
    totals: {
      total: money(rows.reduce((a, r) => a + r.total, 0)), paid: money(rows.reduce((a, r) => a + r.paid, 0)), outstanding: money(rows.reduce((a, r) => a + r.outstanding, 0)),
      overdue: money(rows.filter((r) => r.overdue).reduce((a, r) => a + r.outstanding, 0)),
    },
  };
}
