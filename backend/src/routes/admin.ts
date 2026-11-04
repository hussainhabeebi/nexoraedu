/** Administration (SRS §9): users, roles, departments, masters, settings, workflows, templates, logs. */
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { ah, badRequest, conflict, paging } from '../lib/http';
import { can } from '../lib/auth';
import { audit } from '../lib/audit';
import { PERMISSIONS } from '../lib/permissions';
import { DEFAULT_SETTINGS, getSettings, invalidateSettings } from '../lib/settings';
import { normalizeEmail, randomPassword } from '../lib/util';
import { notifyLater } from '../services/notify';
import { APPROVAL_TYPES } from '../services/approvals';

const r = Router();

// ── Users ──
r.get('/users', can('users:read'), ah(async (req, res) => {
  const { skip, take, page, pageSize } = paging(req.query);
  const q = String(req.query.q || '');
  const role = req.query.role ? String(req.query.role) : undefined;
  const where: any = {
    roles: role ? { some: { role: { key: role } } } : { none: { role: { key: 'student' } } },
    ...(q && { OR: [{ name: { contains: q, mode: 'insensitive' } }, { email: { contains: q, mode: 'insensitive' } }, { username: { contains: q, mode: 'insensitive' } }] }),
    ...(req.query.active && { isActive: req.query.active === 'true' }),
  };
  const [items, total] = await Promise.all([
    prisma.user.findMany({
      where, skip, take, orderBy: { name: 'asc' },
      select: { id: true, name: true, email: true, username: true, phone: true, isActive: true, designation: true, lastLoginAt: true, department: { select: { id: true, name: true } }, roles: { select: { role: { select: { key: true, name: true } } } }, createdAt: true },
    }),
    prisma.user.count({ where }),
  ]);
  res.json({ items: items.map((u) => ({ ...u, roles: u.roles.map((x) => x.role) })), total, page, pageSize });
}));

const userSchema = z.object({
  name: z.string().min(2),
  email: z.string().email(),
  username: z.string().min(3).regex(/^[a-z0-9._-]+$/i),
  phone: z.string().optional(),
  designation: z.string().optional(),
  departmentId: z.string().nullable().optional(),
  joiningDate: z.coerce.date().optional().nullable(),
  roles: z.array(z.string()).min(1),
  isActive: z.boolean().optional(),
  extraPermissions: z.array(z.string()).optional(),
});

async function assertRoleChange(req: any, roleKeys: string[]) {
  const privileged = roleKeys.some((k) => ['super_admin'].includes(k));
  if (privileged && !req.user.roles.includes('super_admin')) throw badRequest('Only a Super Administrator can grant this role.');
}

r.post('/users', can('users:manage'), ah(async (req, res) => {
  const d = userSchema.parse(req.body);
  await assertRoleChange(req, d.roles);
  if (d.extraPermissions?.length && !req.user!.roles.includes('super_admin')) throw badRequest('Only a Super Administrator can set permission overrides.');
  const roles = await prisma.role.findMany({ where: { key: { in: d.roles } } });
  const temp = randomPassword();
  const u = await prisma.user.create({
    data: {
      name: d.name, email: normalizeEmail(d.email)!, username: d.username.toLowerCase(), phone: d.phone, designation: d.designation,
      departmentId: d.departmentId || null, joiningDate: d.joiningDate || null, extraPermissions: d.extraPermissions ?? [],
      passwordHash: await bcrypt.hash(temp, 10), mustChangePassword: true,
      roles: { create: roles.map((x) => ({ roleId: x.id })) },
      ...(d.roles.includes('faculty') && { faculty: { create: {} } }),
    },
  });
  await audit(req, 'CREATE', 'user', u.id, null, { ...d });
  notifyLater('user.welcome', { userId: u.id, name: u.name, email: u.email, phone: u.phone }, { name: u.name, username: u.username, password: temp }, { channels: ['EMAIL', 'WHATSAPP'] });
  res.status(201).json({ id: u.id, temporaryPassword: temp });
}));

r.patch('/users/:id', can('users:manage'), ah(async (req, res) => {
  const d = userSchema.partial().parse(req.body);
  const before = await prisma.user.findUniqueOrThrow({ where: { id: req.params.id }, include: { roles: { include: { role: true } } } });
  if (d.roles) {
    await assertRoleChange(req, d.roles);
    if (before.roles.some((x) => x.role.key === 'super_admin') && !req.user!.roles.includes('super_admin')) throw badRequest('Only a Super Administrator can modify this user.');
  }
  if (d.extraPermissions && !req.user!.roles.includes('super_admin')) throw badRequest('Only a Super Administrator can set permission overrides.');
  if (d.isActive === false && before.id === req.user!.id) throw badRequest('You cannot deactivate your own account.');
  const roles = d.roles ? await prisma.role.findMany({ where: { key: { in: d.roles } } }) : null;
  const u = await prisma.user.update({
    where: { id: req.params.id },
    data: {
      name: d.name, email: d.email ? normalizeEmail(d.email)! : undefined, username: d.username?.toLowerCase(), phone: d.phone, designation: d.designation,
      departmentId: d.departmentId === undefined ? undefined : d.departmentId, joiningDate: d.joiningDate === undefined ? undefined : d.joiningDate,
      isActive: d.isActive, extraPermissions: d.extraPermissions,
      ...(roles && { roles: { deleteMany: {}, create: roles.map((x) => ({ roleId: x.id })) } }),
    },
  });
  if (d.isActive === false) await prisma.refreshToken.updateMany({ where: { userId: u.id, revokedAt: null }, data: { revokedAt: new Date() } });
  if (roles?.some((x) => x.key === 'faculty')) await prisma.facultyProfile.upsert({ where: { userId: u.id }, create: { userId: u.id }, update: {} });
  await audit(req, 'UPDATE', 'user', u.id, { name: before.name, email: before.email, isActive: before.isActive, roles: before.roles.map((x) => x.role.key) }, d);
  res.json({ ok: true });
}));

r.post('/users/:id/reset-password', can('users:manage'), ah(async (req, res) => {
  const temp = randomPassword();
  const u = await prisma.user.update({ where: { id: req.params.id }, data: { passwordHash: await bcrypt.hash(temp, 10), mustChangePassword: true, failedLogins: 0, lockedUntil: null } });
  await audit(req, 'RESET_PASSWORD', 'user', u.id);
  res.json({ temporaryPassword: temp });
}));

// FR-USR-03 bulk import (JSON rows parsed client-side from CSV)
r.post('/users/import', can('users:manage'), ah(async (req, res) => {
  const rows = z.array(userSchema.omit({ extraPermissions: true })).max(500).parse(req.body.rows);
  const out: { row: number; ok: boolean; error?: string; temporaryPassword?: string }[] = [];
  for (const [i, d] of rows.entries()) {
    try {
      if (d.roles.includes('super_admin')) throw new Error('super_admin cannot be bulk-imported');
      const roles = await prisma.role.findMany({ where: { key: { in: d.roles } } });
      const temp = randomPassword();
      await prisma.user.create({ data: { name: d.name, email: normalizeEmail(d.email)!, username: d.username.toLowerCase(), phone: d.phone, designation: d.designation, passwordHash: await bcrypt.hash(temp, 10), mustChangePassword: true, roles: { create: roles.map((x) => ({ roleId: x.id })) } } });
      out.push({ row: i + 1, ok: true, temporaryPassword: temp });
    } catch (e: any) {
      out.push({ row: i + 1, ok: false, error: e.code === 'P2002' ? 'Email or username already exists' : e.message });
    }
  }
  await audit(req, 'IMPORT', 'user', null, null, { count: rows.length });
  res.json({ results: out });
}));

// ── Roles & permissions (Super Admin only for changes) ──
r.get('/roles', can('users:read'), ah(async (_req, res) => {
  const roles = await prisma.role.findMany({ orderBy: { name: 'asc' }, include: { _count: { select: { users: true } } } });
  res.json({ items: roles, permissions: PERMISSIONS });
}));
r.post('/roles', can('roles:manage'), ah(async (req, res) => {
  const d = z.object({ key: z.string().regex(/^[a-z_]+$/), name: z.string(), description: z.string().optional(), permissions: z.array(z.string()) }).parse(req.body);
  const role = await prisma.role.create({ data: d });
  await audit(req, 'CREATE', 'role', role.id, null, d);
  res.status(201).json(role);
}));
r.patch('/roles/:id', can('roles:manage'), ah(async (req, res) => {
  const d = z.object({ name: z.string().optional(), description: z.string().optional(), permissions: z.array(z.string()).optional() }).parse(req.body);
  const before = await prisma.role.findUniqueOrThrow({ where: { id: req.params.id } });
  if (before.key === 'super_admin') throw badRequest('The Super Administrator role cannot be modified.');
  const role = await prisma.role.update({ where: { id: req.params.id }, data: d });
  await audit(req, 'UPDATE', 'role', role.id, before, d);
  res.json(role);
}));
r.delete('/roles/:id', can('roles:manage'), ah(async (req, res) => {
  const role = await prisma.role.findUniqueOrThrow({ where: { id: req.params.id }, include: { _count: { select: { users: true } } } });
  if (role.isSystem) throw badRequest('System roles cannot be deleted.');
  if (role._count.users > 0) throw conflict('This role is assigned to users and cannot be deleted.'); // ADM-02
  await prisma.role.delete({ where: { id: role.id } });
  await audit(req, 'DELETE', 'role', role.id, role);
  res.json({ ok: true });
}));

// ── Departments & branches ──
r.get('/departments', can('users:read', 'masters:manage'), ah(async (_req, res) => {
  res.json({ items: await prisma.department.findMany({ orderBy: { name: 'asc' }, include: { _count: { select: { users: true } } } }) });
}));
r.post('/departments', can('masters:manage'), ah(async (req, res) => {
  const d = z.object({ name: z.string().min(2), headId: z.string().optional().nullable() }).parse(req.body);
  const dep = await prisma.department.create({ data: d });
  await audit(req, 'CREATE', 'department', dep.id, null, d);
  res.status(201).json(dep);
}));
r.patch('/departments/:id', can('masters:manage'), ah(async (req, res) => {
  const d = z.object({ name: z.string().optional(), headId: z.string().nullable().optional(), isActive: z.boolean().optional() }).parse(req.body);
  const dep = await prisma.department.update({ where: { id: req.params.id }, data: d });
  await audit(req, 'UPDATE', 'department', dep.id, null, d);
  res.json(dep);
}));

// ── Master data (ADM-07) ──
export const MASTER_TYPES = ['lead_source', 'lost_reason', 'qualification', 'document_type', 'payment_mode', 'city', 'discount_reason'] as const;
r.get('/masters', ah(async (req, res) => {
  const type = req.query.type ? String(req.query.type) : undefined;
  res.json({ types: MASTER_TYPES, items: await prisma.masterItem.findMany({ where: { type, ...(req.query.all ? {} : { isActive: true }) }, orderBy: [{ type: 'asc' }, { sortOrder: 'asc' }, { label: 'asc' }] }) });
}));
r.post('/masters', can('masters:manage'), ah(async (req, res) => {
  const d = z.object({ type: z.enum(MASTER_TYPES), code: z.string().regex(/^[a-z0-9_]+$/), label: z.string(), sortOrder: z.number().int().optional() }).parse(req.body);
  const m = await prisma.masterItem.create({ data: d });
  await audit(req, 'CREATE', 'master', m.id, null, d);
  res.status(201).json(m);
}));
r.patch('/masters/:id', can('masters:manage'), ah(async (req, res) => {
  const d = z.object({ label: z.string().optional(), isActive: z.boolean().optional(), sortOrder: z.number().int().optional() }).parse(req.body);
  const m = await prisma.masterItem.update({ where: { id: req.params.id }, data: d });
  await audit(req, 'UPDATE', 'master', m.id, null, d);
  res.json(m);
}));

// ── System settings (ADM-09) ──
r.get('/settings', can('settings:manage', 'masters:manage'), ah(async (_req, res) => res.json(await getSettings())));
r.put('/settings/:key', can('settings:manage'), ah(async (req, res) => {
  const key = req.params.key as keyof typeof DEFAULT_SETTINGS;
  if (!(key in DEFAULT_SETTINGS)) throw badRequest('Unknown settings group.');
  const before = (await getSettings())[key];
  const value = { ...before, ...z.record(z.string(), z.any()).parse(req.body) };
  await prisma.setting.upsert({ where: { key }, create: { key, value }, update: { value } });
  invalidateSettings();
  await audit(req, 'UPDATE', 'setting', key, before, value);
  res.json(value);
}));

// ── Approval workflows (ADM-10; Super Admin only) ──
r.get('/workflows', can('settings:manage', 'approvals:act'), ah(async (_req, res) => {
  res.json({ items: await prisma.approvalWorkflow.findMany({ orderBy: { type: 'asc' } }), types: APPROVAL_TYPES });
}));
r.put('/workflows/:type', can('settings:manage'), ah(async (req, res) => {
  if (!req.user!.roles.includes('super_admin')) throw badRequest('Only a Super Administrator can change approval workflows.');
  const d = z.object({ name: z.string().optional(), isActive: z.boolean().optional(), levels: z.array(z.object({ level: z.number().int().min(1), role: z.string(), minAmount: z.number().optional() })) }).parse(req.body);
  const before = await prisma.approvalWorkflow.findUnique({ where: { type: req.params.type } });
  const wf = await prisma.approvalWorkflow.upsert({
    where: { type: req.params.type },
    create: { type: req.params.type, name: d.name ?? APPROVAL_TYPES[req.params.type] ?? req.params.type, levels: d.levels, isActive: d.isActive ?? true },
    update: { levels: d.levels, isActive: d.isActive, name: d.name },
  });
  await audit(req, 'UPDATE', 'approval_workflow', wf.id, before, d);
  res.json(wf);
}));

// ── Notification templates (ADM-11, NTF-04 versioned) ──
r.get('/templates', can('notifications:manage', 'settings:manage'), ah(async (_req, res) => {
  res.json({ items: await prisma.notificationTemplate.findMany({ orderBy: { key: 'asc' } }) });
}));
r.patch('/templates/:id', can('notifications:manage'), ah(async (req, res) => {
  const d = z.object({ name: z.string().optional(), subject: z.string().nullable().optional(), body: z.string().optional(), waTemplateName: z.string().nullable().optional(), waLanguage: z.string().optional(), channels: z.array(z.enum(['IN_APP', 'EMAIL', 'WHATSAPP'])).optional(), isActive: z.boolean().optional() }).parse(req.body);
  const before = await prisma.notificationTemplate.findUniqueOrThrow({ where: { id: req.params.id } });
  const t = await prisma.notificationTemplate.update({ where: { id: req.params.id }, data: { ...d, version: { increment: 1 } } });
  await audit(req, 'UPDATE', 'notification_template', t.id, before, d);
  res.json(t);
}));

// ── Logs ──
r.get('/audit-logs', can('audit:read'), ah(async (req, res) => {
  const { skip, take, page, pageSize } = paging(req.query);
  const where: any = {
    ...(req.query.entity && { entity: String(req.query.entity) }),
    ...(req.query.entityId && { entityId: String(req.query.entityId) }),
    ...(req.query.userId && { userId: String(req.query.userId) }),
    ...(req.query.action && { action: String(req.query.action) }),
  };
  const [items, total] = await Promise.all([prisma.auditLog.findMany({ where, skip, take, orderBy: { createdAt: 'desc' } }), prisma.auditLog.count({ where })]);
  const users = await prisma.user.findMany({ where: { id: { in: items.map((i) => i.userId!).filter(Boolean) } }, select: { id: true, name: true } });
  const names = Object.fromEntries(users.map((u) => [u.id, u.name]));
  res.json({ items: items.map((i) => ({ ...i, userName: i.userId ? names[i.userId] : 'System' })), total, page, pageSize });
}));
r.get('/login-logs', can('audit:read'), ah(async (req, res) => {
  const { skip, take, page, pageSize } = paging(req.query);
  const [items, total] = await Promise.all([prisma.loginLog.findMany({ skip, take, orderBy: { createdAt: 'desc' } }), prisma.loginLog.count()]);
  res.json({ items, total, page, pageSize });
}));
r.get('/notification-logs', can('notifications:manage', 'audit:read'), ah(async (req, res) => {
  const { skip, take, page, pageSize } = paging(req.query);
  const where: any = { ...(req.query.channel && { channel: String(req.query.channel) }), ...(req.query.status && { status: String(req.query.status) }) };
  const [items, total] = await Promise.all([prisma.notificationLog.findMany({ where, skip, take, orderBy: { createdAt: 'desc' } }), prisma.notificationLog.count({ where })]);
  res.json({ items, total, page, pageSize });
}));
r.get('/integration-logs', can('settings:manage', 'audit:read'), ah(async (req, res) => {
  const { skip, take, page, pageSize } = paging(req.query);
  const [items, total] = await Promise.all([prisma.integrationLog.findMany({ skip, take, orderBy: { createdAt: 'desc' } }), prisma.integrationLog.count()]);
  res.json({ items, total, page, pageSize });
}));

export default r;
