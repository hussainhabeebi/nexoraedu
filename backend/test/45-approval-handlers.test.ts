/**
 * Approval outcomes apply only what was approved; rejection changes nothing (APR-04, FIN-11, FIN-12, ACD-07, EXM-18, STU-10).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app, as, makeStudent, makeUser, prisma, sessionFor } from './helpers';
import { createFeePlan, recordPayment } from '../src/services/finance';
import { atomic } from '../src/lib/db';

let sa: string, accounts: string, finmgr: string, director: string, acad: string, exOff: string, fac: string;
let studentId: string;
beforeAll(async () => {
  const s = await makeUser(['super_admin']);
  [sa, accounts, finmgr, director, acad, exOff, fac] = await Promise.all([s.username, 'accounts', 'finmgr', 'director', 'acadmgr', 'examofficer', 'faculty1'].map((u) => sessionFor(u)));
  const st = await makeStudent({});
  studentId = st.id;
  await atomic((tx) => createFeePlan(tx, { studentId: st.id, courseId: st.courseId, installments: 1 }));
  await atomic((tx) => recordPayment(tx, { studentId: st.id, amount: 8000, mode: 'CASH' }));
});
const act = (id: string, tok: string, action: string, comment?: string) => request(app).post(`/api/v1/approvals/${id}/act`).set(as(tok)).send({ action, comment });

describe('refunds', () => {
  it('rejected refund changes nothing; approved refund (two levels above ₹5,000) can then be paid once', async () => {
    const r1 = await request(app).post('/api/v1/finance/refunds').set(as(accounts)).send({ studentId, amount: 500, reason: 'Duplicate fee paid' });
    expect(r1.status, JSON.stringify(r1.body)).toBe(201);
    expect((await act(r1.body.approval.id, finmgr, 'REJECT', 'Not eligible')).status).toBe(200);
    expect((await prisma.refund.findUniqueOrThrow({ where: { id: r1.body.refund.id } })).status).toBe('REJECTED');
    expect((await request(app).post(`/api/v1/finance/refunds/${r1.body.refund.id}/pay`).set(as(finmgr)).send({ reference: 'NEFT-1' })).status).toBe(400);

    const r2 = await request(app).post('/api/v1/finance/refunds').set(as(accounts)).send({ studentId, amount: 6000, reason: 'Course withdrawn in week one' });
    expect(r2.body.approval.levels).toHaveLength(2);
    expect((await act(r2.body.approval.id, finmgr, 'APPROVE')).status).toBe(200);
    expect((await prisma.refund.findUniqueOrThrow({ where: { id: r2.body.refund.id } })).status).toBe('PENDING_APPROVAL');
    expect((await act(r2.body.approval.id, director, 'APPROVE')).status).toBe(200);
    expect((await prisma.refund.findUniqueOrThrow({ where: { id: r2.body.refund.id } })).status).toBe('APPROVED');
    const [p1, p2] = await Promise.all([
      request(app).post(`/api/v1/finance/refunds/${r2.body.refund.id}/pay`).set(as(finmgr)).send({ reference: 'NEFT-2' }),
      request(app).post(`/api/v1/finance/refunds/${r2.body.refund.id}/pay`).set(as(finmgr)).send({ reference: 'NEFT-3' }),
    ]);
    expect([p1.status, p2.status].sort()).toEqual([200, 400]); // paid exactly once
    expect(await prisma.ledgerEntry.count({ where: { refType: 'refund', refId: r2.body.refund.id } })).toBe(1);
    expect((await request(app).post('/api/v1/finance/refunds').set(as(accounts)).send({ studentId, amount: 999999, reason: 'Too much' })).status).toBe(400);
  });
});

describe('payment cancellation', () => {
  it('rejection restores the payment; a second cancellation request is refused while one is pending', async () => {
    // The shared student had a ₹6,000 refund paid out of this receipt above, so cancelling it is refused (B1).
    const refunded = await prisma.payment.findFirstOrThrow({ where: { studentId } });
    expect((await request(app).post(`/api/v1/finance/payments/${refunded.id}/cancel-request`).set(as(accounts)).send({ reason: 'Refunded already' })).status).toBe(409);
    // Own synthetic student and receipt for the rejection flow.
    const st = await makeStudent({});
    await atomic((tx) => createFeePlan(tx, { studentId: st.id, courseId: st.courseId, installments: 1 }));
    const pay = await atomic((tx) => recordPayment(tx, { studentId: st.id, amount: 8000, mode: 'CASH' }));
    const c1 = await request(app).post(`/api/v1/finance/payments/${pay.id}/cancel-request`).set(as(accounts)).send({ reason: 'Wrong student selected' });
    expect(c1.status).toBe(200);
    expect((await request(app).post(`/api/v1/finance/payments/${pay.id}/cancel-request`).set(as(accounts)).send({ reason: 'Again please' })).status).toBe(400);
    expect((await act(c1.body.approval.id, finmgr, 'REJECT', 'Receipt is correct')).status).toBe(200);
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: pay.id } })).status).toBe('POSTED');
    expect(await prisma.ledgerEntry.count({ where: { refType: 'payment', refId: pay.id, type: 'REVERSAL' } })).toBe(0);
  });
});

describe('academic approvals', () => {
  it('late attendance edits apply only after approval; transfers apply on approval', async () => {
    const f1 = await prisma.user.findUniqueOrThrow({ where: { username: 'faculty1' } });
    const st = await makeStudent({});
    const session = await prisma.timetableSession.create({ data: { batchId: st.batchId!, facultyId: f1.id, startsAt: new Date(Date.now() - 5 * 864e5), endsAt: new Date(Date.now() - 5 * 864e5 + 3600_000) } });
    const r = await request(app).post(`/api/v1/academics/sessions/${session.id}/attendance`).set(as(fac)).send({ records: [{ studentId: st.id, status: 'PRESENT' }] });
    expect(r.status).toBe(202);
    expect(await prisma.attendance.count({ where: { sessionId: session.id } })).toBe(0);
    const ap = await prisma.approvalRequest.findFirstOrThrow({ where: { type: 'ATTENDANCE_EDIT', entityId: `${session.id}:${st.id}` } });
    expect((await act(ap.id, acad, 'APPROVE')).status).toBe(200);
    expect((await prisma.attendance.findFirstOrThrow({ where: { sessionId: session.id, studentId: st.id } })).status).toBe('PRESENT');
    // Students outside the session's batch cannot be marked at all.
    const outsider = await makeStudent({ batchId: null });
    expect((await request(app).post(`/api/v1/academics/sessions/${session.id}/attendance`).set(as(fac)).send({ records: [{ studentId: outsider.id, status: 'PRESENT' }] })).status).toBe(400);

    const target = (await prisma.batch.findFirstOrThrow({ where: { courseId: st.courseId, NOT: { id: st.batchId! } } })).id;
    const t = await request(app).post(`/api/v1/students/${st.id}/transfer`).set(as(sa)).send({ toBatchId: target, reason: 'Weekend batch requested' });
    expect((await act(t.body.approval.id, acad, 'APPROVE')).status).toBe(200);
    expect((await prisma.student.findUniqueOrThrow({ where: { id: st.id } })).batchId).toBe(target);
  });
});

describe('result correction', () => {
  it('two-level correction (Exam Officer → Academic Manager) changes marks only when fully approved', async () => {
    const st = await makeStudent({});
    const exam = await prisma.exam.create({ data: { code: `EX-H-${Date.now()}`, title: 'Handler exam', courseId: st.courseId, batchId: st.batchId, startAt: new Date(), endAt: new Date(), totalMarks: 100, passMarks: 40 } });
    const res = await prisma.result.create({ data: { examId: exam.id, studentId: st.id, marks: 35, percentage: 35, grade: 'F', passed: false, locked: true } });
    const c = await request(app).post(`/api/v1/exams/results/${res.id}/correction`).set(as(acad)).send({ newMarks: 45, reason: 'Totalling error on page 3', evidence: 'Scanned answer sheet' });
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    expect((await act(c.body.approval.id, exOff, 'APPROVE')).status).toBe(200);
    expect((await prisma.result.findUniqueOrThrow({ where: { id: res.id } })).marks).toBe(35); // level 2 pending
    expect((await act(c.body.approval.id, acad, 'APPROVE')).status).toBe(403); // requester cannot approve
    const acad2 = await sessionFor((await makeUser(['academic_manager'])).username);
    expect((await act(c.body.approval.id, acad2, 'APPROVE')).status).toBe(200);
    const after = await prisma.result.findUniqueOrThrow({ where: { id: res.id } });
    expect(after).toMatchObject({ marks: 45, passed: true });
    expect(await prisma.studentHistory.count({ where: { studentId: st.id, type: 'RESULT' } })).toBe(1);
  });

  it('a returned request goes back to the requester with a mandatory comment', async () => {
    const st = await makeStudent({});
    const target = (await prisma.batch.findFirstOrThrow({ where: { courseId: st.courseId, NOT: { id: st.batchId! } } })).id;
    const t = await request(app).post(`/api/v1/students/${st.id}/transfer`).set(as(sa)).send({ toBatchId: target, reason: 'Return test' });
    expect((await act(t.body.approval.id, acad, 'RETURN')).status).toBe(400);
    expect((await act(t.body.approval.id, acad, 'RETURN', 'Please attach the parent request')).status).toBe(200);
    expect((await prisma.approvalRequest.findUniqueOrThrow({ where: { id: t.body.approval.id } })).status).toBe('RETURNED');
    expect((await prisma.student.findUniqueOrThrow({ where: { id: st.id } })).batchId).not.toBe(target);
  });
});
