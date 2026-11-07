/** Approvals inbox (SRS §22, APR-10/12). Visibility is scoped: see canView(). */
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { ah, notFound, paging } from '../lib/http';
import { can } from '../lib/auth';
import { APPROVAL_TYPES, actOnApproval, canActOn, canView } from '../services/approvals';

const r = Router();

const query = z.object({
  box: z.enum(['mine', 'requested', 'all']).default('mine'), // mine = awaiting me, requested = raised by me, all = everything I may see
  status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'RETURNED']).optional(),
  type: z.string().max(40).optional(),
});

r.get('/', ah(async (req, res) => {
  const { skip, take, page, pageSize } = paging(req.query);
  const q = query.parse({ box: req.query.box, status: req.query.status, type: req.query.type });
  const u = req.user!;
  const status = q.status ?? (q.box === 'mine' ? 'PENDING' : undefined);
  const where: any = { ...(status && { status }), ...(q.type && { type: q.type }), ...(q.box === 'requested' && { requestedById: u.id }) };
  const scan = q.box === 'requested' ? { take, skip } : { take: 1000, skip: 0 };
  let items = await prisma.approvalRequest.findMany({ where, orderBy: { createdAt: 'desc' }, ...scan, include: { actions: { orderBy: { createdAt: 'asc' } } } });
  if (q.box === 'mine') items = items.filter((i) => canActOn(u, i));
  if (q.box === 'all') items = items.filter((i) => canView(u, i, i.actions.map((a) => a.userId)));
  const total = q.box === 'requested' ? await prisma.approvalRequest.count({ where }) : items.length;
  if (q.box !== 'requested') items = items.slice(skip, skip + take);
  const users = await prisma.user.findMany({ where: { id: { in: [...new Set(items.flatMap((i) => [i.requestedById, ...i.actions.map((a) => a.userId)]))] } }, select: { id: true, name: true } });
  const names = Object.fromEntries(users.map((x) => [x.id, x.name]));
  res.json({
    items: items.map((i) => ({ ...i, typeLabel: APPROVAL_TYPES[i.type] ?? i.type, requestedBy: names[i.requestedById], canAct: canActOn(u, i), actions: i.actions.map((a) => ({ ...a, userName: names[a.userId] })) })),
    total, page, pageSize,
  });
}));

r.get('/:id', ah(async (req, res) => {
  const i = await prisma.approvalRequest.findUnique({ where: { id: req.params.id }, include: { actions: { orderBy: { createdAt: 'asc' } } } });
  // Out-of-scope requests look exactly like missing ones.
  if (!i || !canView(req.user!, i, i.actions.map((a) => a.userId))) throw notFound();
  const users = await prisma.user.findMany({ where: { id: { in: [i.requestedById, ...i.actions.map((a) => a.userId)] } }, select: { id: true, name: true } });
  const names = Object.fromEntries(users.map((u) => [u.id, u.name]));
  res.json({ ...i, typeLabel: APPROVAL_TYPES[i.type] ?? i.type, requestedBy: names[i.requestedById], canAct: canActOn(req.user!, i), actions: i.actions.map((a) => ({ ...a, userName: names[a.userId] })) });
}));

r.post('/:id/act', can('approvals:act'), ah(async (req, res) => {
  const { action, comment } = z.object({ action: z.enum(['APPROVE', 'REJECT', 'RETURN']), comment: z.string().max(1000).optional() }).parse(req.body);
  res.json(await actOnApproval(req.params.id, req, action, comment));
}));

export default r;
