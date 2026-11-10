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
   * mfaRequired: ask privileged roles for an authenticator code at every sign-in (and make them enrol one).
   * Off by default (owner decision 2026-11-10); a Super Administrator can switch it on in Settings → Security.
   */
  security: { sessionTimeoutMin: 30, passwordMinLength: 10, maxFailedLogins: 5, lockMinutes: 15, activationHours: 72, mfaRequired: false },
  crm: { autoAssign: 'round_robin', inactivityDays: 3 },
  finance: { discountApprovalLimit: 5000, reminderDaysBefore: [3, 1], reminderDaysAfter: [1, 7], monthlyTarget: 1000000 },
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
