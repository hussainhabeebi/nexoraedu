/**
 * R4 — approvals fail closed (SEC-T10…T13). SRS: APR-01…04, APR-07/08, APR-10, FR-FIN-04, FIN-09, FIN-12, 22.x.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app, as, makeStudent, makeUser, prisma, sessionFor } from './helpers';
import { createApproval } from '../src/services/approvals';
import { createFeePlan } from '../src/services/finance';
import { atomic } from '../src/lib/db';

let sa: string, acad: string, accounts: string, finmgr: string, director: string, c2: string;
let studentId: string, toBatchId: string;
beforeAll(async () => {
  const s = await makeUser(['super_admin']);
  [sa, acad, accounts, finmgr, director, c2] = await Promise.all([sessionFor(s.username), sessionFor('acadmgr'), sessionFor('accounts'), sessionFor('finmgr'), sessionFor('director'), sessionFor('counselor2')]);
  const st = await makeStudent({});
  studentId = st.id;
  await atomic((tx) => createFeePlan(tx, { studentId: st.id, courseId: st.courseId, installments: 1 }));
  toBatchId = (await prisma.batch.findFirstOrThrow({ where: { courseId: st.courseId, NOT: { id: st.batchId! } } })).id;
});

describe('SEC-T10 missing or disabled workflow ⇒ request refused, nothing changes', () => {
  it('disabled workflow', async () => {
    await prisma.approvalWorkflow.update({ where: { type: 'BATCH_TRANSFER' }, data: { isActive: false } });
    try {
      const n = await prisma.approvalRequest.count();
      const r = await request(app).post(`/api/v1/students/${studentId}/transfer`).set(as(sa)).send({ toBatchId, reason: 'Timing change' });
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe('APPROVAL_NOT_CONFIGURED');
      expect(await prisma.approvalRequest.count()).toBe(n);
      expect((await prisma.student.findUniqueOrThrow({ where: { id: studentId } })).batchId).not.toBe(toBatchId);
    } finally {
      await prisma.approvalWorkflow.update({ where: { type: 'BATCH_TRANSFER' }, data: { isActive: true } });
    }
  });
  it('unknown type / no applicable levels', async () => {
    await expect(atomic((tx) => createApproval(tx, { type: 'DISCOUNT_AUTO', entityType: 'x', entityId: 'x', title: 'x', requestedById: 'x' }))).rejects.toThrow(/not configured/);
    await prisma.approvalWorkflow.update({ where: { type: 'REFUND' }, data: { levels: [{ level: 1, role: 'finance_manager', minAmount: 1_000_000 }] } });
    try {
      await expect(atomic((tx) => createApproval(tx, { type: 'REFUND', entityType: 'refund', entityId: 'r1', title: 'x', amount: 10, requestedById: 'x' }))).rejects.toThrow(/not configured/);
    } finally {
      await prisma.approvalWorkflow.update({ where: { type: 'REFUND' }, data: { levels: [{ level: 1, role: 'finance_manager' }, { level: 2, role: 'management', minAmount: 5000 }] } });
    }
  });
});

describe('SEC-T11 workflow configuration guards', () => {
  it('mandatory workflows cannot be switched off or emptied; roles must exist', async () => {
    const put = (body: any) => request(app).put('/api/v1/admin/workflows/ADMISSION').set(as(sa)).send(body);
    expect((await put({ isActive: false, levels: [{ level: 1, role: 'sales_manager' }] })).status).toBe(400);
    expect((await put({ levels: [] })).status).toBe(422);
    expect((await put({ levels: [{ level: 1, role: 'ghost_role' }] })).status).toBe(400);
    expect((await put({ levels: [{ level: 2, role: 'sales_manager' }] })).status).toBe(400); // gap
    expect((await put({ levels: [{ level: 1, role: 'student' }] })).status).toBe(400);
    expect((await put({ levels: [{ level: 1, role: 'sales_manager' }] })).status).toBe(200);
    expect((await request(app).put('/api/v1/admin/workflows/ADMISSION').set(as(await sessionFor('office'))).send({ levels: [{ level: 1, role: 'sales_manager' }] })).status).toBe(403);
  });
});

describe('SEC-T12 segregation of duties', () => {
  it('nobody — including the Super Administrator — approves their own request', async () => {
    const r = await request(app).post(`/api/v1/students/${studentId}/transfer`).set(as(sa)).send({ toBatchId, reason: 'Own request test' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const act = await request(app).post(`/api/v1/approvals/${r.body.approval.id}/act`).set(as(sa)).send({ action: 'APPROVE' });
    expect(act.status).toBe(403);
    // Duplicate pending request for the same record is refused.
    expect((await request(app).post(`/api/v1/students/${studentId}/transfer`).set(as(sa)).send({ toBatchId, reason: 'Again' })).status).toBe(409);
    // Reject needs a comment; then reject cleanly.
    expect((await request(app).post(`/api/v1/approvals/${r.body.approval.id}/act`).set(as(acad)).send({ action: 'REJECT' })).status).toBe(400);
    expect((await request(app).post(`/api/v1/approvals/${r.body.approval.id}/act`).set(as(acad)).send({ action: 'REJECT', comment: 'Not now' })).status).toBe(200);
    expect((await prisma.student.findUniqueOrThrow({ where: { id: studentId } })).batchId).not.toBe(toBatchId); // rejected changes nothing
    const action = await prisma.approvalAction.findFirstOrThrow({ where: { requestId: r.body.approval.id } });
    expect(action.ip).toBeTruthy(); // APR-10
    expect(await prisma.auditLog.count({ where: { action: 'APPROVAL_REJECT', entityId: r.body.approval.id } })).toBe(1);
  });

  it('one person cannot decide two levels of the same request (multi-level discount)', async () => {
    const d = await request(app).post('/api/v1/finance/discounts').set(as(accounts)).send({ studentId, kind: 'FIXED', value: 12000, reason: 'Merit scholarship test' });
    expect(d.status, JSON.stringify(d.body)).toBe(201);
    expect(d.body.approval.levels).toHaveLength(2); // amount ≥ 10000 adds Management (APR-08)
    const id = d.body.approval.id;
    expect((await request(app).post(`/api/v1/approvals/${id}/act`).set(as(accounts)).send({ action: 'APPROVE' })).status).toBe(403); // no approvals:act
    expect((await request(app).post(`/api/v1/approvals/${id}/act`).set(as(sa)).send({ action: 'APPROVE' })).status).toBe(200); // level 1
    expect((await request(app).post(`/api/v1/approvals/${id}/act`).set(as(sa)).send({ action: 'APPROVE' })).status).toBe(403); // same person, level 2
    expect((await request(app).post(`/api/v1/approvals/${id}/act`).set(as(finmgr)).send({ action: 'APPROVE' })).status).toBe(403); // wrong role for level 2
    expect((await prisma.discount.findUniqueOrThrow({ where: { id: d.body.discount.id } })).status).toBe('PENDING_APPROVAL');
    expect((await request(app).post(`/api/v1/approvals/${id}/act`).set(as(director)).send({ action: 'APPROVE' })).status).toBe(200);
    expect((await prisma.discount.findUniqueOrThrow({ where: { id: d.body.discount.id } })).status).toBe('APPLIED');
  });

  it('every discount needs the configured approval — no automatic exemption, even ₹100 by a Finance Manager (decision 5)', async () => {
    const d = await request(app).post('/api/v1/finance/discounts').set(as(finmgr)).send({ studentId, kind: 'FIXED', value: 100, reason: 'Early bird' });
    expect(d.status).toBe(201);
    expect(d.body.approval.status).toBe('PENDING');
    expect((await prisma.discount.findUniqueOrThrow({ where: { id: d.body.discount.id } })).status).toBe('PENDING_APPROVAL');
    expect((await request(app).post(`/api/v1/approvals/${d.body.approval.id}/act`).set(as(finmgr)).send({ action: 'APPROVE' })).status).toBe(403); // own request
    expect((await request(app).post(`/api/v1/approvals/${d.body.approval.id}/act`).set(as(sa)).send({ action: 'APPROVE' })).status).toBe(200);
    expect((await prisma.discount.findUniqueOrThrow({ where: { id: d.body.discount.id } })).status).toBe('APPLIED');
    expect(await prisma.auditLog.count({ where: { action: 'DISCOUNT_APPLIED_WITHIN_LIMIT' } })).toBe(0);
  });

  it('concurrent decisions: exactly one succeeds', async () => {
    const st = await makeStudent({});
    const target = (await prisma.batch.findFirstOrThrow({ where: { courseId: st.courseId, NOT: { id: st.batchId! } } })).id;
    const r = await request(app).post(`/api/v1/students/${st.id}/transfer`).set(as(await sessionFor('office'))).send({ toBatchId: target, reason: 'Race test' });
    const sa2 = await sessionFor((await makeUser(['super_admin'])).username);
    const [a, b] = await Promise.all([
      request(app).post(`/api/v1/approvals/${r.body.approval.id}/act`).set(as(acad)).send({ action: 'APPROVE' }),
      request(app).post(`/api/v1/approvals/${r.body.approval.id}/act`).set(as(sa2)).send({ action: 'APPROVE' }),
    ]);
    expect([a.status, b.status].sort(), JSON.stringify([a.body, b.body])).toEqual([200, 403]);
    expect(await prisma.approvalAction.count({ where: { requestId: r.body.approval.id } })).toBe(1);
    expect(await prisma.studentHistory.count({ where: { studentId: st.id, type: 'BATCH' } })).toBe(1);
  });
});

describe('SEC-T13 approval visibility', () => {
  it('invalid inbox filter is rejected; uninvolved users cannot read a request', async () => {
    expect((await request(app).get('/api/v1/approvals?box=foo').set(as(c2))).status).toBe(422);
    const r = await request(app).post(`/api/v1/students/${studentId}/transfer`).set(as(await sessionFor('office'))).send({ toBatchId, reason: 'Visibility test' });
    expect((await request(app).get(`/api/v1/approvals/${r.body.approval.id}`).set(as(c2))).status).toBe(404);
    expect((await request(app).get(`/api/v1/approvals/${r.body.approval.id}`).set(as(acad))).status).toBe(200);
    const all = await request(app).get('/api/v1/approvals?box=all').set(as(c2));
    expect(all.body.items.map((i: any) => i.id)).not.toContain(r.body.approval.id);
  });
});
