/**
 * Database client. The ERP runs on Cloudflare D1 through Prisma's D1 adapter.
 * The Worker (src/worker.ts) and the test harness call initDb() with the D1 binding before handling requests.
 *
 * IMPORTANT: on D1, Prisma's own transactions are NOT atomic. Never use prisma.$transaction();
 * use atomic() from lib/db.ts for any change that writes more than one row.
 */
import { PrismaD1 } from '@prisma/adapter-d1';
import { PrismaClient } from '#prisma';

export type D1 = import('@cloudflare/workers-types').D1Database;

let binding: D1 | undefined;
let client: PrismaClient | undefined;

export function initDb(db: D1) {
  if (binding === db && client) return;
  binding = db;
  client = new PrismaClient({ adapter: new PrismaD1(db as any) });
}

/** The raw D1 binding (used by lib/db.ts for atomic batches). */
export function d1(): D1 {
  if (!binding) throw new Error('Database not initialised (initDb was not called).');
  return binding;
}

/** Prisma client bound to the current D1 database. */
export const prisma: PrismaClient = new Proxy({} as PrismaClient, {
  get(_t, key) {
    if (!client) throw new Error('Database not initialised (initDb was not called).');
    const v = (client as any)[key];
    return typeof v === 'function' ? v.bind(client) : v;
  },
});
