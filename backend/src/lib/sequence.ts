import { getSettings } from './settings';
import { toCalendarDate } from './caldate';
import { atomic, conflictMarker, type Tx } from './db';


/** Numbers already claimed by an atomic() batch, so two claims in one batch never get the same number. */
const claimed = new WeakMap<Tx, Map<string, number>>();

/**
 * Gap-free, never-reused sequential numbers (STU-06, FIN-04, FIN-06).
 * The number is claimed INSIDE the caller's atomic batch: if another batch takes the same number first, the
 * commit fails and atomic() re-runs the whole operation with the next number. A rolled-back batch uses no number.
 * Format tokens: {YYYY} {YY} {MM} and #### (zero-padded counter width).
 */
export async function nextNumber(name: string, format: string, tx?: Tx, at?: { y: number; m: number }): Promise<string> {
  if (!tx || typeof (tx as any).assert !== 'function') return atomic((t) => nextNumber(name, format, t, at));
  // Year/month tokens AND the yearly counter key follow the academy calendar, not the server clock (DB-08):
  // otherwise numbers issued around midnight on 31 December could repeat. Key format "receipt:2026" is unchanged.
  const when = at ?? toCalendarDate(new Date(), (await getSettings()).academy.timeZone);
  name = name.replace('{year}', String(when.y));
  let mine = claimed.get(tx);
  if (!mine) claimed.set(tx, (mine = new Map()));
  let n = mine.get(name);
  if (n === undefined) {
    const row = await tx.sequence.findUnique({ where: { name } });
    n = row?.next ?? 1;
    tx.assert(`coalesce((SELECT "next" FROM "sequences" WHERE "name" = ?), 1) = ?`, [name, n], `${conflictMarker}: sequence ${name}`);
  } else n += 1;
  mine.set(name, n);
  await tx.$executeRaw`INSERT INTO "sequences" ("name", "prefix", "next") VALUES (${name}, '', ${n + 1}) ON CONFLICT ("name") DO UPDATE SET "next" = ${n + 1}`;
  return format
    .replace('{YYYY}', String(when.y))
    .replace('{YY}', String(when.y).slice(2))
    .replace('{MM}', String(when.m).padStart(2, '0'))
    .replace(/#+/, (m) => String(n).padStart(m.length, '0'));
}
