/**
 * Single-use account activation links (management decision 8, 2026-11-05): new staff and student accounts get
 * NO password. They receive a link (default 72 h, configurable 1–168 h) to set their own password, which must
 * meet the policy; privileged roles then enrol MFA. Replaces temporary passwords sent by WhatsApp/email.
 */
import type { Prisma } from '#prisma';
import { prisma } from './prisma';
import { getSettings } from './settings';
import { randomToken, sha256 } from './util';
import { type Tx } from './db';
import { resetPasswordLink } from './links';

type Db = Tx | typeof prisma;

export async function issueActivationLink(db: Db, userId: string, opts: { hours?: number } = {}) {
  const s = await getSettings();
  const hours = Math.min(168, Math.max(1, opts.hours ?? s.security.activationHours ?? 72));
  // Any earlier unused activation link stops working.
  await db.passwordReset.updateMany({ where: { userId, purpose: 'ENROLL', usedAt: null, expiresAt: { gt: new Date() } }, data: { expiresAt: new Date() } });
  const token = randomToken(32);
  await db.passwordReset.create({ data: { userId, purpose: 'ENROLL', tokenHash: sha256(token), expiresAt: new Date(Date.now() + hours * 3600_000) } });
  return { link: resetPasswordLink(token, { activate: true }), hours, token };
}

export async function issueResetLink(db: Db, userId: string, minutes = 30) {
  await db.passwordReset.updateMany({ where: { userId, purpose: 'RESET', usedAt: null, expiresAt: { gt: new Date() } }, data: { expiresAt: new Date() } });
  const token = randomToken(32);
  await db.passwordReset.create({ data: { userId, purpose: 'RESET', tokenHash: sha256(token), expiresAt: new Date(Date.now() + minutes * 60_000) } });
  return { link: resetPasswordLink(token), token };
}
