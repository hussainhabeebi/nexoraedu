import { Router } from 'express';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { ah, badRequest, HttpError } from '../lib/http';
import { authenticate, loadAuthUser, signAccess } from '../lib/auth';
import { config } from '../config';
import { randomToken, sha256 } from '../lib/util';
import { getSettings } from '../lib/settings';
import { audit } from '../lib/audit';
import { notify } from '../services/notify';

const r = Router();
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false });

async function issueTokens(userId: string) {
  const u = await loadAuthUser(userId);
  if (!u) throw new HttpError(401, 'Invalid credentials', 'INVALID_CREDENTIALS');
  const refresh = randomToken(48);
  await prisma.refreshToken.create({ data: { userId, tokenHash: sha256(refresh), expiresAt: new Date(Date.now() + config.refreshTtlDays * 864e5) } });
  const full = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { mustChangePassword: true, username: true, phone: true } });
  return { accessToken: signAccess(u), refreshToken: refresh, expiresIn: config.accessTtlSec, user: { ...u, ...full } };
}

const GENERIC = 'The username or password you entered is incorrect.'; // UI-05

r.post('/login', limiter, ah(async (req, res) => {
  const { identifier, password, portal } = z.object({ identifier: z.string().min(1), password: z.string().min(1), portal: z.enum(['staff', 'student']).optional() }).parse(req.body);
  const id = identifier.trim().toLowerCase();
  const user = await prisma.user.findFirst({ where: { OR: [{ email: id }, { username: id }] }, include: { roles: { include: { role: true } } } });
  const s = await getSettings();
  const logFail = () => prisma.loginLog.create({ data: { userId: user?.id, identifier: id, success: false, ip: req.ip, userAgent: req.get('user-agent') } });
  if (!user || !user.isActive) {
    await logFail();
    throw new HttpError(401, GENERIC, 'INVALID_CREDENTIALS');
  }
  if (user.lockedUntil && user.lockedUntil > new Date()) {
    await logFail();
    throw new HttpError(423, 'Too many failed attempts. Please try again later or reset your password.', 'LOCKED');
  }
  if (!(await bcrypt.compare(password, user.passwordHash))) {
    const failed = user.failedLogins + 1;
    await prisma.user.update({
      where: { id: user.id },
      data: { failedLogins: failed, lockedUntil: failed >= s.security.maxFailedLogins ? new Date(Date.now() + s.security.lockMinutes * 60_000) : null },
    });
    await logFail();
    throw new HttpError(401, GENERIC, 'INVALID_CREDENTIALS');
  }
  const isStudent = user.roles.some((x) => x.role.key === 'student');
  if (portal === 'student' && !isStudent) throw new HttpError(403, 'Please use the staff sign-in page.', 'WRONG_PORTAL');
  if (portal === 'staff' && isStudent && user.roles.length === 1) throw new HttpError(403, 'Please use the student sign-in page.', 'WRONG_PORTAL');
  await prisma.user.update({ where: { id: user.id }, data: { failedLogins: 0, lockedUntil: null, lastLoginAt: new Date() } });
  await prisma.loginLog.create({ data: { userId: user.id, identifier: id, success: true, ip: req.ip, userAgent: req.get('user-agent') } });
  res.json(await issueTokens(user.id));
}));

r.post('/refresh', limiter, ah(async (req, res) => {
  const { refreshToken } = z.object({ refreshToken: z.string() }).parse(req.body);
  const row = await prisma.refreshToken.findUnique({ where: { tokenHash: sha256(refreshToken) } });
  if (!row || row.revokedAt || row.expiresAt < new Date()) throw new HttpError(401, 'Your session has expired. Please sign in again.', 'TOKEN_EXPIRED');
  await prisma.refreshToken.update({ where: { id: row.id }, data: { revokedAt: new Date() } }); // rotation
  res.json(await issueTokens(row.userId));
}));

r.post('/logout', ah(async (req, res) => {
  const t = req.body?.refreshToken;
  if (t) await prisma.refreshToken.updateMany({ where: { tokenHash: sha256(t) }, data: { revokedAt: new Date() } });
  res.json({ ok: true });
}));

r.get('/me', authenticate, ah(async (req, res) => {
  const u = await prisma.user.findUniqueOrThrow({ where: { id: req.user!.id }, select: { id: true, name: true, email: true, username: true, phone: true, mustChangePassword: true, designation: true } });
  res.json({ ...u, roles: req.user!.roles, perms: req.user!.perms, studentId: req.user!.studentId });
}));

r.post('/change-password', authenticate, ah(async (req, res) => {
  const s = await getSettings();
  const { currentPassword, newPassword } = z.object({ currentPassword: z.string(), newPassword: z.string().min(s.security.passwordMinLength) }).parse(req.body);
  if (!/[A-Za-z]/.test(newPassword) || !/\d/.test(newPassword)) throw badRequest('Password must contain letters and numbers.');
  const u = await prisma.user.findUniqueOrThrow({ where: { id: req.user!.id } });
  if (!(await bcrypt.compare(currentPassword, u.passwordHash))) throw badRequest('Current password is incorrect.');
  await prisma.user.update({ where: { id: u.id }, data: { passwordHash: await bcrypt.hash(newPassword, 10), mustChangePassword: false } });
  await prisma.refreshToken.updateMany({ where: { userId: u.id, revokedAt: null }, data: { revokedAt: new Date() } });
  await audit(req, 'PASSWORD_CHANGE', 'user', u.id);
  res.json(await issueTokens(u.id));
}));

// FR-AUTH-02: reset via verified email / WhatsApp link. Always responds the same (no account enumeration).
r.post('/forgot-password', limiter, ah(async (req, res) => {
  const { identifier } = z.object({ identifier: z.string().min(1) }).parse(req.body);
  const id = identifier.trim().toLowerCase();
  const user = await prisma.user.findFirst({ where: { OR: [{ email: id }, { username: id }], isActive: true } });
  if (user) {
    const token = randomToken(32);
    await prisma.passwordReset.create({ data: { userId: user.id, tokenHash: sha256(token), expiresAt: new Date(Date.now() + 30 * 60_000) } });
    const link = `${config.publicAppUrl}/reset-password?token=${token}`;
    notify('auth.password_reset', { userId: user.id, name: user.name, email: user.email, phone: user.phone }, { name: user.name, link }, { channels: ['EMAIL', 'WHATSAPP'] }).catch(() => undefined);
  }
  res.json({ ok: true, message: 'If an account exists, a reset link has been sent to the registered email / WhatsApp.' });
}));

r.post('/reset-password', limiter, ah(async (req, res) => {
  const s = await getSettings();
  const { token, newPassword } = z.object({ token: z.string(), newPassword: z.string().min(s.security.passwordMinLength) }).parse(req.body);
  const row = await prisma.passwordReset.findUnique({ where: { tokenHash: sha256(token) } });
  if (!row || row.usedAt || row.expiresAt < new Date()) throw badRequest('This reset link is invalid or has expired. Please request a new one.');
  await prisma.$transaction([
    prisma.user.update({ where: { id: row.userId }, data: { passwordHash: await bcrypt.hash(newPassword, 10), mustChangePassword: false, failedLogins: 0, lockedUntil: null } }),
    prisma.passwordReset.update({ where: { id: row.id }, data: { usedAt: new Date() } }),
    prisma.refreshToken.updateMany({ where: { userId: row.userId, revokedAt: null }, data: { revokedAt: new Date() } }),
  ]);
  res.json({ ok: true });
}));

export default r;
