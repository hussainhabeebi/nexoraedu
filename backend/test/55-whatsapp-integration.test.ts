/**
 * WhatsApp (Chatwoot) adapter with a stubbed network: credentials encrypted at rest and never returned (INT-01),
 * every call logged (INT-02), retries with back-off (19.9), and inbox scoping per user (API-08).
 * No request leaves the machine — global fetch is replaced for this file.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { app, as, makeUser, prisma, sessionFor } from './helpers';

type Call = { method: string; url: string; body?: any };
const calls: Call[] = [];
let fail500 = 0;
const realFetch = globalThis.fetch;

function reply(json: unknown, status = 200) {
  return new Response(JSON.stringify(json), { status, headers: { 'Content-Type': 'application/json' } });
}

beforeAll(async () => {
  vi.stubGlobal('fetch', async (url: string, init: any) => {
    calls.push({ method: init?.method ?? 'GET', url: String(url), body: init?.body ? JSON.parse(init.body) : undefined });
    if (!String(url).startsWith('https://chatwoot.test/')) return realFetch(url, init);
    if (fail500 > 0) {
      fail500--;
      return reply({ error: 'boom' }, 500);
    }
    const u = new URL(String(url));
    const p = u.pathname.replace('/api/v1/accounts/7', '');
    if (p === '/contacts/search') return reply({ payload: [] });
    if (p === '/contacts' && init.method === 'POST') return reply({ payload: { contact: { id: 501, phone_number: init.body && JSON.parse(init.body).phone_number, contact_inboxes: [] } } });
    if (/^\/contacts\/\d+\/contact_inboxes$/.test(p)) return reply({ source_id: 'src-1' });
    if (/^\/contacts\/\d+\/conversations$/.test(p)) return reply({ payload: [] });
    if (p === '/conversations' && init.method === 'POST') return reply({ id: 9001 });
    if (/^\/conversations\/\d+\/messages$/.test(p) && init.method === 'POST') return reply({ id: 7001 });
    if (/^\/conversations\/\d+\/messages$/.test(p)) return reply({ payload: [{ id: 1, content: 'hello', message_type: 0, created_at: 1700000000 }] });
    if (p === '/conversations') return reply({ data: { meta: { all_count: 2 }, payload: [
      { id: 9001, status: 'open', meta: { sender: { id: 501, name: 'Own lead', phone_number: '+917700000001' } } },
      { id: 9002, status: 'open', meta: { sender: { id: 502, name: 'Someone else', phone_number: '+917700000002' } } },
    ] } });
    return reply({});
  });
  const sa = await sessionFor((await makeUser(['super_admin'])).username);
  const r = await request(app).put('/api/v1/whatsapp/config').set(as(sa)).send({ enabled: true, baseUrl: 'https://chatwoot.test', accountId: '7', inboxId: '3', apiToken: 'cw-secret-token-123456', webhookSecret: 'hook-secret-123456' });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
});
afterAll(async () => {
  vi.unstubAllGlobals();
  // Leave the integration disabled for any later test file.
  await prisma.setting.deleteMany({ where: { key: 'integration.chatwoot' } });
});

describe('Chatwoot integration', () => {
  it('stores the API token encrypted and never returns it', async () => {
    const row = await prisma.setting.findUniqueOrThrow({ where: { key: 'integration.chatwoot' } });
    expect(JSON.stringify(row.value)).not.toContain('cw-secret-token-123456');
    expect(JSON.stringify(row.value)).not.toContain('hook-secret-123456');
    const pub = await request(app).get('/api/v1/whatsapp/config').set(as(await sessionFor('office')));
    expect(JSON.stringify(pub.body)).not.toContain('cw-secret-token-123456');
    expect(pub.body.tokenHint).toBe('••••3456');
    expect(await prisma.auditLog.count({ where: { entity: 'integration', entityId: 'chatwoot' } })).toBeGreaterThan(0);
  });

  it('sends to an owned lead (contact → conversation → message), logs every call, and records the activity', async () => {
    const owner = await prisma.user.findUniqueOrThrow({ where: { username: 'counselor1' } });
    const lead = await prisma.lead.create({ data: { code: `LD-WA-${Date.now()}`, name: 'Own lead', phone: '+917700000001', phoneNormalized: '+917700000001', ownerId: owner.id } });
    const c1 = await sessionFor('counselor1');
    const before = await prisma.integrationLog.count();
    const r = await request(app).post(`/api/v1/whatsapp/leads/${lead.id}/send`).set(as(c1)).send({ content: 'Hello from Nexora' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ conversationId: 9001, messageId: 7001 });
    expect(calls.some((c) => c.url.includes('/conversations/9001/messages') && c.body?.content === 'Hello from Nexora')).toBe(true);
    expect(await prisma.integrationLog.count()).toBeGreaterThan(before);
    expect(await prisma.leadActivity.count({ where: { leadId: lead.id, type: 'WHATSAPP', direction: 'OUTBOUND' } })).toBe(1);
    // Another counselor cannot use this lead.
    expect((await request(app).post(`/api/v1/whatsapp/leads/${lead.id}/send`).set(as(await sessionFor('counselor2'))).send({ content: 'x' })).status).toBe(404);
  });

  it('inbox and conversation scope: counselors see only conversations of their own leads', async () => {
    const c1 = await sessionFor('counselor1');
    const list = await request(app).get('/api/v1/whatsapp/conversations').set(as(c1));
    expect(list.status).toBe(200);
    expect(list.body.items.map((i: any) => i.id)).toEqual([9001]);
    expect((await request(app).get('/api/v1/whatsapp/conversations/9001/messages').set(as(c1))).status).toBe(200);
    expect((await request(app).get('/api/v1/whatsapp/conversations/9002/messages').set(as(c1))).status).toBe(404);
    const sales = await sessionFor('salesmgr'); // leads:read_all → whole inbox
    expect((await request(app).get('/api/v1/whatsapp/conversations').set(as(sales))).body.items).toHaveLength(2);
  });

  it('retries transient Chatwoot 5xx errors with back-off and logs each attempt', async () => {
    fail500 = 1;
    const before = await prisma.integrationLog.count({ where: { status: 500 } });
    const r = await request(app).get('/api/v1/whatsapp/conversations/9001/messages').set(as(await sessionFor('salesmgr')));
    expect(r.status).toBe(200);
    expect(await prisma.integrationLog.count({ where: { status: 500 } })).toBe(before + 1);
  });

  it('inbound webhook requires the configured secret', async () => {
    const body = { event: 'message_created', message_type: 'incoming', content: 'Hi', conversation: { id: 1, inbox_id: 3 }, sender: { id: 9, phone_number: '+917700000099' } };
    expect((await request(app).post('/api/v1/webhooks/chatwoot').send(body)).status).toBe(401);
    expect((await request(app).post('/api/v1/webhooks/chatwoot').set('X-Webhook-Token', 'wrong-secret-000000').send(body)).status).toBe(401);
    expect((await request(app).post('/api/v1/webhooks/chatwoot').set('X-Webhook-Token', 'hook-secret-123456').send(body)).status).toBe(200);
  });
});
