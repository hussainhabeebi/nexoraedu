/**
 * Monthly fee reminders (services/feeReminders.ts): stages (5th, 8th, 10th, 11th, then weekly), students and
 * guardians, at-most-once delivery, failure and retry with back-off, manual / bulk sends, history and access.
 * WhatsApp goes to a stubbed Chatwoot (no request leaves the machine). Synthetic data only.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { app, as, makeStudent, makeUser, prisma, sessionFor } from './helpers';
import { isoDate, parseIsoDate, toCalendarDate } from '../src/lib/caldate';
import { atomic } from '../src/lib/db';
import { createFeePlan } from '../src/services/finance';
import { currentStage, enqueueDueReminders, mask, processReminderQueue, reminderStages, RETRY_BACKOFF_MS, withinSendingHours } from '../src/services/feeReminders';
import { DEFAULT_SETTINGS } from '../src/lib/settings';

const TZ = 'Asia/Kolkata';
const realFetch = globalThis.fetch;
let waFail = false;
let waSent = 0;
const reply = (json: unknown, status = 200) => new Response(JSON.stringify(json), { status, headers: { 'Content-Type': 'application/json' } });

let fin: string, staff: string, staffId: string;
beforeAll(async () => {
  vi.stubGlobal('fetch', async (url: string, init: any) => {
    if (!String(url).startsWith('https://chatwoot.test/')) return realFetch(url, init);
    if (waFail) return reply({ error: 'gateway down' }, 500);
    const p = new URL(String(url)).pathname.replace('/api/v1/accounts/7', '');
    if (p === '/contacts/search') return reply({ payload: [] });
    if (p === '/contacts') return reply({ payload: { contact: { id: 501, contact_inboxes: [] } } });
    if (/^\/contacts\/\d+\/contact_inboxes$/.test(p)) return reply({ source_id: 'src-1' });
    if (/^\/contacts\/\d+\/conversations$/.test(p)) return reply({ payload: [] });
    if (p === '/conversations') return reply({ id: 9001 });
    if (/^\/conversations\/\d+\/messages$/.test(p)) {
      waSent++;
      return reply({ id: 7000 + waSent });
    }
    return reply({});
  });
  const sa = await sessionFor((await makeUser(['super_admin'])).username);
  const r = await request(app).put('/api/v1/whatsapp/config').set(as(sa)).send({ enabled: true, baseUrl: 'https://chatwoot.test', accountId: '7', inboxId: '3', apiToken: 'cw-test-token-000000', webhookSecret: 'hook-test-secret-0000' });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  fin = await sessionFor('finmgr');
  staffId = (await prisma.user.findUniqueOrThrow({ where: { username: 'accounts' } })).id;
  staff = await sessionFor('accounts');
});
afterAll(async () => {
  vi.unstubAllGlobals();
  await prisma.setting.deleteMany({ where: { key: 'integration.chatwoot' } });
});

const today = () => toCalendarDate(new Date(), TZ);
const daysFromToday = (n: number) => {
  const t = today();
  const d = new Date(Date.UTC(t.y, t.m - 1, t.d) + n * 864e5);
  return isoDate({ y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() });
};
/** A student with one installment due `offset` days from today (negative = already overdue) and a guardian. */
async function studentDue(offset: number, opts: { guardianPhone?: string; ownerId?: string } = {}) {
  const st = await makeStudent({});
  if (opts.ownerId) await prisma.student.update({ where: { id: st.id }, data: { financeOwnerId: opts.ownerId } });
  const n = st.phone.slice(-9);
  const g = await prisma.guardian.create({ data: { studentId: st.id, name: `Parent ${n}`, relation: 'Mother', phone: opts.guardianPhone ?? `+918${n}`, email: `p${n}@example.invalid` } });
  await atomic((tx) => createFeePlan(tx, { studentId: st.id, courseId: st.courseId, installments: 1, startDate: daysFromToday(offset) }));
  const inst = await prisma.installment.findFirstOrThrow({ where: { feePlan: { studentId: st.id } } });
  return { st, g, inst };
}
const rowsOf = (studentId: string) => prisma.feeReminder.findMany({ where: { studentId }, orderBy: [{ channel: 'asc' }, { recipientType: 'asc' }] });

describe('schedule (pure)', () => {
  const stages = reminderStages(DEFAULT_SETTINGS.finance);
  const at = (due: string, day: string) => currentStage(stages, Math.round((Date.parse(day) - Date.parse(due)) / 864e5), 7)?.key ?? null;

  it('due on the 10th: reminders on the 5th, 8th and 10th, overdue from the 11th and then every 7 days', () => {
    expect(stages.slice(0, 6).map((s) => s.key)).toEqual(['BEFORE_5', 'BEFORE_2', 'DUE', 'OVERDUE_1', 'OVERDUE_8', 'OVERDUE_15']);
    const due = '2027-12-10';
    expect(at(due, '2027-12-04')).toBeNull();
    expect(at(due, '2027-12-05')).toBe('BEFORE_5');
    expect(at(due, '2027-12-06')).toBe('BEFORE_5'); // a missed day catches up once (same stage, not re-sent)
    expect(at(due, '2027-12-08')).toBe('BEFORE_2');
    expect(at(due, '2027-12-10')).toBe('DUE');
    expect(at(due, '2027-12-11')).toBe('OVERDUE_1');
    expect(at(due, '2027-12-17')).toBe('OVERDUE_1');
    expect(at(due, '2027-12-18')).toBe('OVERDUE_8');
    expect(at(due, '2028-01-01')).toBe('OVERDUE_22');
  });

  it('stops after overdueMaxDays', () => {
    const last = stages[stages.length - 1];
    expect(last.offset).toBeLessThanOrEqual(DEFAULT_SETTINGS.finance.overdueMaxDays);
    expect(currentStage(stages, last.offset + 6, 7)?.key).toBe(last.key);
    expect(currentStage(stages, last.offset + 7, 7)).toBeNull();
  });

  it('automatic sends only in the daytime in the academy zone; addresses are masked for display', () => {
    expect(withinSendingHours(new Date('2027-12-05T03:29:00Z'), TZ)).toBe(false); // 08:59 IST
    expect(withinSendingHours(new Date('2027-12-05T03:30:00Z'), TZ)).toBe(true); // 09:00 IST
    expect(withinSendingHours(new Date('2027-12-05T14:30:00Z'), TZ)).toBe(false); // 20:00 IST
    expect(mask('EMAIL', 'parent@example.invalid')).toBe('p•••••@example.invalid');
    expect(mask('WHATSAPP', '+919876543210')).toBe('•••••••••3210');
    expect(parseIsoDate('2027-12-10')).toBeTruthy();
  });
});

describe('automatic reminders in the database', () => {
  it('reach the student and the guardian on each channel, with the right template, exactly once', async () => {
    const { st, g } = await studentDue(-1); // due yesterday → OVERDUE_1
    await enqueueDueReminders();
    let rows = await rowsOf(st.id);
    expect(rows.map((r) => `${r.recipientType}:${r.channel}:${r.stage}`).sort()).toEqual([
      'GUARDIAN:EMAIL:OVERDUE_1', 'GUARDIAN:WHATSAPP:OVERDUE_1', 'STUDENT:EMAIL:OVERDUE_1', 'STUDENT:WHATSAPP:OVERDUE_1',
    ]);
    await processReminderQueue({ ids: rows.map((r) => r.id) });
    rows = await rowsOf(st.id);
    expect(rows.find((r) => r.channel === 'WHATSAPP' && r.recipientType === 'GUARDIAN')!.status).toBe('SENT');
    expect(rows.find((r) => r.channel === 'EMAIL')!.status).toBe('SKIPPED'); // SMTP not configured: not retried
    const log = await prisma.notificationLog.findFirstOrThrow({ where: { recipient: g.email!, templateKey: 'fee.reminder_overdue_guardian' } });
    expect(log.body).toContain(st.fullName);
    expect(log.body).toContain('1 day(s) overdue');

    // Running again (cron overlap, retry, manual run) sends nothing new.
    await enqueueDueReminders();
    await enqueueDueReminders();
    await processReminderQueue({ ids: rows.map((r) => r.id) });
    expect(await prisma.feeReminder.count({ where: { studentId: st.id } })).toBe(4);
    expect(await prisma.notificationLog.count({ where: { recipient: g.email! } })).toBe(1);
  });

  it('due today uses the upcoming template; a guardian sharing the student\'s phone gets one WhatsApp, not two', async () => {
    const st0 = await makeStudent({});
    const { st } = await studentDue(0, { guardianPhone: undefined });
    await prisma.guardian.create({ data: { studentId: st.id, name: 'Same Phone', relation: 'Father', phone: st.phone } });
    await enqueueDueReminders();
    const rows = await rowsOf(st.id);
    expect(rows.every((r) => r.stage === 'DUE')).toBe(true);
    expect(rows.filter((r) => r.channel === 'WHATSAPP')).toHaveLength(2); // student + the guardian with its own phone
    await processReminderQueue({ ids: rows.map((r) => r.id) });
    expect(await prisma.notificationLog.count({ where: { recipient: st.phone, templateKey: 'fee.reminder_upcoming' } })).toBe(1);
    expect(st0.id).toBeTruthy();
  });

  it('withdrawn students and paid installments get nothing', async () => {
    const a = await studentDue(-1);
    await prisma.student.update({ where: { id: a.st.id }, data: { status: 'WITHDRAWN' } });
    const b = await studentDue(-1);
    await request(app).post('/api/v1/finance/payments').set(as(fin)).set('Idempotency-Key', `pay-${b.st.id}`).send({ studentId: b.st.id, amount: Number(b.inst.amount), mode: 'CASH' }).expect(201);
    await enqueueDueReminders();
    expect(await prisma.feeReminder.count({ where: { studentId: { in: [a.st.id, b.st.id] } } })).toBe(0);
  });
});

describe('failure and retry', () => {
  it('a failed WhatsApp is retried with back-off, then succeeds; other channels are unaffected', async () => {
    const { st } = await studentDue(-1);
    await enqueueDueReminders();
    const wa = (await rowsOf(st.id)).filter((r) => r.channel === 'WHATSAPP');
    waFail = true;
    try {
      const t0 = new Date();
      await processReminderQueue({ ids: wa.map((r) => r.id), now: t0 });
      const failed = await prisma.feeReminder.findMany({ where: { id: { in: wa.map((r) => r.id) } } });
      for (const f of failed) {
        expect(f.status).toBe('FAILED');
        expect(f.attempts).toBe(1);
        expect(f.lastError).toBeTruthy();
        expect(f.nextAttemptAt!.getTime() - t0.getTime()).toBe(RETRY_BACKOFF_MS[0]);
      }
      // Not yet due for retry: nothing happens.
      expect((await processReminderQueue({ ids: wa.map((r) => r.id), now: new Date(t0.getTime() + 60_000) })).sent).toBe(0);
    } finally {
      waFail = false;
    }
    const later = new Date(Date.now() + RETRY_BACKOFF_MS[0] + 1000);
    const d = await processReminderQueue({ ids: wa.map((r) => r.id), now: later });
    expect(d.sent).toBe(wa.length);
    const done = await prisma.feeReminder.findMany({ where: { id: { in: wa.map((r) => r.id) } } });
    expect(done.every((r) => r.status === 'SENT' && r.attempts === 2 && r.sentAt && r.lastError === null)).toBe(true);
  });

  it('gives up after the maximum attempts; staff can retry by hand (audited); a paid installment is skipped', async () => {
    const { st, inst } = await studentDue(-1);
    await enqueueDueReminders();
    const wa = (await rowsOf(st.id)).find((r) => r.channel === 'WHATSAPP' && r.recipientType === 'STUDENT')!;
    waFail = true;
    let now = Date.now();
    try {
      for (let i = 0; i < DEFAULT_SETTINGS.finance.reminderMaxAttempts; i++) {
        await processReminderQueue({ ids: [wa.id], now: new Date(now) });
        now += 13 * 3600_000;
      }
    } finally {
      waFail = false;
    }
    const gaveUp = await prisma.feeReminder.findUniqueOrThrow({ where: { id: wa.id } });
    expect(gaveUp).toMatchObject({ status: 'FAILED', attempts: DEFAULT_SETTINGS.finance.reminderMaxAttempts, nextAttemptAt: null });
    expect((await processReminderQueue({ ids: [wa.id], now: new Date(now + 864e5) })).failed).toBe(0); // no more automatic attempts

    const r = await request(app).post(`/api/v1/finance/reminders/${wa.id}/retry`).set(as(fin));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.reminder.status).toBe('SENT');
    expect(await prisma.auditLog.count({ where: { action: 'REMINDER_RETRY', entityId: wa.id } })).toBe(1);
    expect((await request(app).post(`/api/v1/finance/reminders/${wa.id}/retry`).set(as(fin))).status).toBe(400); // already sent

    // A queued reminder whose installment is paid before delivery is skipped, not sent.
    const other = (await rowsOf(st.id)).find((x) => x.channel === 'WHATSAPP' && x.recipientType === 'GUARDIAN')!;
    await prisma.feeReminder.update({ where: { id: other.id }, data: { status: 'FAILED', nextAttemptAt: new Date(0), attempts: 1 } });
    await request(app).post('/api/v1/finance/payments').set(as(fin)).set('Idempotency-Key', `pay2-${st.id}`).send({ studentId: st.id, amount: Number(inst.amount), mode: 'UPI', reference: `UPI-${st.id}` }).expect(201);
    await processReminderQueue({ ids: [other.id] });
    expect(await prisma.feeReminder.findUniqueOrThrow({ where: { id: other.id } })).toMatchObject({ status: 'SKIPPED', lastError: 'Installment already paid' });
  });

  it('two workers processing the same queue deliver each reminder once', async () => {
    const { st } = await studentDue(-1);
    await enqueueDueReminders();
    const ids = (await rowsOf(st.id)).filter((r) => r.channel === 'WHATSAPP').map((r) => r.id);
    const before = waSent;
    const [a, b] = await Promise.all([processReminderQueue({ ids }), processReminderQueue({ ids })]);
    expect(a.sent + b.sent).toBe(ids.length);
    expect(waSent - before).toBe(ids.length);
  });
});

describe('manual and bulk reminders, history and access', () => {
  it('Finance Staff: only students assigned to them; once per day; Finance Manager: any student', async () => {
    const mine = await studentDue(-3, { ownerId: staffId });
    const notMine = await studentDue(-3);
    expect((await request(app).post('/api/v1/finance/reminders/send').set(as(staff)).send({ studentIds: [notMine.st.id] })).status).toBe(403);
    expect((await request(app).post('/api/v1/finance/reminders/send').set(as(staff)).send({ studentIds: [mine.st.id, notMine.st.id] })).status).toBe(403);
    const r = await request(app).post('/api/v1/finance/reminders/send').set(as(staff)).send({ studentIds: [mine.st.id] });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ students: 1, queued: 4, duplicate: 0 });
    expect(r.body.sent).toBeGreaterThan(0);
    const again = await request(app).post('/api/v1/finance/reminders/send').set(as(staff)).send({ studentIds: [mine.st.id] });
    expect(again.body).toMatchObject({ queued: 0, duplicate: 4 }); // already reminded today
    const manual = await prisma.feeReminder.findMany({ where: { studentId: mine.st.id, trigger: 'MANUAL' } });
    expect(manual).toHaveLength(4);
    expect(manual.every((m) => m.sentById === staffId && m.stage.startsWith('MANUAL_'))).toBe(true);
    expect((await request(app).post('/api/v1/finance/reminders/send').set(as(fin)).send({ studentIds: [notMine.st.id] })).status).toBe(200);
    expect(await prisma.auditLog.count({ where: { action: 'REMINDER_SEND', userId: staffId } })).toBeGreaterThanOrEqual(2);
  });

  it('bulk "all overdue" covers only the sender\'s scope', async () => {
    const mine = await studentDue(-2, { ownerId: staffId });
    const notMine = await studentDue(-2);
    const upcoming = await studentDue(3, { ownerId: staffId }); // not overdue
    const r = await request(app).post('/api/v1/finance/reminders/send').set(as(staff)).send({ overdueOnly: true });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await prisma.feeReminder.count({ where: { studentId: mine.st.id, trigger: 'MANUAL' } })).toBe(4);
    expect(await prisma.feeReminder.count({ where: { studentId: notMine.st.id, trigger: 'MANUAL' } })).toBe(0);
    expect(await prisma.feeReminder.count({ where: { studentId: upcoming.st.id, trigger: 'MANUAL' } })).toBe(0);
    expect((await request(app).post('/api/v1/finance/reminders/send').set(as(staff)).send({})).status).toBe(422);
  });

  it('history shows delivery status with masked addresses; students and other staff cannot read it; run-all is manager-only', async () => {
    const { st, g } = await studentDue(-1);
    await enqueueDueReminders();
    await processReminderQueue({ ids: (await rowsOf(st.id)).map((r) => r.id) });
    const h = await request(app).get(`/api/v1/finance/reminders?studentId=${st.id}`).set(as(staff));
    expect(h.status).toBe(200);
    expect(h.body.total).toBe(4);
    const text = JSON.stringify(h.body);
    for (const secret of [st.phone, st.email, g.phone, g.email!]) expect(text).not.toContain(secret);
    expect(h.body.items[0]).toMatchObject({ student: { id: st.id }, installment: { seq: 1 } });
    expect(h.body.items.map((i: any) => i.status).sort()).toEqual(['SENT', 'SENT', 'SKIPPED', 'SKIPPED']);
    const counselor = await sessionFor('counselor1');
    expect((await request(app).get('/api/v1/finance/reminders').set(as(counselor))).status).toBe(403);
    expect((await request(app).post('/api/v1/finance/reminders/send').set(as(counselor)).send({ overdueOnly: true })).status).toBe(403);
    expect((await request(app).post('/api/v1/finance/reminders/run').set(as(staff))).status).toBe(403);
    expect((await request(app).get('/api/v1/finance/reminders')).status).toBe(401);
  });
});
