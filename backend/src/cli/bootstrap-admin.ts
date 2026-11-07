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
import crypto from 'crypto';
import { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { UNUSABLE_PASSWORD } from '../lib/password';
import { sha256 } from '../lib/util';

export const ACTIVATION_MINUTES = 60;

export async function bootstrapSuperAdmin(prisma: PrismaClient, a: { email: string; name: string; username: string; phone?: string; second?: boolean; nomination?: string }, publicAppUrl: string) {
  const d = z.object({ email: z.string().email(), name: z.string().min(2), username: z.string().min(3).regex(/^[a-z0-9._-]+$/i), phone: z.string().optional(), second: z.boolean().optional(), nomination: z.string().optional() }).parse(a);
  // Decision 4 (2026-11-05): the second Super Administrator must be nominated by Nexora management.
  // The nomination reference (e.g. board resolution / signed letter id) is mandatory and is kept in the audit log.
  if (d.second && (!d.nomination || d.nomination.trim().length < 5)) throw new Error('--second requires --nomination "<management nomination reference>".');
  return prisma.$transaction(async (tx) => {
    // Serialise concurrent bootstraps.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(4242001)`;
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
    return { userId: user.id, token, link: `${publicAppUrl.replace(/\/$/, '')}/reset-password?token=${token}&activate=1` };
  });
}

function arg(name: string) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

if (require.main === module) {
  const prisma = new PrismaClient();
  bootstrapSuperAdmin(prisma, { email: arg('email') ?? '', name: arg('name') ?? '', username: arg('username') ?? '', phone: arg('phone'), second: process.argv.includes('--second'), nomination: arg('nomination') }, process.env.PUBLIC_APP_URL || 'http://localhost:5173')
    .then((r) => {
      console.log('Super Administrator created. Activation link (single use, expires in 60 minutes — share only with the account owner):');
      console.log(`  ${r.link}`);
      console.log('After setting a password the owner must enrol an authenticator app (MFA) before using the portal.');
    })
    .catch((e) => {
      console.error(`Bootstrap failed: ${e.message ?? e}`);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
