import type { Request } from 'express';
import { prisma } from './prisma';

const SENSITIVE = /password|token|secret|hash/i;
function scrub(v: unknown): any {
  if (v == null || typeof v !== 'object') return v ?? undefined;
  if (Array.isArray(v)) return v.map(scrub);
  if (v instanceof Date) return v.toISOString();
  return Object.fromEntries(Object.entries(v as object).map(([k, x]) => [k, SENSITIVE.test(k) ? '***' : scrub(x)]));
}

/** Append-only audit trail (FR-AUD-01). */
export async function audit(req: Request | null, action: string, entity: string, entityId?: string | null, oldValues?: unknown, newValues?: unknown) {
  try {
    await prisma.auditLog.create({
      data: {
        userId: req?.user?.id,
        action,
        entity,
        entityId: entityId ?? undefined,
        oldValues: scrub(JSON.parse(JSON.stringify(oldValues ?? null))) ?? undefined,
        newValues: scrub(JSON.parse(JSON.stringify(newValues ?? null))) ?? undefined,
        ip: req?.ip,
      },
    });
  } catch (e) {
    console.error('audit write failed', e);
  }
}
