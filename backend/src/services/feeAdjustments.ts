/**
 * Fee adjustments (SRS 22.6, FIN-03, FIN-12, FIN-13, 24.4).
 *
 * Rules (from the SRS and the existing finance model — open decisions are listed in the report):
 *  A1 Requested by Finance Staff / Finance Manager; applied ONLY after the configured FEE_ADJUSTMENT approval
 *     (Finance Manager; Management above the threshold). Fails closed if the workflow is missing. Requesters
 *     cannot approve their own request (engine rule APR-03).
 *  A2 WAIVER: forgives part or all of the UNPAID amount of one fee plan. Installments are reduced from the last one
 *     backwards (same order as discounts). Posts one WAIVER ledger credit (FIN-13). Paid money is never touched:
 *     returning paid money is a refund (22.5), not a waiver.
 *  A3 RESCHEDULE (custom installment plan, FIN-03): replaces the unpaid part of a plan with a new schedule whose
 *     total equals the unpaid amount exactly. Open installments keep what was paid on them (partly paid → PAID for
 *     the paid part; unpaid → SUPERSEDED with amount 0); their invoices are marked SUPERSEDED, never deleted or
 *     renumbered; new installments get new invoice numbers (FIN-04). No ledger entry: the amount owed is unchanged.
 *  A4 The request is re-validated when applied, under the student account lock: if payments, discounts or another
 *     adjustment changed the unpaid amount meanwhile, approval is refused and NOTHING changes (the approver rejects
 *     and Finance re-requests).
 *  A5 One pending adjustment per fee plan (service check + partial unique index).
 *  A6 Old values are kept: `before` snapshot on the adjustment, audit log in the same transaction, student history.
 *  A7 (decision 2026-11-06) A custom plan forgives nothing, so the Management threshold does not apply to it: it is
 *     decided by the Finance Manager. Waivers (money forgiven) go to Management at or above the threshold.
 *  A8 (decision 2026-11-06, B2) REBILL: a new fee plan for a course the student was already billed for (e.g. returning
 *     to it after a course change) is created only through this approval, at the normal levels on the plan amount.
 *     Re-checked at approval: the enrollment is still current, no plan was created for it meanwhile, and the course
 *     fee is unchanged (otherwise refused, nothing changes).
 */
import type { Prisma } from '#prisma';
import { badRequest, conflict, notFound } from '../lib/http';
import { nextNumber } from '../lib/sequence';
import { getSettings } from '../lib/settings';
import { money } from '../lib/util';
import { endOfDayUtc, isoDate, parseIsoDate, toCalendarDate } from '../lib/caldate';
import { createApproval } from './approvals';
import { courseFee, createFeePlan, ledger, lockStudentAccount, openInstallment } from './finance';
import { type Tx } from '../lib/db';

export type ScheduleRow = { dueDate: string; amount: number };

const P = (v: unknown) => Math.round(Number(v ?? 0) * 100);

async function openOf(tx: Tx, feePlanId: string) {
  const insts = await tx.installment.findMany({ where: { feePlanId, status: openInstallment }, orderBy: { seq: 'asc' } });
  return { insts, openPaise: insts.reduce((s, i) => s + P(i.amount) - P(i.paidAmount), 0) };
}

/** Validates a custom schedule (pure, except for "today" in the academy zone). */
export function validateSchedule(rows: ScheduleRow[], openPaise: number, timeZone: string, now = new Date()) {
  if (!rows.length || rows.length > 24) throw badRequest('A custom plan needs between 1 and 24 installments.');
  const today = isoDate(toCalendarDate(now, timeZone));
  let prev = '';
  for (const r of rows) {
    if (!parseIsoDate(r.dueDate)) throw badRequest(`Invalid due date: ${r.dueDate}`);
    if (r.dueDate < today) throw badRequest('Due dates in a custom plan cannot be in the past.');
    if (prev && r.dueDate < prev) throw badRequest('Due dates must be in chronological order.');
    if (!(r.amount > 0) || P(r.amount) / 100 !== Number(r.amount)) throw badRequest('Each installment must be a positive amount with at most 2 decimals.');
    prev = r.dueDate;
  }
  const total = rows.reduce((s, r) => s + P(r.amount), 0);
  if (total !== openPaise) throw badRequest(`The custom plan must add up to the unpaid amount (${(openPaise / 100).toFixed(2)}); it adds up to ${(total / 100).toFixed(2)}.`);
}

export async function requestFeeAdjustment(
  tx: Tx,
  p: { studentId: string; feePlanId: string; kind: 'WAIVER' | 'RESCHEDULE'; amount?: number; schedule?: ScheduleRow[]; reason: string; requestedById: string },
) {
  await lockStudentAccount(tx, p.studentId);
  const plan = await tx.feePlan.findFirst({ where: { id: p.feePlanId, studentId: p.studentId }, include: { student: { select: { fullName: true } } } });
  if (!plan) throw notFound('Fee plan not found for this student.');
  const pending = await tx.feeAdjustment.findFirst({ where: { feePlanId: plan.id, status: 'PENDING_APPROVAL' }, select: { id: true } });
  if (pending) throw conflict('An adjustment for this fee plan is already awaiting approval.', { adjustmentId: pending.id });
  const { openPaise } = await openOf(tx, plan.id);
  if (openPaise <= 0) throw badRequest('This fee plan has nothing unpaid to adjust.');
  let amount: number;
  let schedule: ScheduleRow[] | undefined;
  if (p.kind === 'WAIVER') {
    amount = money(p.amount ?? 0);
    if (!(amount > 0)) throw badRequest('Waiver amount must be greater than zero.');
    if (P(amount) > openPaise) throw badRequest(`A waiver cannot exceed the unpaid amount (${(openPaise / 100).toFixed(2)}). Paid amounts are returned by refund, not waived.`);
  } else {
    const tz = plan.dueTimeZone ?? (await getSettings()).academy.timeZone;
    schedule = (p.schedule ?? []).map((r) => ({ dueDate: r.dueDate, amount: money(r.amount) }));
    validateSchedule(schedule, openPaise, tz);
    amount = openPaise / 100;
  }
  const adj = await tx.feeAdjustment.create({ data: { studentId: p.studentId, feePlanId: plan.id, kind: p.kind, amount, reason: p.reason, schedule: schedule as any, requestedById: p.requestedById } });
  const what = p.kind === 'WAIVER' ? `Waive ${amount.toFixed(2)}` : `Custom plan: ${amount.toFixed(2)} over ${schedule!.length} installment(s)`;
  const approval = await createApproval(tx, {
    type: 'FEE_ADJUSTMENT', entityType: 'fee_adjustment', entityId: adj.id,
    title: `${what} — ${plan.student.fullName}: ${p.reason}`,
    payload: { kind: p.kind, amount, reason: p.reason, ...(schedule && { schedule: schedule.map((r) => `${r.dueDate}: ${r.amount.toFixed(2)}`).join('; ') }) },
    amount, requestedById: p.requestedById,
    // A7: a custom plan forgives nothing, so no Management threshold applies to it.
    levelAmount: p.kind === 'RESCHEDULE' ? 0 : amount,
  });
  const updated = await tx.feeAdjustment.update({ where: { id: adj.id }, data: { approvalRequestId: approval.id } });
  return { adjustment: updated, approval };
}

export type NewPlan = { enrollmentId: string; courseId: string; installments: number; startDate?: string };

/** Earlier plans for the same course outside the current enrollment chain (B2: the course was billed before). */
export async function earlierPlansForCourse(tx: Tx, studentId: string, courseId: string, chain: string[]) {
  return tx.feePlan.findMany({ where: { studentId, courseId, enrollmentId: { notIn: chain } }, orderBy: { createdAt: 'asc' } });
}

/** A8 / B2: request a new plan for a course the student was billed for before. Nothing is billed until approved. */
export async function requestRebill(tx: Tx, p: { studentId: string; plan: NewPlan; earlierPlanId: string; reason: string; requestedById: string }) {
  await lockStudentAccount(tx, p.studentId);
  const pending = await tx.feeAdjustment.findFirst({ where: { studentId: p.studentId, kind: 'REBILL', status: 'PENDING_APPROVAL' }, select: { id: true } });
  if (pending) throw conflict('A new fee plan for this student is already awaiting approval.', { adjustmentId: pending.id });
  const [st, course, fee] = await Promise.all([
    tx.student.findUniqueOrThrow({ where: { id: p.studentId }, select: { fullName: true } }),
    tx.course.findUniqueOrThrow({ where: { id: p.plan.courseId }, select: { name: true } }),
    courseFee(tx, p.plan.courseId),
  ]);
  const amount = money(fee.gross);
  const adj = await tx.feeAdjustment.create({ data: { studentId: p.studentId, feePlanId: p.earlierPlanId, kind: 'REBILL', amount, reason: p.reason, newPlan: p.plan as any, requestedById: p.requestedById } });
  const approval = await createApproval(tx, {
    type: 'FEE_ADJUSTMENT', entityType: 'fee_adjustment', entityId: adj.id,
    title: `New fee plan ${amount.toFixed(2)} for ${course.name} (billed before) — ${st.fullName}: ${p.reason}`,
    payload: { kind: 'REBILL', amount, course: course.name, installments: p.plan.installments, reason: p.reason },
    amount, requestedById: p.requestedById,
  });
  const updated = await tx.feeAdjustment.update({ where: { id: adj.id }, data: { approvalRequestId: approval.id } });
  return { adjustment: updated, approval };
}

async function applyRebill(tx: Tx, a: { id: string; studentId: string; feePlanId: string; amount: unknown; reason: string; newPlan: unknown; approvalRequestId: string | null }, actorId: string) {
  const np = a.newPlan as NewPlan;
  const cur = await tx.enrollment.findFirst({ where: { id: np.enrollmentId, studentId: a.studentId, status: { in: ['ACTIVE', 'ON_HOLD'] } } });
  if (!cur || cur.courseId !== np.courseId) throw conflict('The enrollment this plan was requested for is no longer current. Nothing was changed — reject this request.');
  const chain = await feeEnrollmentChain(tx, cur.id);
  if (await tx.feePlan.count({ where: { studentId: a.studentId, enrollmentId: { in: chain } } })) throw conflict('A fee plan already exists for this enrollment. Nothing was changed — reject this request.');
  const fee = await courseFee(tx, np.courseId);
  if (P(fee.gross) !== P(a.amount)) throw conflict(`The course fee changed since the request (now ${money(fee.gross).toFixed(2)}). Nothing was changed — reject this request and submit a new one.`);
  const earlier = await tx.feePlan.findUniqueOrThrow({ where: { id: a.feePlanId }, include: { installments: true } });
  const before = { earlierPlanId: earlier.id, earlierPlanUnpaid: earlier.installments.filter((i) => ['DUE', 'PARTIAL'].includes(i.status)).reduce((s, i) => s + P(i.amount) - P(i.paidAmount), 0) / 100 };
  const plan = await createFeePlan(tx, { studentId: a.studentId, courseId: np.courseId, installments: np.installments, startDate: np.startDate?.includes('T') ? new Date(np.startDate) : np.startDate, userId: actorId, enrollmentId: cur.id });
  await tx.feeAdjustment.update({ where: { id: a.id }, data: { status: 'APPLIED', appliedAt: new Date(), before, createdFeePlanId: plan.id } });
  await tx.studentHistory.create({ data: { studentId: a.studentId, type: 'FEE', message: `New fee plan of ${Number(a.amount).toFixed(2)} created after approval (course billed before) — ${a.reason}`, userId: actorId } });
  await tx.auditLog.create({ data: { userId: actorId, action: 'FEE_ADJUSTMENT_REBILL', entity: 'fee_adjustment', entityId: a.id, oldValues: before as any, newValues: { status: 'APPLIED', createdFeePlanId: plan.id, amount: Number(a.amount), approvalRequestId: a.approvalRequestId } as any } });
}

/** Executed by the FEE_ADJUSTMENT approval handler (inside the approval transaction). */
export async function applyFeeAdjustment(tx: Tx, adjustmentId: string, actorId: string) {
  const a0 = await tx.feeAdjustment.findUniqueOrThrow({ where: { id: adjustmentId } });
  await lockStudentAccount(tx, a0.studentId);
  const a = await tx.feeAdjustment.findUniqueOrThrow({ where: { id: adjustmentId } });
  if (a.status !== 'PENDING_APPROVAL') throw conflict(`This adjustment is already ${a.status.toLowerCase().replace('_', ' ')}.`);
  if (a.kind === 'REBILL') return applyRebill(tx, a, actorId);
  const plan = await tx.feePlan.findUniqueOrThrow({ where: { id: a.feePlanId } });
  const { insts, openPaise } = await openOf(tx, plan.id);
  const before = insts.map((i) => ({ id: i.id, seq: i.seq, amount: Number(i.amount), paidAmount: Number(i.paidAmount), status: i.status, dueDate: i.dueDate.toISOString() }));
  const amt = P(a.amount);
  const changed = () => conflict(`The unpaid amount of this fee plan changed since the request (now ${(openPaise / 100).toFixed(2)}). Nothing was changed — reject this request and submit a new one.`);

  if (a.kind === 'WAIVER') {
    if (amt > openPaise) throw changed();
    let left = amt;
    for (const i of [...insts].sort((x, y) => y.seq - x.seq)) {
      if (left <= 0) break;
      const take = Math.min(P(i.amount) - P(i.paidAmount), left);
      if (take <= 0) continue;
      const amount = (P(i.amount) - take) / 100;
      await tx.installment.update({ where: { id: i.id }, data: { amount, status: P(i.paidAmount) >= P(amount) ? 'PAID' : i.status } });
      left -= take;
    }
    await tx.feePlan.update({ where: { id: plan.id }, data: { waived: { increment: a.amount } } });
    await ledger(tx, { studentId: a.studentId, type: 'WAIVER', credit: Number(a.amount), refType: 'fee_adjustment', refId: a.id, narration: `Fee waiver: ${a.reason}`, userId: actorId });
    await tx.studentHistory.create({ data: { studentId: a.studentId, type: 'FEE', message: `Fee waiver of ${Number(a.amount).toFixed(2)} applied — ${a.reason}`, userId: actorId } });
  } else {
    if (amt !== openPaise) throw changed();
    const rows = (a.schedule as ScheduleRow[]) ?? [];
    const s = await getSettings();
    const tz = plan.dueTimeZone ?? s.academy.timeZone;
    const now = new Date();
    for (const i of insts) {
      const paid = P(i.paidAmount);
      await tx.installment.update({ where: { id: i.id }, data: paid > 0 ? { amount: paid / 100, status: 'PAID', supersededAt: now } : { amount: 0, status: 'SUPERSEDED', supersededAt: now } });
    }
    await tx.invoice.updateMany({ where: { installmentId: { in: insts.map((i) => i.id) } }, data: { status: 'SUPERSEDED' } });
    const maxSeq = (await tx.installment.aggregate({ where: { feePlanId: plan.id }, _max: { seq: true } }))._max.seq ?? 0;
    for (const [n, r] of rows.entries()) {
      const dueDate = endOfDayUtc(parseIsoDate(r.dueDate)!, tz);
      const inst = await tx.installment.create({ data: { feePlanId: plan.id, seq: maxSeq + n + 1, amount: r.amount, dueDate, feeMonth: r.dueDate.slice(0, 7), adjustmentId: a.id } });
      const number = await nextNumber('invoice:{year}', s.ids.invoice, tx);
      await tx.invoice.create({ data: { number, studentId: a.studentId, feePlanId: plan.id, installmentId: inst.id, amount: r.amount, dueDate } });
    }
    await tx.studentHistory.create({ data: { studentId: a.studentId, type: 'FEE', message: `Custom installment plan applied: ${Number(a.amount).toFixed(2)} over ${rows.length} installment(s) — ${a.reason}`, userId: actorId } });
  }
  await tx.feeAdjustment.update({ where: { id: a.id }, data: { status: 'APPLIED', appliedAt: new Date(), before } });
  await tx.auditLog.create({ data: { userId: actorId, action: `FEE_ADJUSTMENT_${a.kind}`, entity: 'fee_adjustment', entityId: a.id, oldValues: { installments: before } as any, newValues: { status: 'APPLIED', amount: Number(a.amount), schedule: a.schedule ?? undefined, approvalRequestId: a.approvalRequestId } as any } });
}

export async function rejectFeeAdjustment(tx: Tx, adjustmentId: string) {
  await tx.feeAdjustment.updateMany({ where: { id: adjustmentId, status: 'PENDING_APPROVAL' }, data: { status: 'REJECTED' } });
}

/** Follows same-course successors of an enrollment (a batch transfer continues the same course and its fee plan). */
export async function feeEnrollmentChain(tx: Tx, enrollmentId: string) {
  const ids = [enrollmentId];
  let cur = await tx.enrollment.findUniqueOrThrow({ where: { id: enrollmentId } });
  for (;;) {
    const prev = cur.previousEnrollmentId ? await tx.enrollment.findUnique({ where: { id: cur.previousEnrollmentId } }) : null;
    if (!prev || prev.courseId !== cur.courseId) return ids;
    ids.push(prev.id);
    cur = prev;
  }
}
