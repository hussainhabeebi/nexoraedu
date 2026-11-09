/**
 * R1 — default credentials, demo seeding, secure Super Administrator provisioning.
 * Runs first: the seeded test database contains NO Super Administrator; this file creates them via the real
 * bootstrap command (SEC-T01…T05; SRS SEC-01, SEC-04, ADM-01, DEP-02, DEP-11, DEP-18).
 */
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import { app, prisma } from './helpers';
import { bootstrapSuperAdmin } from '../src/cli/bootstrap-admin';
import { deactivateLegacyAccounts, findLegacyAccounts, LEGACY_DEFAULT_PASSWORD } from '../src/cli/legacy-accounts';
import { assertDemoAllowed } from '../src/seed/demo';
import { seedReference } from '../src/seed/reference';
import { databaseIsolationProblem, productionConfigProblems } from '../src/config';

const STRONG = { JWT_SECRET: 'a'.repeat(16) + 'B7#kq2Lm9xP4vR8tW1zY', APP_ENCRYPTION_KEY: '9f'.repeat(32), PUBLIC_APP_URL: 'https://portal.example.org', API_BASE_URL: 'https://portal.example.org', CORS_ORIGINS: 'https://portal.example.org', PROXY_SECRET: 'p'.repeat(32) };

describe('R1 seed & defaults', () => {
  it('SEC-T01 reference seed creates no users and no account has the old default password', async () => {
    const before = await prisma.user.count();
    await seedReference(prisma as any);
    expect(await prisma.user.count()).toBe(before);
    expect(await prisma.user.count({ where: { roles: { some: { role: { key: 'super_admin' } } } } })).toBe(0);
    const legacy = await findLegacyAccounts(prisma as any);
    expect(legacy.filter((a) => a.defaultPassword)).toHaveLength(0);
    expect(await prisma.user.count({ where: { email: { endsWith: '@nexoraed.com' } } })).toBe(0);
  });

  it('SEC-T02 demo seed refuses production', () => {
    expect(() => assertDemoAllowed({ NODE_ENV: 'production', APP_ENV: 'development' } as any)).toThrow(/refused/);
    expect(() => assertDemoAllowed({ APP_ENV: 'production' } as any)).toThrow(/refused/);
    expect(() => assertDemoAllowed({} as any)).toThrow(/refused/);
    expect(assertDemoAllowed({ APP_ENV: 'staging' } as any)).toBe('staging');
  });

  it('SEC-T03 staging/production refuse weak or default configuration', () => {
    expect(productionConfigProblems({ ...STRONG } as any, 'production')).toEqual([]);
    expect(productionConfigProblems({ ...STRONG, JWT_SECRET: 'change-me' } as any, 'production').join()).toMatch(/JWT_SECRET/);
    expect(productionConfigProblems({ ...STRONG, JWT_SECRET: 'short-secret-16b' } as any, 'staging').join()).toMatch(/JWT_SECRET/);
    expect(productionConfigProblems({ ...STRONG, APP_ENCRYPTION_KEY: '0'.repeat(64) } as any, 'production').join()).toMatch(/APP_ENCRYPTION_KEY/);
    expect(productionConfigProblems({ ...STRONG, PUBLIC_APP_URL: 'http://localhost:5173' } as any, 'production').join()).toMatch(/PUBLIC_APP_URL/);
    expect(productionConfigProblems({ ...STRONG, CORS_ORIGINS: 'https://a.org,http://localhost:5173' } as any, 'production').join()).toMatch(/CORS/);
    expect(productionConfigProblems({ ...STRONG, SEED_ADMIN_PASSWORD: 'x' } as any, 'production').join()).toMatch(/SEED_ADMIN_PASSWORD/);
    expect(productionConfigProblems({} as any, 'development')).toEqual([]);
    expect(databaseIsolationProblem('postgresql://u:p@prod-db.internal:5432/x', 'staging', ['prod-db.internal'])).toMatch(/must not use/);
    expect(databaseIsolationProblem('postgresql://u:p@prod-db.internal:5432/x', 'production', ['prod-db.internal'])).toBeNull();
  });
});

describe('R1 Super Administrator bootstrap', () => {
  let firstToken = '';
  it('SEC-T04 creates the first Super Admin with no usable password and a single-use activation link', async () => {
    const r = await bootstrapSuperAdmin(prisma as any, { email: 'owner@example.invalid', name: 'Owner Admin', username: 'owner' }, 'https://portal.example.org');
    expect(r.link).toMatch(/^https:\/\/portal\.example\.org\/reset-password\?token=.+&activate=1$/);
    firstToken = r.token;
    const u = await prisma.user.findUniqueOrThrow({ where: { username: 'owner' } });
    expect(u.passwordHash.startsWith('$2')).toBe(false);
    // No password works before activation.
    expect((await request(app).post('/api/v1/auth/login').send({ identifier: 'owner', password: '!unusable' })).status).toBe(401);
    expect(await prisma.auditLog.count({ where: { action: 'BOOTSTRAP_SUPER_ADMIN', entityId: u.id } })).toBe(1);
  });

  it('SEC-T04 refuses a second bootstrap while a Super Admin exists; --second works exactly once', async () => {
    await expect(bootstrapSuperAdmin(prisma as any, { email: 'x@example.invalid', name: 'Intruder', username: 'intruder' }, 'https://x')).rejects.toThrow(/already exists/);
    // Decision 4: the second Super Admin needs a recorded management nomination.
    await expect(bootstrapSuperAdmin(prisma as any, { email: 'second@example.invalid', name: 'Second Admin', username: 'owner2', second: true }, 'https://x')).rejects.toThrow(/nomination/);
    await bootstrapSuperAdmin(prisma as any, { email: 'second@example.invalid', name: 'Second Admin', username: 'owner2', second: true, nomination: 'TEST-NOMINATION-001' }, 'https://x');
    const row = await prisma.auditLog.findFirstOrThrow({ where: { action: 'BOOTSTRAP_SUPER_ADMIN', newValues: { path: '$.second', equals: true } } });
    expect((row.newValues as any).nomination).toBe('TEST-NOMINATION-001');
    await expect(bootstrapSuperAdmin(prisma as any, { email: 'third@example.invalid', name: 'Third Admin', username: 'owner3', second: true, nomination: 'TEST-NOMINATION-002' }, 'https://x')).rejects.toThrow(/exactly one/);
  });

  it('SEC-T04 activation enforces the password policy and is single-use', async () => {
    const weak = await request(app).post('/api/v1/auth/reset-password').send({ token: firstToken, newPassword: 'password123' });
    expect(weak.status).toBe(400);
    const ok = await request(app).post('/api/v1/auth/reset-password').send({ token: firstToken, newPassword: 'Kite#Harbour-Lamp-2026' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const again = await request(app).post('/api/v1/auth/reset-password').send({ token: firstToken, newPassword: 'Maple#River-Stone-2026' });
    expect(again.status).toBe(400);
    // Signs in, but as a privileged role only an MFA-enrolment session is issued.
    const login = await request(app).post('/api/v1/auth/login').send({ identifier: 'owner', password: 'Kite#Harbour-Lamp-2026' });
    expect(login.status).toBe(200);
    expect(login.body.mfaEnrollmentRequired).toBe(true);
    expect((await request(app).get('/api/v1/admin/users').set({ Authorization: `Bearer ${login.body.accessToken}` })).body.error.code).toBe('MFA_ENROLLMENT_REQUIRED');
    // Make the second admin usable for later tests (fixture).
    await prisma.user.update({ where: { username: 'owner2' }, data: { passwordHash: await bcrypt.hash('Owner2#Strong-Pass-2026', 4), mustChangePassword: false } });
  });

  it('SEC-T05 legacy default accounts are detected and can be deactivated (dry run changes nothing)', async () => {
    const role = await prisma.role.findUniqueOrThrow({ where: { key: 'super_admin' } });
    await prisma.user.create({ data: { username: 'admin', email: 'admin@nexoraed.com', name: 'Legacy admin', passwordHash: await bcrypt.hash(LEGACY_DEFAULT_PASSWORD, 4), roles: { create: { roleId: role.id } } } });
    const found = (await findLegacyAccounts(prisma as any)).filter((a) => a.risky);
    expect(found.map((a) => a.username)).toEqual(['admin']);
    expect((await prisma.user.findUniqueOrThrow({ where: { username: 'admin' } })).isActive).toBe(true); // dry run
    const done = await deactivateLegacyAccounts(prisma as any);
    expect(done.map((a) => a.username)).toEqual(['admin']);
    expect((await prisma.user.findUniqueOrThrow({ where: { username: 'admin' } })).isActive).toBe(false);
    expect(await prisma.auditLog.count({ where: { action: 'DEACTIVATE_LEGACY_ACCOUNT' } })).toBe(1);
    expect((await request(app).post('/api/v1/auth/login').send({ identifier: 'admin', password: LEGACY_DEFAULT_PASSWORD })).status).toBe(401);
  });
});

describe('Cloudflare bootstrap endpoint (POST /auth/bootstrap)', () => {
  const body = { email: 'late@example.invalid', name: 'Late Admin', username: 'lateadmin' };
  it('is invisible without the BOOTSTRAP_TOKEN secret, and refuses while a Super Admin exists', async () => {
    const saved = process.env.BOOTSTRAP_TOKEN;
    try {
      delete process.env.BOOTSTRAP_TOKEN;
      expect((await request(app).post('/api/v1/auth/bootstrap').set('X-Bootstrap-Token', 'x'.repeat(40)).send(body)).status).toBe(404);
      process.env.BOOTSTRAP_TOKEN = 'short-token';
      expect((await request(app).post('/api/v1/auth/bootstrap').set('X-Bootstrap-Token', 'short-token').send(body)).status).toBe(404); // too short = disabled
      process.env.BOOTSTRAP_TOKEN = 'T'.repeat(48);
      expect((await request(app).post('/api/v1/auth/bootstrap').set('X-Bootstrap-Token', 'W'.repeat(48)).send(body)).status).toBe(404);
      const r = await request(app).post('/api/v1/auth/bootstrap').set('X-Bootstrap-Token', 'T'.repeat(48)).send(body);
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe('BOOTSTRAP_REFUSED');
      expect(await prisma.user.count({ where: { username: 'lateadmin' } })).toBe(0);
    } finally {
      if (saved === undefined) delete process.env.BOOTSTRAP_TOKEN;
      else process.env.BOOTSTRAP_TOKEN = saved;
    }
  });
});
