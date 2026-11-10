/**
 * Finance MVP task 1 — month-end due dates in the academy time zone, and read-only reconciliation.
 * SRS: FIN-02/03/05/07/08/13, RPT-06, DB-08, 8.4. Synthetic data on the local test database only.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app, as, makeStudent, prisma, sessionFor } from './helpers';
import { addMonthsClamped, dayDiff, endOfDayUtc, isoDate, parseIsoDate, toCalendarDate, zonedTimeToUtc, isValidTimeZone } from '../src/lib/caldate';
import { buildInstallmentSchedule, createFeePlan, planStartDate, recordPayment } from '../src/services/finance';
import { reconcile } from '../src/services/reconciliation';
import { nextNumber } from '../src/lib/sequence';
import { invalidateSettings } from '../src/lib/settings';
import { runFeeReminders } from '../src/jobs/scheduler';
import { processReminderQueue } from '../src/services/feeReminders';
import { atomic } from '../src/lib/db';

const c = (s: string) => parseIsoDate(s)!;
const dates = (start: string, n: number, tz = 'Asia/Kolkata') => buildInstallmentSchedule(1000, n, c(start), tz).map((x) => isoDate(x.calendarDate));

describe('Month-end policy: "anchor day, clamped"', () => {
  it('31 January → last day of February → 31 March … (non-leap year 2027)', () => {
    expect(dates('2027-01-31', 6)).toEqual(['2027-01-31', '2027-02-28', '2027-03-31', '2027-04-30', '2027-05-31', '2027-06-30']);
  });
  it('leap years: 29 February in 2028; century rules (2000 leap, 2100 not)', () => {
    expect(dates('2028-01-31', 3)).toEqual(['2028-01-31', '2028-02-29', '2028-03-31']);
    expect(dates('2028-01-29', 2)).toEqual(['2028-01-29', '2028-02-29']);
    expect(dates('2027-01-29', 2)).toEqual(['2027-01-29', '2027-02-28']);
    expect(isoDate(addMonthsClamped(c('2000-01-31'), 1))).toBe('2000-02-29');
    expect(isoDate(addMonthsClamped(c('2100-01-31'), 1))).toBe('2100-02-28');
    expect(isoDate(addMonthsClamped(c('2028-02-29'), 12))).toBe('2029-02-28');
  });
  it('anchor day is kept after a short month (no drift to the 28th) and across year ends', () => {
    expect(dates('2027-01-30', 3)).toEqual(['2027-01-30', '2027-02-28', '2027-03-30']);
    expect(dates('2027-08-31', 3)).toEqual(['2027-08-31', '2027-09-30', '2027-10-31']);
    expect(dates('2027-12-31', 3)).toEqual(['2027-12-31', '2028-01-31', '2028-02-29']);
    expect(dates('2027-02-28', 2)).toEqual(['2027-02-28', '2027-03-28']); // anchor = 28, not "end of month"
  });
  it('amounts are split in whole paise and always add up exactly', () => {
    for (const [gross, n] of [[100000.01, 3], [61100, 3], [0.05, 4], [99999.99, 7], [12345.67, 12]] as const) {
      const s = buildInstallmentSchedule(gross, n, c('2027-01-31'), 'Asia/Kolkata');
      expect(s.reduce((t, x) => t + Math.round(x.amount * 100), 0)).toBe(Math.round(gross * 100));
      expect(s.every((x) => Number.isInteger(Math.round(x.amount * 100)) && x.amount >= 0)).toBe(true);
    }
  });
});

describe('Academy time zone (DB-08)', () => {
  it('a due date is the end of the calendar day in the academy zone, stored in UTC', () => {
    expect(endOfDayUtc(c('2027-02-28'), 'Asia/Kolkata').toISOString()).toBe('2027-02-28T18:29:59.999Z'); // UTC+5:30
    expect(endOfDayUtc(c('2027-02-28'), 'America/New_York').toISOString()).toBe('2027-03-01T04:59:59.999Z'); // UTC−5
    expect(endOfDayUtc(c('2027-03-14'), 'America/New_York').toISOString()).toBe('2027-03-15T03:59:59.999Z'); // DST day (UTC−4)
    expect(endOfDayUtc(c('2027-02-28'), 'Pacific/Auckland').toISOString()).toBe('2027-02-28T10:59:59.999Z'); // UTC+13
    expect(endOfDayUtc(c('2027-02-28'), 'UTC').toISOString()).toBe('2027-02-28T23:59:59.999Z');
    for (const tz of ['Asia/Kolkata', 'America/New_York', 'Pacific/Auckland', 'Asia/Kathmandu', 'UTC']) {
      expect(isoDate(toCalendarDate(endOfDayUtc(c('2028-02-29'), tz), tz)), tz).toBe('2028-02-29'); // calendar date preserved
      expect(isoDate(toCalendarDate(zonedTimeToUtc(c('2028-02-29'), tz), tz)), tz).toBe('2028-02-29');
    }
    expect(isValidTimeZone('Asia/Kolkata')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
  });

  it('start-date parsing: a calendar date is taken as-is; an instant is read in the academy zone', () => {
    expect(isoDate(planStartDate('2027-01-31', 'America/New_York'))).toBe('2027-01-31');
    const late = new Date('2027-01-31T20:00:00Z'); // 01:30 on 1 Feb in India, 15:00 on 31 Jan in New York
    expect(isoDate(planStartDate(late, 'Asia/Kolkata'))).toBe('2027-02-01');
    expect(isoDate(planStartDate(late, 'America/New_York'))).toBe('2027-01-31');
    expect(() => planStartDate('2027-02-30', 'Asia/Kolkata')).toThrow();
  });

  it('results do not depend on the server time zone', () => {
    const saved = process.env.TZ;
    try {
      process.env.TZ = 'America/Los_Angeles';
      const a = buildInstallmentSchedule(5000, 4, c('2027-01-31'), 'Asia/Kolkata').map((x) => x.dueDate.toISOString());
      process.env.TZ = 'Asia/Tokyo';
      const b = buildInstallmentSchedule(5000, 4, c('2027-01-31'), 'Asia/Kolkata').map((x) => x.dueDate.toISOString());
      expect(a).toEqual(b);
    } finally {
      process.env.TZ = saved;
    }
  });

  it('calendar-day differences for ageing and reminders', () => {
    expect(dayDiff(c('2027-02-28'), c('2027-03-01'))).toBe(1);
    expect(dayDiff(c('2028-02-28'), c('2028-03-01'))).toBe(2);
    expect(dayDiff(c('2027-12-31'), c('2027-12-31'))).toBe(0);
  });

  it('yearly number sequences follow the academy calendar (no duplicates around New Year)', async () => {
    expect(await nextNumber('rcpt-test:{year}', 'RT-{YYYY}-###', prisma, { y: 2031, m: 1 })).toBe('RT-2031-001');
    expect(await nextNumber('rcpt-test:{year}', 'RT-{YYYY}-###', prisma, { y: 2031, m: 12 })).toBe('RT-2031-002');
    expect(await nextNumber('rcpt-test:{year}', 'RT-{YYYY}-###', prisma, { y: 2032, m: 1 })).toBe('RT-2032-001');
    expect(await prisma.sequence.findUnique({ where: { name: 'rcpt-test:2031' } })).toMatchObject({ next: 3 });
  });
});

describe('Fee plans in the database', () => {
  let fin: string, accounts: string;
  beforeAll(async () => {
    [fin, accounts] = await Promise.all([sessionFor('finmgr'), sessionFor('accounts')]);
  });

  it('plan from 31 Jan uses the policy, records it, and invoices match the installments', async () => {
    const st = await makeStudent({});
    const plan = await atomic((tx) => createFeePlan(tx, { studentId: st.id, courseId: st.courseId, installments: 4, startDate: '2027-01-31' }));
    expect(plan).toMatchObject({ dueAnchorDay: 31, dueTimeZone: 'Asia/Kolkata' });
    const ins = await prisma.installment.findMany({ where: { feePlanId: plan.id }, orderBy: { seq: 'asc' } });
    expect(ins.map((i) => isoDate(toCalendarDate(i.dueDate, 'Asia/Kolkata')))).toEqual(['2027-01-31', '2027-02-28', '2027-03-31', '2027-04-30']);
    expect(ins[1].dueDate.toISOString()).toBe('2027-02-28T18:29:59.999Z');
    const inv = await prisma.invoice.findMany({ where: { feePlanId: plan.id } });
    expect(inv).toHaveLength(4);
    expect(inv.every((v) => ins.find((i) => i.id === v.installmentId)!.dueDate.getTime() === v.dueDate!.getTime())).toBe(true);
    expect((await reconcile({ studentId: st.id })).ok).toBe(true);
  });

  it('API: start date as a calendar date; leap year; one plan per course', async () => {
    const st = await makeStudent({});
    const r = await request(app).post(`/api/v1/finance/students/${st.id}/fee-plan`).set(as(fin)).send({ installments: 2, startDate: '2028-01-31' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const ins = await prisma.installment.findMany({ where: { feePlanId: r.body.id }, orderBy: { seq: 'asc' } });
    expect(ins.map((i) => isoDate(toCalendarDate(i.dueDate, 'Asia/Kolkata')))).toEqual(['2028-01-31', '2028-02-29']);
    expect((await request(app).post(`/api/v1/finance/students/${st.id}/fee-plan`).set(as(fin)).send({ installments: 2 })).status).toBe(400);
    expect((await request(app).post(`/api/v1/finance/students/${(await makeStudent({})).id}/fee-plan`).set(as(fin)).send({ installments: 2, startDate: '2027-02-30' })).status).toBe(400); // not a real date
  });

  it('changing the academy time zone affects new plans only; existing due dates are untouched', async () => {
    const st1 = await makeStudent({});
    const p1 = await atomic((tx) => createFeePlan(tx, { studentId: st1.id, courseId: st1.courseId, installments: 2, startDate: '2027-05-31' }));
    const before = (await prisma.installment.findMany({ where: { feePlanId: p1.id }, orderBy: { seq: 'asc' } })).map((i) => i.dueDate.toISOString());
    const sa = await sessionFor('owner2');
    expect((await request(app).put('/api/v1/admin/settings/academy').set(as(sa)).send({ timeZone: 'Mars/Olympus' })).status).toBe(400);
    expect((await request(app).put('/api/v1/admin/settings/academy').set(as(sa)).send({ timeZone: 'America/New_York' })).status).toBe(200);
    try {
      invalidateSettings();
      const st2 = await makeStudent({});
      const p2 = await atomic((tx) => createFeePlan(tx, { studentId: st2.id, courseId: st2.courseId, installments: 2, startDate: '2027-05-31' }));
      expect(p2.dueTimeZone).toBe('America/New_York');
      const ins2 = await prisma.installment.findMany({ where: { feePlanId: p2.id }, orderBy: { seq: 'asc' } });
      expect(ins2.map((i) => i.dueDate.toISOString())).toEqual(['2027-06-01T03:59:59.999Z', '2027-07-01T03:59:59.999Z']); // 31 May, 30 Jun (EDT)
      expect((await prisma.installment.findMany({ where: { feePlanId: p1.id }, orderBy: { seq: 'asc' } })).map((i) => i.dueDate.toISOString())).toEqual(before);
      expect((await reconcile({ studentId: st1.id })).ok).toBe(true); // validated against its OWN recorded zone
      expect((await reconcile({ studentId: st2.id })).ok).toBe(true);
    } finally {
      await request(app).put('/api/v1/admin/settings/academy').set(as(sa)).send({ timeZone: 'Asia/Kolkata' });
      invalidateSettings();
    }
  });

  it('partial payments: FIFO allocation, statuses and outstanding balance', async () => {
    const st = await makeStudent({});
    const plan = await atomic((tx) => createFeePlan(tx, { studentId: st.id, courseId: st.courseId, installments: 3, startDate: '2027-01-31' }));
    const ins = await prisma.installment.findMany({ where: { feePlanId: plan.id }, orderBy: { seq: 'asc' } });
    const first = Number(ins[0].amount);
    const pay = (amount: number, key: string) => request(app).post('/api/v1/finance/payments').set(as(accounts)).set('Idempotency-Key', key).send({ studentId: st.id, amount, mode: 'UPI', reference: key });
    expect((await pay(1000, `p1-${st.id}`)).status).toBe(201);
    expect((await pay(first, `p2-${st.id}`)).status).toBe(201); // completes #1, spills 1000 into #2
    const after = await prisma.installment.findMany({ where: { feePlanId: plan.id }, orderBy: { seq: 'asc' } });
    expect(after.map((i) => i.status)).toEqual(['PAID', 'PARTIAL', 'DUE']);
    expect(Number(after[1].paidAmount)).toBeCloseTo(1000, 2);
    const acct = await request(app).get(`/api/v1/finance/students/${st.id}/account`).set(as(accounts));
    const open = after.reduce((s, i) => s + Number(i.amount) - Number(i.paidAmount), 0);
    expect(acct.body.balance).toBeCloseTo(open, 2);
    expect((await pay(open + 1, `p3-${st.id}`)).status).toBe(409); // cannot overpay
    expect((await reconcile({ studentId: st.id })).ok).toBe(true);
  });

  it('ageing: due today is not overdue; due yesterday is 1 day overdue (academy calendar)', async () => {
    const tz = 'Asia/Kolkata';
    const today = toCalendarDate(new Date(), tz);
    const yesterday = addMonthsClamped(today, 0); // copy
    const y = new Date(Date.UTC(today.y, today.m - 1, today.d) - 864e5);
    const stA = await makeStudent({});
    const stB = await makeStudent({});
    await atomic((tx) => createFeePlan(tx, { studentId: stA.id, courseId: stA.courseId, installments: 1, startDate: isoDate(today) }));
    await atomic((tx) => createFeePlan(tx, { studentId: stB.id, courseId: stB.courseId, installments: 1, startDate: isoDate({ y: y.getUTCFullYear(), m: y.getUTCMonth() + 1, d: y.getUTCDate() }) }));
    expect(yesterday).toEqual(today);
    const out = await request(app).get('/api/v1/finance/outstanding').set(as(fin));
    const a = out.body.items.find((i: any) => i.studentId === stA.id);
    const b = out.body.items.find((i: any) => i.studentId === stB.id);
    expect(a).toMatchObject({ overdue: 0, maxDaysOverdue: 0 });
    expect(b.overdue).toBeGreaterThan(0);
    expect(b.maxDaysOverdue).toBe(1);
  });

  it('reminders: due today uses the "upcoming" template, then not repeated the same day', async () => {
    const tz = 'Asia/Kolkata';
    const today = toCalendarDate(new Date(), tz);
    const st = await makeStudent({});
    await atomic((tx) => createFeePlan(tx, { studentId: st.id, courseId: st.courseId, installments: 1, startDate: isoDate(today) }));
    await runFeeReminders({ ignoreHours: true });
    // The queue delivers in bounded batches; deliver this student's reminders now.
    await processReminderQueue({ ids: (await prisma.feeReminder.findMany({ where: { studentId: st.id } })).map((r) => r.id) });
    const logs = await prisma.notificationLog.findMany({ where: { recipient: st.email } });
    expect(logs.map((l) => l.templateKey)).toContain('fee.reminder_upcoming');
    expect(logs.map((l) => l.templateKey)).not.toContain('fee.reminder_overdue');
    const n = logs.length;
    await runFeeReminders({ ignoreHours: true });
    expect(await prisma.notificationLog.count({ where: { recipient: st.email } })).toBe(n);
  });

  it('concurrent partial payments never exceed the balance and stay reconciled', async () => {
    const st = await makeStudent({});
    const plan = await atomic((tx) => createFeePlan(tx, { studentId: st.id, courseId: st.courseId, installments: 2, startDate: '2027-01-31' }));
    const total = Number(plan.grossAmount);
    const part = Math.floor((total * 0.3) * 100) / 100;
    const res = await Promise.all(Array.from({ length: 5 }, (_, i) => request(app).post('/api/v1/finance/payments').set(as(accounts)).set('Idempotency-Key', `cp-${st.id}-${i}`).send({ studentId: st.id, amount: part, mode: 'CASH' })));
    expect(res.filter((r) => r.status === 201)).toHaveLength(3); // 3 × 30% fit, the 4th and 5th would overpay
    const paid = await prisma.payment.aggregate({ where: { studentId: st.id }, _sum: { amount: true } });
    expect(Number(paid._sum.amount)).toBeLessThanOrEqual(total + 0.001);
    expect((await reconcile({ studentId: st.id })).ok).toBe(true);
  });
});

describe('Reconciliation', () => {
  let fin: string;
  beforeAll(async () => {
    fin = await sessionFor('finmgr');
  });

  it('clean after the full money lifecycle: partial payment, cancellation, discount, refund', async () => {
    const st = await makeStudent({});
    await atomic((tx) => createFeePlan(tx, { studentId: st.id, courseId: st.courseId, installments: 3, startDate: '2027-01-31' }));
    const [accounts, sa] = await Promise.all([sessionFor('accounts'), sessionFor('owner2')]);
    const p1 = await request(app).post('/api/v1/finance/payments').set(as(accounts)).send({ studentId: st.id, amount: 7000, mode: 'CASH' });
    const p2 = await request(app).post('/api/v1/finance/payments').set(as(accounts)).send({ studentId: st.id, amount: 3000, mode: 'UPI', reference: 'UPI-REC-1' });
    expect(p1.status, JSON.stringify(p1.body)).toBe(201);
    expect(p2.status, JSON.stringify(p2.body)).toBe(201);
    const cr = await request(app).post(`/api/v1/finance/payments/${p1.body.id}/cancel-request`).set(as(accounts)).send({ reason: 'Wrong amount entered' });
    await request(app).post(`/api/v1/approvals/${cr.body.approval.id}/act`).set(as(fin)).send({ action: 'APPROVE' });
    const d = await request(app).post('/api/v1/finance/discounts').set(as(accounts)).send({ studentId: st.id, kind: 'PERCENT', value: 10, reason: 'Sibling discount' });
    await request(app).post(`/api/v1/approvals/${d.body.approval.id}/act`).set(as(fin)).send({ action: 'APPROVE' });
    if (d.body.approval.levels.length > 1) await request(app).post(`/api/v1/approvals/${d.body.approval.id}/act`).set(as(await sessionFor('director'))).send({ action: 'APPROVE' });
    const rf = await request(app).post('/api/v1/finance/refunds').set(as(accounts)).send({ studentId: st.id, amount: 1000, reason: 'Excess collected' });
    expect(rf.status, JSON.stringify(rf.body)).toBe(201);
    await request(app).post(`/api/v1/approvals/${rf.body.approval.id}/act`).set(as(fin)).send({ action: 'APPROVE' });
    await request(app).post(`/api/v1/finance/refunds/${rf.body.refund.id}/pay`).set(as(fin)).send({ reference: 'NEFT-REC-1' });
    expect(sa).toBeTruthy();
    const r = await request(app).get(`/api/v1/finance/reconciliation?studentId=${st.id}`).set(as(fin));
    expect(r.status).toBe(200);
    expect(r.body.issues.filter((i: any) => i.severity !== 'INFO'), JSON.stringify(r.body.issues)).toEqual([]);
    expect(r.body.checked).toMatchObject({ plans: 1, payments: 2, discounts: 1, refunds: 1 });
    expect(await prisma.auditLog.count({ where: { action: 'REPORT_RUN', entityId: 'reconciliation' } })).toBeGreaterThan(0);
  });

  it('detects tampering and inconsistencies without changing anything', async () => {
    const st = await makeStudent({});
    const plan = await atomic((tx) => createFeePlan(tx, { studentId: st.id, courseId: st.courseId, installments: 2, startDate: '2027-01-31' }));
    const pay = await atomic((tx) => recordPayment(tx, { studentId: st.id, amount: 2500, mode: 'CASH' }));
    const ins = await prisma.installment.findFirstOrThrow({ where: { feePlanId: plan.id, seq: 1 } });
    // Simulated corruption (synthetic): paid amount edited outside the payment flow, an allocation removed,
    // an orphan ledger entry, a missing invoice.
    // The database itself refuses paid > amount; simulate someone bypassing that rule (direct DB access).
    const [guard] = await prisma.$queryRawUnsafe<{ sql: string }[]>(`SELECT sql FROM sqlite_master WHERE name = 'installments_paid_le_amount_update'`);
    await expect(prisma.installment.update({ where: { id: ins.id }, data: { paidAmount: 999999 } })).rejects.toThrow(/paid_le_amount/);
    await prisma.$executeRawUnsafe('DROP TRIGGER "installments_paid_le_amount_update"');
    try {
      await prisma.installment.update({ where: { id: ins.id }, data: { paidAmount: 999999, status: 'PAID' } });
    } finally {
      await prisma.$executeRawUnsafe(guard.sql);
    }
    await prisma.paymentAllocation.deleteMany({ where: { paymentId: pay.id } });
    await prisma.ledgerEntry.create({ data: { studentId: st.id, type: 'PAYMENT', credit: 1, refType: 'payment', refId: 'does-not-exist', narration: 'Orphan' } });
    await prisma.invoice.deleteMany({ where: { installmentId: ins.id } });

    const snapshot = async () => JSON.stringify(await Promise.all([
      prisma.installment.findMany({ where: { feePlanId: plan.id }, orderBy: { seq: 'asc' } }),
      prisma.ledgerEntry.count({ where: { studentId: st.id } }), prisma.payment.findMany({ where: { studentId: st.id } }),
    ]));
    const before = await snapshot();
    const r = await reconcile({ studentId: st.id });
    expect(await snapshot()).toBe(before); // read-only
    expect(r.ok).toBe(false);
    const rules = new Set(r.issues.map((i) => i.rule));
    for (const rule of ['R1_LEDGER_BALANCE', 'R3_INSTALLMENT_BOUNDS', 'R4_INSTALLMENT_PAID', 'R5_PAYMENT_ALLOCATION', 'R10_LEDGER_REFERENCE', 'R11_INVOICE_COVERAGE']) expect(rules, rule).toContain(rule);
    expect(r.issues.find((i) => i.rule === 'R4_INSTALLMENT_PAID')).toMatchObject({ expected: '0.00', actual: '999999.00' });
  });

  it('legacy plans (old generator, server-local month overflow) are reported as INFO and never changed', async () => {
    const st = await makeStudent({});
    const plan = await prisma.feePlan.create({ data: { studentId: st.id, courseId: st.courseId, grossAmount: 3000, components: [] } }); // no policy columns
    // Reproduce the old bug: new Date(start).setMonth(+1) from 31 Jan → 3 Mar (server-local 23:59:59).
    const old = (i: number) => { const d = new Date(2027, 0, 31); d.setMonth(d.getMonth() + i); d.setHours(23, 59, 59, 0); return d; };
    for (let i = 0; i < 3; i++) {
      const inst = await prisma.installment.create({ data: { feePlanId: plan.id, seq: i + 1, amount: 1000, dueDate: old(i) } });
      await prisma.invoice.create({ data: { number: `INV-LEGACY-${st.id}-${i}`, studentId: st.id, feePlanId: plan.id, installmentId: inst.id, amount: 1000, dueDate: old(i) } });
    }
    await prisma.ledgerEntry.create({ data: { studentId: st.id, type: 'FEE', debit: 3000, refType: 'fee_plan', refId: plan.id, narration: 'Legacy fee' } });
    const before = (await prisma.installment.findMany({ where: { feePlanId: plan.id }, orderBy: { seq: 'asc' } })).map((i) => i.dueDate.toISOString());
    const r = await reconcile({ studentId: st.id });
    expect(r.ok).toBe(true);
    expect(r.issues.filter((i) => i.severity !== 'INFO')).toEqual([]);
    expect(r.issues.find((i) => i.rule === 'R12_DUE_DATE_POLICY')?.severity).toBe('INFO');
    expect((await prisma.installment.findMany({ where: { feePlanId: plan.id }, orderBy: { seq: 'asc' } })).map((i) => i.dueDate.toISOString())).toEqual(before);
    // Legacy plans still accept payments normally.
    await atomic((tx) => recordPayment(tx, { studentId: st.id, amount: 1500, mode: 'CASH' }));
    expect((await reconcile({ studentId: st.id })).ok).toBe(true);
  });

  afterAll(async () => {
    // Whole-database run on the synthetic test data (for the report): only the deliberately corrupted fixture may fail.
    const all = await reconcile();
    const errorStudents = new Set(all.issues.filter((i) => i.severity === 'ERROR').map((i) => i.studentId));
    console.log(`[reconciliation] full run: checked=${JSON.stringify(all.checked)} bySeverity=${JSON.stringify(all.bySeverity)} byRule=${JSON.stringify(all.byRule)} studentsWithErrors=${errorStudents.size}`);
  });
});
