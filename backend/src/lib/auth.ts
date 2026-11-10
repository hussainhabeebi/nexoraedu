/**
 * Authentication core (SEC-05, FR-AUTH-04, SEC-06).
 * - Access JWT (short-lived) carries only {sub, sid, av}; every request re-checks the server-side session,
 *   the idle timeout and the user's authVersion, so deactivation / role changes apply on the next request.
 * - Refresh token lives only in an HttpOnly, Secure, SameSite=Strict cookie; rotation per use; reuse revokes the family.
 */
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import type { NextFunction, Request, Response } from 'express';
import type { Prisma } from '#prisma';
import { config } from '../config';
import { HttpError, forbidden } from './http';
import { hasPerm, MFA_REQUIRED_ROLES } from './permissions';
import { prisma } from './prisma';
import { getSettings } from './settings';
import { randomToken, sha256 } from './util';
import { type Tx } from './db';

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  roles: string[];
  perms: string[];
  studentId?: string | null;
  sessionId?: string;
  /** MFA is required for this user's roles (SEC-06). */
  mfaRequired?: boolean;
  /** This session completed the second factor. */
  mfaVerified?: boolean;
  mustChangePassword?: boolean;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
      id?: string;
    }
  }
}

type Db = Tx | typeof prisma;

export const REFRESH_COOKIE = '__Host-nx_rt';
export const requiresMfa = (roles: string[]) => roles.some((r) => (MFA_REQUIRED_ROLES as readonly string[]).includes(r));

export const signAccess = (userId: string, sessionId: string, authVersion: number) =>
  jwt.sign({ sid: sessionId, av: authVersion }, config.jwtSecret, { subject: userId, expiresIn: config.accessTtlSec, algorithm: 'HS256' });

// ── Effective permissions, cached per user+authVersion (invalidated by any authVersion bump) ──
const permCache = new Map<string, { at: number; v: Omit<AuthUser, 'sessionId' | 'mfaVerified'> }>();
const PERM_TTL = 60_000;
/** Drop cached permissions/MFA flags (e.g. after the security settings change). */
export function clearAuthCache() {
  permCache.clear();
}

export async function loadAuthUser(userId: string, authVersion?: number): Promise<Omit<AuthUser, 'sessionId' | 'mfaVerified'> | null> {
  const key = `${userId}:${authVersion ?? '?'}`;
  const hit = permCache.get(key);
  if (authVersion !== undefined && hit && Date.now() - hit.at < PERM_TTL) return hit.v;
  const u = await prisma.user.findUnique({ where: { id: userId }, include: { roles: { include: { role: true } }, student: true } });
  if (!u || !u.isActive) return null;
  if (authVersion !== undefined && u.authVersion !== authVersion) return null;
  const perms = new Set<string>((u.extraPermissions as string[] | null) ?? []);
  u.roles.forEach((r) => ((r.role.permissions as string[] | null) ?? []).forEach((p) => perms.add(p)));
  const roles = u.roles.map((r) => r.role.key);
  const mfaOn = (await getSettings()).security.mfaRequired === true;
  const v = { id: u.id, name: u.name, email: u.email, roles, perms: [...perms], studentId: u.student?.id, mfaRequired: mfaOn && requiresMfa(roles), mustChangePassword: u.mustChangePassword };
  if (authVersion !== undefined) {
    if (permCache.size > 5000) permCache.clear();
    permCache.set(key, { at: Date.now(), v });
  }
  return v;
}

/** Bump authVersion: invalidates every access token and cached permission set for the user. */
export async function bumpAuthVersion(db: Db, userId: string) {
  await db.user.update({ where: { id: userId }, data: { authVersion: { increment: 1 } } });
}

export async function revokeUserSessions(db: Db, userId: string, reason: string, exceptSessionId?: string) {
  await db.session.updateMany({ where: { userId, revokedAt: null, ...(exceptSessionId && { NOT: { id: exceptSessionId } }) }, data: { revokedAt: new Date(), revokedReason: reason } });
}

/** Creates a session row and returns the opaque refresh token (only ever sent as an HttpOnly cookie). */
export async function createSession(db: Db, p: { userId: string; mfaVerified: boolean; ip?: string; userAgent?: string; familyId?: string; createdAt?: Date; expiresAt?: Date }) {
  const refreshToken = randomToken(48);
  const session = await db.session.create({
    data: {
      userId: p.userId,
      familyId: p.familyId ?? crypto.randomUUID(),
      refreshHash: sha256(refreshToken),
      mfaVerified: p.mfaVerified,
      ip: p.ip,
      userAgent: p.userAgent?.slice(0, 300),
      createdAt: p.createdAt,
      expiresAt: p.expiresAt ?? new Date(Date.now() + config.sessionMaxHours * 3600_000),
    },
  });
  return { session, refreshToken };
}

// ── Cookies (no cookie-parser dependency) ──
export function readCookie(req: Request, name: string): string | undefined {
  const raw = req.headers.cookie;
  if (!raw) return undefined;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}
export function setRefreshCookie(res: Response, token: string) {
  res.cookie(REFRESH_COOKIE, token, { httpOnly: true, secure: true, sameSite: 'strict', path: '/', maxAge: config.sessionMaxHours * 3600_000 });
}
export function clearRefreshCookie(res: Response) {
  res.clearCookie(REFRESH_COOKIE, { httpOnly: true, secure: true, sameSite: 'strict', path: '/' });
}

/** CSRF defence for cookie-authenticated endpoints: custom header + allowed Origin (SEC-07). */
export function assertCsrfSafe(req: Request) {
  if (req.get('x-requested-with') !== 'nexora') throw new HttpError(403, 'Request blocked.', 'CSRF');
  const origin = req.get('origin');
  if (origin && !config.corsOrigins.includes(origin)) throw new HttpError(403, 'Request blocked.', 'CSRF');
}

const LAST_SEEN_WRITE_MS = 60_000;

export async function authenticate(req: Request, _res: Response, next: NextFunction) {
  try {
    const h = req.headers.authorization;
    if (!h?.startsWith('Bearer ')) throw new HttpError(401, 'Please sign in to continue.', 'UNAUTHENTICATED');
    let p: jwt.JwtPayload;
    try {
      p = jwt.verify(h.slice(7), config.jwtSecret, { algorithms: ['HS256'] }) as jwt.JwtPayload;
    } catch {
      throw new HttpError(401, 'Your session has expired. Please sign in again.', 'TOKEN_EXPIRED');
    }
    if (typeof p.sub !== 'string' || typeof p.sid !== 'string' || typeof p.av !== 'number') throw new HttpError(401, 'Your session has expired. Please sign in again.', 'TOKEN_EXPIRED');
    // One query: session + the user's CURRENT authVersion/active flag. The permission cache below is only
    // consulted after this check, so revocation is immediate (never served from a stale cache entry).
    const s = await prisma.session.findUnique({ where: { id: p.sid }, include: { user: { select: { authVersion: true, isActive: true } } } });
    const now = Date.now();
    const st = await getSettings();
    const idleMs = Math.max(1, st.security.sessionTimeoutMin) * 60_000;
    if (!s || s.userId !== p.sub || s.revokedAt || s.expiresAt.getTime() < now) throw new HttpError(401, 'Your session has expired. Please sign in again.', 'SESSION_ENDED');
    if (now - s.lastSeenAt.getTime() > idleMs) {
      await prisma.session.updateMany({ where: { familyId: s.familyId, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: 'IDLE_TIMEOUT' } });
      throw new HttpError(401, 'You were signed out after a period of inactivity.', 'SESSION_IDLE');
    }
    if (!s.user.isActive || s.user.authVersion !== p.av) throw new HttpError(401, 'Your session has expired. Please sign in again.', 'SESSION_ENDED');
    const u = await loadAuthUser(p.sub, p.av);
    if (!u) throw new HttpError(401, 'Your session has expired. Please sign in again.', 'SESSION_ENDED');
    if (now - s.lastSeenAt.getTime() > LAST_SEEN_WRITE_MS) await prisma.session.update({ where: { id: s.id }, data: { lastSeenAt: new Date() } });
    req.user = { ...u, sessionId: s.id, mfaVerified: s.mfaVerified };
    next();
  } catch (e) {
    next(e);
  }
}

/**
 * Blocks business APIs until the session is complete: MFA verified where required (SEC-06)
 * and any forced password change done (ADM-01). Auth endpoints that finish these steps are mounted before it.
 */
export function requireCompleteSession(req: Request, _res: Response, next: NextFunction) {
  const u = req.user;
  if (!u) return next(new HttpError(401, 'Please sign in to continue.', 'UNAUTHENTICATED'));
  if (u.mfaRequired && !u.mfaVerified) return next(new HttpError(403, 'Set up two-factor authentication to continue.', 'MFA_ENROLLMENT_REQUIRED'));
  if (u.mustChangePassword) return next(new HttpError(403, 'Please change your temporary password to continue.', 'PASSWORD_CHANGE_REQUIRED'));
  next();
}

/** Require ANY of the listed permissions. */
export const can =
  (...perms: string[]) =>
  (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(new HttpError(401, 'Please sign in to continue.', 'UNAUTHENTICATED'));
    if (perms.some((p) => hasPerm(req.user!.perms, p))) return next();
    next(forbidden());
  };

export const userCan = (req: Request, p: string) => !!req.user && hasPerm(req.user.perms, p);
export const isSuperAdmin = (u?: AuthUser) => !!u?.roles.includes('super_admin');
