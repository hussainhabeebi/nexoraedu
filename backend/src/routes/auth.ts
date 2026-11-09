/**
 * Authentication API (SRS 26.2, FR-AUTH-01…04, SEC-01, SEC-04…07, UI-05).
 *
 *  POST /auth/login             password step → session, or { mfaRequired, mfaToken }
 *  POST /auth/mfa/verify        second step (TOTP or recovery code) → session
 *  POST /auth/mfa/enroll/start  begin authenticator enrolment (any signed-in user; mandatory for privileged roles)
 *  POST /auth/mfa/enroll/confirm
 *  POST /auth/refresh           rotates the HttpOnly refresh cookie (reuse ⇒ whole family revoked)
 *  POST /auth/logout
 *  GET  /auth/me
 *  POST /auth/change-password
 *  GET|DELETE /auth/sessions[/:id], POST /auth/sessions/revoke-others
 *  POST /auth/forgot-password, /auth/reset-password (also completes first-time activation links)
 */
import { Router, type NextFunction, type Request, type Response } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { D1Store } from '../lib/rate-store';
import { ACTIVATION_MINUTES, bootstrapSuperAdmin } from '../services/bootstrap';

/** Limiters are created in a fixed order at start-up, so every Worker instance uses the same D1 key prefixes. */
let storeSeq = 0;
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { ah, badRequest, HttpError } from '../lib/http';
import {
  assertCsrfSafe, authenticate, clearRefreshCookie, createSession, loadAuthUser, readCookie, REFRESH_COOKIE,
  requireCompleteSession, requiresMfa, revokeUserSessions, setRefreshCookie, signAccess,
} from '../lib/auth';
import { config } from '../config';
import { randomToken, sha256, encrypt, decrypt } from '../lib/util';
import { getSettings } from '../lib/settings';
import { audit, securityEvent } from '../lib/audit';
import { assertNotReused, assertPasswordPolicy, BCRYPT_COST, hashPassword, setPassword } from '../lib/password';
import { newTotpSecret, otpauthUrl, verifyTotp } from '../lib/totp';
import { notify } from '../services/notify';
import { atomic } from '../lib/db';

const r = Router();
const RATE_WINDOW_MS = 15 * 60 * 1000;
const RATE_LIMITED = { error: { code: 'RATE_LIMIT', message: 'Too many attempts. Please wait a few minutes and try again.' } };

/** Per-IP limit (password reset: AUTH_RATE_LIMIT, default 30 per 15 min, unchanged). */
export function makeAuthLimiter(limit: number) {
  return rateLimit({ windowMs: RATE_WINDOW_MS, limit, standardHeaders: true, legacyHeaders: false, store: new D1Store(`auth:${++storeSeq}:`), message: RATE_LIMITED });
}
const limiter = makeAuthLimiter(Number(process.env.AUTH_RATE_LIMIT || 30));

/**
 * Sign-in limits for a whole office behind one connection (a 9 am rush of 15+ staff exhausted a 30-per-IP limit,
 * because each sign-in is a password step plus an MFA step):
 *  - per IP + username (AUTH_ACCOUNT_RATE_LIMIT, default 10 / 15 min): guessing one account stays tightly limited,
 *    on top of the existing account lockout after repeated wrong passwords;
 *  - per IP for all sign-in steps together (AUTH_IP_RATE_LIMIT, default 100 / 15 min): still stops one connection
 *    trying many usernames (credential stuffing), with room for a full office.
 * MFA codes are additionally limited per challenge (MFA_MAX_ATTEMPTS).
 */
export function makeSignInLimiters(o: { perAccount: number; perIp: number }) {
  const perIp = rateLimit({ windowMs: RATE_WINDOW_MS, limit: o.perIp, standardHeaders: true, legacyHeaders: false, store: new D1Store(`auth:${++storeSeq}:`), message: RATE_LIMITED, keyGenerator: (req) => `signin-ip:${ipKeyGenerator(req.ip ?? '')}` });
  const perAccount = rateLimit({
    windowMs: RATE_WINDOW_MS, limit: o.perAccount, standardHeaders: true, legacyHeaders: false, store: new D1Store(`auth:${++storeSeq}:`), message: RATE_LIMITED,
    keyGenerator: (req) => `signin-acct:${ipKeyGenerator(req.ip ?? '')}:${String(req.body?.identifier ?? '').trim().toLowerCase().slice(0, 200)}`,
  });
  return { login: [perIp, perAccount], mfa: [perIp] };
}
const signIn = makeSignInLimiters({ perAccount: Number(process.env.AUTH_ACCOUNT_RATE_LIMIT || 10), perIp: Number(process.env.AUTH_IP_RATE_LIMIT || 100) });

/**
 * P1: session refresh has its OWN limits and never consumes the login allowance. A refresh needs the HttpOnly
 * refresh cookie (a 384-bit random token), so it is not a password-guessing route, and it runs on every page load —
 * counting it per IP signed out whole offices sharing one connection.
 *  - with a known session: limited per session family (stable across token rotation), so one person's reloads
 *    never affect a colleague on the same connection;
 *  - without one (no / unknown cookie, e.g. opening the login page): limited per IP, more generously than login.
 */
export function makeRefreshLimiters(o: { perSession: number; anonymous: number }) {
  const known = (req: Request) => typeof (req as any).refreshFamily === 'string';
  const identify = async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const t = readCookie(req, REFRESH_COOKIE);
      if (t) {
        const s = await prisma.session.findUnique({ where: { refreshHash: sha256(t) }, select: { familyId: true } });
        if (s) (req as any).refreshFamily = s.familyId;
      }
      next();
    } catch (e) {
      next(e);
    }
  };
  const perSession = rateLimit({ windowMs: RATE_WINDOW_MS, limit: o.perSession, standardHeaders: true, legacyHeaders: false, store: new D1Store(`auth:${++storeSeq}:`), message: RATE_LIMITED, skip: (req) => !known(req), keyGenerator: (req) => `fam:${(req as any).refreshFamily}` });
  const anonymous = rateLimit({ windowMs: RATE_WINDOW_MS, limit: o.anonymous, standardHeaders: true, legacyHeaders: false, store: new D1Store(`auth:${++storeSeq}:`), message: RATE_LIMITED, skip: known, keyGenerator: (req) => `anon:${ipKeyGenerator(req.ip ?? '')}` });
  return [identify, perSession, anonymous];
}
const refreshLimiters = makeRefreshLimiters({ perSession: Number(process.env.REFRESH_RATE_LIMIT || 120), anonymous: Number(process.env.REFRESH_ANON_RATE_LIMIT || 300) });

const GENERIC = 'The username or password you entered is incorrect.'; // UI-05: same for unknown, wrong, inactive and locked
const MFA_GENERIC = 'The code is incorrect or has expired. Please try again.';
const MFA_CHALLENGE_MINUTES = 5;
const MFA_MAX_ATTEMPTS = 5;
const REFRESH_RACE_GRACE_MS = Number(process.env.REFRESH_RACE_GRACE_MS ?? 20_000);
let dummy: Promise<string> | null = null;
const dummyHash = () => (dummy ??= bcrypt.hash(crypto.randomBytes(16).toString('hex'), BCRYPT_COST));

async function userPayload(userId: string, mfaVerified: boolean) {
  const u = await loadAuthUser(userId);
  if (!u) throw new HttpError(401, GENERIC, 'INVALID_CREDENTIALS');
  const full = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { username: true, phone: true, authVersion: true, mfaFactor: { select: { confirmedAt: true } } } });
  return { u, full, user: { ...u, username: full.username, phone: full.phone, mfaEnrolled: !!full.mfaFactor?.confirmedAt, mfaVerified } };
}

/** Creates a session, sets the refresh cookie and returns the response body (no refresh token in JSON). */
async function issue(req: Request, res: Response, userId: string, mfaVerified: boolean) {
  const { session, refreshToken } = await createSession(prisma, { userId, mfaVerified, ip: req.ip, userAgent: req.get('user-agent') });
  const { u, full, user } = await userPayload(userId, mfaVerified);
  setRefreshCookie(res, refreshToken);
  return {
    accessToken: signAccess(userId, session.id, full.authVersion),
    expiresIn: config.accessTtlSec,
    user,
    mfaEnrollmentRequired: !!u.mfaRequired && !mfaVerified,
    passwordChangeRequired: !!u.mustChangePassword,
  };
}

async function registerFailure(req: Request, user: { id: string; name: string; email: string; phone: string | null; failedLogins: number }, identifier: string, event: string) {
  const s = await getSettings();
  const failed = user.failedLogins + 1;
  const lock = failed >= s.security.maxFailedLogins;
  await atomic(async (tx) => {
    await tx.user.update({ where: { id: user.id }, data: { failedLogins: failed, lockedUntil: lock ? new Date(Date.now() + s.security.lockMinutes * 60_000) : undefined } });
    await securityEvent(tx, req, { event, userId: user.id, identifier, success: false });
    if (lock) await securityEvent(tx, req, { event: 'LOCKED', userId: user.id, identifier, success: false });
  });
  if (lock) notify('security.account_locked', { userId: user.id, name: user.name, email: user.email, phone: user.phone }, { name: user.name, minutes: s.security.lockMinutes }, { channels: ['IN_APP', 'EMAIL'] }).catch(() => undefined);
}

// ── Password step ──
r.post('/login', ...signIn.login, ah(async (req, res) => {
  const { identifier, password, portal } = z.object({ identifier: z.string().min(1).max(200), password: z.string().min(1).max(200), portal: z.enum(['staff', 'student']).optional() }).parse(req.body);
  const id = identifier.trim().toLowerCase();
  const user = await prisma.user.findFirst({ where: { OR: [{ email: id }, { username: id }] }, include: { roles: { include: { role: true } }, mfaFactor: true } });
  const fail = async (event: string) => {
    await securityEvent(prisma, req, { event, userId: user?.id, identifier: id, success: false });
    throw new HttpError(401, GENERIC, 'INVALID_CREDENTIALS');
  };
  if (!user || !user.isActive) {
    await bcrypt.compare(password, await dummyHash()); // equalise timing for unknown accounts
    return fail('LOGIN_FAIL');
  }
  if (user.lockedUntil && user.lockedUntil > new Date()) return fail('LOCKED'); // SEC-01, response identical (S21)
  if (!user.passwordHash.startsWith('$2') || !(await bcrypt.compare(password, user.passwordHash))) {
    await registerFailure(req, user, id, 'LOGIN_FAIL');
    throw new HttpError(401, GENERIC, 'INVALID_CREDENTIALS');
  }
  const roleKeys = user.roles.map((x) => x.role.key);
  const isStudent = roleKeys.includes('student');
  if (portal === 'student' && !isStudent) throw new HttpError(403, 'Please use the staff sign-in page.', 'WRONG_PORTAL');
  if (portal === 'staff' && isStudent && roleKeys.length === 1) throw new HttpError(403, 'Please use the student sign-in page.', 'WRONG_PORTAL');
  // Opportunistic re-hash to the current bcrypt cost.
  const rehash = bcrypt.getRounds(user.passwordHash) < BCRYPT_COST ? await hashPassword(password) : undefined;
  await prisma.user.update({ where: { id: user.id }, data: { failedLogins: 0, lockedUntil: null, ...(rehash && { passwordHash: rehash }) } });

  if (user.mfaFactor?.confirmedAt) {
    const token = randomToken(32);
    await prisma.mfaChallenge.create({ data: { userId: user.id, tokenHash: sha256(token), portal, expiresAt: new Date(Date.now() + MFA_CHALLENGE_MINUTES * 60_000) } });
    await securityEvent(prisma, req, { event: 'PASSWORD_OK_MFA_PENDING', userId: user.id, identifier: id, success: true });
    return res.json({ mfaRequired: true, mfaToken: token, expiresIn: MFA_CHALLENGE_MINUTES * 60 });
  }
  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
  await securityEvent(prisma, req, { event: requiresMfa(roleKeys) ? 'LOGIN_OK_MFA_ENROLMENT_REQUIRED' : 'LOGIN_OK', userId: user.id, identifier: id, success: true });
  res.json(await issue(req, res, user.id, false));
}));

// ── Second factor ──
r.post('/mfa/verify', ...signIn.mfa, ah(async (req, res) => {
  const d = z.object({ mfaToken: z.string().min(10), code: z.string().trim().optional(), recoveryCode: z.string().trim().optional() }).refine((x) => x.code || x.recoveryCode, 'Enter a code').parse(req.body);
  const ch = await prisma.mfaChallenge.findUnique({ where: { tokenHash: sha256(d.mfaToken) } });
  if (!ch || ch.usedAt || ch.expiresAt < new Date() || ch.attempts >= MFA_MAX_ATTEMPTS) throw new HttpError(401, 'Your sign-in attempt expired. Please sign in again.', 'MFA_CHALLENGE_EXPIRED');
  const user = await prisma.user.findUniqueOrThrow({ where: { id: ch.userId }, include: { mfaFactor: true } });
  if (!user.isActive || (user.lockedUntil && user.lockedUntil > new Date()) || !user.mfaFactor?.confirmedAt) throw new HttpError(401, 'Your sign-in attempt expired. Please sign in again.', 'MFA_CHALLENGE_EXPIRED');

  let ok = false;
  if (d.code) {
    const step = verifyTotp(decrypt(user.mfaFactor.secretEnc), d.code, { afterStep: user.mfaFactor.lastUsedStep });
    // Conditional update makes the step single-use even under concurrent requests (replay protection).
    if (step !== null) ok = (await prisma.mfaFactor.updateMany({ where: { id: user.mfaFactor.id, lastUsedStep: { lt: step } }, data: { lastUsedStep: step } })).count === 1;
  } else if (d.recoveryCode) {
    const hash = sha256(d.recoveryCode.toLowerCase().replace(/[^a-z0-9]/g, ''));
    ok = (await prisma.mfaRecoveryCode.updateMany({ where: { userId: user.id, codeHash: hash, usedAt: null }, data: { usedAt: new Date() } })).count === 1;
  }
  if (!ok) {
    await prisma.mfaChallenge.update({ where: { id: ch.id }, data: { attempts: { increment: 1 } } });
    await registerFailure(req, user, user.username, 'MFA_FAIL');
    throw new HttpError(401, MFA_GENERIC, 'MFA_INVALID');
  }
  const used = await prisma.mfaChallenge.updateMany({ where: { id: ch.id, usedAt: null }, data: { usedAt: new Date() } });
  if (used.count !== 1) throw new HttpError(401, 'Your sign-in attempt expired. Please sign in again.', 'MFA_CHALLENGE_EXPIRED');
  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date(), failedLogins: 0 } });
  await securityEvent(prisma, req, { event: d.recoveryCode ? 'MFA_OK_RECOVERY_CODE' : 'MFA_OK', userId: user.id, identifier: user.username, success: true });
  res.json(await issue(req, res, user.id, true));
}));

// ── Refresh (cookie) with rotation and reuse detection ──
r.post('/refresh', ...refreshLimiters, ah(async (req, res) => {
  assertCsrfSafe(req);
  const token = readCookie(req, REFRESH_COOKIE);
  const expired = () => {
    clearRefreshCookie(res);
    return new HttpError(401, 'Your session has expired. Please sign in again.', 'SESSION_ENDED');
  };
  if (!token) throw expired();
  const s = await prisma.session.findUnique({ where: { refreshHash: sha256(token) } });
  if (!s) throw expired();
  if (s.revokedAt) {
    if (s.revokedReason === 'ROTATED') {
      if (Date.now() - s.revokedAt.getTime() < REFRESH_RACE_GRACE_MS) throw new HttpError(401, 'Please retry.', 'REFRESH_RACE'); // parallel tabs
      await atomic(async (tx) => {
        await tx.session.updateMany({ where: { familyId: s.familyId, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: 'TOKEN_REUSE' } });
        await securityEvent(tx, req, { event: 'TOKEN_REUSE', userId: s.userId, success: false });
      });
      const u = await prisma.user.findUnique({ where: { id: s.userId } });
      if (u) notify('security.session_reuse', { userId: u.id, name: u.name, email: u.email, phone: u.phone }, { name: u.name }, { channels: ['IN_APP', 'EMAIL'] }).catch(() => undefined);
    }
    throw expired();
  }
  const st = await getSettings();
  if (s.expiresAt < new Date() || Date.now() - s.lastSeenAt.getTime() > st.security.sessionTimeoutMin * 60_000) {
    await prisma.session.update({ where: { id: s.id }, data: { revokedAt: new Date(), revokedReason: 'IDLE_TIMEOUT' } });
    throw expired();
  }
  if (!(await loadAuthUser(s.userId))) throw expired();
  const next = await atomic(async (tx) => {
    const rotated = await tx.session.updateMany({ where: { id: s.id, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: 'ROTATED' } });
    if (rotated.count !== 1) throw new HttpError(401, 'Please retry.', 'REFRESH_RACE');
    return createSession(tx, { userId: s.userId, familyId: s.familyId, mfaVerified: s.mfaVerified, ip: req.ip, userAgent: req.get('user-agent'), createdAt: s.createdAt, expiresAt: s.expiresAt });
  });
  const { full, user, u } = await userPayload(s.userId, s.mfaVerified);
  setRefreshCookie(res, next.refreshToken);
  res.json({ accessToken: signAccess(s.userId, next.session.id, full.authVersion), expiresIn: config.accessTtlSec, user, mfaEnrollmentRequired: !!u.mfaRequired && !s.mfaVerified, passwordChangeRequired: !!u.mustChangePassword });
}));

r.post('/logout', ah(async (req, res) => {
  const token = readCookie(req, REFRESH_COOKIE);
  const s = token ? await prisma.session.findUnique({ where: { refreshHash: sha256(token) } }) : null;
  if (s) {
    assertCsrfSafe(req);
    await atomic(async (tx) => {
      await tx.session.updateMany({ where: { familyId: s.familyId, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: 'LOGOUT' } });
      await securityEvent(tx, req, { event: 'LOGOUT', userId: s.userId, success: true });
    });
  }
  clearRefreshCookie(res);
  res.json({ ok: true });
}));

r.get('/me', authenticate, ah(async (req, res) => {
  const u = await prisma.user.findUniqueOrThrow({ where: { id: req.user!.id }, select: { id: true, name: true, email: true, username: true, phone: true, mustChangePassword: true, designation: true, mfaFactor: { select: { confirmedAt: true } } } });
  const { mfaFactor, ...rest } = u;
  res.json({ ...rest, roles: req.user!.roles, perms: req.user!.perms, studentId: req.user!.studentId, mfaRequired: !!req.user!.mfaRequired, mfaEnrolled: !!mfaFactor?.confirmedAt, mfaVerified: !!req.user!.mfaVerified });
}));

// ── MFA enrolment (allowed in an incomplete session so privileged users can finish set-up) ──
r.post('/mfa/enroll/start', authenticate, ah(async (req, res) => {
  const existing = await prisma.mfaFactor.findUnique({ where: { userId: req.user!.id } });
  if (existing?.confirmedAt) throw new HttpError(409, 'Two-factor authentication is already set up. Ask a Super Administrator to reset it if you lost your device.', 'MFA_ALREADY_ENROLLED');
  const secret = newTotpSecret();
  await prisma.mfaFactor.upsert({ where: { userId: req.user!.id }, create: { userId: req.user!.id, secretEnc: encrypt(secret) }, update: { secretEnc: encrypt(secret), lastUsedStep: 0 } });
  const u = await prisma.user.findUniqueOrThrow({ where: { id: req.user!.id }, select: { username: true } });
  res.json({ secret, otpauthUrl: otpauthUrl(secret, u.username) });
}));

r.post('/mfa/enroll/confirm', authenticate, ah(async (req, res) => {
  const { code } = z.object({ code: z.string().trim() }).parse(req.body);
  const f = await prisma.mfaFactor.findUnique({ where: { userId: req.user!.id } });
  if (!f || f.confirmedAt) throw badRequest('Start the set-up again.');
  const step = verifyTotp(decrypt(f.secretEnc), code);
  if (step === null) throw new HttpError(400, MFA_GENERIC, 'MFA_INVALID');
  const codes = Array.from({ length: 10 }, () => crypto.randomBytes(6).toString('hex'));
  await atomic(async (tx) => {
    await tx.mfaFactor.update({ where: { id: f.id }, data: { confirmedAt: new Date(), lastUsedStep: step } });
    await tx.mfaRecoveryCode.deleteMany({ where: { userId: f.userId } });
    await tx.mfaRecoveryCode.createMany({ data: codes.map((c) => ({ userId: f.userId, codeHash: sha256(c) })) });
    await tx.session.update({ where: { id: req.user!.sessionId! }, data: { mfaVerified: true } });
    await securityEvent(tx, req, { event: 'MFA_ENROLLED', userId: f.userId, success: true });
    await audit(tx, req, 'MFA_ENROLL', 'user', f.userId);
  });
  res.json({ ok: true, recoveryCodes: codes.map((c) => `${c.slice(0, 4)}-${c.slice(4, 8)}-${c.slice(8)}`) });
}));

// ── Password change (allowed in an incomplete session: forced first-login change) ──
r.post('/change-password', authenticate, ah(async (req, res) => {
  const s = await getSettings();
  const { currentPassword, newPassword } = z.object({ currentPassword: z.string().max(200), newPassword: z.string().max(200) }).parse(req.body);
  const u = await prisma.user.findUniqueOrThrow({ where: { id: req.user!.id } });
  if (!u.passwordHash.startsWith('$2') || !(await bcrypt.compare(currentPassword, u.passwordHash))) throw badRequest('Current password is incorrect.');
  assertPasswordPolicy(newPassword, { minLength: s.security.passwordMinLength, username: u.username, email: u.email, name: u.name });
  await assertNotReused(prisma, u.id, newPassword);
  await atomic(async (tx) => {
    await setPassword(tx, u.id, newPassword);
    await revokeUserSessions(tx, u.id, 'PASSWORD_CHANGE', req.user!.sessionId);
    await securityEvent(tx, req, { event: 'PASSWORD_CHANGE', userId: u.id, success: true });
    await audit(tx, req, 'PASSWORD_CHANGE', 'user', u.id);
  });
  // authVersion changed: hand the current session a fresh access token.
  const fresh = await prisma.user.findUniqueOrThrow({ where: { id: u.id }, select: { authVersion: true } });
  const { user, u: au } = await userPayload(u.id, !!req.user!.mfaVerified);
  res.json({ accessToken: signAccess(u.id, req.user!.sessionId!, fresh.authVersion), expiresIn: config.accessTtlSec, user, mfaEnrollmentRequired: !!au.mfaRequired && !req.user!.mfaVerified, passwordChangeRequired: false });
}));

// ── Active sessions (SEC-05: view and end sessions) ──
r.get('/sessions', authenticate, requireCompleteSession, ah(async (req, res) => {
  const items = await prisma.session.findMany({ where: { userId: req.user!.id, revokedAt: null, expiresAt: { gt: new Date() } }, orderBy: { lastSeenAt: 'desc' }, select: { id: true, familyId: true, ip: true, userAgent: true, createdAt: true, lastSeenAt: true, mfaVerified: true } });
  const current = await prisma.session.findUnique({ where: { id: req.user!.sessionId! }, select: { familyId: true } });
  res.json({ items: items.map((s) => ({ ...s, current: s.familyId === current?.familyId })) });
}));
r.delete('/sessions/:id', authenticate, requireCompleteSession, ah(async (req, res) => {
  const s = await prisma.session.findFirst({ where: { id: req.params.id, userId: req.user!.id } });
  if (!s) throw new HttpError(404, 'Session not found.', 'NOT_FOUND');
  await atomic(async (tx) => {
    await tx.session.updateMany({ where: { familyId: s.familyId, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: 'USER_REVOKED' } });
    await securityEvent(tx, req, { event: 'SESSION_REVOKED', userId: req.user!.id, success: true });
  });
  res.json({ ok: true });
}));
r.post('/sessions/revoke-others', authenticate, requireCompleteSession, ah(async (req, res) => {
  const cur = await prisma.session.findUniqueOrThrow({ where: { id: req.user!.sessionId! } });
  const n = await atomic(async (tx) => {
    const x = await tx.session.updateMany({ where: { userId: req.user!.id, revokedAt: null, NOT: { familyId: cur.familyId } }, data: { revokedAt: new Date(), revokedReason: 'USER_REVOKED' } });
    await securityEvent(tx, req, { event: 'SESSION_REVOKED', userId: req.user!.id, success: true });
    return x.count;
  });
  res.json({ ok: true, revoked: n });
}));

// ── FR-AUTH-02 reset via verified email / WhatsApp link; also first-time activation (purpose ENROLL) ──
r.post('/forgot-password', limiter, ah(async (req, res) => {
  const { identifier } = z.object({ identifier: z.string().min(1).max(200) }).parse(req.body);
  const id = identifier.trim().toLowerCase();
  const user = await prisma.user.findFirst({ where: { OR: [{ email: id }, { username: id }], isActive: true } });
  if (user) {
    const token = randomToken(32);
    await prisma.passwordReset.create({ data: { userId: user.id, purpose: 'RESET', tokenHash: sha256(token), expiresAt: new Date(Date.now() + 30 * 60_000) } });
    const link = `${config.publicAppUrl}/reset-password?token=${token}`;
    notify('auth.password_reset', { userId: user.id, name: user.name, email: user.email, phone: user.phone }, { name: user.name, link }, { channels: ['EMAIL', 'WHATSAPP'], sensitive: true }).catch(() => undefined);
  }
  res.json({ ok: true, message: 'If an account exists, a reset link has been sent to the registered email / WhatsApp.' });
}));

r.post('/reset-password', limiter, ah(async (req, res) => {
  const s = await getSettings();
  const { token, newPassword } = z.object({ token: z.string().min(10).max(200), newPassword: z.string().max(200) }).parse(req.body);
  const row = await prisma.passwordReset.findUnique({ where: { tokenHash: sha256(token) } });
  if (!row || row.usedAt || row.expiresAt < new Date()) throw badRequest('This link is invalid or has expired. Please request a new one.');
  const u = await prisma.user.findUniqueOrThrow({ where: { id: row.userId } });
  if (!u.isActive) throw badRequest('This link is invalid or has expired. Please request a new one.');
  assertPasswordPolicy(newPassword, { minLength: s.security.passwordMinLength, username: u.username, email: u.email, name: u.name });
  await assertNotReused(prisma, u.id, newPassword);
  await atomic(async (tx) => {
    const used = await tx.passwordReset.updateMany({ where: { id: row.id, usedAt: null }, data: { usedAt: new Date() } });
    if (used.count !== 1) throw badRequest('This link is invalid or has expired. Please request a new one.');
    await setPassword(tx, u.id, newPassword);
    await revokeUserSessions(tx, u.id, row.purpose === 'ENROLL' ? 'ACTIVATED' : 'PASSWORD_RESET');
    await securityEvent(tx, req, { event: row.purpose === 'ENROLL' ? 'ACCOUNT_ACTIVATED' : 'PASSWORD_RESET', userId: u.id, success: true });
    await audit(tx, req, row.purpose === 'ENROLL' ? 'ACCOUNT_ACTIVATED' : 'PASSWORD_RESET', 'user', u.id);
  });
  res.json({ ok: true });
}));

/**
 * One-time Super Administrator provisioning on Cloudflare (replaces `npm run admin:bootstrap` on a server).
 * Enabled only while the secret BOOTSTRAP_TOKEN (≥ 32 random characters) is set on the Worker; send it in the
 * X-Bootstrap-Token header. Same rules as the CLI: refused while an active Super Admin exists (except one
 * `second` with a management nomination). Returns the single-use activation link. Delete the secret afterwards.
 */
r.post('/bootstrap', limiter, ah(async (req, res) => {
  const expected = process.env.BOOTSTRAP_TOKEN ?? '';
  const given = req.get('x-bootstrap-token') ?? '';
  const ok = expected.length >= 32 && given.length === expected.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
  if (!ok) throw new HttpError(404, 'Not found', 'NOT_FOUND');
  const d = z.object({ email: z.string().email(), name: z.string().min(2), username: z.string().min(3), phone: z.string().optional(), second: z.boolean().optional(), nomination: z.string().optional() }).parse(req.body);
  try {
    const out = await bootstrapSuperAdmin(prisma as any, d, config.publicAppUrl);
    res.status(201).json({ userId: out.userId, activationLink: out.link, expiresInMinutes: ACTIVATION_MINUTES, next: 'Open the link, set a password, then enrol an authenticator app. Then delete BOOTSTRAP_TOKEN from the Worker secrets.' });
  } catch (e: any) {
    if (e instanceof HttpError || e?.name === 'ZodError') throw e;
    throw new HttpError(409, String(e?.message ?? e), 'BOOTSTRAP_REFUSED');
  }
}));

export default r;
