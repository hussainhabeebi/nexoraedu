import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { ah } from '../lib/http';

const r = Router();
r.get('/', ah(async (req, res) => {
  const [items, unread] = await Promise.all([
    prisma.notification.findMany({ where: { userId: req.user!.id }, orderBy: { createdAt: 'desc' }, take: 50 }),
    prisma.notification.count({ where: { userId: req.user!.id, readAt: null } }),
  ]);
  res.json({ items, unread });
}));
r.post('/read', ah(async (req, res) => {
  const ids: string[] | undefined = req.body?.ids;
  await prisma.notification.updateMany({ where: { userId: req.user!.id, readAt: null, ...(ids && { id: { in: ids } }) }, data: { readAt: new Date() } });
  res.json({ ok: true });
}));
export default r;
