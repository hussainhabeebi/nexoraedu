/**
 * Staging-only re-issue of the bootstrapped Super Administrator's activation link
 * (POST /api/v1/auth/bootstrap/reissue-activation). Synthetic accounts only.
 */
import { afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import crypto from 'node:crypto';
import { app, prisma } from './helpers';
import { config } from '../src/config';
import { UNUSABLE_PASSWORD } from '../src/lib/password';

const ENDPOINT = '/api/v1/auth/bootstrap/reissue-activation';
const TOKEN = 'R'.repeat(48);
const NEW_PASSWORD = 'Quartz#Meadow-4827v';
const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const tokenOf = (link: string) => new URL(link).searchParams.get('token')!;

const saved = { token: process.env.BOOTSTRAP_TOKEN, appEnv: config.appEnv, url: config.publicAppUrl };
process.env.BOOTSTRAP_TOKEN = TOKEN;
config.publicAppUrl = 'https://staging.example.invalid';
afterAll(async () => {
  if (saved.token === undefined) delete process.env.BOOTSTRAP_TOKEN;
  else process.env.BOOTSTRAP_TOKEN = saved.token;
  config.appEnv = saved.appEnv;
  config.publicAppUrl = saved.url;
  // Keep the shared test database tidy: the synthetic Super Admins made here are switched off.
  await prisma.user.updateMany({ where: { username: { startsWith: 'reissue' } }, data: { isActive: false } });
});

let seq = 0;
/** A bootstrapped-but-never-activated Super Admin, exactly as bootstrap leaves it (one unused ENROLL link). */
async function pendingSuperAdmin() {
  seq++;
  const role = await prisma.role.findUniqueOrThrow({ where: { key: 'super_admin' } });
  const username = `reissue${Date.now().toString(36)}${seq}`;
  const u = await prisma.user.create({
    data: { username, email: `${username}@example.invalid`, name: 'Pending Owner', passwordHash: UNUSABLE_PASSWORD, mustChangePassword: true, roles: { create: { roleId: role.id } } },
  });
  const original = crypto.randomBytes(32).toString('base64url');
  await prisma.passwordReset.create({ data: { userId: u.id, purpose: 'ENROLL', tokenHash: sha(original), expiresAt: new Date(Date.now() + 3600_000) } });
  return { u, original, body: { username, email: u.email } };
}
const reissue = (body: unknown, token: string | null = TOKEN) => {
  const r = request(app).post(ENDPOINT);
  if (token !== null) r.set('X-Bootstrap-Token', token);
  return r.send(body as object);
};
const activate = (token: string) => request(app).post('/api/v1/auth/reset-password').send({ token, newPassword: NEW_PASSWORD });

describe('authorisation', () => {
  it('is hidden (404) without the BOOTSTRAP_TOKEN header, with a wrong one, or when the secret is too short', async () => {
    const { body } = await pendingSuperAdmin();
    expect((await reissue(body, null)).status).toBe(404);
    expect((await reissue(body, 'W'.repeat(48))).status).toBe(404);
    process.env.BOOTSTRAP_TOKEN = 'short-secret';
    try {
      expect((await reissue(body, 'short-secret')).status).toBe(404);
    } finally {
      process.env.BOOTSTRAP_TOKEN = TOKEN;
    }
  });

  it('does not exist in production, even with a valid token', async () => {
    const { body, u } = await pendingSuperAdmin();
    config.appEnv = 'production';
    try {
      expect((await reissue(body)).status).toBe(404);
    } finally {
      config.appEnv = saved.appEnv;
    }
    expect(await prisma.passwordReset.count({ where: { userId: u.id } })).toBe(1); // nothing issued
  });
});

describe('account matching (never creates a user)', () => {
  it('needs username AND email of the same active Super Administrator', async () => {
    const { body } = await pendingSuperAdmin();
    const users = await prisma.user.count();
    expect((await reissue({ ...body, email: 'someone-else@example.invalid' })).status).toBe(404);
    expect((await reissue({ ...body, username: 'nobody-here' })).status).toBe(404);
    expect((await reissue({ username: 'office', email: 'office@example.invalid' })).status).toBe(404); // not a Super Admin
    expect((await reissue({})).status).toBe(422);
    expect(await prisma.user.count()).toBe(users);
  });
});

describe('re-issue', () => {
  it('invalidates the old link, stores only the hash, expires in 60 minutes, audits, and the new link works exactly once', async () => {
    const { u, original, body } = await pendingSuperAdmin();
    const users = await prisma.user.count();
    const r = await reissue(body);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.activationLink).toMatch(/^https:\/\/staging\.example\.invalid\/reset-password\?token=[A-Za-z0-9_-]{43}&activate=1$/);
    expect(r.body).toMatchObject({ userId: u.id, expiresInMinutes: 60, previousLinksInvalidated: 1 });
    const fresh = tokenOf(r.body.activationLink);
    expect(await prisma.user.count()).toBe(users);

    // Only the hash is stored, with a 60-minute expiry.
    const rows = await prisma.passwordReset.findMany({ where: { userId: u.id }, orderBy: { createdAt: 'asc' } });
    expect(rows).toHaveLength(2);
    expect(rows[1].tokenHash).toBe(sha(fresh));
    expect(JSON.stringify(rows)).not.toContain(fresh);
    expect(Math.abs(rows[1].expiresAt.getTime() - Date.now() - 3600_000)).toBeLessThan(60_000);

    // Audit row without the token.
    const log = await prisma.auditLog.findFirstOrThrow({ where: { action: 'BOOTSTRAP_ACTIVATION_REISSUED', entityId: u.id } });
    expect(log.newValues).toMatchObject({ username: u.username, email: u.email, previousLinksInvalidated: 1, expiresInMinutes: 60 });
    expect(JSON.stringify(log)).not.toContain(fresh);

    // The previous link no longer works; the new one works once; it cannot be reused.
    expect((await activate(original)).status).toBe(400);
    expect((await activate(fresh)).status).toBe(200);
    expect((await activate(fresh)).status).toBe(400);
    // Credentials were never touched by the re-issue itself: only the owner's own activation set the password.
    expect((await prisma.user.findUniqueOrThrow({ where: { id: u.id } })).passwordHash).not.toBe(UNUSABLE_PASSWORD);
  });

  it('a re-issued link that has expired is refused, and a further re-issue is still possible before activation', async () => {
    const { u, body } = await pendingSuperAdmin();
    const first = tokenOf((await reissue(body)).body.activationLink);
    await prisma.passwordReset.update({ where: { tokenHash: sha(first) }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await activate(first)).status).toBe(400);
    const second = await reissue(body);
    expect(second.status).toBe(201);
    expect(second.body.previousLinksInvalidated).toBe(0); // nothing still usable was left to invalidate
    expect((await activate(tokenOf(second.body.activationLink))).status).toBe(200);
    expect(await prisma.auditLog.count({ where: { action: 'BOOTSTRAP_ACTIVATION_REISSUED', entityId: u.id } })).toBe(2);
  });
});

describe('eligibility (refused once the account has been activated)', () => {
  it('refuses after the password has been set (activation used)', async () => {
    const { original, body, u } = await pendingSuperAdmin();
    expect((await activate(original)).status).toBe(200);
    const r = await reissue(body);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('REISSUE_REFUSED');
    expect(await prisma.passwordReset.count({ where: { userId: u.id } })).toBe(1);
  });

  it('refuses after a sign-in or a confirmed MFA factor, and changes nothing', async () => {
    const a = await pendingSuperAdmin();
    await prisma.user.update({ where: { id: a.u.id }, data: { lastLoginAt: new Date() } });
    expect((await reissue(a.body)).status).toBe(409);
    const b = await pendingSuperAdmin();
    await prisma.mfaFactor.create({ data: { userId: b.u.id, secretEnc: 'synthetic-not-a-secret', confirmedAt: new Date() } });
    expect((await reissue(b.body)).status).toBe(409);
    for (const x of [a, b]) {
      const rows = await prisma.passwordReset.findMany({ where: { userId: x.u.id } });
      expect(rows).toHaveLength(1);
      expect(rows[0].usedAt).toBeNull(); // the existing link was not touched
    }
    expect(await prisma.auditLog.count({ where: { action: 'BOOTSTRAP_ACTIVATION_REISSUED', entityId: { in: [a.u.id, b.u.id] } } })).toBe(0);
  });
});

describe('activation link format (regression: links must open the frontend page, never an API route)', () => {
  const assertFrontendLink = (link: string, origin: string) => {
    const u = new URL(link);
    expect(u.origin).toBe(origin);
    expect(u.pathname).toBe('/reset-password');
    expect(link).not.toContain('/api/v1/auth');
    expect(link).not.toContain('/api/');
    expect(u.searchParams.get('token')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(u.searchParams.get('activate')).toBe('1');
  };

  it('re-issue builds PUBLIC_APP_URL origin + /reset-password?token=…&activate=1', async () => {
    const { body } = await pendingSuperAdmin();
    const r = await reissue(body);
    expect(r.status).toBe(201);
    assertFrontendLink(r.body.activationLink, 'https://staging.example.invalid');
  });

  it('a PUBLIC_APP_URL that wrongly includes a path (e.g. /api/v1/auth) still yields the frontend page', async () => {
    config.publicAppUrl = 'https://staging.example.invalid/api/v1/auth/';
    try {
      const { body } = await pendingSuperAdmin();
      const r = await reissue(body);
      expect(r.status).toBe(201);
      assertFrontendLink(r.body.activationLink, 'https://staging.example.invalid');
    } finally {
      config.publicAppUrl = 'https://staging.example.invalid';
    }
  });

  it('every link builder uses the same rule (bootstrap, activation, password reset)', async () => {
    const { resetPasswordLink } = await import('../src/lib/links');
    const t = 'A'.repeat(43);
    for (const base of ['https://staging.example.invalid', 'https://staging.example.invalid/', 'https://staging.example.invalid/api/v1/auth']) {
      assertFrontendLink(resetPasswordLink(t, { activate: true, publicAppUrl: base }), 'https://staging.example.invalid');
      const reset = new URL(resetPasswordLink(t, { publicAppUrl: base }));
      expect(reset.pathname).toBe('/reset-password');
      expect(reset.searchParams.get('activate')).toBeNull();
    }
  });
});

