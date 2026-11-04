import jwt from 'jsonwebtoken';
import type { NextFunction, Request, Response } from 'express';
import { config } from '../config';
import { HttpError, forbidden } from './http';
import { hasPerm } from './permissions';
import { prisma } from './prisma';

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  roles: string[];
  perms: string[];
  studentId?: string | null;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export const signAccess = (u: AuthUser) =>
  jwt.sign({ sub: u.id, name: u.name, email: u.email, roles: u.roles, perms: u.perms, sid: u.studentId ?? null }, config.jwtSecret, {
    expiresIn: config.accessTtlSec,
  });

export async function loadAuthUser(userId: string): Promise<AuthUser | null> {
  const u = await prisma.user.findUnique({ where: { id: userId }, include: { roles: { include: { role: true } }, student: true } });
  if (!u || !u.isActive) return null;
  const perms = new Set<string>(u.extraPermissions);
  u.roles.forEach((r) => r.role.permissions.forEach((p) => perms.add(p)));
  return { id: u.id, name: u.name, email: u.email, roles: u.roles.map((r) => r.role.key), perms: [...perms], studentId: u.student?.id };
}

export function authenticate(req: Request, _res: Response, next: NextFunction) {
  const h = req.headers.authorization;
  if (!h?.startsWith('Bearer ')) return next(new HttpError(401, 'Please sign in to continue.', 'UNAUTHENTICATED'));
  try {
    const p = jwt.verify(h.slice(7), config.jwtSecret) as any;
    req.user = { id: p.sub, name: p.name, email: p.email, roles: p.roles, perms: p.perms, studentId: p.sid };
    next();
  } catch {
    next(new HttpError(401, 'Your session has expired. Please sign in again.', 'TOKEN_EXPIRED'));
  }
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
