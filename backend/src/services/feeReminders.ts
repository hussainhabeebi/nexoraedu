/**
 * Monthly fee reminders (FIN-08): students and their parents / guardians, by in-app message, WhatsApp and email.
 *
 * Schedule (academy calendar days, relative to each installment's due date; with the default due day of the 10th):
 *   BEFORE_5 (5th) · BEFORE_2 (8th) · DUE (10th) · OVERDUE_1 (11th) · OVERDUE_8, OVERDUE_15 … every 7 days until paid.
 *
 * Every reminder is one row in fee_reminders, unique per (installment, stage, channel, recipient): a second run,
 * an overlapping run, or a manual send on the same day can never send it again. Rows are a small queue:
 *   QUEUED → SENDING → SENT | SKIPPED (channel not configured / already paid) | FAILED (retried with back-off
 *   until reminderMaxAttempts, then left FAILED for staff to see and retry by hand).
 * Delivery is claimed with a compare-and-set on (status, attempts), so two workers never deliver the same row.
 */
import { prisma } from '../lib/prisma';
import { getSettings, type Settings } from '../lib/settings';
import { money } from '../lib/util';
import { dayDiff, formatDate, isoDate, toCalendarDate } from '../lib/caldate';
import { notify, type Channel } from './notify';
import { feeMonthLabel, installmentFeeMonth, OPEN_INSTALLMENT_STATUSES } from './finance';

const DAY = 864e5;
/** Back-off before the 2nd, 3rd, 4th … attempt. */
export const RETRY_BACKOFF_MS = [15 * 60_000, 60 * 60_000, 4 * 60 * 60_000, 12 * 60 * 60_000];
/** A row left in SENDING this long (worker stopped mid-delivery) is picked up again. */
const STALE_SENDING_MS = 10 * 60_000;
/** Automatic deliveries happen only during the day in the academy zone (09:00–20:00). */
export const QUIET_HOURS = { from: 9, until: 20 };
const INACTIVE_STUDENT = ['WITHDRAWN', 'TERMINATED', 'COMPLETED'];

export interface Stage { key: string; offset: number }

/** The reminder stages, ordered by day offset from the due date (negative = before). */
export function reminderStages(fin: Pick<Settings['finance'], 'reminderDaysBefore' | 'overdueEveryDays' | 'overdueMaxDays'>): Stage[] {
  const before = [...new Set(fin.reminderDaysBefore)].filter((d) => d > 0).sort((a, b) => b - a).map((d) => ({ key: `BEFORE_${d}`, offset: -d }));
  const overdue: Stage[] = [];
  for (let d = 1; d <= fin.overdueMaxDays; d += Math.max(1, fin.overdueEveryDays)) overdue.push({ key: `OVERDUE_${d}`, offset: d });
  return [...before, { key: 'DUE', offset: 0 }, ...overdue];
}

/**
 * The stage that is due today for an installment `diff` days from its due date (diff > 0 = overdue), or null.
 * Only the most recent stage is ever sent, so a missed day (cron outage) catches up once, never in a burst.
 */
export function currentStage(stages: Stage[], diff: number, everyDays = 7): Stage | null {
  let cur: Stage | null = null;
  for (const s of stages) if (s.offset <= diff) cur = s;
  if (!cur) return null;
  // After the last overdue stage (overdueMaxDays) has had its window, reminders stop.
  if (cur === stages[stages.length - 1] && cur.offset > 0 && diff - cur.offset >= everyDays) return null;
  return cur;
}

export const mask = (channel: string, a: string) =>
  channel === 'EMAIL' ? a.replace(/^(.)(.*)(@.*)$/, (_m, f, mid, d) => `${f}${'•'.repeat(Math.min(6, mid.length))}${d}`)
    : channel === 'WHATSAPP' ? `${'•'.repeat(Math.max(0, a.length - 4))}${a.slice(-4)}`
      : 'in-app';

type Candidate = { installmentId: string; studentId: string; stage: string; channel: Channel; recipientType: 'STUDENT' | 'GUARDIAN'; recipientRef: string; address: string };

/** Recipients and channels for one student: the student, then each guardian (skipping addresses already used). */
async function recipientsFor(studentIds: string[], fin: Settings['finance']) {
  const students = await prisma.student.findMany({ where: { id: { in: studentIds } }, include: { guardians: true } });
  const out = new Map<string, Omit<Candidate, 'installmentId' | 'stage'>[]>();
  const channels = fin.reminderChannels as Channel[];
  for (const st of students) {
    const list: Omit<Candidate, 'installmentId' | 'stage'>[] = [];
    const used = new Set<string>();
    const add = (recipientType: 'STUDENT' | 'GUARDIAN', recipientRef: string, ch: Channel, address: string | null | undefined) => {
      if (!address || !channels.includes(ch)) return;
      const k = `${ch}:${address.trim().toLowerCase()}`;
      if (used.has(k)) return; // e.g. a guardian sharing the student's phone gets one message, not two
      used.add(k);
      list.push({ studentId: st.id, channel: ch, recipientType, recipientRef, address: address.trim() });
    };
    add('STUDENT', st.id, 'IN_APP', st.userId);
    add('STUDENT', st.id, 'WHATSAPP', st.phone);
    add('STUDENT', st.id, 'EMAIL', st.email);
    if (fin.remindGuardians) {
      for (const g of st.guardians) {
        add('GUARDIAN', g.id, 'IN_APP', g.userId);
        add('GUARDIAN', g.id, 'WHATSAPP', g.phone);
        add('GUARDIAN', g.id, 'EMAIL', g.email);
      }
    }
    out.set(st.id, list);
  }
  return out;
}

/** Inserts reminder rows; an existing (installment, stage, channel, recipient) is left alone. */
async function enqueue(rows: Candidate[], trigger: 'AUTO' | 'MANUAL', sentById?: string) {
  let queued = 0;
  let duplicate = 0;
  if (!rows.length) return { queued, duplicate };
  const existing = await prisma.feeReminder.findMany({
    where: { installmentId: { in: [...new Set(rows.map((r) => r.installmentId))] }, stage: { in: [...new Set(rows.map((r) => r.stage))] } },
    select: { installmentId: true, stage: true, channel: true, recipientRef: true },
  });
  const seen = new Set(existing.map((e) => `${e.installmentId}|${e.stage}|${e.channel}|${e.recipientRef}`));
  const now = new Date();
  for (const r of rows) {
    const k = `${r.installmentId}|${r.stage}|${r.channel}|${r.recipientRef}`;
    if (seen.has(k)) {
      duplicate++;
      continue;
    }
    seen.add(k);
    try {
      await prisma.feeReminder.create({ data: { ...r, status: 'QUEUED', nextAttemptAt: now, trigger, sentById } });
      queued++;
    } catch (e: any) {
      if (isUniqueViolation(e)) duplicate++; // a concurrent run inserted it first
      else throw e;
    }
  }
  return { queued, duplicate };
}

const isUniqueViolation = (e: any) => e?.code === 'P2002' || /UNIQUE constraint failed/i.test(String(e?.message ?? e));

/** Automatic stage reminders for every open installment (idempotent; safe to run any number of times a day). */
export async function enqueueDueReminders(now = new Date()) {
  const s = await getSettings();
  const tz = s.academy.timeZone;
  const today = toCalendarDate(now, tz);
  const stages = reminderStages(s.finance);
  const maxBefore = Math.max(0, ...s.finance.reminderDaysBefore);
  const insts = await prisma.installment.findMany({
    where: { status: { in: OPEN_INSTALLMENT_STATUSES }, dueDate: { gte: new Date(now.getTime() - (s.finance.overdueMaxDays + 8) * DAY), lte: new Date(now.getTime() + (maxBefore + 1) * DAY) } },
    select: { id: true, dueDate: true, feePlan: { select: { student: { select: { id: true, status: true } } } } },
  });
  const due: { installmentId: string; studentId: string; stage: string }[] = [];
  for (const i of insts) {
    const st = i.feePlan.student;
    if (INACTIVE_STUDENT.includes(st.status)) continue;
    const stage = currentStage(stages, dayDiff(toCalendarDate(i.dueDate, tz), today), s.finance.overdueEveryDays);
    if (stage) due.push({ installmentId: i.id, studentId: st.id, stage: stage.key });
  }
  const recips = await recipientsFor([...new Set(due.map((d) => d.studentId))], s.finance);
  const rows = due.flatMap((d) => (recips.get(d.studentId) ?? []).map((r) => ({ ...r, installmentId: d.installmentId, stage: d.stage })));
  return enqueue(rows, 'AUTO');
}

/**
 * Manual reminders from finance staff, for the given students' open installments that are due within the
 * reminder window or overdue. At most one manual reminder per installment, recipient and channel per day.
 */
export async function enqueueManualReminders(studentIds: string[], userId: string, now = new Date()) {
  const s = await getSettings();
  const tz = s.academy.timeZone;
  const maxBefore = Math.max(0, ...s.finance.reminderDaysBefore);
  const stage = `MANUAL_${isoDate(toCalendarDate(now, tz))}`;
  const insts = await prisma.installment.findMany({
    where: { status: { in: OPEN_INSTALLMENT_STATUSES }, feePlan: { studentId: { in: studentIds } }, dueDate: { lte: new Date(now.getTime() + (maxBefore + 1) * DAY) } },
    select: { id: true, feePlan: { select: { studentId: true } } },
  });
  const recips = await recipientsFor(studentIds, s.finance);
  const rows = insts.flatMap((i) => (recips.get(i.feePlan.studentId) ?? []).map((r) => ({ ...r, installmentId: i.id, stage })));
  const res = await enqueue(rows, 'MANUAL', userId);
  const withInstallments = new Set(insts.map((i) => i.feePlan.studentId));
  return { ...res, studentsWithNothingDue: studentIds.filter((id) => !withInstallments.has(id)).length };
}

/** Delivers queued and retry-due reminders (up to `limit`). Returns counts by outcome. */
export async function processReminderQueue(opts: { limit?: number; now?: Date; ids?: string[] } = {}) {
  const now = opts.now ?? new Date();
  const s = await getSettings();
  const max = s.finance.reminderMaxAttempts;
  const rows = await prisma.feeReminder.findMany({
    where: {
      ...(opts.ids ? { id: { in: opts.ids } } : {}),
      OR: [
        { status: { in: ['QUEUED', 'FAILED'] }, nextAttemptAt: { lte: now }, attempts: { lt: max } },
        { status: 'SENDING', updatedAt: { lt: new Date(now.getTime() - STALE_SENDING_MS) }, attempts: { lt: max } },
      ],
    },
    orderBy: { nextAttemptAt: 'asc' },
    take: opts.limit ?? 50,
  });
  const out = { sent: 0, failed: 0, skipped: 0 };
  for (const r of rows) {
    const claimed = await prisma.feeReminder.updateMany({ where: { id: r.id, status: r.status, attempts: r.attempts }, data: { status: 'SENDING', attempts: r.attempts + 1 } });
    if (claimed.count !== 1) continue; // another worker has it
    const result = await deliver(r, s);
    const attempts = r.attempts + 1;
    if (result.status === 'SENT') {
      out.sent++;
      await prisma.feeReminder.update({ where: { id: r.id }, data: { status: 'SENT', sentAt: new Date(), lastError: null, nextAttemptAt: null } });
      await prisma.installment.update({ where: { id: r.installmentId }, data: { lastReminderAt: new Date() } });
    } else if (result.status === 'FAILED') {
      out.failed++;
      const retry = attempts < max ? new Date(now.getTime() + RETRY_BACKOFF_MS[Math.min(attempts - 1, RETRY_BACKOFF_MS.length - 1)]) : null;
      await prisma.feeReminder.update({ where: { id: r.id }, data: { status: 'FAILED', lastError: result.error ?? 'Delivery failed', nextAttemptAt: retry } });
    } else {
      out.skipped++;
      await prisma.feeReminder.update({ where: { id: r.id }, data: { status: 'SKIPPED', lastError: result.error ?? null, nextAttemptAt: null } });
    }
  }
  return out;
}

async function deliver(r: { installmentId: string; studentId: string; stage: string; channel: string; recipientType: string; recipientRef: string; address: string }, s: Settings) {
  const tz = s.academy.timeZone;
  const inst = await prisma.installment.findUnique({ where: { id: r.installmentId }, include: { feePlan: { include: { student: { include: { lead: true } } } } } });
  if (!inst || !OPEN_INSTALLMENT_STATUSES.includes(inst.status)) return { status: 'SKIPPED' as const, error: 'Installment already paid' };
  const st = inst.feePlan.student;
  if (INACTIVE_STUDENT.includes(st.status)) return { status: 'SKIPPED' as const, error: `Student is ${st.status.toLowerCase()}` };
  const diff = dayDiff(toCalendarDate(inst.dueDate, tz), toCalendarDate(new Date(), tz));
  const guardian = r.recipientType === 'GUARDIAN' ? await prisma.guardian.findUnique({ where: { id: r.recipientRef } }) : null;
  if (r.recipientType === 'GUARDIAN' && !guardian) return { status: 'SKIPPED' as const, error: 'Guardian record removed' };
  const overdue = diff > 0;
  const key = `fee.reminder_${overdue ? 'overdue' : 'upcoming'}${guardian ? '_guardian' : ''}`;
  const ch = r.channel as Channel;
  const to = { name: guardian?.name ?? st.fullName, userId: ch === 'IN_APP' ? r.address : null, email: ch === 'EMAIL' ? r.address : null, phone: ch === 'WHATSAPP' ? r.address : null, conversationId: !guardian && ch === 'WHATSAPP' ? st.lead?.chatwootConversationId : null };
  const vars = {
    name: guardian?.name ?? st.fullName, student: st.fullName, amount: money(Number(inst.amount) - Number(inst.paidAmount)).toFixed(2),
    dueDate: formatDate(inst.dueDate, tz), installment: inst.seq, days: Math.abs(diff), feeMonth: feeMonthLabel(installmentFeeMonth(inst, tz)),
  };
  try {
    const res = await notify(key, to, vars, { channels: [ch], link: guardian ? '/parent' : '/portal/fees' });
    const one = res[ch];
    if (!one) return { status: 'SKIPPED' as const, error: 'Template inactive or channel not enabled for it' };
    if (one.status === 'NO_ADDRESS') return { status: 'SKIPPED' as const, error: 'No address on this channel' };
    return one;
  } catch (e: any) {
    return { status: 'FAILED' as const, error: String(e?.message || e).slice(0, 300) };
  }
}

/** Is it daytime in the academy zone (automatic deliveries only)? */
export function withinSendingHours(now: Date, tz: string) {
  const h = Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', hour: '2-digit' }).format(now));
  return h >= QUIET_HOURS.from && h < QUIET_HOURS.until;
}

/** Scheduled entry point: queue today's stage reminders, then deliver a bounded batch (daytime only). */
export async function runFeeReminders(opts: { now?: Date; limit?: number; ignoreHours?: boolean } = {}) {
  const now = opts.now ?? new Date();
  const s = await getSettings();
  if (!opts.ignoreHours && !withinSendingHours(now, s.academy.timeZone)) return { queued: 0, duplicate: 0, sent: 0, failed: 0, skipped: 0 };
  const q = await enqueueDueReminders(now);
  const d = await processReminderQueue({ now, limit: opts.limit ?? 50 });
  return { ...q, ...d };
}
