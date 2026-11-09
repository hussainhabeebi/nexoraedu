/**
 * One-time Super Administrator provisioning (R1, replaces the seeded "admin / Admin@12345").
 *
 *   npm run admin:bootstrap -- --email owner@nexoraed.com --name "Full Name" --username owner
 *   npm run admin:bootstrap -- --second --nomination "MGMT-2026-014" --email second@nexoraed.com --name "Second Admin" --username admin2
 *
 * - Refuses when an active Super Administrator already exists (use --second exactly once for the second
 *   named Super Admin needed for approvals, SRS 22.2 / APR-03).
 * - The account has NO usable password. A single-use activation link (60 min) is printed once; the owner
 *   sets a password that meets the policy and must then enrol MFA before using the portal (SEC-06).
 */
import crypto from 'node:crypto';
import type { PrismaClient } from '#prisma';
import { z } from 'zod';
import { UNUSABLE_PASSWORD } from '../lib/password';
import { sha256 } from '../lib/util';
import { atomic } from '../lib/db';
import { resetPasswordLink } from '../lib/links';

export const ACTIVATION_MINUTES = 60;

export async function bootstrapSuperAdmin(prisma: PrismaClient, a: { email: string; name: string; username: string; phone?: string; second?: boolean; nomination?: string }, publicAppUrl: string) {
  const d = z.object({ email: z.string().email(), name: z.string().min(2), username: z.string().min(3).regex(/^[a-z0-9._-]+$/i), phone: z.string().optional(), second: z.boolean().optional(), nomination: z.string().optional() }).parse(a);
  // Decision 4 (2026-11-05): the second Super Administrator must be nominated by Nexora management.
  // The nomination reference (e.g. board resolution / signed letter id) is mandatory and is kept in the audit log.
  if (d.second && (!d.nomination || d.nomination.trim().length < 5)) throw new Error('--second requires --nomination "<management nomination reference>".');
  return atomic(async (tx) => {
    // Serialise concurrent bootstraps (a concurrent one makes this batch retry and then see the new admin).
    await tx.lock('bootstrap:super_admin');
    const role = await tx.role.findUnique({ where: { key: 'super_admin' } });
    if (!role) throw new Error('Roles are missing. Run `npm run db:seed:reference` first.');
    const active = await tx.user.count({ where: { isActive: true, roles: { some: { roleId: role.id } } } });
    if (!d.second && active > 0) throw new Error('An active Super Administrator already exists. Bootstrap refused.');
    if (d.second && active !== 1) throw new Error('--second requires exactly one existing active Super Administrator.');
    const user = await tx.user.create({
      data: {
        email: d.email.trim().toLowerCase(), username: d.username.toLowerCase(), name: d.name, phone: d.phone,
        passwordHash: UNUSABLE_PASSWORD, mustChangePassword: true, designation: 'Super Administrator', roles: { create: { roleId: role.id } },
      },
    });
    const token = crypto.randomBytes(32).toString('base64url');
    await tx.passwordReset.create({ data: { userId: user.id, purpose: 'ENROLL', tokenHash: sha256(token), expiresAt: new Date(Date.now() + ACTIVATION_MINUTES * 60_000) } });
    await tx.auditLog.create({ data: { action: 'BOOTSTRAP_SUPER_ADMIN', entity: 'user', entityId: user.id, newValues: { username: user.username, email: user.email, second: !!d.second, nomination: d.nomination ?? null } } });
    return { userId: user.id, token, link: resetPasswordLink(token, { activate: true, publicAppUrl }) };
  });
}

/** Why a re-issue was refused (shown to the caller; never contains credentials). */
export class ReissueRefused extends Error {
  constructor(message: string, public status: 404 | 409) {
    super(message);
  }
}

/**
 * Staging only: a fresh single-use activation link for the bootstrapped Super Administrator when the first link
 * was lost or expired. Never creates a user and never changes the password, roles, MFA or sessions.
 * Allowed only while the account has never been activated: no password set, never signed in, no MFA, and no
 * activation link ever used. Every unused activation link is invalidated (expired at once); only the new token's SHA-256 hash
 * is stored; the link expires in ACTIVATION_MINUTES; an audit row records the re-issue (never the token).
 */
export async function reissueActivation(
  prisma: PrismaClient,
  a: { username: string; email: string },
  publicAppUrl: string,
  meta: { ip?: string; userAgent?: string; requestId?: string } = {},
) {
  const d = z.object({ username: z.string().trim().min(3).max(100), email: z.string().trim().email().max(200) }).parse(a);
  return atomic(async (tx) => {
    await tx.lock('bootstrap:super_admin'); // same lock as bootstrap: never overlaps with it or another re-issue
    const u = await tx.user.findFirst({
      where: { username: d.username.toLowerCase(), email: d.email.toLowerCase(), isActive: true, roles: { some: { role: { key: 'super_admin' } } } },
      include: { mfaFactor: { select: { confirmedAt: true } } },
    });
    if (!u) throw new ReissueRefused('No active Super Administrator matches this username and email.', 404);
    const usedLinks = await tx.passwordReset.count({ where: { userId: u.id, purpose: 'ENROLL', usedAt: { not: null } } });
    const reasons = [
      u.passwordHash !== UNUSABLE_PASSWORD || u.passwordChangedAt ? 'a password has already been set' : null,
      u.lastLoginAt ? 'the account has already signed in' : null,
      u.mfaFactor?.confirmedAt ? 'MFA is already enrolled' : null,
      usedLinks ? 'an activation link has already been used' : null,
    ].filter(Boolean);
    if (reasons.length) throw new ReissueRefused(`This account has already been activated (${reasons.join('; ')}). Re-issue refused.`, 409);
    const now = new Date();
    // Invalidate by expiring (not by marking used): "used" keeps meaning a real activation, so a lost re-issued
    // link can itself be replaced while the account is still unactivated.
    const revoked = await tx.passwordReset.updateMany({ where: { userId: u.id, purpose: 'ENROLL', usedAt: null, expiresAt: { gt: now } }, data: { expiresAt: new Date(now.getTime() - 1000) } });
    const token = crypto.randomBytes(32).toString('base64url');
    await tx.passwordReset.create({ data: { userId: u.id, purpose: 'ENROLL', tokenHash: sha256(token), expiresAt: new Date(now.getTime() + ACTIVATION_MINUTES * 60_000) } });
    await tx.auditLog.create({
      data: {
        action: 'BOOTSTRAP_ACTIVATION_REISSUED', entity: 'user', entityId: u.id,
        newValues: { username: u.username, email: u.email, previousLinksInvalidated: revoked.count, expiresInMinutes: ACTIVATION_MINUTES },
        ip: meta.ip, userAgent: meta.userAgent?.slice(0, 300), requestId: meta.requestId,
      },
    });
    return { userId: u.id, token, link: resetPasswordLink(token, { activate: true, publicAppUrl }), previousLinksInvalidated: revoked.count };
  });
}
