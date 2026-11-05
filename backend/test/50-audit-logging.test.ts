/**
 * R7 — reliable, transactional, tamper-resistant audit logging (SEC-T25…T29).
 * SRS: FR-AUD-01/02, LOG-01…03, LOG-07, RPT-08, 24.x, API-02, UI-24, DEP-09.
 */
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import morgan from 'morgan';
import { app, as, prisma, sessionFor, makeUser } from './helpers';
import { audit } from '../src/lib/audit';
import { config } from '../src/config';

describe('SEC-T25 audit rows are part of the business transaction', () => {
  it('if the audit write fails, the business change is rolled back', async () => {
    const code = `rollback_${Date.now()}`;
    await expect(
      prisma.$transaction(async (tx) => {
        await tx.masterItem.create({ data: { type: 'city', code, label: 'Rollback test' } });
        await audit(tx, null, 'CREATE', 'master', 'x', null, { bad: BigInt(1) as any }); // not serialisable → throws
      }),
    ).rejects.toThrow();
    expect(await prisma.masterItem.count({ where: { code } })).toBe(0);
  });

  it('API changes write their audit row in the same commit (with request id and user agent)', async () => {
    const t = await sessionFor('office');
    const r = await request(app).post('/api/v1/admin/masters').set(as(t)).set('User-Agent', 'audit-test-agent').send({ type: 'city', code: `aud_${Date.now()}`, label: 'Audit City' });
    expect(r.status).toBe(201);
    const row = await prisma.auditLog.findFirstOrThrow({ where: { entity: 'master', entityId: r.body.id } });
    expect(row.requestId).toBe(r.headers['x-request-id']);
    expect(row.userAgent).toBe('audit-test-agent');
  });
});

describe('SEC-T26 the runtime database role cannot rewrite history', () => {
  it('UPDATE/DELETE/TRUNCATE on append-only tables are refused by privileges (not only triggers)', async () => {
    for (const t of ['audit_logs', 'ledger_entries', 'approval_actions', 'login_logs', 'lead_activities', 'student_history']) {
      await expect(prisma.$executeRawUnsafe(`UPDATE "${t}" SET "createdAt" = "createdAt"`), t).rejects.toThrow(/permission denied/);
      await expect(prisma.$executeRawUnsafe(`DELETE FROM "${t}"`), t).rejects.toThrow(/permission denied/);
    }
    await expect(prisma.$executeRawUnsafe('ALTER TABLE audit_logs DISABLE TRIGGER audit_logs_immutable')).rejects.toThrow(/must be owner|permission denied/);
    await expect(prisma.$executeRawUnsafe('CREATE TABLE evil (id int)')).rejects.toThrow(/permission denied/);
    const who = await prisma.$queryRawUnsafe<{ u: string }[]>('SELECT current_user AS u');
    expect(who[0].u).toBe('nexora_app_test');
  });
});

describe('SEC-T27 viewing and exporting are themselves logged; errors carry a reference', () => {
  it('audit-log views, report runs and CSV exports create audit rows', async () => {
    const sa = await sessionFor((await makeUser(['super_admin'])).username);
    const before = await prisma.auditLog.count({ where: { action: 'VIEW', entity: 'audit_logs' } });
    expect((await request(app).get('/api/v1/admin/audit-logs').set(as(sa))).status).toBe(200);
    expect(await prisma.auditLog.count({ where: { action: 'VIEW', entity: 'audit_logs' } })).toBe(before + 1);
    const fin = await sessionFor('finmgr');
    expect((await request(app).get('/api/v1/dashboard/reports/collections').set(as(fin))).status).toBe(200);
    expect((await request(app).get('/api/v1/dashboard/reports/collections?format=csv').set(as(fin))).status).toBe(200);
    expect(await prisma.auditLog.count({ where: { action: 'REPORT_RUN', entityId: 'collections' } })).toBeGreaterThan(0);
    expect(await prisma.auditLog.count({ where: { action: 'REPORT_EXPORT', entityId: 'collections' } })).toBeGreaterThan(0);
    expect((await request(app).get('/api/v1/students?format=csv').set(as(sa))).status).toBe(200);
    expect(await prisma.auditLog.count({ where: { action: 'EXPORT', entity: 'student' } })).toBeGreaterThan(0);
  });

  it('every error response includes ref = X-Request-Id; secrets are scrubbed from audit values', async () => {
    const r = await request(app).get('/api/v1/students').set('X-Request-Id', 'test-correlation-0001');
    expect(r.status).toBe(401);
    expect(r.body.error.ref).toBe('test-correlation-0001');
    expect(r.headers['x-request-id']).toBe('test-correlation-0001');
    const nf = await request(app).get('/api/v1/no-such-thing');
    expect(nf.body.error.ref).toBe(nf.headers['x-request-id']);
    await audit(prisma, null, 'TEST', 'scrub', null, null, { password: 'x', apiToken: 'y', nested: { recoveryCode: 'z', ok: 1 } });
    const row = await prisma.auditLog.findFirstOrThrow({ where: { action: 'TEST', entity: 'scrub' } });
    expect(row.newValues).toEqual({ password: '***', apiToken: '***', nested: { recoveryCode: '***', ok: 1 } });
  });
});

describe('SEC-T28/T29 log hygiene and proxy enforcement', () => {
  it('access-log path never includes the query string (webhook secrets)', () => {
    const path = (morgan as any).path({ originalUrl: '/api/v1/webhooks/chatwoot?token=super-secret' });
    expect(path).toBe('/api/v1/webhooks/chatwoot');
  });

  it('with REQUIRE_PROXY_SECRET, direct API calls are refused and spoofed IP headers are ignored', async () => {
    const saved = { require: config.requireProxySecret, secret: config.proxySecret };
    config.requireProxySecret = true;
    config.proxySecret = 'proxy-secret-for-tests-0123456789';
    try {
      const direct = await request(app).get('/api/v1/public/site');
      expect(direct.status).toBe(403);
      expect(direct.body.error.code).toBe('PROXY_REQUIRED');
      expect((await request(app).get('/health')).status).toBe(200); // container health check
      const viaProxy = await request(app).get('/api/v1/public/site').set('X-Proxy-Secret', config.proxySecret);
      expect(viaProxy.status).toBe(200);
      await request(app).post('/api/v1/auth/login').set('X-Proxy-Secret', config.proxySecret).set('X-Forwarded-For', '6.6.6.6').send({ identifier: 'ip-spoof-test', password: 'x' });
      const log = await prisma.loginLog.findFirstOrThrow({ where: { identifier: 'ip-spoof-test' }, orderBy: { createdAt: 'desc' } });
      expect(log.ip).not.toBe('6.6.6.6');
      await request(app).post('/api/v1/auth/login').set('X-Proxy-Secret', config.proxySecret).set('X-Client-IP', '203.0.113.9').send({ identifier: 'ip-proxy-test', password: 'x' });
      expect((await prisma.loginLog.findFirstOrThrow({ where: { identifier: 'ip-proxy-test' } })).ip).toBe('203.0.113.9');
    } finally {
      config.requireProxySecret = saved.require;
      config.proxySecret = saved.secret;
    }
  });
});
