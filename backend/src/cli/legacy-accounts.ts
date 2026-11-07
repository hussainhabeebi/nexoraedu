/**
 * Finds (and optionally deactivates) accounts created by the pre-hardening seed: the default "admin"
 * (password Admin@12345) and the 11 demo staff users. DRY-RUN by default. Operator use only, after approval.
 *
 *   npm run accounts:legacy            # report only, changes nothing
 *   npm run accounts:legacy -- --apply # deactivate, end sessions, audit-log
 */
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import { LEGACY_DEFAULT_USERNAMES, DEMO_USERNAMES } from '../seed/demo';

export const LEGACY_DEFAULT_PASSWORD = 'Admin@12345';

export async function findLegacyAccounts(prisma: PrismaClient) {
  const users = await prisma.user.findMany({ where: { username: { in: LEGACY_DEFAULT_USERNAMES } }, select: { id: true, username: true, email: true, isActive: true, passwordHash: true, lastLoginAt: true } });
  const out = [];
  for (const u of users) {
    const defaultPassword = u.passwordHash.startsWith('$2') && (await bcrypt.compare(LEGACY_DEFAULT_PASSWORD, u.passwordHash));
    const demo = DEMO_USERNAMES.includes(u.username) && u.email.endsWith('@nexoraed.com');
    out.push({ id: u.id, username: u.username, email: u.email, isActive: u.isActive, lastLoginAt: u.lastLoginAt, defaultPassword, legacyDemo: demo, risky: u.isActive && (defaultPassword || demo) });
  }
  return out;
}

export async function deactivateLegacyAccounts(prisma: PrismaClient) {
  const risky = (await findLegacyAccounts(prisma)).filter((a) => a.risky);
  for (const a of risky) {
    await prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: a.id }, data: { isActive: false, authVersion: { increment: 1 } } });
      await tx.session.updateMany({ where: { userId: a.id, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: 'LEGACY_ACCOUNT_DISABLED' } });
      await tx.auditLog.create({ data: { action: 'DEACTIVATE_LEGACY_ACCOUNT', entity: 'user', entityId: a.id, newValues: { username: a.username, defaultPassword: a.defaultPassword, legacyDemo: a.legacyDemo } } });
    });
  }
  return risky;
}

if (require.main === module) {
  const prisma = new PrismaClient();
  const apply = process.argv.includes('--apply');
  (apply ? deactivateLegacyAccounts(prisma) : findLegacyAccounts(prisma))
    .then((rows) => {
      console.table(rows.map(({ id: _id, ...r }) => r));
      console.log(apply ? `Deactivated ${rows.length} account(s).` : 'Dry run: nothing changed. Re-run with --apply to deactivate the rows marked risky.');
    })
    .catch((e) => {
      console.error(e);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
