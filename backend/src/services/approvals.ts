/**
 * Configurable multi-level approval engine (SRS §22, FR-APR-01/02, APR-01…04, APR-08…10).
 * Workflows: approval_workflows.levels = [{ level, role, minAmount? }]. A level whose minAmount exceeds the
 * request amount is skipped (APR-08 conditional levels).
 *
 * R4 hardening:
 *  - FAIL CLOSED: a missing/inactive workflow, or one with no applicable level, is an error — never an auto-approval.
 *  - Nobody (including the Super Administrator) may approve their own request (APR-03).
 *  - One person cannot decide two levels of the same request (segregation of duties).
 *  - The request row is locked while deciding, so concurrent approvals cannot both succeed.
 *  - Each decision stores IP address and user agent (APR-10).
 */
import type { Request } from 'express';
import type { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { audit } from '../lib/audit';
import { badRequest, forbidden, HttpError, notFound } from '../lib/http';
import type { AuthUser } from '../lib/auth';
import { notifyRole, notifyUser } from './notify';

type Tx = Prisma.TransactionClient;
type Level = { level: number; role: string; minAmount?: number };

type Handler = {
  onApprove: (tx: Tx, req: { id: string; entityId: string; payload: any; requestedById: string }, actorId: string) => Promise<void>;
  onReject?: (tx: Tx, req: { id: string; entityId: string; payload: any }, actorId: string) => Promise<void>;
};
const handlers = new Map<string, Handler>();
export const registerApprovalHandler = (type: string, h: Handler) => handlers.set(type, h);

export const APPROVAL_TYPES: Record<string, string> = {
  ADMISSION: 'Admission',
  DISCOUNT: 'Fee discount / scholarship',
  REFUND: 'Refund',
  PAYMENT_CANCELLATION: 'Payment / receipt cancellation',
  BATCH_TRANSFER: 'Batch transfer / course change',
  RESULT_CORRECTION: 'Result correction',
  CERTIFICATE: 'Certificate issue',
  ATTENDANCE_EDIT: 'Late attendance edit',
  EXAM_REATTEMPT: 'Exam re-attempt / eligibility exception',
  USER_PRIVILEGE: 'Privileged role grant',
};
/** Workflows that can never be switched off (every type the application raises). */
export const MANDATORY_APPROVAL_TYPES = Object.keys(APPROVAL_TYPES);

export class ApprovalNotConfigured extends HttpError {
  constructor(type: string) {
    super(409, `The "${APPROVAL_TYPES[type] ?? type}" approval workflow is not configured. Ask a Super Administrator to set it up; nothing was changed.`, 'APPROVAL_NOT_CONFIGURED');
  }
}

/** Every level must name an existing role; levels must be numbered 1..n. */
export async function assertWorkflowLevels(db: Tx | typeof prisma, levels: Level[]) {
  const sorted = [...levels].sort((a, b) => a.level - b.level);
  if (sorted.some((l, i) => l.level !== i + 1)) throw badRequest('Approval levels must be numbered 1, 2, 3… without gaps.');
  const keys = [...new Set(levels.map((l) => l.role))];
  const found = await db.role.findMany({ where: { key: { in: keys } }, select: { key: true } });
  const missing = keys.filter((k) => !found.some((f) => f.key === k));
  if (missing.length) throw badRequest(`Unknown approver role(s): ${missing.join(', ')}`);
  if (keys.includes('student')) throw badRequest('Students cannot be approvers.');
}

export async function createApproval(
  tx: Tx,
  p: { type: string; entityType: string; entityId: string; title: string; payload?: any; amount?: number; requestedById: string },
) {
  if (!handlers.has(p.type) || !(p.type in APPROVAL_TYPES)) throw new ApprovalNotConfigured(p.type);
  const wf = await tx.approvalWorkflow.findUnique({ where: { type: p.type } });
  if (!wf || !wf.isActive) throw new ApprovalNotConfigured(p.type);
  const all = (Array.isArray(wf.levels) ? wf.levels : []) as Level[];
  const levels = all.filter((l) => !l.minAmount || (p.amount ?? 0) >= l.minAmount).sort((a, b) => a.level - b.level);
  if (!levels.length) throw new ApprovalNotConfigured(p.type);
  const pending = await tx.approvalRequest.findFirst({ where: { type: p.type, entityId: p.entityId, status: 'PENDING' }, select: { id: true } });
  if (pending) throw new HttpError(409, 'An approval request for this record is already pending.', 'APPROVAL_PENDING', { approvalId: pending.id });
  const req = await tx.approvalRequest.create({
    data: {
      type: p.type,
      entityType: p.entityType,
      entityId: p.entityId,
      title: p.title,
      payload: p.payload ?? {},
      amount: p.amount,
      levels: levels as any,
      requestedById: p.requestedById,
      status: 'PENDING',
    },
  });
  setImmediate(() => notifyRole(levels[0].role, `Approval needed: ${APPROVAL_TYPES[p.type] ?? p.type}`, p.title, `/staff/approvals/${req.id}`).catch(() => undefined));
  return req;
}

/** The current level's role (Super Administrator may act at any level), but never on one's own request. */
export function canActOn(user: AuthUser, r: { status: string; currentLevel: number; levels: any; requestedById?: string }) {
  if (r.status !== 'PENDING') return false;
  if (r.requestedById && r.requestedById === user.id) return false;
  const lvl = (r.levels as Level[])[r.currentLevel - 1];
  return !!lvl && (user.roles.includes('super_admin') || user.roles.includes(lvl.role));
}

/** Whether a user may see a request at all (requester, past actor, any-level approver, or auditor). */
export function canView(user: AuthUser, r: { requestedById: string; levels: any }, actorIds: string[]) {
  if (r.requestedById === user.id || actorIds.includes(user.id)) return true;
  if (user.perms.includes('*') || user.perms.includes('audit:read')) return true;
  return (r.levels as Level[]).some((l) => user.roles.includes(l.role));
}

export async function actOnApproval(id: string, req: Request, action: 'APPROVE' | 'REJECT' | 'RETURN', comment: string | undefined) {
  const user = req.user!;
  if ((action === 'REJECT' || action === 'RETURN') && !comment?.trim()) throw badRequest('A comment is required when rejecting or returning a request.');
  return prisma.$transaction(async (tx) => {
    // Row lock: serialises concurrent decisions on the same request.
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM approval_requests WHERE id = ${id} FOR UPDATE`;
    if (!locked.length) throw notFound('Approval request not found');
    const r = await tx.approvalRequest.findUniqueOrThrow({ where: { id }, include: { actions: true } });
    if (r.requestedById === user.id) throw forbidden('You cannot approve your own request.');
    if (!canActOn(user, r)) throw forbidden('This request is not awaiting your approval.');
    if (r.actions.some((a) => a.userId === user.id)) throw forbidden('You have already decided an earlier level of this request; another approver must decide this level.');
    const levels = r.levels as Level[];
    await tx.approvalAction.create({ data: { requestId: id, level: r.currentLevel, action, comment, userId: user.id, ip: req.ip, userAgent: req.get('user-agent')?.slice(0, 300) } });

    let status = r.status;
    let currentLevel = r.currentLevel;
    if (action === 'APPROVE') {
      if (r.currentLevel < levels.length) currentLevel++;
      else status = 'APPROVED';
    } else status = action === 'REJECT' ? 'REJECTED' : 'RETURNED';

    const updated = await tx.approvalRequest.update({
      where: { id },
      data: { status, currentLevel, decidedAt: status !== 'PENDING' ? new Date() : null },
    });
    const h = handlers.get(r.type);
    if (!h) throw new ApprovalNotConfigured(r.type);
    if (status === 'APPROVED') await h.onApprove(tx, r, user.id);
    if (status === 'REJECTED' || status === 'RETURNED') await h.onReject?.(tx, r, user.id);
    await audit(tx, req, `APPROVAL_${action}`, 'approval_request', id, { status: r.status, level: r.currentLevel }, { status, level: currentLevel, comment, type: r.type, entityId: r.entityId });

    setImmediate(() => {
      const label = APPROVAL_TYPES[r.type] ?? r.type;
      if (status === 'PENDING') notifyRole(levels[currentLevel - 1].role, `Approval needed: ${label}`, r.title, `/staff/approvals/${id}`).catch(() => undefined);
      else notifyUser(r.requestedById, `${label} ${status.toLowerCase()}`, `${r.title}${comment ? ` — "${comment}"` : ''}`, `/staff/approvals/${id}`).catch(() => undefined);
    });
    return updated;
  });
}
