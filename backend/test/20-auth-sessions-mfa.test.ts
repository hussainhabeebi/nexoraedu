/**
 * R6 — sessions, MFA, password policy, browser token storage (SEC-T18…T24).
 * SRS: FR-AUTH-01/04, SEC-01, SEC-04, SEC-05, SEC-06, SEC-07, UI-05.
 */
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { app, as, cookieHeader, CSRF, decrypt, DEMO_PASSWORD, makeUser, prisma, refreshCookie, sessionFor, totpNow } from './helpers';
import { passwordProblems } from '../src/lib/password';
import { hotp, base32Decode, verifyTotp } from '../src/lib/totp';

describe('TOTP implementation', () => {
  it('matches the RFC 6238 SHA-1 test vectors', () => {
    // RFC 6238 Appendix B: secret "12345678901234567890" (ASCII), 8 digits → we compare the last 6.
    const secret = Buffer.from('12345678901234567890');
    expect(hotp(secret, Math.floor(59 / 30), 8)).toBe('94287082');
    expect(hotp(secret, Math.floor(1111111109 / 30), 8)).toBe('07081804');
    expect(hotp(secret, Math.floor(1234567890 / 30), 8)).toBe('89005924');
    expect(base32Decode('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ').toString()).toBe('12345678901234567890');
    expect(verifyTotp('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', '287082', { now: 59_000 })).not.toBeNull();
    expect(verifyTotp('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', '287082', { now: 59_000, afterStep: 1 })).toBeNull(); // replay
  });
});

describe('SEC-T18 MFA for privileged roles', () => {
  it('enrolment-only session until MFA is set up; then challenge, replay protection, recovery codes', async () => {
    const u = await makeUser(['finance_staff']);
    const first = await request(app).post('/api/v1/auth/login').send({ identifier: u.username, password: DEMO_PASSWORD });
    expect(first.status).toBe(200);
    expect(first.body.mfaEnrollmentRequired).toBe(true);
    const t = first.body.accessToken;
    const blocked = await request(app).get('/api/v1/finance/payments').set(as(t));
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('MFA_ENROLLMENT_REQUIRED');

    const start = await request(app).post('/api/v1/auth/mfa/enroll/start').set(as(t)).send({});
    expect(start.status).toBe(200);
    expect(start.body.otpauthUrl).toMatch(/^otpauth:\/\/totp\//);
    const factor = await prisma.mfaFactor.findUniqueOrThrow({ where: { userId: u.id } });
    expect(factor.secretEnc).not.toContain(start.body.secret); // encrypted at rest
    expect((await request(app).post('/api/v1/auth/mfa/enroll/confirm').set(as(t)).send({ code: '000000' })).status).toBe(400);
    const conf = await request(app).post('/api/v1/auth/mfa/enroll/confirm').set(as(t)).send({ code: totpNow(start.body.secret) });
    expect(conf.status, JSON.stringify(conf.body)).toBe(200);
    expect(conf.body.recoveryCodes).toHaveLength(10);
    expect((await request(app).get('/api/v1/finance/payments').set(as(t))).status).toBe(200); // session now complete

    // Next sign-in: password alone gives no tokens.
    const pw = await request(app).post('/api/v1/auth/login').send({ identifier: u.username, password: DEMO_PASSWORD });
    expect(pw.body).toMatchObject({ mfaRequired: true });
    expect(pw.body.accessToken).toBeUndefined();
    expect(refreshCookie(pw)).toBeUndefined();
    expect((await request(app).post('/api/v1/auth/mfa/verify').send({ mfaToken: pw.body.mfaToken, code: '123456' })).status).toBe(401);
    // The enrolment code's time step was consumed: replaying it is rejected; the next step is accepted.
    const used = (await prisma.mfaFactor.findUniqueOrThrow({ where: { userId: u.id } })).lastUsedStep;
    const key = base32Decode(decrypt(factor.secretEnc));
    expect(decrypt(factor.secretEnc)).toBe(start.body.secret);
    const replay = await request(app).post('/api/v1/auth/mfa/verify').send({ mfaToken: pw.body.mfaToken, code: hotp(key, used) });
    expect(replay.status).toBe(401);
    const ok = await request(app).post('/api/v1/auth/mfa/verify').send({ mfaToken: pw.body.mfaToken, code: hotp(key, used + 1) });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.user.mfaVerified).toBe(true);
    // A used challenge cannot be used again.
    expect((await request(app).post('/api/v1/auth/mfa/verify').send({ mfaToken: pw.body.mfaToken, code: hotp(key, used + 2) })).status).toBe(401);

    // Recovery code: single use.
    const rc = conf.body.recoveryCodes[0];
    const c1 = await request(app).post('/api/v1/auth/login').send({ identifier: u.username, password: DEMO_PASSWORD });
    expect((await request(app).post('/api/v1/auth/mfa/verify').send({ mfaToken: c1.body.mfaToken, recoveryCode: rc })).status).toBe(200);
    const c2 = await request(app).post('/api/v1/auth/login').send({ identifier: u.username, password: DEMO_PASSWORD });
    expect((await request(app).post('/api/v1/auth/mfa/verify').send({ mfaToken: c2.body.mfaToken, recoveryCode: rc })).status).toBe(401);
    expect(await prisma.loginLog.count({ where: { userId: u.id, event: 'MFA_FAIL' } })).toBeGreaterThanOrEqual(2);
  });

  it('Sales Manager and Examination Officer must enrol MFA (decision 3)', async () => {
    for (const u of ['salesmgr', 'examofficer']) {
      const r = await request(app).post('/api/v1/auth/login').send({ identifier: u, password: DEMO_PASSWORD });
      expect(r.body.mfaEnrollmentRequired, u).toBe(true);
      expect((await request(app).get('/api/v1/crm/leads').set(as(r.body.accessToken))).body.error.code, u).toBe('MFA_ENROLLMENT_REQUIRED');
    }
  });

  it('non-privileged roles are not forced to enrol', async () => {
    const r = await request(app).post('/api/v1/auth/login').send({ identifier: 'counselor2', password: DEMO_PASSWORD });
    expect(r.body.mfaEnrollmentRequired).toBe(false);
  });
});

describe('SEC-T19/T20 refresh cookie, rotation and reuse detection', () => {
  it('refresh token only in an HttpOnly, Secure, SameSite=Strict __Host- cookie', async () => {
    const r = await request(app).post('/api/v1/auth/login').send({ identifier: 'counselor2', password: DEMO_PASSWORD });
    const raw = ([] as string[]).concat(r.headers['set-cookie']).find((c) => c.startsWith('__Host-nx_rt='))!;
    expect(raw).toMatch(/HttpOnly/i);
    expect(raw).toMatch(/Secure/i);
    expect(raw).toMatch(/SameSite=Strict/i);
    expect(raw).toMatch(/Path=\//);
    expect(raw).not.toMatch(/Domain=/i);
    expect(JSON.stringify(r.body)).not.toMatch(/refresh/i);
  });

  it('rotates on refresh; reusing an old token revokes the whole family; CSRF header required', async () => {
    const r = await request(app).post('/api/v1/auth/login').send({ identifier: 'counselor2', password: DEMO_PASSWORD });
    const a = refreshCookie(r)!;
    expect((await request(app).post('/api/v1/auth/refresh').set('Cookie', cookieHeader(a))).status).toBe(403); // no X-Requested-With
    expect((await request(app).post('/api/v1/auth/refresh').set('Cookie', cookieHeader(a)).set(CSRF).set('Origin', 'https://evil.example')).status).toBe(403);
    const r2 = await request(app).post('/api/v1/auth/refresh').set('Cookie', cookieHeader(a)).set(CSRF);
    expect(r2.status).toBe(200);
    const b = refreshCookie(r2)!;
    expect(b).not.toBe(a);
    const reuse = await request(app).post('/api/v1/auth/refresh').set('Cookie', cookieHeader(a)).set(CSRF);
    expect(reuse.status).toBe(401);
    expect((await request(app).post('/api/v1/auth/refresh').set('Cookie', cookieHeader(b)).set(CSRF)).status).toBe(401); // family revoked
    expect((await request(app).get('/api/v1/crm/leads').set(as(r2.body.accessToken))).status).toBe(401); // its access token too
    expect(await prisma.loginLog.count({ where: { event: 'TOKEN_REUSE' } })).toBeGreaterThan(0);
  });

  it('logout ends the session server-side', async () => {
    const r = await request(app).post('/api/v1/auth/login').send({ identifier: 'counselor2', password: DEMO_PASSWORD });
    const out = await request(app).post('/api/v1/auth/logout').set('Cookie', cookieHeader(refreshCookie(r)!)).set(CSRF).send({});
    expect(out.status).toBe(200);
    expect((await request(app).get('/api/v1/crm/leads').set(as(r.body.accessToken))).status).toBe(401);
  });
});

describe('SEC-T21/T22 revocation and idle timeout', () => {
  it('deactivation and role removal apply on the very next request', async () => {
    const u = await makeUser(['counselor']);
    const t = await sessionFor(u.username);
    expect((await request(app).get('/api/v1/crm/leads').set(as(t))).status).toBe(200);
    const sa = await sessionFor((await makeUser(['super_admin'])).username);
    expect((await request(app).patch(`/api/v1/admin/users/${u.id}`).set(as(sa)).send({ roles: ['faculty'] })).status).toBe(200);
    expect((await request(app).get('/api/v1/crm/leads').set(as(t))).status).toBe(401); // old token (authVersion changed)
    const t2 = await sessionFor(u.username);
    expect((await request(app).get('/api/v1/crm/leads').set(as(t2))).status).toBe(403); // new token: no longer a counselor
    expect((await request(app).patch(`/api/v1/admin/users/${u.id}`).set(as(sa)).send({ isActive: false })).status).toBe(200);
    expect((await request(app).get('/api/v1/academics/batches').set(as(t2))).status).toBe(401);
  });

  it('idle sessions expire server-side (SEC-05 30 minutes)', async () => {
    const t = await sessionFor('counselor2');
    const s = await prisma.session.findFirstOrThrow({ where: { user: { username: 'counselor2' } }, orderBy: { createdAt: 'desc' } });
    await prisma.session.update({ where: { id: s.id }, data: { lastSeenAt: new Date(Date.now() - 31 * 60_000) } });
    const r = await request(app).get('/api/v1/crm/leads').set(as(t));
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe('SESSION_IDLE');
  });

  it('with the inactivity sign-out off (0, the default), an idle session keeps working; the absolute lifetime still applies', async () => {
    const sa = await sessionFor((await makeUser(['super_admin'])).username);
    const cur = (await request(app).get('/api/v1/admin/settings').set(as(sa))).body.security;
    expect((await request(app).put('/api/v1/admin/settings/security').set(as(sa)).send({ ...cur, sessionTimeoutMin: 3 })).status).toBe(422);
    expect((await request(app).put('/api/v1/admin/settings/security').set(as(sa)).send({ ...cur, sessionTimeoutMin: 0 })).status).toBe(200);
    try {
      const t = await sessionFor('counselor2');
      const s = await prisma.session.findFirstOrThrow({ where: { user: { username: 'counselor2' } }, orderBy: { createdAt: 'desc' } });
      await prisma.session.update({ where: { id: s.id }, data: { lastSeenAt: new Date(Date.now() - 6 * 3600_000) } });
      expect((await request(app).get('/api/v1/crm/leads').set(as(t))).status).toBe(200);
      await prisma.session.update({ where: { id: s.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
      expect((await request(app).get('/api/v1/crm/leads').set(as(t))).status).toBe(401);
    } finally {
      await request(app).put('/api/v1/admin/settings/security').set(as(sa)).send({ ...cur, sessionTimeoutMin: 30 });
    }
  });

  it('users can list and end their own sessions', async () => {
    const t1 = await login2('counselor1');
    const t2 = await login2('counselor1');
    const list = await request(app).get('/api/v1/auth/sessions').set(as(t1));
    expect(list.status).toBe(200);
    expect(list.body.items.length).toBeGreaterThanOrEqual(2);
    expect((await request(app).post('/api/v1/auth/sessions/revoke-others').set(as(t1)).send({})).status).toBe(200);
    expect((await request(app).get('/api/v1/crm/leads').set(as(t2))).status).toBe(401);
    expect((await request(app).get('/api/v1/crm/leads').set(as(t1))).status).toBe(200);
  });
});

async function login2(u: string) {
  return (await request(app).post('/api/v1/auth/login').send({ identifier: u, password: DEMO_PASSWORD })).body.accessToken as string;
}

describe('SEC-T23/T24 password policy and lockout', () => {
  it('policy rules', () => {
    expect(passwordProblems('Short#1a')).not.toEqual([]); // < 10
    expect(passwordProblems('alllowercaseletters')).not.toEqual([]); // 1 class
    expect(passwordProblems('Password@123')).not.toEqual([]); // common base word
    expect(passwordProblems('Nexora#Academy1')).not.toEqual([]); // common base word
    expect(passwordProblems('Arjun#Garden-2026', { name: 'Arjun Das' })).not.toEqual([]); // personal
    expect(passwordProblems('Velvet#Comet-Trail-2026')).toEqual([]);
  });

  it('change-password enforces policy and the last-5 reuse rule; reset enforces policy', async () => {
    const u = await makeUser(['counselor']);
    const t = await login2(u.username);
    const chg = (cur: string, next: string, tok = t) => request(app).post('/api/v1/auth/change-password').set(as(tok)).send({ currentPassword: cur, newPassword: next });
    expect((await chg(DEMO_PASSWORD, 'weakpass')).status).toBe(400);
    expect((await chg(DEMO_PASSWORD, DEMO_PASSWORD)).status).toBe(400); // reuse of current
    const p1 = 'Velvet#Comet-Trail-2026';
    const r1 = await chg(DEMO_PASSWORD, p1);
    expect(r1.status).toBe(200);
    const r2 = await chg(p1, 'Quartz#Meadow-Lantern-7', r1.body.accessToken);
    expect(r2.status).toBe(200);
    expect((await chg('Quartz#Meadow-Lantern-7', p1, r2.body.accessToken)).status).toBe(400); // in history
    expect((await chg('Quartz#Meadow-Lantern-7', DEMO_PASSWORD, r2.body.accessToken)).status).toBe(400); // in history
    // Changing the password ends other sessions.
    expect((await request(app).get('/api/v1/crm/leads').set(as(t))).status).toBe(401);
    const tok = 'reset-token-for-policy-test-0001';
    await prisma.passwordReset.create({ data: { userId: u.id, tokenHash: (await import('../src/lib/util')).sha256(tok), expiresAt: new Date(Date.now() + 60_000) } });
    expect((await request(app).post('/api/v1/auth/reset-password').send({ token: tok, newPassword: 'password1' })).status).toBe(400);
  });

  it('locked accounts get the same generic response as a wrong password (SEC-01, UI-05)', async () => {
    const u = await makeUser(['counselor']);
    const wrong = () => request(app).post('/api/v1/auth/login').send({ identifier: u.username, password: 'Wrong#Password-000' });
    const first = await wrong();
    for (let i = 0; i < 5; i++) await wrong();
    const locked = await request(app).post('/api/v1/auth/login').send({ identifier: u.username, password: DEMO_PASSWORD });
    expect(locked.status).toBe(first.status);
    expect(locked.body.error.code).toBe(first.body.error.code);
    expect(locked.body.error.message).toBe(first.body.error.message);
    const unknown = await request(app).post('/api/v1/auth/login').send({ identifier: 'nobody-here', password: 'x' });
    expect(unknown.body.error.message).toBe(first.body.error.message);
    expect(await prisma.loginLog.count({ where: { userId: u.id, event: 'LOCKED' } })).toBeGreaterThan(0);
  });
});
