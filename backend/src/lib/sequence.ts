import type { Prisma } from '@prisma/client';
import { prisma } from './prisma';

type Tx = Prisma.TransactionClient;

/**
 * Gap-safe, never-reused sequential numbers (STU-06, FIN-04, FIN-06) using an atomic UPSERT.
 * Format tokens: {YYYY} {YY} {MM} and #### (zero-padded counter width).
 */
export async function nextNumber(name: string, format: string, tx: Tx = prisma): Promise<string> {
  const rows = await tx.$queryRaw<{ next: number }[]>`
    INSERT INTO sequences (name, prefix, next) VALUES (${name}, '', 2)
    ON CONFLICT (name) DO UPDATE SET next = sequences.next + 1
    RETURNING next - 1 AS next`;
  const n = Number(rows[0].next);
  const now = new Date();
  return format
    .replace('{YYYY}', String(now.getFullYear()))
    .replace('{YY}', String(now.getFullYear()).slice(2))
    .replace('{MM}', String(now.getMonth() + 1).padStart(2, '0'))
    .replace(/#+/, (m) => String(n).padStart(m.length, '0'));
}
