import type { Prisma } from '@prisma/client';
import { prisma } from './prisma';
import { getSettings } from './settings';
import { toCalendarDate } from './caldate';

type Tx = Prisma.TransactionClient;

/**
 * Gap-safe, never-reused sequential numbers (STU-06, FIN-04, FIN-06) using an atomic UPSERT.
 * Format tokens: {YYYY} {YY} {MM} and #### (zero-padded counter width).
 */
export async function nextNumber(name: string, format: string, tx: Tx = prisma, at?: { y: number; m: number }): Promise<string> {
  // Year/month tokens AND the yearly counter key follow the academy calendar, not the server clock (DB-08):
  // otherwise numbers issued around midnight on 31 December could repeat. Key format "receipt:2026" is unchanged.
  const when = at ?? toCalendarDate(new Date(), (await getSettings()).academy.timeZone);
  name = name.replace('{year}', String(when.y));
  const rows = await tx.$queryRaw<{ next: number }[]>`
    INSERT INTO sequences (name, prefix, next) VALUES (${name}, '', 2)
    ON CONFLICT (name) DO UPDATE SET next = sequences.next + 1
    RETURNING next - 1 AS next`;
  const n = Number(rows[0].next);
  return format
    .replace('{YYYY}', String(when.y))
    .replace('{YY}', String(when.y).slice(2))
    .replace('{MM}', String(when.m).padStart(2, '0'))
    .replace(/#+/, (m) => String(n).padStart(m.length, '0'));
}
