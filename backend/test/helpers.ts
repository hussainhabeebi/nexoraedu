/** Shared test helpers. Synthetic fixtures only; the database is the disposable local/CI test database. */
import request from 'supertest';
import { expect } from 'vitest';
import bcrypt from 'bcryptjs';

export const DEMO_PASSWORD = process.env.DEMO_PASSWORD || 'Test-Only#Passw0rd!2026';

const { createApp } = await import('../src/app');
const { prisma } = await import('../src/lib/prisma');
const auth = await import('../src/lib/auth');
const util = await import('../src/lib/util');
const totpLib = await import('../src/lib/totp');

export { prisma };
export const app = createApp();
export const as = (t: string) => ({ Authorization: `Bearer ${t}` });

/** Real HTTP login (password step). Use for non-privileged users; privileged users need MFA — see sessionFor(). */
export async function login(identifier: string, password = DEMO_PASSWORD) {
  const r = await request(app).post('/api/v1/auth/login').send({ identifier, password });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  expect(r.body.mfaRequired, 'use sessionFor() for MFA users').toBeFalsy();
  return r.body.accessToken as string;
}

/**
 * Fixture session for any user (mfaVerified), issued the same way the API does after a successful sign-in.
 * Lets tests act as privileged roles without repeating the TOTP flow, which has its own dedicated tests.
 */
export async function sessionFor(username: string, opts: { mfaVerified?: boolean } = {}) {
  const u = await prisma.user.findUniqueOrThrow({ where: { username } });
  const { session } = await auth.createSession(prisma, { userId: u.id, mfaVerified: opts.mfaVerified ?? true });
  return auth.signAccess(u.id, session.id, u.authVersion);
}

let seq = 0;
/** Creates a staff user with the given roles and a known password (mustChangePassword=false). */
export async function makeUser(roles: string[], opts: { password?: string; username?: string; active?: boolean } = {}) {
  seq++;
  const username = opts.username ?? `t${Date.now().toString(36)}${seq}`;
  const roleRows = await prisma.role.findMany({ where: { key: { in: roles } } });
  return prisma.user.create({
    data: {
      username, email: `${username}@example.invalid`, name: `Test ${username}`, isActive: opts.active ?? true,
      passwordHash: await bcrypt.hash(opts.password ?? DEMO_PASSWORD, 4), mustChangePassword: false,
      roles: { create: roleRows.map((r) => ({ roleId: r.id })) },
    },
  });
}

export const totpNow = (secret: string, offsetSteps = 0) => totpLib.totp(secret, Date.now() + offsetSteps * 30_000);
export const decrypt = util.decrypt;

/** Extracts the refresh cookie value from a supertest response. */
export function refreshCookie(res: request.Response): string | undefined {
  const raw = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
  const c = raw.find((x) => x.startsWith(`${auth.REFRESH_COOKIE}=`));
  return c?.split(';')[0].slice(auth.REFRESH_COOKIE.length + 1) || undefined;
}
export const cookieHeader = (v: string) => `${auth.REFRESH_COOKIE}=${v}`;
export const CSRF = { 'X-Requested-With': 'nexora' };

/** Minimal synthetic student (+ optional lead owner and batch). */
export async function makeStudent(opts: { ownerId?: string; batchId?: string | null; courseCode?: string } = {}) {
  seq++;
  const course = await prisma.course.findUniqueOrThrow({ where: { code: opts.courseCode ?? 'FSD' }, include: { batches: true } });
  const n = `${Date.now()}${seq}`.slice(-9);
  const phone = `+917${n}`;
  const email = `s${n}@example.invalid`;
  const st = await prisma.student.create({
    data: {
      studentCode: `TST-${n}`, fullName: `Synthetic Student ${n}`, dob: new Date('2000-01-01'), gender: 'Other', phone, phoneNormalized: phone, email, emailNormalized: email,
      address: 'Synthetic address 1', courseId: course.id, batchId: opts.batchId === undefined ? course.batches[0].id : opts.batchId, status: 'ACTIVE',
    },
  });
  if (opts.ownerId) await prisma.lead.create({ data: { code: `LD-T-${n}`, name: st.fullName, phone, phoneNormalized: phone, email, emailNormalized: email, ownerId: opts.ownerId, status: 'ADMITTED', studentId: st.id } });
  return st;
}
