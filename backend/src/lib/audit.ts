/**
 * Audit trail (FR-AUD-01/02, LOG-01…03, 24.x).
 * R7: audit rows are written with the SAME database client (transaction) as the business change and errors
 * propagate, so a change can never commit without its audit row (and vice versa). Never swallow failures here.
 */
import type { Request } from 'express';
import type { Prisma } from '@prisma/client';
import { prisma } from './prisma';

type Db = Prisma.TransactionClient | typeof prisma;

const SENSITIVE = /password|token|secret|hash|otp|recovery|authorization|cookie|^code$/i;
export function scrub(v: unknown): any {
  if (v == null || typeof v !== 'object') return v ?? undefined;
  if (Array.isArray(v)) return v.map(scrub);
  if (v instanceof Date) return v.toISOString();
  return Object.fromEntries(Object.entries(v as object).map(([k, x]) => [k, SENSITIVE.test(k) ? '***' : scrub(x)]));
}
const clean = (v: unknown) => scrub(JSON.parse(JSON.stringify(v ?? null))) ?? undefined;

export async function audit(db: Db, req: Request | null, action: string, entity: string, entityId?: string | null, oldValues?: unknown, newValues?: unknown) {
  await db.auditLog.create({
    data: {
      userId: req?.user?.id,
      action,
      entity,
      entityId: entityId ?? undefined,
      oldValues: clean(oldValues),
      newValues: clean(newValues),
      ip: req?.ip,
      userAgent: req?.get?.('user-agent')?.slice(0, 300),
      requestId: req?.id,
    },
  });
}

/** Login / session / MFA security events (24.2). Append-only table. */
export async function securityEvent(db: Db, req: Request | null, e: { event: string; userId?: string | null; identifier?: string; success: boolean }) {
  await db.loginLog.create({
    data: { event: e.event, userId: e.userId ?? undefined, identifier: (e.identifier ?? '').slice(0, 200), success: e.success, ip: req?.ip, userAgent: req?.get?.('user-agent')?.slice(0, 300) },
  });
}
