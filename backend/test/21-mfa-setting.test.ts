/**
 * Security setting "mfaRequired" (Settings → Security): when OFF (the default), nobody is asked for an
 * authenticator code at sign-in or forced to enrol one; when ON, the strict SEC-06 behaviour applies.
 * Only a Super Administrator can change it, and the change is audit-logged. Synthetic users only.
 */
import { afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app, as, DEMO_PASSWORD, makeUser, prisma, sessionFor } from './helpers';
import { encrypt } from '../src/lib/util';

const security = async () => (await request(app).get('/api/v1/admin/settings').set(as(await sessionFor((await makeUser(['super_admin'])).username)))).body.security;
const setMfa = async (tok: string, on: boolean) => {
  const current = await security();
  return request(app).put('/api/v1/admin/settings/security').set(as(tok)).send({ ...current, mfaRequired: on });
};
const login = (identifier: string) => request(app).post('/api/v1/auth/login').send({ identifier, password: DEMO_PASSWORD });

let sa: string;
afterAll(async () => {
  // Leave the shared test database in the strict mode the other suites expect.
  await setMfa(sa, true);
});

describe('authenticator code at sign-in is a Super Admin setting', () => {
  it('only a Super Administrator can switch it; the change is audit-logged', async () => {
    sa = await sessionFor((await makeUser(['super_admin'])).username);
    const admin = await sessionFor('office');
    const refused = await setMfa(admin, false);
    expect(refused.status).toBe(403);
    const ok = await setMfa(sa, false);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.mfaRequired).toBe(false);
    const row = await prisma.auditLog.findFirstOrThrow({ where: { action: 'UPDATE', entity: 'setting', entityId: 'security' }, orderBy: { createdAt: 'desc' } });
    expect(row.newValues).toMatchObject({ mfaRequired: false });
  });

  it('OFF: a privileged user with no authenticator signs straight in and can use the staff API', async () => {
    const u = await makeUser(['finance_manager']);
    const r = await login(u.username);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.mfaRequired).toBeFalsy();
    expect(r.body.mfaEnrollmentRequired).toBe(false);
    expect((await request(app).get('/api/v1/finance/payments').set(as(r.body.accessToken))).status).toBe(200);
  });

  it('OFF: a user who already enrolled an authenticator is not asked for a code', async () => {
    const u = await makeUser(['super_admin']);
    await prisma.mfaFactor.create({ data: { userId: u.id, secretEnc: encrypt('JBSWY3DPEHPK3PXP'), confirmedAt: new Date() } });
    const r = await login(u.username);
    expect(r.status).toBe(200);
    expect(r.body.mfaRequired).toBeFalsy();
    expect(r.body.accessToken).toBeTruthy();
  });

  it('ON again: the code is asked for, and privileged users without one must enrol', async () => {
    expect((await setMfa(sa, true)).status).toBe(200);
    const enrolled = await makeUser(['super_admin']);
    await prisma.mfaFactor.create({ data: { userId: enrolled.id, secretEnc: encrypt('JBSWY3DPEHPK3PXP'), confirmedAt: new Date() } });
    const challenged = await login(enrolled.username);
    expect(challenged.body.mfaRequired).toBe(true);
    expect(challenged.body.accessToken).toBeUndefined();
    const fin = await makeUser(['finance_manager']);
    const r = await login(fin.username);
    expect(r.body.mfaEnrollmentRequired).toBe(true);
    const api = await request(app).get('/api/v1/finance/payments').set(as(r.body.accessToken));
    expect(api.status).toBe(403);
    expect(api.body.error.code).toBe('MFA_ENROLLMENT_REQUIRED');
  });
});
