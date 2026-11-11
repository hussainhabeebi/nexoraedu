/**
 * Email through Resend's HTTPS API (RESEND_API_KEY): sender on the verified domain, results in the notification log,
 * failures retryable, and an admin test send. The network is stubbed; no email leaves the machine. Synthetic data.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { app, as, makeUser, prisma, sessionFor } from './helpers';
import { notify, emailProvider } from '../src/services/notify';

const KEY = 're_test_' + 'x'.repeat(24);
const calls: { url: string; headers: any; body: any }[] = [];
let fail = 0;
const realFetch = globalThis.fetch;

beforeAll(() => {
  process.env.RESEND_API_KEY = KEY;
  vi.stubGlobal('fetch', async (url: string, init: any) => {
    if (!String(url).startsWith('https://api.resend.com/')) return realFetch(url, init);
    calls.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) });
    if (fail > 0) {
      fail--;
      return new Response(JSON.stringify({ name: 'internal_server_error', message: 'Temporary problem' }), { status: 500 });
    }
    return new Response(JSON.stringify({ id: `email-${calls.length}` }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
});
afterAll(() => {
  delete process.env.RESEND_API_KEY;
  vi.unstubAllGlobals();
});

describe('Resend email', () => {
  it('sends from the verified domain with the API key, and logs SENT with the Resend id', async () => {
    expect(emailProvider()).toBe('resend');
    const to = `r${Date.now()}@example.invalid`;
    const res = await notify('fee.reminder_upcoming', { email: to, name: 'Synthetic' }, { name: 'Synthetic', amount: '100.00', dueDate: '10 Dec 2027', installment: 1 }, { channels: ['EMAIL'] });
    expect(res.EMAIL).toEqual({ status: 'SENT' });
    const c = calls[calls.length - 1];
    expect(c.url).toBe('https://api.resend.com/emails');
    expect(c.headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(c.body).toMatchObject({ from: 'Nexora Academy <no-reply@mail.nexoraed.com>', to: [to] });
    expect(c.body.text).toContain('100.00');
    const log = await prisma.notificationLog.findFirstOrThrow({ where: { recipient: to } });
    expect(log).toMatchObject({ channel: 'EMAIL', status: 'SENT', providerRef: `resend:email-${calls.length}` });
  });

  it('a Resend error is FAILED (so fee reminders retry it), with the reason', async () => {
    fail = 1;
    const to = `f${Date.now()}@example.invalid`;
    const res = await notify('fee.reminder_upcoming', { email: to }, { name: 'S', amount: '1.00', dueDate: 'x', installment: 1 }, { channels: ['EMAIL'] });
    expect(res.EMAIL.status).toBe('FAILED');
    expect(res.EMAIL.error).toContain('Resend 500');
    expect((await prisma.notificationLog.findFirstOrThrow({ where: { recipient: to } })).status).toBe('FAILED');
  });

  it('activation links are not stored in the log (sensitive messages stay redacted)', async () => {
    const to = `a${Date.now()}@example.invalid`;
    await notify('user.welcome', { email: to, name: 'New' }, { name: 'New', username: 'new', link: 'https://example.invalid/reset-password?token=SECRET123', hours: 72 }, { channels: ['EMAIL'], sensitive: true });
    expect(calls[calls.length - 1].body.text).toContain('SECRET123'); // the recipient gets the link
    expect((await prisma.notificationLog.findFirstOrThrow({ where: { recipient: to } })).body).not.toContain('SECRET123');
  });

  it('Super Admin test send: reports the provider, never the key; audited; others refused', async () => {
    const sa = await sessionFor((await makeUser(['super_admin'])).username);
    const info = await request(app).get('/api/v1/admin/email').set(as(sa));
    expect(info.body).toEqual({ provider: 'resend', from: 'Nexora Academy <no-reply@mail.nexoraed.com>' });
    const ok = await request(app).post('/api/v1/admin/email/test').set(as(sa)).send({ to: 'owner@example.invalid' });
    expect(ok.body.ok).toBe(true);
    expect(JSON.stringify(ok.body) + JSON.stringify(info.body)).not.toContain(KEY);
    fail = 1;
    const bad = await request(app).post('/api/v1/admin/email/test').set(as(sa)).send({ to: 'owner@example.invalid' });
    expect(bad.body).toMatchObject({ ok: false });
    expect(await prisma.auditLog.count({ where: { action: 'EMAIL_TEST' } })).toBeGreaterThanOrEqual(2);
    expect((await request(app).post('/api/v1/admin/email/test').set(as(await sessionFor('office'))).send({ to: 'x@example.invalid' })).status).toBe(403);
  });
});
