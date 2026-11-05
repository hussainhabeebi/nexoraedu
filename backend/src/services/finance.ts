/** Finance domain: fee plans, invoices, payments, allocations and the immutable ledger (SRS §12). */
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { badRequest, conflict, notFound } from '../lib/http';
import { nextNumber } from '../lib/sequence';
import { getSettings } from '../lib/settings';
import { money } from '../lib/util';

type Tx = Prisma.TransactionClient;

export async function ledger(tx: Tx, e: { studentId: string; type: string; debit?: number; credit?: number; refType?: string; refId?: string; narration: string; userId?: string }) {
  return tx.ledgerEntry.create({ data: { ...e, debit: e.debit ?? 0, credit: e.credit ?? 0 } });
}

export async function studentBalance(studentId: string, tx: Tx = prisma) {
  const agg = await tx.ledgerEntry.aggregate({ where: { studentId }, _sum: { debit: true, credit: true } });
  return money(Number(agg._sum.debit ?? 0) - Number(agg._sum.credit ?? 0));
}

/** FIN-02/03: build a fee plan from the course fee structure, split into installments, invoice each. */
export async function createFeePlan(tx: Tx, p: { studentId: string; courseId: string; installments?: number; startDate?: Date; userId?: string }) {
  const comps = await tx.feeComponent.findMany({ where: { courseId: p.courseId, isActive: true, effectiveFrom: { lte: new Date() } } });
  const components = comps.map((c) => {
    const tax = money((Number(c.amount) * Number(c.taxPercent)) / 100);
    return { name: c.name, amount: Number(c.amount), tax, total: money(Number(c.amount) + tax) };
  });
  const gross = money(components.reduce((s, c) => s + c.total, 0));
  const course = await tx.course.findUniqueOrThrow({ where: { id: p.courseId } });
  const n = Math.max(1, p.installments ?? course.defaultInstallments);
  const start = p.startDate ?? new Date();
  const base = Math.floor((gross / n) * 100) / 100;
  const plan = await tx.feePlan.create({ data: { studentId: p.studentId, courseId: p.courseId, grossAmount: gross, components } });
  const s = await getSettings();
  for (let i = 0; i < n; i++) {
    const amount = i === n - 1 ? money(gross - base * (n - 1)) : base;
    const due = new Date(start);
    due.setMonth(due.getMonth() + i);
    due.setHours(23, 59, 59, 0);
    const inst = await tx.installment.create({ data: { feePlanId: plan.id, seq: i + 1, amount, dueDate: due } });
    const number = await nextNumber(`invoice:${new Date().getFullYear()}`, s.ids.invoice, tx);
    await tx.invoice.create({ data: { number, studentId: p.studentId, feePlanId: plan.id, installmentId: inst.id, amount, dueDate: due } });
  }
  if (gross > 0) await ledger(tx, { studentId: p.studentId, type: 'FEE', debit: gross, refType: 'fee_plan', refId: plan.id, narration: `Course fee — ${course.name}`, userId: p.userId });
  return plan;
}

export async function outstandingInstallments(tx: Tx, studentId: string) {
  return tx.installment.findMany({ where: { feePlan: { studentId }, status: { not: 'PAID' } }, orderBy: [{ dueDate: 'asc' }, { seq: 'asc' }] });
}

/** FIN-05/06: record a payment, allocate FIFO to installments, post ledger, issue receipt number. */
/** Serialises all money movements on one student account (FIN-05/13, 8.4): prevents parallel overpayment. */
export async function lockStudentAccount(tx: Tx, studentId: string) {
  await tx.$queryRaw`SELECT id FROM students WHERE id = ${studentId} FOR UPDATE`;
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
  const receiptNumber = await nextNumber(`receipt:${new Date().getFullYear()}`, s.ids.receipt, tx);
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

/** Executed after PAYMENT_CANCELLATION approval: reverse allocations + reversing ledger entry. */
export async function cancelPayment(tx: Tx, paymentId: string, userId: string) {
  const pay = await tx.payment.findUnique({ where: { id: paymentId }, include: { allocations: true } });
  if (!pay) throw notFound('Payment not found');
  await lockStudentAccount(tx, pay.studentId);
  if (pay.status === 'CANCELLED') return;
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
