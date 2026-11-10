/**
 * Pending fee management: Finance Dashboard for a fee month (expected / collected / outstanding, paid / partial /
 * unpaid students, overdue) and the per-student ledger by fee month. Balances follow successful payments only.
 * Uses a fee month no other suite touches (March 2031). Synthetic data only.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app, as, makeStudent, prisma, sessionFor } from './helpers';
import { atomic } from '../src/lib/db';
import { cancelPayment, createFeePlan } from '../src/services/finance';
import { feeMonthLedger, monthRange, monthSummary } from '../src/services/feeSummary';

const MONTH = '2031-03';
let fin: string, staff: string, staffId: string;
const S: Record<string, { id: string; march: number }> = {};

async function student(key: string) {
  const st = await makeStudent({});
  await atomic((tx) => createFeePlan(tx, { studentId: st.id, courseId: st.courseId, installments: 3, startDate: '2031-03-05' }));
  const march = await prisma.installment.findFirstOrThrow({ where: { feePlan: { studentId: st.id }, seq: 1 } });
  S[key] = { id: st.id, march: Number(march.amount) };
  return st;
}
const pay = (studentId: string, amount: number, key: string) =>
  request(app).post('/api/v1/finance/payments').set(as(fin)).set('Idempotency-Key', key).send({ studentId, amount, mode: 'CASH' });

beforeAll(async () => {
  fin = await sessionFor('finmgr');
  staff = await sessionFor('accounts');
  staffId = (await prisma.user.findUniqueOrThrow({ where: { username: 'accounts' } })).id;
  for (const k of ['paid', 'partial', 'unpaid', 'cancelled']) await student(k);
  expect((await pay(S.paid.id, S.paid.march, `sum-paid-${S.paid.id}`)).status).toBe(201);
  expect((await pay(S.partial.id, 1000, `sum-part-${S.partial.id}`)).status).toBe(201);
  const p = await pay(S.cancelled.id, S.cancelled.march, `sum-canc-${S.cancelled.id}`);
  expect(p.status).toBe(201);
  const finUser = await prisma.user.findUniqueOrThrow({ where: { username: 'finmgr' } });
  await atomic((tx) => cancelPayment(tx, p.body.id, finUser.id));
});

describe('Finance Dashboard for a fee month', () => {
  it('expected, collected and outstanding, and paid / partial / unpaid students', async () => {
    const r = await request(app).get(`/api/v1/finance/summary?month=${MONTH}&pageSize=200`).set(as(fin));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const expected = Object.values(S).reduce((a, x) => a + x.march, 0);
    const collected = S.paid.march + 1000;
    expect(r.body.month).toBe(MONTH);
    expect(r.body.totals.expected).toBeCloseTo(expected, 2);
    expect(r.body.totals.collected).toBeCloseTo(collected, 2); // the cancelled receipt counts for nothing
    expect(r.body.totals.outstanding).toBeCloseTo(expected - collected, 2);
    expect(r.body.students).toMatchObject({ total: 4, paid: 1, partial: 1, unpaid: 2 });
    const by = (id: string) => r.body.items.find((i: any) => i.studentId === id);
    expect(by(S.paid.id)).toMatchObject({ status: 'PAID', outstanding: 0 });
    expect(by(S.partial.id)).toMatchObject({ status: 'PARTIAL', paid: 1000 });
    expect(by(S.cancelled.id)).toMatchObject({ status: 'UNPAID', paid: 0 });
    const onlyPartial = await request(app).get(`/api/v1/finance/summary?month=${MONTH}&status=PARTIAL`).set(as(fin));
    expect(onlyPartial.body.items.map((i: any) => i.studentId)).toEqual([S.partial.id]);
  });

  it('overdue after the due date (academy calendar), for this month and across months', async () => {
    const out = await monthSummary(MONTH, { id: { in: Object.values(S).map((x) => x.id) } }, new Date('2031-03-20T06:00:00Z'));
    expect(out.students.overdue).toBe(3);
    expect(out.items.find((i) => i.studentId === S.unpaid.id)!.overdueDays).toBe(15);
    expect(out.items.find((i) => i.studentId === S.paid.id)!.overdueDays).toBe(0);
    expect(out.totals.overdue).toBeCloseTo(out.totals.outstanding, 2);
    expect(out.allMonthsOverdue.students).toBe(3);
    const dueDay = await monthSummary(MONTH, { id: S.unpaid.id }, new Date('2031-03-05T12:00:00Z')); // due today: not overdue yet
    expect(dueDay.students.overdue).toBe(0);
    // Month boundaries are academy-zone months.
    const { from, to } = monthRange(MONTH, 'Asia/Kolkata');
    expect(from.toISOString()).toBe('2031-02-28T18:30:00.000Z');
    expect(to.toISOString()).toBe('2031-03-31T18:30:00.000Z');
  });

  it('"assigned to me" shows only the staff member\'s students; assignment is manager-only and audited', async () => {
    expect((await request(app).put(`/api/v1/finance/students/${S.unpaid.id}/finance-owner`).set(as(staff)).send({ userId: staffId })).status).toBe(403);
    const counselorId = (await prisma.user.findUniqueOrThrow({ where: { username: 'counselor1' } })).id;
    expect((await request(app).put(`/api/v1/finance/students/${S.unpaid.id}/finance-owner`).set(as(fin)).send({ userId: counselorId })).status).toBe(400);
    expect((await request(app).put(`/api/v1/finance/students/${S.unpaid.id}/finance-owner`).set(as(fin)).send({ userId: staffId })).status).toBe(200);
    expect(await prisma.auditLog.count({ where: { action: 'ASSIGN', entity: 'student_finance_owner', entityId: S.unpaid.id } })).toBe(1);
    const mine = await request(app).get(`/api/v1/finance/summary?month=${MONTH}&mine=true`).set(as(staff));
    expect(mine.body.items.map((i: any) => i.studentId)).toEqual([S.unpaid.id]);
  });

  it('only finance readers can see it', async () => {
    for (const u of ['counselor1', 'faculty1']) expect((await request(app).get(`/api/v1/finance/summary?month=${MONTH}`).set(as(await sessionFor(u)))).status).toBe(403);
    expect((await request(app).get(`/api/v1/finance/summary`)).status).toBe(401);
  });
});

describe('per-student ledger by fee month', () => {
  it('each month with total, paid, outstanding, due date, status and payment history', async () => {
    const r = await request(app).get(`/api/v1/finance/students/${S.partial.id}/fee-months`).set(as(staff));
    expect(r.status).toBe(200);
    expect(r.body.student).toMatchObject({ id: S.partial.id });
    expect(r.body.rows.map((x: any) => x.feeMonth)).toEqual(['2031-03', '2031-04', '2031-05']);
    expect(r.body.rows[0]).toMatchObject({ status: 'PARTIAL', paid: 1000, outstanding: S.partial.march - 1000 });
    expect(r.body.rows[0].payments).toHaveLength(1);
    expect(r.body.rows[0].payments[0]).toMatchObject({ amount: 1000, mode: 'CASH', status: 'POSTED' });
    expect(r.body.rows[0].lastPaymentDate).toBeTruthy();
    expect(r.body.rows[1]).toMatchObject({ status: 'UNPAID', paid: 0, payments: [] });
  });

  it('a cancelled receipt is listed and marked, but the month stays unpaid', async () => {
    const l = await feeMonthLedger(S.cancelled.id);
    expect(l.rows[0]).toMatchObject({ status: 'UNPAID', paid: 0, lastPaymentDate: null });
    expect(l.rows[0].payments.map((p) => p.status)).toEqual(['CANCELLED']);
    expect(l.totals.paid).toBe(0);
  });
});
