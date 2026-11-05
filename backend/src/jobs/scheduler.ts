/** Workflow automation (SRS §5.7): fee reminders, follow-up reminders, inactivity alerts, exam auto-submit. */
import { prisma } from '../lib/prisma';
import { getSettings } from '../lib/settings';
import { money } from '../lib/util';
import { dayDiff, formatDate, toCalendarDate, zonedTimeToUtc } from '../lib/caldate';
import { notify, notifyRole, notifyUser } from '../services/notify';
import { finalizeAttempt } from '../routes/portal';

const DAY = 864e5;

/** FIN-08: reminders N days before / after due date (once per day per installment). */
export async function runFeeReminders(force = false) {
  const s = await getSettings();
  // Reminder offsets are whole CALENDAR days in the academy zone (not server-local hours).
  const tz = s.academy.timeZone;
  const todayCal = toCalendarDate(new Date(), tz);
  const today = zonedTimeToUtc(todayCal, tz); // start of today in the academy zone (once-per-day guard)
  const offsets = [...s.finance.reminderDaysBefore.map((d) => -d), 0, ...s.finance.reminderDaysAfter];
  const insts = await prisma.installment.findMany({
    where: { status: { not: 'PAID' }, dueDate: { gte: new Date(today.getTime() - 120 * DAY), lte: new Date(today.getTime() + 30 * DAY) }, ...(force ? {} : { OR: [{ lastReminderAt: null }, { lastReminderAt: { lt: today } }] }) },
    include: { feePlan: { include: { student: { include: { lead: true } } } } },
  });
  let sent = 0;
  for (const i of insts) {
    const st = i.feePlan.student;
    if (['WITHDRAWN', 'TERMINATED', 'COMPLETED'].includes(st.status)) continue;
    const diff = dayDiff(toCalendarDate(i.dueDate, tz), todayCal); // >0 overdue, <0 upcoming
    if (!force && !offsets.includes(diff)) continue;
    if (force && diff < -Math.max(...s.finance.reminderDaysBefore, 0)) continue;
    const key = diff <= 0 ? 'fee.reminder_upcoming' : 'fee.reminder_overdue'; // due today is not yet overdue
    await notify(key, { userId: st.userId, name: st.fullName, email: st.email, phone: st.phone, conversationId: st.lead?.chatwootConversationId }, {
      name: st.fullName, amount: money(Number(i.amount) - Number(i.paidAmount)).toFixed(2), dueDate: formatDate(i.dueDate, tz), installment: i.seq, days: Math.abs(diff),
    });
    await prisma.installment.update({ where: { id: i.id }, data: { lastReminderAt: new Date() } });
    sent++;
  }
  return sent;
}

/** CRM-08 reminders for due follow-ups (15 min ahead) + CRM-09 inactivity alert to Sales Manager. */
export async function runCrmReminders() {
  const soon = new Date(Date.now() + 15 * 60_000);
  const due = await prisma.followUp.findMany({ where: { status: 'PENDING', reminded: false, dueAt: { lte: soon } }, include: { lead: { select: { id: true, name: true, phone: true } } } });
  for (const f of due) {
    await notifyUser(f.userId, `Follow-up due: ${f.lead.name}`, `${f.mode} ${f.lead.phone} at ${f.dueAt.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}${f.note ? ` — ${f.note}` : ''}`, `/staff/leads/${f.lead.id}`);
    await prisma.followUp.update({ where: { id: f.id }, data: { reminded: true } });
  }
  const s = await getSettings();
  const stale = await prisma.lead.count({ where: { status: { in: ['NEW', 'CONTACTED', 'INTERESTED', 'COUNSELLED'] }, lastActivityAt: { lt: new Date(Date.now() - s.crm.inactivityDays * DAY) } } });
  return { reminders: due.length, stale };
}

export async function runDailyDigest() {
  const s = await getSettings();
  const stale = await prisma.lead.findMany({ where: { status: { in: ['NEW', 'CONTACTED', 'INTERESTED', 'COUNSELLED'] }, lastActivityAt: { lt: new Date(Date.now() - s.crm.inactivityDays * DAY) } }, select: { id: true } });
  if (stale.length) await notifyRole('sales_manager', 'Inactive leads', `${stale.length} lead(s) have had no activity for ${s.crm.inactivityDays}+ days.`, '/staff/leads?inactive=1');
  // ACD-14 at-risk students → Academic Manager
  const low = await prisma.$queryRaw<{ c: bigint }[]>`
    SELECT COUNT(*) c FROM (SELECT a."studentId" FROM attendance a GROUP BY 1 HAVING COUNT(*) >= 3 AND 100.0 * SUM(CASE WHEN a.status IN ('PRESENT','LATE') THEN 1 ELSE 0 END) / COUNT(*) < ${s.academics.attendanceThreshold}) x`;
  if (Number(low[0]?.c ?? 0) > 0) await notifyRole('academic_manager', 'At-risk students', `${low[0].c} student(s) are below ${s.academics.attendanceThreshold}% attendance.`, '/staff/dashboard');
}

/** EXM-09 auto-submit on timeout. */
export async function runExamSweeper() {
  const open = await prisma.examAttempt.findMany({ where: { status: 'IN_PROGRESS' }, include: { exam: true } });
  let n = 0;
  for (const a of open) {
    const dl = Math.min(a.startedAt.getTime() + a.exam.durationMin * 60_000, a.exam.endAt.getTime());
    if (Date.now() > dl + 30_000) {
      await finalizeAttempt(a.id);
      n++;
    }
  }
  return n;
}

let started = false;
export function startScheduler() {
  if (started) return;
  started = true;
  const safe = (name: string, fn: () => Promise<unknown>) => () => fn().catch((e) => console.error(`[job ${name}]`, e));
  setInterval(safe('crm', runCrmReminders), 5 * 60_000);
  setInterval(safe('exam', runExamSweeper), 60_000);
  let lastDaily = '';
  setInterval(safe('daily', async () => {
    const now = new Date();
    const key = now.toDateString();
    if (now.getHours() >= 9 && lastDaily !== key) {
      lastDaily = key;
      await runFeeReminders();
      await runDailyDigest();
    }
  }), 10 * 60_000);
  console.log('[scheduler] started');
}
