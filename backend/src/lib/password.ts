/**
 * Password policy (SEC-04): ≥10 characters, 3 of 4 character classes, not based on the user's name,
 * not a common/breached password, not one of the last 5 passwords. bcrypt cost 12.
 */
import bcrypt from 'bcryptjs';
import type { Prisma } from '@prisma/client';
import { prisma } from './prisma';
import { badRequest } from './http';

export const BCRYPT_COST = 12;
export const MIN_LENGTH_FLOOR = 10;
export const HISTORY_DEPTH = 5;

/**
 * Common and breached base passwords (lower-case). Matched exactly, and also after removing
 * non-letters (so "Password@123" matches "password"). Extend with a full breached list before go-live.
 */
const COMMON = new Set(
  `password passw0rd p@ssword p@ssw0rd pass1234 password1 password12 password123 qwerty qwertyuiop qwerty123 asdfgh asdfghjkl zxcvbnm
  letmein welcome welcome1 welcome123 admin admin123 administrator root toor login master monkey dragon football baseball cricket
  iloveyou princess sunshine shadow superman batman trustno1 abc123 abcdef abcd1234 123456 1234567 12345678 123456789 1234567890
  111111 000000 654321 123123 121212 112233 987654321 qazwsx qazwsxedc 1q2w3e4r 1qaz2wsx zaq12wsx changeme changeme123 default
  secret secret123 test test123 testing guest guest123 user user123 hello hello123 india india123 kerala kochi chennai mumbai
  student student123 teacher academy academy123 college school school123 nexora nexoraacademy nexoraed nexoraedu nexora123
  summer winter spring autumn january february march april june july august september october november december
  monday tuesday friday sunday computer internet samsung iphone google facebook whatsapp instagram
  michael jennifer jessica charlie daniel thomas andrew joshua matthew anthony robert william`
    .split(/\s+/)
    .filter(Boolean),
);
const lettersOnly = (s: string) => s.toLowerCase().replace(/[^a-z]/g, '');

export function passwordProblems(pw: string, opts: { minLength?: number; username?: string | null; email?: string | null; name?: string | null } = {}): string[] {
  const p: string[] = [];
  const min = Math.max(MIN_LENGTH_FLOOR, opts.minLength ?? MIN_LENGTH_FLOOR);
  if (pw.length < min) p.push(`Use at least ${min} characters.`);
  if (pw.length > 128) p.push('Use at most 128 characters.');
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(pw)).length;
  if (classes < 3) p.push('Use at least three of: lower-case letters, upper-case letters, numbers, symbols.');
  const lower = pw.toLowerCase();
  if (COMMON.has(lower) || (lettersOnly(pw).length >= 3 && COMMON.has(lettersOnly(pw)))) p.push('This password is too common. Choose something less predictable.');
  const personal = [opts.username, opts.email?.split('@')[0], ...(opts.name?.split(/\s+/) ?? [])]
    .map((s) => (s ?? '').toLowerCase())
    .filter((s) => s.length >= 4);
  if (personal.some((s) => lower.includes(s))) p.push('Do not include your name, username or email in the password.');
  return p;
}

export function assertPasswordPolicy(pw: string, opts: Parameters<typeof passwordProblems>[1]) {
  const problems = passwordProblems(pw, opts);
  if (problems.length) throw badRequest(problems.join(' '), { password: problems });
}

export const hashPassword = (pw: string) => bcrypt.hash(pw, BCRYPT_COST);

type Db = Prisma.TransactionClient | typeof prisma;

/** Rejects reuse of the current password or any of the last HISTORY_DEPTH - 1 previous ones. */
export async function assertNotReused(db: Db, userId: string, pw: string) {
  const u = await db.user.findUniqueOrThrow({ where: { id: userId }, select: { passwordHash: true } });
  const hist = await db.passwordHistory.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: HISTORY_DEPTH - 1 });
  for (const h of [u.passwordHash, ...hist.map((x) => x.hash)]) {
    if (h && h.startsWith('$2') && (await bcrypt.compare(pw, h))) throw badRequest(`You cannot reuse any of your last ${HISTORY_DEPTH} passwords.`);
  }
}

/** Sets a new password: records the old hash in history, bumps authVersion (ends other sessions' access). */
export async function setPassword(db: Db, userId: string, pw: string, opts: { mustChange?: boolean } = {}) {
  const u = await db.user.findUniqueOrThrow({ where: { id: userId }, select: { passwordHash: true } });
  if (u.passwordHash?.startsWith('$2')) await db.passwordHistory.create({ data: { userId, hash: u.passwordHash } });
  await db.user.update({
    where: { id: userId },
    data: { passwordHash: await hashPassword(pw), mustChangePassword: opts.mustChange ?? false, passwordChangedAt: new Date(), failedLogins: 0, lockedUntil: null, authVersion: { increment: 1 } },
  });
}

/** A hash that can never match any password (bcrypt hashes always start with "$2"). */
export const UNUSABLE_PASSWORD = '!unusable';
