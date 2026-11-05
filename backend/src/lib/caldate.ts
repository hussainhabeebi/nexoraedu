/**
 * Calendar dates in the academy time zone (DB-08: timestamps stored in UTC, academy time zone applied for
 * business dates and display). No external dependency — uses the platform's IANA time-zone database (Intl).
 *
 * A CalendarDate is a plain {y, m, d} (m = 1–12). Business rules (installment due dates, overdue days,
 * reminder offsets) are computed on calendar dates, never on server-local clock time.
 */
export interface CalendarDate { y: number; m: number; d: number }

export const DEFAULT_ACADEMY_TZ = 'Asia/Kolkata';

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(0);
    return true;
  } catch {
    return false;
  }
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    fmtCache.set(tz, f);
  }
  return f;
}

/** Wall-clock parts of an instant in a time zone. */
function wallParts(ms: number, tz: string) {
  const p = Object.fromEntries(fmt(tz).formatToParts(new Date(ms)).filter((x) => x.type !== 'literal').map((x) => [x.type, Number(x.value)]));
  return { y: p.year, m: p.month, d: p.day, h: p.hour === 24 ? 0 : p.hour, mi: p.minute, s: p.second };
}

/** Offset (ms) of the zone at an instant: local wall clock minus UTC. */
function offsetAt(ms: number, tz: string) {
  const w = wallParts(ms, tz);
  return Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s) - Math.floor(ms / 1000) * 1000;
}

/** The calendar date an instant falls on in the zone. */
export function toCalendarDate(instant: Date | number, tz: string): CalendarDate {
  const w = wallParts(typeof instant === 'number' ? instant : instant.getTime(), tz);
  return { y: w.y, m: w.m, d: w.d };
}

/** UTC instant of a wall-clock time in the zone (handles DST: re-checks the offset at the result). */
export function zonedTimeToUtc(c: CalendarDate, tz: string, h = 0, mi = 0, s = 0, ms = 0): Date {
  const guess = Date.UTC(c.y, c.m - 1, c.d, h, mi, s, ms);
  let t = guess - offsetAt(guess, tz);
  const o2 = offsetAt(t, tz);
  if (guess - o2 !== t) t = guess - o2;
  return new Date(t);
}

export const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/**
 * MONTH-END POLICY ("anchor day, clamped"): installment n falls on the anchor day-of-month of month (start + n).
 * If that month is shorter, it falls on the month's LAST day — the anchor is kept for later months
 * (31 Jan → 28/29 Feb → 31 Mar → 30 Apr → 31 May). It never rolls over into the next month.
 */
export function addMonthsClamped(c: CalendarDate, months: number, anchorDay = c.d): CalendarDate {
  const idx = c.y * 12 + (c.m - 1) + months;
  const y = Math.floor(idx / 12);
  const m = (idx % 12) + 1;
  return { y, m, d: Math.min(anchorDay, daysInMonth(y, m)) };
}

/** A due date is the END of its calendar day in the academy zone (payable until 23:59:59.999 local time). */
export const endOfDayUtc = (c: CalendarDate, tz: string) => zonedTimeToUtc(c, tz, 23, 59, 59, 999);

export const isoDate = (c: CalendarDate) => `${c.y}-${String(c.m).padStart(2, '0')}-${String(c.d).padStart(2, '0')}`;
export function parseIsoDate(s: string): CalendarDate | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const c = { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
  return c.m >= 1 && c.m <= 12 && c.d >= 1 && c.d <= daysInMonth(c.y, c.m) ? c : null;
}

/** Whole calendar days from a to b (b − a). */
export const dayDiff = (a: CalendarDate, b: CalendarDate) => Math.round((Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / 864e5);

/** Human date in the academy zone, e.g. "28 Feb 2027" (for messages and PDFs). */
export const formatDate = (instant: Date, tz: string) => instant.toLocaleDateString('en-IN', { timeZone: tz, day: '2-digit', month: 'short', year: 'numeric' });
