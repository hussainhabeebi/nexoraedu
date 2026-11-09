/**
 * Fee adjustments (SRS 22.6, FIN-03, FIN-12, FIN-13, 24.4) and their link to enrollment changes. Synthetic data only.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app, as, makeStudent, makeUser, prisma, sessionFor } from './helpers';
import { reconcile } from '../src/services/reconciliation';
import { studentBalance } from '../src/services/finance';
import { validateSchedule } from '../src/services/feeAdjustments';
import { endOfDayUtc, parseIsoDate } from '../src/lib/caldate';

let sa: string, office: string, acad: string, finmgr: string, accounts: string, director: string, fac: string, couns: string, finmgr2: string;
let fsdBatches: string[], dmBatch: string;

beforeAll(async () => {
  const s = await makeUser(['super_admin']);
  const f2 = await makeUser(['finance_manager']);
  [sa, office, acad, finmgr, accounts, director, fac, couns, finmgr2] = await Promise.all(
    [s.username, 'office', 'acadmgr', 'finmgr', 'accounts', 'director', 'faculty1', 'counselor1', f2.username].map((u) => sessionFor(u)),
  );
  const fsd = await prisma.course.findUniqueOrThrow({ where: { code: 'FSD' }, include: { batches: { orderBy: { startDate: 'asc' } } } });
  fsdBatches = fsd.batches.map((b) => b.id);
  dmBatch = (await prisma.course.findUniqueOrThrow({ where: { code: 'DM' }, include: { batches: true } })).batches[0].id;
});

const act = (approvalId: string, tok: string, action = 'APPROVE', comment?: string) =>
  request(app).post(`/api/v1/approvals/${approvalId}/act`).set(as(tok)).send({ action, comment });
const approve = async (approvalId: string, tok: string) => {
  const r = await act(approvalId, tok);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body;
};
/** Finance Manager at level 1, then Management when the amount needs level 2. */
const approveAll = async (approvalId: string) => {
  let b = await approve(approvalId, finmgr);
  if (b.status === 'PENDING') b = await approve(approvalId, director);
  expect(b.status).toBe('APPROVED');
};
const isoIn = (days: number) => new Date(Date.now() + days * 864e5).toISOString().slice(0, 10);

async function studentWithPlan(installments = 3) {
  const st = await makeStudent({ batchId: fsdBatches[0] });
  const plan = await request(app).post(`/api/v1/finance/students/${st.id}/fee-plan`).set(as(finmgr)).send({ installments, startDate: isoIn(1) });
  expect(plan.status, JSON.stringify(plan.body)).toBe(201);
  return { st, planId: plan.body.id as string };
}
const pay = (studentId: string, amount: number) => request(app).post('/api/v1/finance/payments').set(as(accounts)).send({ studentId, amount, mode: 'CASH' });
const adjust = (body: any, tok = accounts) => request(app).post('/api/v1/finance/adjustments').set(as(tok)).send(body);
const insts = (feePlanId: string) => prisma.installment.findMany({ where: { feePlanId }, orderBy: { seq: 'asc' } });
const clean = async (studentId: string) => expect((await reconcile({ studentId })).issues.filter((i) => i.severity === 'ERROR')).toEqual([]);

describe('Waivers (22.6) — only after approval', () => {
  it('Finance Staff requests; nothing changes until the Finance Manager approves; then installments, plan, ledger, history and audit agree', async () => {
    const { st, planId } = await studentWithPlan(3);
    const before = await insts(planId);
    const bal0 = await studentBalance(st.id);
    const r = await adjust({ kind: 'WAIVER', studentId: st.id, feePlanId: planId, amount: 3000, reason: 'Hardship waiver (synthetic)' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.approval).toMatchObject({ type: 'FEE_ADJUSTMENT', status: 'PENDING' });
    expect(r.body.adjustment).toMatchObject({ status: 'PENDING_APPROVAL', approvalRequestId: r.body.approval.id });
    expect(await insts(planId)).toEqual(before);
    expect(await studentBalance(st.id)).toBe(bal0);
    // Finance Staff cannot approve; the Finance Manager can.
    expect((await act(r.body.approval.id, accounts)).status).toBe(403);
    expect((await approve(r.body.approval.id, finmgr)).status).toBe('APPROVED');

    const after = await insts(planId);
    expect(Number(after[2].amount)).toBe(Number(before[2].amount) - 3000); // last installment first
    expect(after.slice(0, 2).map((i) => Number(i.amount))).toEqual(before.slice(0, 2).map((i) => Number(i.amount)));
    expect(Number((await prisma.feePlan.findUniqueOrThrow({ where: { id: planId } })).waived)).toBe(3000);
    expect(await studentBalance(st.id)).toBe(bal0 - 3000);
    const led = await prisma.ledgerEntry.findMany({ where: { refType: 'fee_adjustment', refId: r.body.adjustment.id } });
    expect(led).toHaveLength(1);
    expect(led[0]).toMatchObject({ type: 'WAIVER' });
    expect(Number(led[0].credit)).toBe(3000);
    const adj = await prisma.feeAdjustment.findUniqueOrThrow({ where: { id: r.body.adjustment.id } });
    expect(adj.status).toBe('APPLIED');
    expect((adj.before as any[]).length).toBe(3); // old values kept
    expect(await prisma.auditLog.count({ where: { action: 'FEE_ADJUSTMENT_WAIVER', entityId: adj.id } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { action: 'CREATE', entity: 'fee_adjustment', entityId: adj.id } })).toBe(1);
    expect(await prisma.studentHistory.count({ where: { studentId: st.id, message: { contains: 'Fee waiver of 3000.00' } } })).toBe(1);
    const acct = await request(app).get(`/api/v1/finance/students/${st.id}/account`).set(as(accounts));
    expect(acct.body.adjustments[0]).toMatchObject({ id: adj.id, status: 'APPLIED' });
    await clean(st.id);
  });

  it('above the threshold a second level (Management) is required; one person cannot decide both levels', async () => {
    const { st, planId } = await studentWithPlan(2);
    const r = await adjust({ kind: 'WAIVER', studentId: st.id, feePlanId: planId, amount: 15000, reason: 'Large waiver (synthetic)' });
    expect(r.status).toBe(201);
    expect((await approve(r.body.approval.id, finmgr)).status).toBe('PENDING');
    expect((await prisma.feeAdjustment.findUniqueOrThrow({ where: { id: r.body.adjustment.id } })).status).toBe('PENDING_APPROVAL');
    expect((await act(r.body.approval.id, finmgr)).status).toBe(403);
    expect((await approve(r.body.approval.id, director)).status).toBe('APPROVED');
    expect(Number((await prisma.feePlan.findUniqueOrThrow({ where: { id: planId } })).waived)).toBe(15000);
    await clean(st.id);
  });

  it('a requester cannot approve their own request; rejection changes nothing', async () => {
    const { st, planId } = await studentWithPlan(2);
    const before = await insts(planId);
    const r = await adjust({ kind: 'WAIVER', studentId: st.id, feePlanId: planId, amount: 500, reason: 'Own request (synthetic)' }, finmgr);
    expect(r.status).toBe(201);
    expect((await act(r.body.approval.id, finmgr)).status).toBe(403);
    expect((await act(r.body.approval.id, finmgr2, 'REJECT', 'Not justified')).status).toBe(200);
    expect((await prisma.feeAdjustment.findUniqueOrThrow({ where: { id: r.body.adjustment.id } })).status).toBe('REJECTED');
    expect(await insts(planId)).toEqual(before);
    expect(await prisma.ledgerEntry.count({ where: { refType: 'fee_adjustment', refId: r.body.adjustment.id } })).toBe(0);
    // A new request is allowed after the rejection.
    expect((await adjust({ kind: 'WAIVER', studentId: st.id, feePlanId: planId, amount: 500, reason: 'Second request (synthetic)' })).status).toBe(201);
  });

  it('limits: only unpaid amounts can be waived; one pending adjustment per plan; plan must belong to the student', async () => {
    const { st, planId } = await studentWithPlan(1);
    const total = Number((await insts(planId))[0].amount);
    expect((await pay(st.id, 10000)).status).toBe(201);
    const over = await adjust({ kind: 'WAIVER', studentId: st.id, feePlanId: planId, amount: total - 10000 + 1, reason: 'Too much (synthetic)' });
    expect(over.status).toBe(400);
    expect(over.body.error.message).toMatch(/refund/);
    const other = await studentWithPlan(1);
    expect((await adjust({ kind: 'WAIVER', studentId: st.id, feePlanId: other.planId, amount: 10, reason: 'Wrong plan (synthetic)' })).status).toBe(404);
    expect((await adjust({ kind: 'WAIVER', studentId: st.id, feePlanId: planId, amount: 100, reason: 'x' })).status).toBe(422); // reason too short (validation)
    const ok = await adjust({ kind: 'WAIVER', studentId: st.id, feePlanId: planId, amount: 100, reason: 'First pending (synthetic)' });
    expect(ok.status).toBe(201);
    expect((await adjust({ kind: 'WAIVER', studentId: st.id, feePlanId: planId, amount: 100, reason: 'Second pending (synthetic)' })).status).toBe(409);
    // Database backstop: partial unique index.
    await expect(prisma.feeAdjustment.create({ data: { studentId: st.id, feePlanId: planId, kind: 'WAIVER', amount: 1, reason: 'direct', requestedById: 'x' } })).rejects.toThrow();
    // CHECK constraints.
    await expect(prisma.$executeRawUnsafe(`UPDATE fee_adjustments SET status = 'DONE' WHERE id = '${ok.body.adjustment.id}'`)).rejects.toThrow();
    await expect(prisma.$executeRawUnsafe(`UPDATE fee_adjustments SET amount = 0 WHERE id = '${ok.body.adjustment.id}'`)).rejects.toThrow();
    // Fully paid plan: nothing to adjust.
    const paid = await studentWithPlan(1);
    expect((await pay(paid.st.id, Number((await insts(paid.planId))[0].amount))).status).toBe(201);
    expect((await adjust({ kind: 'WAIVER', studentId: paid.st.id, feePlanId: paid.planId, amount: 1, reason: 'Nothing unpaid (synthetic)' })).status).toBe(400);
  });

  it('re-validated at approval: if a payment reduced the unpaid amount meanwhile, approval is refused and nothing changes', async () => {
    const { st, planId } = await studentWithPlan(1);
    const total = Number((await insts(planId))[0].amount);
    const r = await adjust({ kind: 'WAIVER', studentId: st.id, feePlanId: planId, amount: total, reason: 'Waive everything (synthetic)' });
    expect(r.status).toBe(201);
    expect((await pay(st.id, 1000)).status).toBe(201);
    const before = await insts(planId);
    // The full fee is above the threshold: level 1 (Finance Manager) passes it on; the final level applies it.
    expect((await approve(r.body.approval.id, finmgr)).status).toBe('PENDING');
    const a = await act(r.body.approval.id, director);
    expect(a.status).toBe(409);
    expect(a.body.error.message).toMatch(/changed since the request/);
    expect(await insts(planId)).toEqual(before);
    expect((await prisma.approvalRequest.findUniqueOrThrow({ where: { id: r.body.approval.id } })).status).toBe('PENDING');
    expect((await prisma.feeAdjustment.findUniqueOrThrow({ where: { id: r.body.adjustment.id } })).status).toBe('PENDING_APPROVAL');
    await clean(st.id);
  });

  it('fails closed when the workflow is not configured (nothing is created)', async () => {
    const { st, planId } = await studentWithPlan(1);
    const wf = await prisma.approvalWorkflow.findUniqueOrThrow({ where: { type: 'FEE_ADJUSTMENT' } });
    await prisma.approvalWorkflow.delete({ where: { id: wf.id } });
    try {
      const r = await adjust({ kind: 'WAIVER', studentId: st.id, feePlanId: planId, amount: 10, reason: 'No workflow (synthetic)' });
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe('APPROVAL_NOT_CONFIGURED');
      expect(await prisma.feeAdjustment.count({ where: { feePlanId: planId } })).toBe(0);
    } finally {
      await prisma.approvalWorkflow.create({ data: wf as any });
    }
  });
});

describe('Custom installment plans (FIN-03 via 22.6)', () => {
  it('schedule validation (pure): totals in whole paise, no past dates, chronological', () => {
    expect(() => validateSchedule([{ dueDate: isoIn(5), amount: 50 }, { dueDate: isoIn(35), amount: 50.01 }], 10001, 'Asia/Kolkata')).not.toThrow();
    expect(() => validateSchedule([{ dueDate: isoIn(5), amount: 100 }], 10001, 'Asia/Kolkata')).toThrow(/add up/);
    expect(() => validateSchedule([{ dueDate: isoIn(-2), amount: 100.01 }], 10001, 'Asia/Kolkata')).toThrow(/past/);
    expect(() => validateSchedule([{ dueDate: isoIn(9), amount: 50 }, { dueDate: isoIn(3), amount: 50.01 }], 10001, 'Asia/Kolkata')).toThrow(/chronological/);
    expect(() => validateSchedule([{ dueDate: isoIn(9), amount: 100.005 }], 10001, 'Asia/Kolkata')).toThrow(/2 decimals/);
    expect(() => validateSchedule([], 0, 'Asia/Kolkata')).toThrow(/between 1 and 24/);
  });

  it('replaces the unpaid part: paid parts kept, old rows superseded (never deleted), new invoices, balance unchanged; payments then go to the new installments', async () => {
    const { st, planId } = await studentWithPlan(2);
    const [i1, i2] = await insts(planId);
    expect((await pay(st.id, 5000)).status).toBe(201); // part of installment 1
    const open = Number(i1.amount) + Number(i2.amount) - 5000;
    const bal0 = await studentBalance(st.id);
    const ledgerCount0 = await prisma.ledgerEntry.count({ where: { studentId: st.id } });
    const bad = await adjust({ kind: 'RESCHEDULE', studentId: st.id, feePlanId: planId, schedule: [{ dueDate: isoIn(10), amount: open - 1 }], reason: 'Custom plan (synthetic)' });
    expect(bad.status).toBe(400);
    const third = Math.floor(open / 3);
    const schedule = [{ dueDate: isoIn(10), amount: third }, { dueDate: isoIn(40), amount: third }, { dueDate: isoIn(70), amount: open - 2 * third }];
    const r = await adjust({ kind: 'RESCHEDULE', studentId: st.id, feePlanId: planId, schedule, reason: 'Custom plan agreed with parent (synthetic)' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(Number(r.body.adjustment.amount)).toBe(open);
    expect(await insts(planId)).toHaveLength(2); // nothing before approval
    await approveAll(r.body.approval.id); // custom plan: Finance Manager only (nothing forgiven, decision 2026-11-06)

    const all = await insts(planId);
    expect(all).toHaveLength(5);
    expect(all[0]).toMatchObject({ status: 'PAID', seq: 1 });
    expect(Number(all[0].amount)).toBe(5000);
    expect(all[0].supersededAt).not.toBeNull();
    expect(all[1]).toMatchObject({ status: 'SUPERSEDED', seq: 2 });
    expect(Number(all[1].amount)).toBe(0);
    expect(all.slice(2).map((i) => [Number(i.amount), i.status, i.adjustmentId])).toEqual(schedule.map((s) => [s.amount, 'DUE', r.body.adjustment.id]));
    // Each new due date is the end of the approved calendar day in the academy zone.
    expect(all.slice(2).map((i) => i.dueDate.toISOString())).toEqual(schedule.map((s) => endOfDayUtc(parseIsoDate(s.dueDate)!, 'Asia/Kolkata').toISOString()));
    const invs = await prisma.invoice.findMany({ where: { feePlanId: planId } });
    expect(invs).toHaveLength(5);
    expect(invs.filter((i) => i.status === 'SUPERSEDED').map((i) => i.installmentId).sort()).toEqual([i1.id, i2.id].sort());
    expect(new Set(invs.map((i) => i.number)).size).toBe(5);
    expect(await studentBalance(st.id)).toBe(bal0);
    expect(await prisma.ledgerEntry.count({ where: { studentId: st.id } })).toBe(ledgerCount0); // no ledger effect
    const adj = await prisma.feeAdjustment.findUniqueOrThrow({ where: { id: r.body.adjustment.id } });
    expect((adj.before as any[]).map((b) => b.id)).toEqual([i1.id, i2.id]);
    expect(await prisma.auditLog.count({ where: { action: 'FEE_ADJUSTMENT_RESCHEDULE', entityId: adj.id } })).toBe(1);
    await clean(st.id);

    // Next payment goes to the first new installment; no allocation to superseded rows.
    const p = await pay(st.id, third + 10);
    expect(p.status).toBe(201);
    const allocs = await prisma.paymentAllocation.findMany({ where: { paymentId: p.body.id } });
    expect(allocs.map((a) => a.installmentId)).toEqual([all[2].id, all[3].id]);
    expect(allocs.every((a) => Number(a.amount) > 0)).toBe(true);
    await clean(st.id);

    // Cancelling the ORIGINAL payment (made before the custom plan) re-opens its part of installment 1 consistently.
    const first = await prisma.payment.findFirstOrThrow({ where: { studentId: st.id, amount: 5000 } });
    const cr = await request(app).post(`/api/v1/finance/payments/${first.id}/cancel-request`).set(as(accounts)).send({ reason: 'Bounced cheque (synthetic)' });
    await approve(cr.body.approval.id, finmgr);
    expect((await prisma.installment.findUniqueOrThrow({ where: { id: i1.id } })).status).toBe('DUE');
    await clean(st.id);
  });

  it('superseded installments are not reminded, not overdue for exam eligibility, and not in outstanding', async () => {
    const { st, planId } = await studentWithPlan(1);
    const [i1] = await insts(planId);
    const r = await adjust({ kind: 'RESCHEDULE', studentId: st.id, feePlanId: planId, schedule: [{ dueDate: isoIn(30), amount: Number(i1.amount) }], reason: 'Move due date (synthetic)' });
    expect(r.status).toBe(201);
    await approveAll(r.body.approval.id);
    // Make the superseded row "overdue" by date: it must still not count.
    await prisma.installment.update({ where: { id: i1.id }, data: { dueDate: new Date(Date.now() - 5 * 864e5) } });
    const out = await request(app).get('/api/v1/finance/outstanding').set(as(accounts));
    const row = out.body.items.find((x: any) => x.studentId === st.id);
    expect(row.overdue).toBe(0);
    expect(row.due).toBe(Number(i1.amount));
  });
});

describe('Enrollment changes and fees', () => {
  it('a batch transfer in the same course keeps the plan; a second plan for the same course is refused (no double billing)', async () => {
    const { st } = await studentWithPlan(2);
    const t = await request(app).post(`/api/v1/students/${st.id}/transfer`).set(as(office)).send({ toBatchId: fsdBatches[1], reason: 'Evening batch (synthetic)' });
    await approve(t.body.approval.id, acad);
    const again = await request(app).post(`/api/v1/finance/students/${st.id}/fee-plan`).set(as(finmgr)).send({ installments: 1 });
    expect(again.status).toBe(400);
    expect(await prisma.feePlan.count({ where: { studentId: st.id } })).toBe(1);
    expect((await reconcile({ studentId: st.id })).issues.filter((i) => i.rule === 'R14_CLOSED_ENROLLMENT_BALANCE')).toEqual([]);
  });

  it('a course change leaves the old plan’s unpaid balance flagged (R14) until Finance waives it with approval', async () => {
    const { st, planId } = await studentWithPlan(2);
    expect((await pay(st.id, 2000)).status).toBe(201);
    const t = await request(app).post(`/api/v1/students/${st.id}/transfer`).set(as(office)).send({ toBatchId: dmBatch, reason: 'Course change (synthetic)' });
    await approve(t.body.approval.id, acad);
    const r14 = (await reconcile({ studentId: st.id })).issues.filter((i) => i.rule === 'R14_CLOSED_ENROLLMENT_BALANCE');
    expect(r14).toHaveLength(1);
    expect(r14[0]).toMatchObject({ severity: 'WARNING', entityId: planId });
    const open = (await insts(planId)).reduce((s, i) => s + Number(i.amount) - Number(i.paidAmount), 0);
    const w = await adjust({ kind: 'WAIVER', studentId: st.id, feePlanId: planId, amount: open, reason: 'Course changed — close old plan (synthetic)' });
    expect(w.status).toBe(201);
    await approveAll(w.body.approval.id);
    const rec = await reconcile({ studentId: st.id });
    expect(rec.issues.filter((i) => i.rule === 'R14_CLOSED_ENROLLMENT_BALANCE')).toEqual([]);
    expect(rec.issues.filter((i) => i.severity === 'ERROR')).toEqual([]);
    expect(await studentBalance(st.id)).toBe(0);
  });

  it('withdrawal with unpaid installments is reported as INFO (policy pending), not as an error', async () => {
    const { st } = await studentWithPlan(1);
    expect((await request(app).post(`/api/v1/students/${st.id}/status`).set(as(office)).send({ status: 'WITHDRAWN', reason: 'Left (synthetic)' })).status).toBe(200);
    const r14 = (await reconcile({ studentId: st.id })).issues.filter((i) => i.rule === 'R14_CLOSED_ENROLLMENT_BALANCE');
    expect(r14.map((i) => i.severity)).toEqual(['INFO']);
  });
});

describe('Access control', () => {
  it('only finance roles can request; only finance readers can list; others are refused', async () => {
    const { st, planId } = await studentWithPlan(1);
    for (const tok of [office, acad, fac, couns]) {
      expect((await adjust({ kind: 'WAIVER', studentId: st.id, feePlanId: planId, amount: 10, reason: 'Not allowed (synthetic)' }, tok)).status).toBe(403);
      expect((await request(app).get(`/api/v1/finance/adjustments?studentId=${st.id}`).set(as(tok))).status).toBe(office === tok ? 200 : 403);
    }
    expect(await prisma.feeAdjustment.count({ where: { feePlanId: planId } })).toBe(0);
    const ok = await adjust({ kind: 'WAIVER', studentId: st.id, feePlanId: planId, amount: 10, reason: 'Allowed (synthetic)' }, accounts);
    expect(ok.status).toBe(201);
    const list = await request(app).get(`/api/v1/finance/adjustments?studentId=${st.id}`).set(as(accounts));
    expect(list.body.items.map((x: any) => x.id)).toEqual([ok.body.adjustment.id]);
  });

  it('the API database role cannot delete fee adjustments', async () => {
    await expect(prisma.$executeRawUnsafe('DELETE FROM fee_adjustments')).rejects.toThrow(/never deleted/);
  });
});

describe('Receipt cancellation keeps refunds covered (B1, R8, FIN-06/FIN-11)', () => {
  const cancelReq = (paymentId: string) => request(app).post(`/api/v1/finance/payments/${paymentId}/cancel-request`).set(as(accounts)).send({ reason: 'Cancellation (synthetic)' });
  const refundReq = (studentId: string, amount: number) => request(app).post('/api/v1/finance/refunds').set(as(accounts)).send({ studentId, amount, reason: 'Refund (synthetic)' });

  it('refused while a refund of that money is paid or pending; nothing changes', async () => {
    const { st } = await studentWithPlan(1);
    const p = await pay(st.id, 10000);
    const rf = await refundReq(st.id, 4000);
    expect(rf.status).toBe(201);
    // Pending refund: cancellation refused.
    const c1 = await cancelReq(p.body.id);
    expect(c1.status).toBe(409);
    expect(c1.body.error.message).toMatch(/refunds of 4000\.00/);
    // Approved and paid refund: still refused.
    await approveAll(rf.body.approval.id);
    expect((await request(app).post(`/api/v1/finance/refunds/${rf.body.refund.id}/pay`).set(as(finmgr)).send({ reference: 'UTR-SYN-1' })).status).toBe(200);
    expect((await cancelReq(p.body.id)).status).toBe(409);
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: p.body.id } })).status).toBe('POSTED');
    expect(await prisma.approvalRequest.count({ where: { type: 'PAYMENT_CANCELLATION', entityId: p.body.id } })).toBe(0);
    await clean(st.id);
  });

  it('allowed when the other receipts still cover the refunds; refused when they would not', async () => {
    const { st } = await studentWithPlan(1);
    const big = await pay(st.id, 10000);
    const small = await pay(st.id, 5000);
    const rf = await refundReq(st.id, 6000);
    await approveAll(rf.body.approval.id);
    expect((await cancelReq(big.body.id)).status).toBe(409); // 5,000 left < 6,000 refunded
    const ok = await cancelReq(small.body.id); // 10,000 left ≥ 6,000
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    await approve(ok.body.approval.id, finmgr);
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: small.body.id } })).status).toBe('CANCELLED');
    await clean(st.id);
  });

  it('a rejected refund no longer blocks cancellation', async () => {
    const { st } = await studentWithPlan(1);
    const p = await pay(st.id, 3000);
    const rf = await refundReq(st.id, 3000);
    expect((await act(rf.body.approval.id, finmgr, 'REJECT', 'Not eligible')).status).toBe(200);
    const c = await cancelReq(p.body.id);
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    await approve(c.body.approval.id, finmgr);
    await clean(st.id);
  });

  it('re-checked at approval: a refund recorded while the cancellation was pending blocks it; rejecting restores the receipt', async () => {
    const { st } = await studentWithPlan(1);
    const p = await pay(st.id, 8000);
    const c = await cancelReq(p.body.id);
    expect(c.status).toBe(200);
    // Simulates a refund recorded concurrently (the refund route itself excludes receipts under cancellation).
    await prisma.refund.create({ data: { studentId: st.id, amount: 2000, reason: 'Concurrent refund (synthetic)', requestedById: (await prisma.user.findUniqueOrThrow({ where: { username: 'accounts' } })).id } });
    const ledger0 = await prisma.ledgerEntry.count({ where: { studentId: st.id } });
    const a = await act(c.body.approval.id, finmgr);
    expect(a.status).toBe(409);
    expect(a.body.error.message).toMatch(/cannot be cancelled/);
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: p.body.id } })).status).toBe('CANCEL_REQUESTED');
    expect((await prisma.approvalRequest.findUniqueOrThrow({ where: { id: c.body.approval.id } })).status).toBe('PENDING');
    expect(await prisma.ledgerEntry.count({ where: { studentId: st.id } })).toBe(ledger0);
    expect((await act(c.body.approval.id, finmgr, 'REJECT', 'Refund outstanding')).status).toBe(200);
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: p.body.id } })).status).toBe('POSTED');
    await clean(st.id);
  });
});

describe('Discount plan choice (students with several plans)', () => {
  const discount = (body: any) => request(app).post('/api/v1/finance/discounts').set(as(accounts)).send({ kind: 'FIXED', reason: 'Merit (synthetic)', ...body });

  it('targets the chosen plan; defaults to the newest; another student’s plan is refused', async () => {
    const { st, planId: oldPlan } = await studentWithPlan(2);
    const t = await request(app).post(`/api/v1/students/${st.id}/transfer`).set(as(office)).send({ toBatchId: dmBatch, reason: 'Course change (synthetic)' });
    await approve(t.body.approval.id, acad);
    const np = await request(app).post(`/api/v1/finance/students/${st.id}/fee-plan`).set(as(finmgr)).send({ installments: 1 });
    expect(np.status).toBe(201);
    const chosen = await discount({ studentId: st.id, feePlanId: oldPlan, value: 700 });
    expect(chosen.status, JSON.stringify(chosen.body)).toBe(201);
    expect(chosen.body.discount.feePlanId).toBe(oldPlan);
    await approveAll(chosen.body.approval.id);
    expect(Number((await prisma.feePlan.findUniqueOrThrow({ where: { id: oldPlan } })).discount)).toBe(700);
    expect(Number((await prisma.feePlan.findUniqueOrThrow({ where: { id: np.body.id } })).discount)).toBe(0);
    const dflt = await discount({ studentId: st.id, value: 300 });
    expect(dflt.body.discount.feePlanId).toBe(np.body.id); // unchanged default: newest plan
    const other = await studentWithPlan(1);
    expect((await discount({ studentId: st.id, feePlanId: other.planId, value: 10 })).status).toBe(404);
    // The limit is the chosen plan's unpaid amount.
    const newOpen = (await insts(np.body.id)).reduce((s, i) => s + Number(i.amount) - Number(i.paidAmount), 0);
    expect((await discount({ studentId: st.id, feePlanId: np.body.id, value: newOpen + 1 })).status).toBe(400);
    expect(await prisma.auditLog.count({ where: { entity: 'discount', entityId: chosen.body.discount.id, action: 'CREATE' } })).toBe(1);
    await clean(st.id);
  });
});

describe('Approval policy decisions (2026-11-06)', () => {
  const levelsOf = async (approvalId: string) => ((await prisma.approvalRequest.findUniqueOrThrow({ where: { id: approvalId } })).levels as any[]).map((l) => l.role);

  it('a custom plan forgives nothing: Finance Manager only, even far above the ₹10,000 threshold; waivers keep Management', async () => {
    const { st, planId } = await studentWithPlan(2);
    const open = (await insts(planId)).reduce((s, i) => s + Number(i.amount) - Number(i.paidAmount), 0);
    expect(open).toBeGreaterThan(10000);
    const r = await adjust({ kind: 'RESCHEDULE', studentId: st.id, feePlanId: planId, schedule: [{ dueDate: isoIn(20), amount: open }], reason: 'One payment later (synthetic)' });
    expect(r.status).toBe(201);
    expect(Number(r.body.approval.amount)).toBe(open); // the real total is still shown to the approver
    expect(await levelsOf(r.body.approval.id)).toEqual(['finance_manager']);
    expect((await approve(r.body.approval.id, finmgr)).status).toBe('APPROVED');
    const w = await studentWithPlan(1);
    const wr = await adjust({ kind: 'WAIVER', studentId: w.st.id, feePlanId: w.planId, amount: 10000, reason: 'At threshold (synthetic)' });
    expect(await levelsOf(wr.body.approval.id)).toEqual(['finance_manager', 'management']); // ≥ 10,000
  });

  it('receipt cancellation: Finance Manager below ₹10,000; Finance Manager then Management at or above it', async () => {
    const { st } = await studentWithPlan(1);
    const small = await pay(st.id, 9999);
    const big = await pay(st.id, 12000);
    const cs = await request(app).post(`/api/v1/finance/payments/${small.body.id}/cancel-request`).set(as(accounts)).send({ reason: 'Wrong amount (synthetic)' });
    expect(await levelsOf(cs.body.approval.id)).toEqual(['finance_manager']);
    const cb = await request(app).post(`/api/v1/finance/payments/${big.body.id}/cancel-request`).set(as(accounts)).send({ reason: 'Bounced cheque (synthetic)' });
    expect(await levelsOf(cb.body.approval.id)).toEqual(['finance_manager', 'management']);
    expect((await approve(cb.body.approval.id, finmgr)).status).toBe('PENDING');
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: big.body.id } })).status).toBe('CANCEL_REQUESTED');
    expect((await approve(cb.body.approval.id, director)).status).toBe('APPROVED');
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: big.body.id } })).status).toBe('CANCELLED');
    await clean(st.id);
  });

  async function returningStudent() {
    const { st, planId } = await studentWithPlan(2); // Full Stack, billed
    for (const to of [dmBatch, fsdBatches[1]]) { // → Digital Marketing → back to Full Stack
      const t = await request(app).post(`/api/v1/students/${st.id}/transfer`).set(as(office)).send({ toBatchId: to, reason: 'Course change (synthetic)' });
      await approve(t.body.approval.id, acad);
    }
    return { st, oldPlanId: planId };
  }
  const newPlan = (id: string, body: any = {}) => request(app).post(`/api/v1/finance/students/${id}/fee-plan`).set(as(finmgr)).send({ installments: 2, ...body });

  it('B2: returning to a course already billed — a second plan needs approval; nothing is billed until approved', async () => {
    const { st, oldPlanId } = await returningStudent();
    const plans0 = await prisma.feePlan.count({ where: { studentId: st.id } });
    const ledger0 = await prisma.ledgerEntry.count({ where: { studentId: st.id } });
    const acct = await request(app).get(`/api/v1/finance/students/${st.id}/account`).set(as(accounts));
    expect(acct.body.newPlan).toEqual({ allowed: true, needsApproval: true, pendingAdjustmentId: null });
    const noReason = await newPlan(st.id);
    expect(noReason.status).toBe(400);
    expect(noReason.body.error.details).toEqual({ needsApproval: true });
    const r = await newPlan(st.id, { reason: 'Re-joined Full Stack after leaving it (synthetic)' });
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    expect(r.body.adjustment).toMatchObject({ kind: 'REBILL', status: 'PENDING_APPROVAL', feePlanId: oldPlanId });
    expect(Number(r.body.adjustment.amount)).toBe(60100);
    expect(await levelsOf(r.body.approval.id)).toEqual(['finance_manager', 'management']); // plan amount ≥ 10,000
    expect(await prisma.feePlan.count({ where: { studentId: st.id } })).toBe(plans0);
    expect(await prisma.ledgerEntry.count({ where: { studentId: st.id } })).toBe(ledger0);
    expect((await newPlan(st.id, { reason: 'Second request (synthetic)' })).status).toBe(409); // one pending at a time
    expect((await request(app).get(`/api/v1/finance/students/${st.id}/account`).set(as(accounts))).body.newPlan.pendingAdjustmentId).toBe(r.body.adjustment.id);
    // The requesting Finance Manager cannot approve; a second Finance Manager, then Management.
    expect((await act(r.body.approval.id, finmgr)).status).toBe(403);
    expect((await approve(r.body.approval.id, finmgr2)).status).toBe('PENDING');
    expect((await approve(r.body.approval.id, director)).status).toBe('APPROVED');
    const adj = await prisma.feeAdjustment.findUniqueOrThrow({ where: { id: r.body.adjustment.id } });
    const created = await prisma.feePlan.findUniqueOrThrow({ where: { id: adj.createdFeePlanId! } });
    const cur = await prisma.enrollment.findFirstOrThrow({ where: { studentId: st.id, status: 'ACTIVE' } });
    expect(adj.status).toBe('APPLIED');
    expect(created).toMatchObject({ studentId: st.id, enrollmentId: cur.id });
    expect(Number(created.grossAmount)).toBe(60100);
    expect(await prisma.ledgerEntry.count({ where: { refType: 'fee_plan', refId: created.id, type: 'FEE' } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { action: 'FEE_ADJUSTMENT_REBILL', entityId: adj.id } })).toBe(1);
    expect((await newPlan(st.id, { reason: 'Third (synthetic)' })).status).toBe(400); // plan now exists for this enrollment
    expect((await reconcile({ studentId: st.id })).issues.filter((i) => i.severity === 'ERROR')).toEqual([]);
  });

  it('B2: re-checked at approval — refused if the course fee changed or the enrollment moved; rejection changes nothing', async () => {
    const { st } = await returningStudent();
    const r = await newPlan(st.id, { reason: 'Re-joined (synthetic)' });
    expect(r.status).toBe(202);
    const comp = await prisma.feeComponent.findFirstOrThrow({ where: { course: { code: 'FSD' }, isActive: true } });
    await prisma.feeComponent.update({ where: { id: comp.id }, data: { amount: { increment: 1 } } });
    try {
      expect((await approve(r.body.approval.id, finmgr2)).status).toBe('PENDING');
      const a = await act(r.body.approval.id, director);
      expect(a.status).toBe(409);
      expect(a.body.error.message).toMatch(/course fee changed/);
    } finally {
      await prisma.feeComponent.update({ where: { id: comp.id }, data: { amount: { decrement: 1 } } });
    }
    // Enrollment moves to another course before the final approval.
    const t = await request(app).post(`/api/v1/students/${st.id}/transfer`).set(as(office)).send({ toBatchId: dmBatch, reason: 'Changed again (synthetic)' });
    await approve(t.body.approval.id, acad);
    const a2 = await act(r.body.approval.id, director);
    expect(a2.status).toBe(409);
    expect(a2.body.error.message).toMatch(/no longer current/);
    expect((await act(r.body.approval.id, director, 'REJECT', 'Obsolete')).status).toBe(200);
    expect((await prisma.feeAdjustment.findUniqueOrThrow({ where: { id: r.body.adjustment.id } })).status).toBe('REJECTED');
    expect(await prisma.feePlan.count({ where: { studentId: st.id, courseId: comp.courseId } })).toBe(1); // only the original
  });

  it('a first plan for a course never billed before is still created directly (unchanged)', async () => {
    const st = await makeStudent({ batchId: fsdBatches[0] });
    const r = await newPlan(st.id);
    expect(r.status).toBe(201);
    expect((await request(app).get(`/api/v1/finance/students/${st.id}/account`).set(as(accounts))).body.newPlan).toEqual({ allowed: false, needsApproval: false, pendingAdjustmentId: null });
  });
});
