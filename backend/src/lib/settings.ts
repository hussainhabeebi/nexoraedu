import { prisma } from './prisma';

export const DEFAULT_SETTINGS = {
  academy: {
    name: 'Nexora Academy',
    tagline: 'Skills that shape tomorrow',
    email: 'info@nexoraed.com',
    phone: '+91 90000 00000',
    whatsapp: '+919000000000',
    address: 'Nexora Academy, Kerala, India',
    logoUrl: '',
    currency: 'INR',
    /** IANA time zone for business dates (due dates, overdue days, reminders, receipts). Decision P6 pending. */
    timeZone: 'Asia/Kolkata',
  },
  ids: { student: 'NXA-{YYYY}-#####', lead: 'LD-{YY}{MM}-#####', application: 'APP-{YYYY}-#####', invoice: 'INV-{YYYY}-######', receipt: 'RCP-{YYYY}-######', certificate: 'NXC-{YYYY}-#####' },
  /**
   * sessionTimeoutMin: sign out after this many idle minutes; 0 = never (owner decision 2026-11-11, default).
   * mfaRequired: ask privileged roles for an authenticator code at every sign-in (and make them enrol one).
   * Off by default (owner decision 2026-11-10); a Super Administrator can switch it on in Settings → Security.
   */
  security: { sessionTimeoutMin: 0, passwordMinLength: 10, maxFailedLogins: 5, lockMinutes: 15, activationHours: 72, mfaRequired: false },
  crm: { autoAssign: 'round_robin', inactivityDays: 3 },
  /**
   * dueDayOfMonth: every NEW fee plan's installments fall due on this day of each month (academy zone), the first
   *   one on the first such day on or after the plan's start date. null = legacy policy (admission/start day).
   *   Existing plans keep their stored due dates.
   * reminderDaysBefore: automatic reminders this many days before the due date (10th → 5th and 8th), plus the due day.
   * overdueEveryDays: overdue reminders from the day after the due date (11th), then every N days until paid.
   * remindGuardians: also remind the student's parents / guardians; reminderChannels: channels tried for each recipient.
   * reminderMaxAttempts: delivery attempts per reminder (failed ones are retried with back-off).
   * reminderDaysAfter: legacy setting, no longer used.
   */
  finance: {
    discountApprovalLimit: 5000, monthlyTarget: 1000000, dueDayOfMonth: 10 as number | null,
    reminderDaysBefore: [5, 2], reminderDaysAfter: [1, 7], overdueEveryDays: 7, overdueMaxDays: 120,
    remindGuardians: true, reminderChannels: ['IN_APP', 'WHATSAPP', 'EMAIL'] as string[], reminderMaxAttempts: 3,
  },
  academics: { attendanceThreshold: 75, attendanceEditWindowHours: 24 },
  exams: { minAttendanceForExam: 0, requireFeesCleared: false, gradeScale: [
    { min: 90, grade: 'A+' }, { min: 80, grade: 'A' }, { min: 70, grade: 'B+' }, { min: 60, grade: 'B' }, { min: 50, grade: 'C' }, { min: 40, grade: 'D' }, { min: 0, grade: 'F' },
  ] },
};
export type Settings = typeof DEFAULT_SETTINGS;

let cache: { at: number; v: Settings } | null = null;

export async function getSettings(): Promise<Settings> {
  if (cache && Date.now() - cache.at < 10_000) return cache.v;
  const rows = await prisma.setting.findMany({ where: { key: { in: Object.keys(DEFAULT_SETTINGS) } } });
  const v: any = structuredClone(DEFAULT_SETTINGS);
  for (const r of rows) v[r.key] = { ...v[r.key], ...(r.value as object) };
  cache = { at: Date.now(), v };
  return v;
}
export function invalidateSettings() {
  cache = null;
}
