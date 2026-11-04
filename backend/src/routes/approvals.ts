import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { ah, notFound, paging } from '../lib/http';
import { can } from '../lib/auth';
import { audit } from '../lib/audit';
import { APPROVAL_TYPES, actOnApproval, canActOn } from '../services/approvals';

const r = Router();

r.get('/', ah(async (req, res) => {
  const { skip, take, page, pageSize } = paging(req.query);
  const box = String(req.query.box || 'mine'); // mine = awaiting me, requested = raised by me, all
  const status = req.query.status ? String(req.query.status) : box === 'mine' ? 'PENDING' : undefined;
  const where: any = { ...(status && { status }), ...(req.query.type && { type: String(req.query.type) }), ...(box === 'requested' && { requestedById: req.user!.id }) };
  let items = await prisma.approvalRequest.findMany({ where, orderBy: { createdAt: 'desc' }, take: box === 'mine' ? 500 : take, skip: box === 'mine' ? 0 : skip, include: { actions: { orderBy: { createdAt: 'asc' } } } });
  if (box === 'mine') items = items.filter((i) => canActOn(req.user!, i));
  else if (box === 'all' && !req.user!.perms.includes('*') && !req.user!.perms.includes('approvals:act')) items = [];
  const users = await prisma.user.findMany({ where: { id: { in: [...new Set(items.flatMap((i) => [i.requestedById, ...i.actions.map((a) => a.userId)]))] } }, select: { id: true, name: true } });
  const names = Object.fromEntries(users.map((u) => [u.id, u.name]));
  res.json({
    items: items.map((i) => ({ ...i, typeLabel: APPROVAL_TYPES[i.type] ?? i.type, requestedBy: names[i.requestedById], canAct: canActOn(req.user!, i), actions: i.actions.map((a) => ({ ...a, userName: names[a.userId] })) })),
    total: box === 'mine' ? items.length : await prisma.approvalRequest.count({ where }),
    page, pageSize,
  });
}));

r.get('/:id', ah(async (req, res) => {
  const i = await prisma.approvalRequest.findUnique({ where: { id: req.params.id }, include: { actions: { orderBy: { createdAt: 'asc' } } } });
  if (!i) throw notFound();
  const users = await prisma.user.findMany({ where: { id: { in: [i.requestedById, ...i.actions.map((a) => a.userId)] } }, select: { id: true, name: true } });
  const names = Object.fromEntries(users.map((u) => [u.id, u.name]));
  res.json({ ...i, typeLabel: APPROVAL_TYPES[i.type] ?? i.type, requestedBy: names[i.requestedById], canAct: canActOn(req.user!, i), actions: i.actions.map((a) => ({ ...a, userName: names[a.userId] })) });
}));

r.post('/:id/act', can('approvals:act'), ah(async (req, res) => {
  const { action, comment } = z.object({ action: z.enum(['APPROVE', 'REJECT', 'RETURN']), comment: z.string().max(1000).optional() }).parse(req.body);
  const out = await actOnApproval(req.params.id, req.user!, action, comment);
  await audit(req, `APPROVAL_${action}`, 'approval_request', out.id, null, { comment, status: out.status });
  res.json(out);
}));

export default r;
