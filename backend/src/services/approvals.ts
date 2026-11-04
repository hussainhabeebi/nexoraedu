/**
 * Configurable multi-level approval engine (SRS §22, FR-APR-01/02).
 * Workflows: approval_workflows.levels = [{ level, role, minAmount? }].
 * A level whose minAmount exceeds the request amount is skipped (APR-08 conditional levels).
 */
import type { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { badRequest, forbidden, notFound } from '../lib/http';
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
  DOCUMENT: 'Document verification exception',
};

export async function createApproval(
  tx: Tx,
  p: { type: string; entityType: string; entityId: string; title: string; payload?: any; amount?: number; requestedById: string },
) {
  const wf = await tx.approvalWorkflow.findUnique({ where: { type: p.type } });
  const all = ((wf?.isActive ? wf.levels : []) as Level[]) ?? [];
  const levels = all.filter((l) => !l.minAmount || (p.amount ?? 0) >= l.minAmount).sort((a, b) => a.level - b.level);
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
      status: levels.length ? 'PENDING' : 'APPROVED',
      decidedAt: levels.length ? null : new Date(),
    },
  });
  if (!levels.length) {
    await handlers.get(p.type)?.onApprove(tx, { id: req.id, entityId: p.entityId, payload: p.payload ?? {}, requestedById: p.requestedById }, p.requestedById);
  } else {
    setImmediate(() => notifyRole(levels[0].role, `Approval needed: ${APPROVAL_TYPES[p.type] ?? p.type}`, p.title, `/staff/approvals/${req.id}`).catch(() => undefined));
  }
  return req;
}

export function canActOn(user: AuthUser, r: { status: string; currentLevel: number; levels: any }) {
  if (r.status !== 'PENDING') return false;
  const lvl = (r.levels as Level[])[r.currentLevel - 1];
  return !!lvl && (user.roles.includes('super_admin') || user.roles.includes(lvl.role));
}

export async function actOnApproval(id: string, user: AuthUser, action: 'APPROVE' | 'REJECT' | 'RETURN', comment?: string) {
  if ((action === 'REJECT' || action === 'RETURN') && !comment?.trim()) throw badRequest('A comment is required when rejecting or returning a request.');
  return prisma.$transaction(async (tx) => {
    const r = await tx.approvalRequest.findUnique({ where: { id } });
    if (!r) throw notFound('Approval request not found');
    if (!canActOn(user, r)) throw forbidden('This request is not awaiting your approval.');
    if (r.requestedById === user.id && !user.roles.includes('super_admin')) throw forbidden('You cannot approve your own request.');
    const levels = r.levels as Level[];
    await tx.approvalAction.create({ data: { requestId: id, level: r.currentLevel, action, comment, userId: user.id } });

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
    if (status === 'APPROVED') await h?.onApprove(tx, r, user.id);
    if (status === 'REJECTED' || status === 'RETURNED') await h?.onReject?.(tx, r, user.id);

    setImmediate(() => {
      const label = APPROVAL_TYPES[r.type] ?? r.type;
      if (status === 'PENDING') notifyRole(levels[currentLevel - 1].role, `Approval needed: ${label}`, r.title, `/staff/approvals/${id}`).catch(() => undefined);
      else notifyUser(r.requestedById, `${label} ${status.toLowerCase()}`, `${r.title}${comment ? ` — "${comment}"` : ''}`, `/staff/approvals/${id}`).catch(() => undefined);
    });
    return updated;
  });
}
