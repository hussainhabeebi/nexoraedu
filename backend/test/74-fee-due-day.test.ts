/**
 * Monthly due date on a fixed day (finance.dueDayOfMonth, default the 10th) and the fee month of each installment.
 * New plans only: existing plans keep their stored due dates. Synthetic students only.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app, as, makeStudent, prisma, sessionFor } from './helpers';
import { isoDate, parseIsoDate, toCalendarDate } from '../src/lib/caldate';
import { buildInstallmentSchedule, createFeePlan, feeMonthLabel, firstDueDate, installmentFeeMonth } from '../src/services/finance';
import { atomic } from '../src/lib/db';
import { DEFAULT_SETTINGS, invalidateSettings } from '../src/lib/settings';
import { reconcile } from '../src/services/reconciliation';

const c = (s: string) => parseIsoDate(s)!;
const TZ = 'Asia/Kolkata';
let sa: string;
const setFinance = (body: object) => request(app).put('/api/v1/admin/settings/finance').set(as(sa)).send(body);

beforeAll(async () => {
  sa = await sessionFor('owner2');
});
afterAll(async () => {
  await setFinance({ dueDayOfMonth: null }); // back to the legacy policy the other suites use
  invalidateSettings();
});

describe('schedule on the 10th (pure)', () => {
  it('the production default is the 10th', () => {
    expect(DEFAULT_SETTINGS.finance.dueDayOfMonth).toBe(10);
  });

  it('first due date is the first 10th on or after the start date', () => {
    expect(isoDate(firstDueDate(c('2027-01-03'), 10))).toBe('2027-01-10');
    expect(isoDate(firstDueDate(c('2027-01-10'), 10))).toBe('2027-01-10'); // the 10th itself
    expect(isoDate(firstDueDate(c('2027-01-11'), 10))).toBe('2027-02-10');
    expect(isoDate(firstDueDate(c('2027-12-25'), 10))).toBe('2028-01-10'); // across the year end
    expect(isoDate(firstDueDate(c('2027-01-25'), null))).toBe('2027-01-25'); // legacy: the start day
  });

  it('every installment falls on the 10th, with its fee month, at the end of the day in the academy zone', () => {
    const s = buildInstallmentSchedule(30000, 4, c('2027-11-20'), TZ, 10);
    expect(s.map((x) => isoDate(x.calendarDate))).toEqual(['2027-12-10', '2028-01-10', '2028-02-10', '2028-03-10']);
    expect(s.map((x) => x.feeMonth)).toEqual(['2027-12', '2028-01', '2028-02', '2028-03']);
    expect(s[0].dueDate.toISOString()).toBe('2027-12-10T18:29:59.999Z'); // 23:59:59.999 IST
    expect(s.reduce((a, x) => a + Math.round(x.amount * 100), 0)).toBe(3000000);
    const ny = buildInstallmentSchedule(1000, 1, c('2027-07-01'), 'America/New_York', 10);
    expect(ny[0].dueDate.toISOString()).toBe('2027-07-11T03:59:59.999Z'); // end of 10 July in New York (EDT)
  });

  it('fee month labels and derivation for older installments without a stored month', () => {
    expect(feeMonthLabel('2027-12')).toBe('December 2027');
    expect(installmentFeeMonth({ feeMonth: null, dueDate: new Date('2027-02-28T18:29:59.999Z') }, TZ)).toBe('2027-02');
    expect(installmentFeeMonth({ feeMonth: '2027-03', dueDate: new Date() }, TZ)).toBe('2027-03');
  });
});

describe('fee plans with the due day switched on', () => {
  it('settings: only 1–28 or null are accepted', async () => {
    expect((await setFinance({ dueDayOfMonth: 31 })).status).toBe(422);
    expect((await setFinance({ dueDayOfMonth: 0 })).status).toBe(422);
    expect((await setFinance({ reminderChannels: ['SMS'] })).status).toBe(422);
  });

  it('new plans use the 10th and record it; existing plans keep their dates; reconciliation stays clean', async () => {
    const old = await makeStudent({});
    const p1 = await atomic((tx) => createFeePlan(tx, { studentId: old.id, courseId: old.courseId, installments: 2, startDate: '2027-05-17' }));
    const before = (await prisma.installment.findMany({ where: { feePlanId: p1.id }, orderBy: { seq: 'asc' } })).map((i) => [i.dueDate.toISOString(), i.feeMonth]);
    expect(before.map((b) => b[1])).toEqual(['2027-05', '2027-06']);

    const r = await setFinance({ dueDayOfMonth: 10 });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    invalidateSettings();
    expect(await prisma.auditLog.count({ where: { action: 'UPDATE', entity: 'setting', entityId: 'finance' } })).toBeGreaterThan(0);

    const st = await makeStudent({});
    const fin = await sessionFor('finmgr');
    const res = await request(app).post(`/api/v1/finance/students/${st.id}/fee-plan`).set(as(fin)).send({ installments: 3, startDate: '2027-05-17' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const plan = await prisma.feePlan.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(plan).toMatchObject({ dueAnchorDay: 10, dueTimeZone: TZ });
    const ins = await prisma.installment.findMany({ where: { feePlanId: plan.id }, orderBy: { seq: 'asc' } });
    expect(ins.map((i) => isoDate(toCalendarDate(i.dueDate, TZ)))).toEqual(['2027-06-10', '2027-07-10', '2027-08-10']);
    expect(ins.map((i) => i.feeMonth)).toEqual(['2027-06', '2027-07', '2027-08']);
    const inv = await prisma.invoice.findMany({ where: { feePlanId: plan.id } });
    expect(inv.every((v) => ins.find((i) => i.id === v.installmentId)!.dueDate.getTime() === v.dueDate!.getTime())).toBe(true);

    // The older plan is untouched.
    expect((await prisma.installment.findMany({ where: { feePlanId: p1.id }, orderBy: { seq: 'asc' } })).map((i) => [i.dueDate.toISOString(), i.feeMonth])).toEqual(before);
    expect((await reconcile({ studentId: st.id })).ok).toBe(true);
    expect((await reconcile({ studentId: old.id })).ok).toBe(true);
  });
});
