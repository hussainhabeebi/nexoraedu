/**
 * WhatsApp AI chatbot on the Chatwoot inbox: admin configuration and permissions, disabled behaviour, incoming
 * messages, AI reply generation (Claude Sonnet 5.5, stubbed), CRM lead creation / matching / duplicate prevention,
 * human handover, outgoing replies through Chatwoot and webhook retries. Anthropic and Chatwoot are stubbed: no
 * real AI call is made and no WhatsApp message leaves the machine. Synthetic data only.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { app, as, makeStudent, makeUser, prisma, sessionFor } from './helpers';
import { invalidateSettings } from '../src/lib/settings';
import { toMessages, wantsHuman } from '../src/services/chatbot/bot-exports';

const HOOK_SECRET = 'chatbot-hook-secret-123456';
const FAKE_KEY = 'sk-ant-test-' + 'x'.repeat(30);
const realFetch = globalThis.fetch;

// ── Anthropic stub ──
type AiMode = 'reply' | 'handover' | 'error' | 'refusal';
let aiMode: AiMode = 'reply';
let aiOut: any = { reply: 'Hello! The Full Stack Web Development course is 6 months. May I know your name?', handover: false, handover_reason: '', lead: { name: null, email: null, city: null, course_interest: null, qualification: null } };
let aiDelayMs = 0;
const aiCalls: { headers: Record<string, string>; body: any }[] = [];
// ── Chatwoot stub ──
const cwSent: { conv: number; content: string; private: boolean }[] = [];
const cwToggles: { conv: number; status: string }[] = [];
const convMessages = new Map<number, any[]>();
let cwNextId = 50_000;

function aiResponse(body: any) {
  if (aiMode === 'error') return new Response(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }), { status: 529, headers: { 'Content-Type': 'application/json' } });
  const refusal = aiMode === 'refusal';
  const out = aiMode === 'handover' ? { ...aiOut, reply: '', handover: true, handover_reason: 'Asked about a refund policy that is not in the facts' } : aiOut;
  return new Response(JSON.stringify({
    id: `msg_${aiCalls.length}`, type: 'message', role: 'assistant', model: body.model,
    content: refusal ? [] : [{ type: 'text', text: JSON.stringify(out) }],
    stop_reason: refusal ? 'refusal' : 'end_turn', stop_sequence: null,
    usage: { input_tokens: 1200, output_tokens: 80, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  }), { status: 200, headers: { 'Content-Type': 'application/json', 'request-id': 'req_test' } });
}

beforeAll(async () => {
  vi.stubGlobal('fetch', async (url: any, init: any) => {
    const u = String(url instanceof Request ? url.url : url);
    if (u.startsWith('https://api.anthropic.com/')) {
      const headers = Object.fromEntries(new Headers(init?.headers ?? {}).entries());
      const body = JSON.parse(String(init?.body ?? '{}'));
      aiCalls.push({ headers, body });
      if (aiDelayMs) await new Promise((r) => setTimeout(r, aiDelayMs));
      return aiResponse(body);
    }
    if (!u.startsWith('https://chatwoot.test/')) return realFetch(url, init);
    const p = new URL(u).pathname.replace('/api/v1/accounts/7', '');
    const json = (j: unknown) => new Response(JSON.stringify(j), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (p === '/inboxes/3') return json({ id: 3, name: 'Nexora Academy', channel_type: 'Channel::Whatsapp', phone_number: '+910000000000' });
    let m = /^\/conversations\/(\d+)\/messages$/.exec(p);
    if (m && init?.method === 'POST') {
      const b = JSON.parse(init.body);
      const id = ++cwNextId;
      cwSent.push({ conv: Number(m[1]), content: b.content, private: !!b.private });
      convMessages.set(Number(m[1]), [...(convMessages.get(Number(m[1])) ?? []), { id, content: b.content, message_type: 1, private: !!b.private, created_at: Math.floor(Date.now() / 1000) }]);
      return json({ id });
    }
    if (m) return json({ payload: convMessages.get(Number(m[1])) ?? [] });
    m = /^\/conversations\/(\d+)\/toggle_status$/.exec(p);
    if (m) {
      cwToggles.push({ conv: Number(m[1]), status: JSON.parse(init.body).status });
      return json({ ok: true });
    }
    return json({});
  });
  const sa = await sessionFor((await makeUser(['super_admin'])).username);
  const r = await request(app).put('/api/v1/whatsapp/config').set(as(sa)).send({ enabled: true, baseUrl: 'https://chatwoot.test', accountId: '7', inboxId: '3', apiToken: 'cw-test-token-123456', webhookSecret: HOOK_SECRET, autoCreateLeads: true });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
});
afterAll(async () => {
  await prisma.setting.deleteMany({ where: { key: { in: ['chatbot', 'integration.chatwoot'] } } });
  invalidateSettings();
  delete process.env.ANTHROPIC_API_KEY;
  vi.unstubAllGlobals();
});

let conv = 9_000;
let msg = 700_000;
const newPhone = () => `+91${9000000000 + Math.floor(Math.random() * 99_999_999)}`;
const hook = (b: unknown) => request(app).post(`/api/v1/webhooks/chatwoot?token=${HOOK_SECRET}`).send(b as object);
function incoming(conversationId: number, phone: string, content: string, opts: { id?: number; name?: string } = {}) {
  const id = opts.id ?? ++msg;
  convMessages.set(conversationId, [...(convMessages.get(conversationId) ?? []), { id, content, message_type: 0, private: false, created_at: Math.floor(Date.now() / 1000) }]);
  return { event: 'message_created', message_type: 'incoming', id, content, private: false, inbox: { id: 3 }, conversation: { id: conversationId, inbox_id: 3, contact_inbox: { source_id: phone.slice(1) } }, sender: { id: 4000 + (id % 1000), name: opts.name ?? 'Synthetic Enquirer', phone_number: phone } };
}
const outgoing = (conversationId: number, content: string, id = ++msg) => ({ event: 'message_created', message_type: 'outgoing', id, content, private: false, inbox: { id: 3 }, conversation: { id: conversationId, inbox_id: 3 } });
const eventOf = (id: number) => prisma.chatwootMessageEvent.findUnique({ where: { chatwootMessageId: String(id) } });
async function settled(id: number) {
  for (let i = 0; i < 200; i++) {
    const e = await eventOf(id);
    if (e && !['PENDING', 'SENDING'].includes(e.botStatus)) return e;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`bot did not finish for message ${id}`);
}
const botSent = (c: number) => cwSent.filter((x) => x.conv === c && !x.private);

let admin: string, sa: string;
const saveBot = (tok: string, patch: Record<string, unknown>) => request(app).get('/api/v1/admin/chatbot').set(as(tok)).then((g) => request(app).put('/api/v1/admin/chatbot').set(as(tok)).send({ ...g.body.config, ...patch }));

describe('admin configuration and permissions', () => {
  it('defaults: off, with a default prompt; status shows what is missing; the key is never returned', async () => {
    [admin, sa] = await Promise.all([sessionFor('office'), sessionFor((await makeUser(['super_admin'])).username)]);
    const r = await request(app).get('/api/v1/admin/chatbot').set(as(admin));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.config.enabled).toBe(false);
    expect(r.body.config.systemPrompt).toMatch(/Nexora Academy/);
    expect(r.body.status).toMatchObject({ enabled: false, aiConfigured: false, chatwootReady: true, model: 'claude-sonnet-5-5', active: false });
    expect(r.body.fixedRules).toMatch(/Never invent/);
    expect(r.body.publishedCourses).toBeGreaterThan(0);
  });

  it('cannot be turned on without the AI key; Admin and Super Admin save the prompt (stored in the database, audited)', async () => {
    const off = await saveBot(admin, { enabled: true });
    expect(off.status).toBe(400);
    expect(off.body.error.message).toMatch(/ANTHROPIC_API_KEY/);
    const saved = await saveBot(admin, { systemPrompt: 'You are the friendly Nexora WhatsApp assistant. PROMPT-MARKER-123.', knowledge: 'Office hours: 9 am to 6 pm, Monday to Saturday.' });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    const row = await prisma.setting.findUniqueOrThrow({ where: { key: 'chatbot' } });
    expect((row.value as any).systemPrompt).toMatch(/PROMPT-MARKER-123/);
    expect((await request(app).get('/api/v1/admin/chatbot').set(as(sa))).body.config.knowledge).toMatch(/Office hours/);
    expect(await prisma.auditLog.count({ where: { action: 'UPDATE', entity: 'setting', entityId: 'chatbot' } })).toBeGreaterThan(0);
    expect((await saveBot(admin, { systemPrompt: 'short' })).status).toBe(422);
  });

  it('only Administrators and Super Administrators may read or change it; the generic settings route cannot bypass it', async () => {
    for (const u of ['counselor1', 'finmgr', 'salesmgr', 'director']) {
      const tok = await sessionFor(u);
      expect((await request(app).get('/api/v1/admin/chatbot').set(as(tok))).status, u).toBe(403);
      expect((await request(app).put('/api/v1/admin/chatbot').set(as(tok)).send({})).status, u).toBe(403);
    }
    expect((await request(app).get('/api/v1/admin/chatbot')).status).toBe(401);
    expect((await request(app).put('/api/v1/admin/settings/chatbot').set(as(sa)).send({ enabled: true })).status).toBe(400);
  });
});

describe('bot disabled', () => {
  it('existing behaviour unchanged: lead created and logged, no AI call, nothing sent', async () => {
    const c = ++conv;
    const phone = newPhone();
    const before = aiCalls.length;
    const e = incoming(c, phone, 'Hi, course details please');
    expect((await hook(e)).status).toBe(200);
    const ev = (await eventOf(e.id))!;
    expect(ev).toMatchObject({ botStatus: 'OFF', contactKind: 'LEAD' });
    const lead = await prisma.lead.findFirstOrThrow({ where: { phoneNormalized: phone } });
    expect(lead.source).toBe('whatsapp');
    expect(await prisma.leadActivity.count({ where: { leadId: lead.id, type: 'WHATSAPP', direction: 'INBOUND' } })).toBe(1);
    expect(aiCalls.length).toBe(before);
    expect(botSent(c)).toHaveLength(0);
  });
});

describe('bot enabled', () => {
  beforeAll(async () => {
    process.env.ANTHROPIC_API_KEY = FAKE_KEY;
    const on = await saveBot(admin, { enabled: true });
    expect(on.status, JSON.stringify(on.body)).toBe(200);
    expect(on.body.status.active).toBe(true);
  });

  it('a new enquiry: one lead (existing assignment rules), grounded AI reply sent through Chatwoot, details saved', async () => {
    const fsd = await prisma.course.findUniqueOrThrow({ where: { code: 'FSD' } });
    aiOut = { ...aiOut, reply: 'Hi Anu! The Full Stack course is 6 months and the total fee is ₹60,100.', lead: { name: 'Anu Synthetic', email: 'anu.synthetic@example.invalid', city: 'Kochi', course_interest: fsd.name, qualification: 'BCom' } };
    const c = ++conv;
    const phone = newPhone();
    const e = incoming(c, phone, 'Hi, I am Anu from Kochi. What is the fee for full stack?');
    await hook(e);
    const ev = await settled(e.id);
    expect(ev, JSON.stringify(ev)).toMatchObject({ botStatus: 'REPLIED', contactKind: 'LEAD', botModel: 'claude-sonnet-5-5', inputTokens: 1200, outputTokens: 80 });
    expect(botSent(c).map((x) => x.content)).toEqual([aiOut.reply]);

    const call = aiCalls[aiCalls.length - 1];
    expect(call.body).toMatchObject({ model: 'claude-sonnet-5-5', fallbacks: 'default', output_config: { effort: 'low' } });
    expect(call.headers['anthropic-beta']).toContain('server-side-fallback-2026-07-01');
    expect(call.headers['x-api-key'] ?? call.headers.authorization).toContain(FAKE_KEY); // key only in the auth header
    expect(JSON.stringify(call.body)).not.toContain(FAKE_KEY);
    const system = JSON.stringify(call.body.system);
    expect(system).toContain('PROMPT-MARKER-123'); // saved admin prompt
    expect(system).toContain('Office hours'); // saved knowledge
    expect(system).toContain(fsd.name); // published course facts
    expect(system).toContain('₹60,100'); // published fee incl. tax
    expect(system).toContain('Never invent'); // fixed rules
    expect(JSON.stringify(call.body)).not.toContain(phone.slice(3)); // no phone number sent to the AI
    const aiLogs = await prisma.integrationLog.findMany({ where: { name: 'anthropic' } });
    expect(aiLogs.length).toBeGreaterThan(0);
    expect(JSON.stringify(aiLogs)).not.toContain(FAKE_KEY);
    expect(JSON.stringify(aiLogs)).not.toContain('Anu');
    expect(call.body.messages.at(-1)).toEqual({ role: 'user', content: 'Hi, I am Anu from Kochi. What is the fee for full stack?' });

    const leads = await prisma.lead.findMany({ where: { phoneNormalized: phone } });
    expect(leads).toHaveLength(1);
    expect(leads[0]).toMatchObject({ name: 'Synthetic Enquirer', city: 'Kochi', email: 'anu.synthetic@example.invalid', courseId: fsd.id, source: 'whatsapp' });
    expect(leads[0].ownerId).toBeTruthy(); // assigned by the existing round-robin rule
    expect(await prisma.leadActivity.count({ where: { leadId: leads[0].id, type: 'WHATSAPP', direction: 'OUTBOUND' } })).toBe(1);
    expect(await prisma.leadActivity.count({ where: { leadId: leads[0].id, content: { contains: 'qualification: BCom' } } })).toBe(1);
  });

  it('a retried or duplicated webhook event is ignored: no second reply, activity or AI call', async () => {
    const c = ++conv;
    const e = incoming(c, newPhone(), 'Do you have weekend batches?');
    await hook(e);
    await settled(e.id);
    const calls = aiCalls.length;
    const sent = botSent(c).length;
    const dup = await hook(e);
    expect(dup.body.duplicate).toBe(true);
    await hook(e);
    expect(aiCalls.length).toBe(calls);
    expect(botSent(c).length).toBe(sent);
    expect(await prisma.chatwootMessageEvent.count({ where: { chatwootMessageId: String(e.id) } })).toBe(1);
    const lead = await prisma.lead.findFirstOrThrow({ where: { chatwootConversationId: c } });
    expect(await prisma.leadActivity.count({ where: { leadId: lead.id, type: 'WHATSAPP', direction: 'INBOUND' } })).toBe(1);
  });

  it('several messages from a new number at once: one lead, and one reply (to the latest message)', async () => {
    const c = ++conv;
    const phone = newPhone();
    aiDelayMs = 150;
    try {
      const evs = [1, 2, 3].map((i) => incoming(c, phone, `Message ${i}`));
      await Promise.all(evs.map((e) => hook(e)));
      const done = await Promise.all(evs.map((e) => settled(e.id)));
      expect(await prisma.lead.count({ where: { phoneNormalized: phone } })).toBe(1);
      expect(done.filter((d) => d.botStatus === 'REPLIED').length).toBeLessThanOrEqual(1);
      expect(botSent(c).length).toBeLessThanOrEqual(1);
    } finally {
      aiDelayMs = 0;
    }
  });

  it('an existing lead is matched by normalised phone: no new lead, its owner keeps it', async () => {
    const owner = await prisma.user.findUniqueOrThrow({ where: { username: 'counselor1' } });
    const digits = String(8000000000 + Math.floor(Math.random() * 99_999_999));
    const lead = await prisma.lead.create({ data: { code: `LD-BOT-${Date.now()}`, name: 'Existing Prospect', phone: `${digits.slice(0, 5)} ${digits.slice(5)}`, phoneNormalized: `+91${digits}`, ownerId: owner.id, source: 'website' } });
    const c = ++conv;
    const e = incoming(c, `+91${digits}`, 'Hello again');
    await hook(e);
    const ev = await settled(e.id);
    expect(ev).toMatchObject({ leadId: lead.id, contactKind: 'LEAD', botStatus: 'REPLIED' });
    expect(await prisma.lead.count({ where: { phoneNormalized: `+91${digits}` } })).toBe(1);
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).ownerId).toBe(owner.id);
  });

  it('students and parents are never answered by the bot and never become leads', async () => {
    const st = await makeStudent({});
    const c1 = ++conv;
    const e1 = incoming(c1, st.phoneNormalized, 'When is my next class?');
    await hook(e1);
    expect(await settled(e1.id)).toMatchObject({ contactKind: 'STUDENT', botStatus: 'SKIPPED' });
    const digits = String(7000000000 + Math.floor(Math.random() * 99_999_999));
    const g = await request(app).post(`/api/v1/students/${st.id}/guardians`).set(as(admin)).send({ name: 'Synthetic Father', relation: 'Father', phone: `0${digits}` });
    expect(g.body.phoneNormalized).toBe(`+91${digits}`);
    const c2 = ++conv;
    const e2 = incoming(c2, `+91${digits}`, 'Fee query for my son');
    await hook(e2);
    expect(await settled(e2.id)).toMatchObject({ contactKind: 'PARENT', botStatus: 'SKIPPED' });
    expect(await prisma.lead.count({ where: { phoneNormalized: { in: [st.phoneNormalized, `+91${digits}`] } } })).toBe(0);
    expect(botSent(c1).length + botSent(c2).length).toBe(0);
  });

  it('handover keyword: no AI call, handover message, private note, conversation opened, owner notified; then silence', async () => {
    const c = ++conv;
    const calls = aiCalls.length;
    const e = incoming(c, newPhone(), 'Can I talk to a counsellor please?');
    await hook(e);
    expect(await settled(e.id)).toMatchObject({ botStatus: 'HANDOVER', botReason: 'The customer asked for a person' });
    expect(aiCalls.length).toBe(calls);
    expect(botSent(c).map((x) => x.content)).toEqual(['Thank you! I have passed your message to our counsellor, who will reply to you here shortly.']);
    expect(cwSent.some((x) => x.conv === c && x.private && /handed this conversation/.test(x.content))).toBe(true);
    expect(cwToggles).toContainEqual({ conv: c, status: 'open' });
    const lead = await prisma.lead.findFirstOrThrow({ where: { chatwootConversationId: c } });
    expect(await prisma.notification.count({ where: { userId: lead.ownerId!, title: { contains: 'needs a person' } } })).toBe(1);
    const next = incoming(c, lead.phoneNormalized, 'Hello?');
    await hook(next);
    expect(await settled(next.id)).toMatchObject({ botStatus: 'SKIPPED', botReason: 'Conversation is with a person' });
    expect(botSent(c)).toHaveLength(1);
  });

  it('the AI decides to hand over when the answer is not in the verified facts', async () => {
    aiMode = 'handover';
    try {
      const c = ++conv;
      const e = incoming(c, newPhone(), 'What happens to my fee if I leave the course after a month?');
      await hook(e);
      expect(await settled(e.id)).toMatchObject({ botStatus: 'HANDOVER', botReason: 'Asked about a refund policy that is not in the facts' });
      expect(botSent(c).map((x) => x.content)).toEqual(['Thank you! I have passed your message to our counsellor, who will reply to you here shortly.']);
    } finally {
      aiMode = 'reply';
    }
  });

  it('AI unavailable or declining: the customer is handed to a person instead of waiting', async () => {
    for (const mode of ['error', 'refusal'] as const) {
      aiMode = mode;
      try {
        const c = ++conv;
        const e = incoming(c, newPhone(), 'Hi there');
        await hook(e);
        const ev = await settled(e.id);
        expect(ev.botStatus, mode).toBe('FAILED');
        expect((await prisma.chatbotConversation.findUniqueOrThrow({ where: { conversationId: c } })).mode).toBe('HUMAN');
        expect(botSent(c)).toHaveLength(1); // the handover message only
      } finally {
        aiMode = 'reply';
      }
    }
  });

  it("a staff reply in Chatwoot hands over; the bot's own echo does not; Nexora inbox replies count as staff", async () => {
    const c = ++conv;
    const phone = newPhone();
    const e = incoming(c, phone, 'Hi');
    await hook(e);
    await settled(e.id);
    const botText = botSent(c)[0].content;
    expect((await hook(outgoing(c, botText))).body.outgoing).toBe('bot');
    expect((await prisma.chatbotConversation.findUniqueOrThrow({ where: { conversationId: c } })).mode).toBe('BOT');
    expect((await hook(outgoing(c, 'Hi, this is Meera from the admissions desk.'))).body.outgoing).toBe('staff');
    expect((await prisma.chatbotConversation.findUniqueOrThrow({ where: { conversationId: c } })).mode).toBe('HUMAN');
    const e2 = incoming(c, phone, 'Thanks Meera');
    await hook(e2);
    expect((await settled(e2.id)).botStatus).toBe('SKIPPED');

    const c2 = ++conv;
    const e3 = incoming(c2, newPhone(), 'Hello');
    await hook(e3);
    await settled(e3.id);
    const fin = await sessionFor('salesmgr');
    expect((await request(app).post(`/api/v1/whatsapp/conversations/${c2}/reply`).set(as(fin)).send({ content: 'Hello from the sales team' })).status).toBe(200);
    expect((await prisma.chatbotConversation.findUniqueOrThrow({ where: { conversationId: c2 } })).mode).toBe('HUMAN');
  });

  it('reply limit hands over; an admin can resume a conversation (audited)', async () => {
    const c = ++conv;
    const phone = newPhone();
    await saveBot(admin, { maxBotReplies: 1 });
    try {
      const a = incoming(c, phone, 'Question one');
      await hook(a);
      expect((await settled(a.id)).botStatus).toBe('REPLIED');
      const b = incoming(c, phone, 'Question two');
      await hook(b);
      expect(await settled(b.id)).toMatchObject({ botStatus: 'HANDOVER', botReason: 'Reply limit reached (1 assistant replies)' });
      const r = await request(app).post(`/api/v1/admin/chatbot/conversations/${c}/resume`).set(as(admin));
      expect(r.status).toBe(200);
      expect(await prisma.chatbotConversation.findUniqueOrThrow({ where: { conversationId: c } })).toMatchObject({ mode: 'BOT', botReplies: 0 });
      expect(await prisma.auditLog.count({ where: { action: 'CHATBOT_RESUME', entityId: String(c) } })).toBe(1);
      expect((await request(app).post(`/api/v1/admin/chatbot/conversations/${c}/resume`).set(as(await sessionFor('counselor1')))).status).toBe(403);
    } finally {
      await saveBot(admin, { maxBotReplies: 8 });
    }
  });

  it('test endpoint: generates a reply with a draft prompt, sends nothing, changes no record', async () => {
    const sent = cwSent.length;
    const leads = await prisma.lead.count();
    const r = await request(app).post('/api/v1/admin/chatbot/test').set(as(admin)).send({ message: 'What courses do you offer?', draft: { systemPrompt: 'Draft prompt DRAFT-MARKER for testing purposes only.' } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ handover: false, model: 'claude-sonnet-5-5' });
    expect(r.body.reply).toBeTruthy();
    expect(JSON.stringify(aiCalls[aiCalls.length - 1].body.system)).toContain('DRAFT-MARKER');
    expect(cwSent.length).toBe(sent);
    expect(await prisma.lead.count()).toBe(leads);
    expect((await request(app).post('/api/v1/admin/chatbot/test').set(as(await sessionFor('counselor1'))).send({ message: 'x' })).status).toBe(403);
  });

  it('activity list shows results without phone numbers; turning the bot off stops replies immediately', async () => {
    const list = await request(app).get('/api/v1/admin/chatbot/events').set(as(admin));
    expect(list.status).toBe(200);
    expect(list.body.items.length).toBeGreaterThan(0);
    expect(JSON.stringify(list.body)).not.toMatch(/\+91\d{10}/);
    expect((await saveBot(admin, { enabled: false })).body.status.enabled).toBe(false);
    const c = ++conv;
    const calls = aiCalls.length;
    const e = incoming(c, newPhone(), 'Hi');
    await hook(e);
    expect((await eventOf(e.id))!.botStatus).toBe('OFF');
    expect(aiCalls.length).toBe(calls);
  });
});

describe('pure helpers', () => {
  it('handover keywords match whole words and phrases, not parts of words', () => {
    expect(wantsHuman('Can I talk to a COUNSELLOR?', ['counsellor'])).toBe(true);
    expect(wantsHuman('please call me tomorrow', ['call me'])).toBe(true);
    expect(wantsHuman('I want to be a humanities teacher', ['human'])).toBe(false);
  });
  it('conversation for the AI starts and ends with the customer and drops empty messages', () => {
    expect(toMessages([{ role: 'assistant', text: 'Welcome' }, { role: 'user', text: 'Hi' }, { role: 'assistant', text: '' }, { role: 'assistant', text: 'Hello!' }, { role: 'user', text: 'Fees?' }])).toEqual([
      { role: 'user', content: 'Hi' }, { role: 'assistant', content: 'Hello!' }, { role: 'user', content: 'Fees?' },
    ]);
  });
});
