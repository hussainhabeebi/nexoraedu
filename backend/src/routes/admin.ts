/** Administration (SRS §9): users, roles, departments, masters, settings, workflows, templates, logs. */
import { Router, type Request } from 'express';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { ah, badRequest, conflict, forbidden, paging } from '../lib/http';
import { bumpAuthVersion, can, isSuperAdmin, revokeUserSessions } from '../lib/auth';
import { audit, securityEvent } from '../lib/audit';
import { PERMISSIONS, isKnownPermission, isPrivilegedRole } from '../lib/permissions';
import { DEFAULT_SETTINGS, getSettings, invalidateSettings } from '../lib/settings';
import { hashPassword, MIN_LENGTH_FLOOR, setPassword } from '../lib/password';
import { normalizeEmail, randomPassword, randomToken, sha256 } from '../lib/util';
import { config } from '../config';
import { notifyLater } from '../services/notify';
import { APPROVAL_TYPES, assertWorkflowLevels, createApproval, MANDATORY_APPROVAL_TYPES } from '../services/approvals';

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

const roleKeysOf = (u: { roles: { role: { key: string } }[] }) => u.roles.map((x) => x.role.key);

/** R2: accounts holding a privileged role (incl. Super Admin) can only be managed by a Super Administrator. */
function assertCanManage(req: Request, targetKeys: string[]) {
  if (targetKeys.some(isPrivilegedRole) && !isSuperAdmin(req.user)) throw forbidden('Only a Super Administrator can manage this account.');
}

/** R3: validate role keys and overrides; only a Super Administrator may touch privileged roles or overrides. */
async function resolveRoles(req: Request, keys: string[]) {
  const roles = await prisma.role.findMany({ where: { key: { in: keys } } });
  const unknown = keys.filter((k) => !roles.some((r) => r.key === k));
  if (unknown.length) throw badRequest(`Unknown role(s): ${unknown.join(', ')}`);
  if (keys.some(isPrivilegedRole) && !isSuperAdmin(req.user)) throw forbidden('Only a Super Administrator can grant administrative, management or finance roles.');
  return roles;
}
function assertOverrides(req: Request, extra?: string[]) {
  if (extra === undefined) return;
  if (!isSuperAdmin(req.user)) throw forbidden('Only a Super Administrator can set permission overrides.');
  const bad = extra.filter((p) => p === '*' || !isKnownPermission(p));
  if (bad.length) throw badRequest(`Invalid permission override(s): ${bad.join(', ')}`);
}

/** SRS 22.2: privileged grants are applied only after a second Super Administrator approves (APR-03). */
async function requestPrivilegedGrant(tx: Prisma.TransactionClient, req: Request, userId: string, name: string, add: string[]) {
  return createApproval(tx, { type: 'USER_PRIVILEGE', entityType: 'user', entityId: userId, title: `Grant ${add.join(', ')} to ${name}`, payload: { add }, requestedById: req.user!.id });
}

r.post('/users', can('users:manage'), ah(async (req, res) => {
  const d = userSchema.parse(req.body);
  const roles = await resolveRoles(req, d.roles);
  assertOverrides(req, d.extraPermissions);
  const direct = roles.filter((x) => !isPrivilegedRole(x.key));
  const pending = roles.filter((x) => isPrivilegedRole(x.key)).map((x) => x.key);
  const temp = randomPassword();
  const out = await prisma.$transaction(async (tx) => {
    const u = await tx.user.create({
      data: {
        name: d.name, email: normalizeEmail(d.email)!, username: d.username.toLowerCase(), phone: d.phone, designation: d.designation,
        departmentId: d.departmentId || null, joiningDate: d.joiningDate || null, extraPermissions: d.extraPermissions ?? [],
        passwordHash: await hashPassword(temp), mustChangePassword: true,
        roles: { create: direct.map((x) => ({ roleId: x.id })) },
        ...(d.roles.includes('faculty') && { faculty: { create: {} } }),
      },
    });
    const approval = pending.length ? await requestPrivilegedGrant(tx, req, u.id, u.name, pending) : null;
    await audit(tx, req, 'CREATE', 'user', u.id, null, { ...d, appliedRoles: direct.map((x) => x.key), pendingRoles: pending, approvalId: approval?.id });
    return { u, approval };
  });
  notifyLater('user.welcome', { userId: out.u.id, name: out.u.name, email: out.u.email, phone: out.u.phone }, { name: out.u.name, username: out.u.username, password: temp }, { channels: ['EMAIL', 'WHATSAPP'] });
  res.status(201).json({ id: out.u.id, temporaryPassword: temp, pendingRoles: pending, approval: out.approval });
}));

r.patch('/users/:id', can('users:manage'), ah(async (req, res) => {
  const d = userSchema.partial().parse(req.body);
  const before = await prisma.user.findUniqueOrThrow({ where: { id: req.params.id }, include: { roles: { include: { role: true } } } });
  const current = roleKeysOf(before);
  assertCanManage(req, current);
  const self = before.id === req.user!.id;
  if (self && (d.roles || d.extraPermissions || d.isActive === false)) throw forbidden('You cannot change your own roles, permissions or active status.');
  assertOverrides(req, d.extraPermissions);

  let applyRoles: { id: string; key: string }[] | null = null;
  let pendingAdd: string[] = [];
  if (d.roles) {
    const desired = await prisma.role.findMany({ where: { key: { in: d.roles } } });
    const unknown = d.roles.filter((k) => !desired.some((r) => r.key === k));
    if (unknown.length) throw badRequest(`Unknown role(s): ${unknown.join(', ')}`);
    const added = desired.filter((x) => !current.includes(x.key));
    const removed = current.filter((k) => !d.roles!.includes(k));
    if ([...added.map((x) => x.key), ...removed].some(isPrivilegedRole) && !isSuperAdmin(req.user)) throw forbidden('Only a Super Administrator can grant or remove administrative, management or finance roles.');
    pendingAdd = added.filter((x) => isPrivilegedRole(x.key)).map((x) => x.key);
    // Removals and non-privileged additions apply now; privileged additions wait for approval.
    applyRoles = desired.filter((x) => !pendingAdd.includes(x.key));
  }
  const identityChanged = (d.email && normalizeEmail(d.email) !== before.email) || (d.username && d.username.toLowerCase() !== before.username);
  const accessChanged = !!applyRoles || d.extraPermissions !== undefined || d.isActive === false || identityChanged;

  const approval = await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: before.id },
      data: {
        name: d.name, email: d.email ? normalizeEmail(d.email)! : undefined, username: d.username?.toLowerCase(), phone: d.phone, designation: d.designation,
        departmentId: d.departmentId === undefined ? undefined : d.departmentId, joiningDate: d.joiningDate === undefined ? undefined : d.joiningDate,
        isActive: d.isActive, extraPermissions: d.extraPermissions,
        ...(applyRoles && { roles: { deleteMany: {}, create: applyRoles.map((x) => ({ roleId: x.id })) } }),
        ...(accessChanged && { authVersion: { increment: 1 } }),
      },
    });
    if (d.isActive === false || identityChanged) await revokeUserSessions(tx, before.id, d.isActive === false ? 'DEACTIVATED' : 'IDENTITY_CHANGED');
    if (applyRoles?.some((x) => x.key === 'faculty')) await tx.facultyProfile.upsert({ where: { userId: before.id }, create: { userId: before.id }, update: {} });
    const approval = pendingAdd.length ? await requestPrivilegedGrant(tx, req, before.id, before.name, pendingAdd) : null;
    await audit(tx, req, 'UPDATE', 'user', before.id,
      { name: before.name, email: before.email, username: before.username, isActive: before.isActive, roles: current, extraPermissions: before.extraPermissions },
      { ...d, appliedRoles: applyRoles?.map((x) => x.key), pendingRoles: pendingAdd, approvalId: approval?.id });
    return approval;
  });
  if (identityChanged && d.email) {
    // Tell the OLD address so a hijacked change is noticed.
    notifyLater('security.email_changed', { userId: before.id, name: before.name, email: before.email, phone: before.phone }, { name: before.name, newEmail: normalizeEmail(d.email) }, { channels: ['EMAIL'] });
  }
  res.json({ ok: true, pendingRoles: pendingAdd, approval });
}));

r.post('/users/:id/reset-password', can('users:manage'), ah(async (req, res) => {
  const target = await prisma.user.findUniqueOrThrow({ where: { id: req.params.id }, include: { roles: { include: { role: true } } } });
  if (target.id === req.user!.id) throw badRequest('Use "Change password" for your own account.');
  const keys = roleKeysOf(target);
  assertCanManage(req, keys);
  if (keys.some(isPrivilegedRole)) {
    // Privileged accounts: never reveal a password to another person; send a single-use reset link instead.
    const token = randomToken(32);
    await prisma.$transaction(async (tx) => {
      await tx.passwordReset.create({ data: { userId: target.id, purpose: 'RESET', tokenHash: sha256(token), expiresAt: new Date(Date.now() + 30 * 60_000) } });
      await revokeUserSessions(tx, target.id, 'ADMIN_RESET');
      await bumpAuthVersion(tx, target.id);
      await audit(tx, req, 'RESET_PASSWORD_LINK', 'user', target.id);
    });
    notifyLater('auth.password_reset', { userId: target.id, name: target.name, email: target.email, phone: target.phone }, { name: target.name, link: `${config.publicAppUrl}/reset-password?token=${token}` }, { channels: ['EMAIL', 'WHATSAPP'] });
    return res.json({ ok: true, delivery: 'reset-link' });
  }
  const temp = randomPassword();
  await prisma.$transaction(async (tx) => {
    await setPassword(tx, target.id, temp, { mustChange: true });
    await revokeUserSessions(tx, target.id, 'ADMIN_RESET');
    await audit(tx, req, 'RESET_PASSWORD', 'user', target.id);
  });
  res.json({ temporaryPassword: temp });
}));

/** SEC-06: a Super Administrator can reset another user's MFA (lost device). Never their own. */
r.post('/users/:id/mfa/reset', can('users:manage'), ah(async (req, res) => {
  if (!isSuperAdmin(req.user)) throw forbidden('Only a Super Administrator can reset two-factor authentication.');
  if (req.params.id === req.user!.id) throw badRequest('You cannot reset your own two-factor authentication.');
  const target = await prisma.user.findUniqueOrThrow({ where: { id: req.params.id } });
  await prisma.$transaction(async (tx) => {
    await tx.mfaFactor.deleteMany({ where: { userId: target.id } });
    await tx.mfaRecoveryCode.deleteMany({ where: { userId: target.id } });
    await revokeUserSessions(tx, target.id, 'MFA_RESET');
    await bumpAuthVersion(tx, target.id);
    await securityEvent(tx, req, { event: 'MFA_RESET', userId: target.id, success: true });
    await audit(tx, req, 'MFA_RESET', 'user', target.id);
  });
  res.json({ ok: true });
}));

// FR-USR-03 bulk import (JSON rows parsed client-side from CSV). Privileged roles cannot be bulk-imported.
r.post('/users/import', can('users:manage'), ah(async (req, res) => {
  const rows = z.array(userSchema.omit({ extraPermissions: true })).max(500).parse(req.body.rows);
  const out: { row: number; ok: boolean; error?: string; temporaryPassword?: string }[] = [];
  for (const [i, d] of rows.entries()) {
    try {
      const priv = d.roles.filter(isPrivilegedRole);
      if (priv.length) throw new Error(`Privileged roles cannot be bulk-imported (${priv.join(', ')})`);
      const roles = await prisma.role.findMany({ where: { key: { in: d.roles } } });
      if (roles.length !== d.roles.length) throw new Error('Unknown role');
      const temp = randomPassword();
      await prisma.$transaction(async (tx) => {
        const u = await tx.user.create({ data: { name: d.name, email: normalizeEmail(d.email)!, username: d.username.toLowerCase(), phone: d.phone, designation: d.designation, passwordHash: await hashPassword(temp), mustChangePassword: true, roles: { create: roles.map((x) => ({ roleId: x.id })) } } });
        await audit(tx, req, 'CREATE', 'user', u.id, null, { ...d, via: 'import' });
      });
      out.push({ row: i + 1, ok: true, temporaryPassword: temp });
    } catch (e: any) {
      out.push({ row: i + 1, ok: false, error: e.code === 'P2002' ? 'Email or username already exists' : e.message });
    }
  }
  await audit(prisma, req, 'IMPORT', 'user', null, null, { count: rows.length, created: out.filter((o) => o.ok).length });
  res.json({ results: out });
}));

// ── Roles & permissions (Super Admin only for changes) ──
r.get('/roles', can('users:read'), ah(async (_req, res) => {
  const roles = await prisma.role.findMany({ orderBy: { name: 'asc' }, include: { _count: { select: { users: true } } } });
  res.json({ items: roles, permissions: PERMISSIONS });
}));
// SEC-03: new roles start with no access; only catalogue permissions; '*' is reserved for super_admin.
function assertPermissionList(perms: string[]) {
  const bad = perms.filter((p) => p === '*' || !isKnownPermission(p));
  if (bad.length) throw badRequest(`Invalid permission(s): ${bad.join(', ')}`);
}
r.post('/roles', can('roles:manage'), ah(async (req, res) => {
  if (!isSuperAdmin(req.user)) throw forbidden('Only a Super Administrator can change roles.');
  const d = z.object({ key: z.string().regex(/^[a-z_]+$/), name: z.string(), description: z.string().optional(), permissions: z.array(z.string()).default([]) }).parse(req.body);
  if (isPrivilegedRole(d.key)) throw badRequest('This role key is reserved.');
  assertPermissionList(d.permissions);
  const role = await prisma.$transaction(async (tx) => {
    const role = await tx.role.create({ data: d });
    await audit(tx, req, 'CREATE', 'role', role.id, null, d);
    return role;
  });
  res.status(201).json(role);
}));
r.patch('/roles/:id', can('roles:manage'), ah(async (req, res) => {
  if (!isSuperAdmin(req.user)) throw forbidden('Only a Super Administrator can change roles.');
  const d = z.object({ name: z.string().optional(), description: z.string().optional(), permissions: z.array(z.string()).optional() }).parse(req.body);
  const before = await prisma.role.findUniqueOrThrow({ where: { id: req.params.id } });
  if (before.key === 'super_admin') throw badRequest('The Super Administrator role cannot be modified.');
  if (d.permissions) assertPermissionList(d.permissions);
  const role = await prisma.$transaction(async (tx) => {
    const role = await tx.role.update({ where: { id: req.params.id }, data: d });
    // Permission changes take effect on the holders' next request.
    if (d.permissions) await tx.user.updateMany({ where: { roles: { some: { roleId: role.id } } }, data: { authVersion: { increment: 1 } } });
    await audit(tx, req, 'UPDATE', 'role', role.id, before, d);
    return role;
  });
  res.json(role);
}));
r.delete('/roles/:id', can('roles:manage'), ah(async (req, res) => {
  if (!isSuperAdmin(req.user)) throw forbidden('Only a Super Administrator can change roles.');
  const role = await prisma.role.findUniqueOrThrow({ where: { id: req.params.id }, include: { _count: { select: { users: true } } } });
  if (role.isSystem) throw badRequest('System roles cannot be deleted.');
  if (role._count.users > 0) throw conflict('This role is assigned to users and cannot be deleted.'); // ADM-02
  await prisma.$transaction(async (tx) => {
    await tx.role.delete({ where: { id: role.id } });
    await audit(tx, req, 'DELETE', 'role', role.id, role);
  });
  res.json({ ok: true });
}));

// ── Departments & branches ──
r.get('/departments', can('users:read', 'masters:manage'), ah(async (_req, res) => {
  res.json({ items: await prisma.department.findMany({ orderBy: { name: 'asc' }, include: { _count: { select: { users: true } } } }) });
}));
r.post('/departments', can('masters:manage'), ah(async (req, res) => {
  const d = z.object({ name: z.string().min(2), headId: z.string().optional().nullable() }).parse(req.body);
  const dep = await prisma.$transaction(async (tx) => {
    const dep = await tx.department.create({ data: d });
    await audit(tx, req, 'CREATE', 'department', dep.id, null, d);
    return dep;
  });
  res.status(201).json(dep);
}));
r.patch('/departments/:id', can('masters:manage'), ah(async (req, res) => {
  const d = z.object({ name: z.string().optional(), headId: z.string().nullable().optional(), isActive: z.boolean().optional() }).parse(req.body);
  const dep = await prisma.$transaction(async (tx) => {
    const before = await tx.department.findUniqueOrThrow({ where: { id: req.params.id } });
    const dep = await tx.department.update({ where: { id: req.params.id }, data: d });
    await audit(tx, req, 'UPDATE', 'department', dep.id, before, d);
    return dep;
  });
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
  const m = await prisma.$transaction(async (tx) => {
    const m = await tx.masterItem.create({ data: d });
    await audit(tx, req, 'CREATE', 'master', m.id, null, d);
    return m;
  });
  res.status(201).json(m);
}));
r.patch('/masters/:id', can('masters:manage'), ah(async (req, res) => {
  const d = z.object({ label: z.string().optional(), isActive: z.boolean().optional(), sortOrder: z.number().int().optional() }).parse(req.body);
  const m = await prisma.$transaction(async (tx) => {
    const before = await tx.masterItem.findUniqueOrThrow({ where: { id: req.params.id } });
    const m = await tx.masterItem.update({ where: { id: req.params.id }, data: d });
    await audit(tx, req, 'UPDATE', 'master', m.id, before, d);
    return m;
  });
  res.json(m);
}));

// ── System settings (ADM-09) ──
r.get('/settings', can('settings:manage', 'masters:manage'), ah(async (_req, res) => res.json(await getSettings())));
r.put('/settings/:key', can('settings:manage'), ah(async (req, res) => {
  const key = req.params.key as keyof typeof DEFAULT_SETTINGS;
  if (!(key in DEFAULT_SETTINGS)) throw badRequest('Unknown settings group.');
  const before = (await getSettings())[key];
  const value: any = { ...before, ...z.record(z.string(), z.any()).parse(req.body) };
  if (key === 'security') {
    // Security floors from the SRS cannot be weakened from the UI (SEC-01, SEC-04, SEC-05).
    const sec = z.object({ sessionTimeoutMin: z.number().int().min(5).max(240), passwordMinLength: z.number().int().min(MIN_LENGTH_FLOOR).max(64), maxFailedLogins: z.number().int().min(3).max(10), lockMinutes: z.number().int().min(5).max(1440) }).parse(value);
    Object.assign(value, sec);
  }
  await prisma.$transaction(async (tx) => {
    await tx.setting.upsert({ where: { key }, create: { key, value }, update: { value } });
    await audit(tx, req, 'UPDATE', 'setting', key, before, value);
  });
  invalidateSettings();
  res.json(value);
}));

// ── Approval workflows (ADM-10; Super Admin only) ──
r.get('/workflows', can('settings:manage', 'approvals:act'), ah(async (_req, res) => {
  res.json({ items: await prisma.approvalWorkflow.findMany({ orderBy: { type: 'asc' } }), types: APPROVAL_TYPES });
}));
r.put('/workflows/:type', can('settings:manage'), ah(async (req, res) => {
  if (!req.user!.roles.includes('super_admin')) throw badRequest('Only a Super Administrator can change approval workflows.');
  const d = z.object({ name: z.string().optional(), isActive: z.boolean().optional(), levels: z.array(z.object({ level: z.number().int().min(1), role: z.string(), minAmount: z.number().optional() })).min(1, 'A workflow needs at least one approval level.') }).parse(req.body);
  if (!(req.params.type in APPROVAL_TYPES)) throw badRequest('Unknown approval type.');
  // R4: approvals fail closed; mandatory workflows cannot be switched off.
  if (d.isActive === false && (MANDATORY_APPROVAL_TYPES as readonly string[]).includes(req.params.type)) throw badRequest('This approval workflow is mandatory and cannot be deactivated.');
  await assertWorkflowLevels(prisma, d.levels);
  const before = await prisma.approvalWorkflow.findUnique({ where: { type: req.params.type } });
  const wf = await prisma.$transaction(async (tx) => {
    const wf = await tx.approvalWorkflow.upsert({
      where: { type: req.params.type },
      create: { type: req.params.type, name: d.name ?? APPROVAL_TYPES[req.params.type] ?? req.params.type, levels: d.levels, isActive: d.isActive ?? true },
      update: { levels: d.levels, isActive: d.isActive, name: d.name },
    });
    await audit(tx, req, 'UPDATE', 'approval_workflow', wf.id, before, d);
    return wf;
  });
  res.json(wf);
}));

// ── Notification templates (ADM-11, NTF-04 versioned) ──
r.get('/templates', can('notifications:manage', 'settings:manage'), ah(async (_req, res) => {
  res.json({ items: await prisma.notificationTemplate.findMany({ orderBy: { key: 'asc' } }) });
}));
r.patch('/templates/:id', can('notifications:manage'), ah(async (req, res) => {
  const d = z.object({ name: z.string().optional(), subject: z.string().nullable().optional(), body: z.string().optional(), waTemplateName: z.string().nullable().optional(), waLanguage: z.string().optional(), channels: z.array(z.enum(['IN_APP', 'EMAIL', 'WHATSAPP'])).optional(), isActive: z.boolean().optional() }).parse(req.body);
  const before = await prisma.notificationTemplate.findUniqueOrThrow({ where: { id: req.params.id } });
  const t = await prisma.$transaction(async (tx) => {
    const t = await tx.notificationTemplate.update({ where: { id: req.params.id }, data: { ...d, version: { increment: 1 } } });
    await audit(tx, req, 'UPDATE', 'notification_template', t.id, before, d);
    return t;
  });
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
  await audit(prisma, req, 'VIEW', 'audit_logs', null, null, { filters: where, page }); // LOG-07
  const users = await prisma.user.findMany({ where: { id: { in: items.map((i) => i.userId!).filter(Boolean) } }, select: { id: true, name: true } });
  const names = Object.fromEntries(users.map((u) => [u.id, u.name]));
  res.json({ items: items.map((i) => ({ ...i, userName: i.userId ? names[i.userId] : 'System' })), total, page, pageSize });
}));
r.get('/login-logs', can('audit:read'), ah(async (req, res) => {
  const { skip, take, page, pageSize } = paging(req.query);
  const [items, total] = await Promise.all([prisma.loginLog.findMany({ skip, take, orderBy: { createdAt: 'desc' } }), prisma.loginLog.count()]);
  await audit(prisma, req, 'VIEW', 'login_logs', null, null, { page });
  res.json({ items, total, page, pageSize });
}));
r.get('/notification-logs', can('notifications:manage', 'audit:read'), ah(async (req, res) => {
  const { skip, take, page, pageSize } = paging(req.query);
  const where: any = { ...(req.query.channel && { channel: String(req.query.channel) }), ...(req.query.status && { status: String(req.query.status) }) };
  const [items, total] = await Promise.all([prisma.notificationLog.findMany({ where, skip, take, orderBy: { createdAt: 'desc' } }), prisma.notificationLog.count({ where })]);
  await audit(prisma, req, 'VIEW', 'notification_logs', null, null, { filters: where, page });
  res.json({ items, total, page, pageSize });
}));
r.get('/integration-logs', can('settings:manage', 'audit:read'), ah(async (req, res) => {
  const { skip, take, page, pageSize } = paging(req.query);
  const [items, total] = await Promise.all([prisma.integrationLog.findMany({ skip, take, orderBy: { createdAt: 'desc' } }), prisma.integrationLog.count()]);
  await audit(prisma, req, 'VIEW', 'integration_logs', null, null, { page });
  res.json({ items, total, page, pageSize });
}));

export default r;
