/**
 * Chatwoot (app.aiingo.com) client — WhatsApp channel for Nexora (SRS §17.4, §19.4).
 *
 * All WhatsApp traffic is routed through a Chatwoot WhatsApp inbox:
 *   outgoing → Chatwoot API (contacts → conversations → messages)
 *   incoming → Chatwoot webhook → /api/v1/webhooks/chatwoot
 *
 * Credentials are stored encrypted in `settings` (key: integration.chatwoot) and can be
 * overridden by env vars. Every call is logged in integration_logs (INT-02).
 */
import { prisma } from '../lib/prisma';
import { config } from '../config';
import { decrypt, encrypt } from '../lib/util';
import { HttpError } from '../lib/http';

export interface ChatwootConfig {
  enabled: boolean;
  baseUrl: string;
  accountId: string;
  inboxId: string;
  apiToken: string;
  webhookSecret: string;
  autoCreateLeads: boolean;
}

const KEY = 'integration.chatwoot';

export async function getChatwootConfig(): Promise<ChatwootConfig> {
  const row = await prisma.setting.findUnique({ where: { key: KEY } });
  const v = (row?.value ?? {}) as any;
  let token = config.chatwoot.apiToken;
  if (v.apiTokenEnc) {
    try {
      token = decrypt(v.apiTokenEnc);
    } catch {
      /* key rotated — fall back to env */
    }
  }
  let secret = config.chatwoot.webhookSecret;
  if (v.webhookSecretEnc) {
    try {
      secret = decrypt(v.webhookSecretEnc);
    } catch {
      /* ignore */
    }
  }
  return {
    enabled: v.enabled ?? Boolean(token),
    baseUrl: (v.baseUrl || config.chatwoot.baseUrl).replace(/\/+$/, ''),
    accountId: String(v.accountId || config.chatwoot.accountId || ''),
    inboxId: String(v.inboxId || config.chatwoot.inboxId || ''),
    apiToken: token,
    webhookSecret: secret,
    autoCreateLeads: v.autoCreateLeads ?? true,
  };
}

export async function saveChatwootConfig(input: Partial<ChatwootConfig>) {
  const row = await prisma.setting.findUnique({ where: { key: KEY } });
  const cur = (row?.value ?? {}) as any;
  const next: any = {
    ...cur,
    enabled: input.enabled ?? cur.enabled ?? false,
    baseUrl: input.baseUrl ?? cur.baseUrl ?? config.chatwoot.baseUrl,
    accountId: input.accountId ?? cur.accountId ?? '',
    inboxId: input.inboxId ?? cur.inboxId ?? '',
    autoCreateLeads: input.autoCreateLeads ?? cur.autoCreateLeads ?? true,
  };
  if (input.apiToken) next.apiTokenEnc = encrypt(input.apiToken);
  if (input.webhookSecret) next.webhookSecretEnc = encrypt(input.webhookSecret);
  await prisma.setting.upsert({ where: { key: KEY }, create: { key: KEY, value: next }, update: { value: next } });
}

export async function publicChatwootConfig() {
  const c = await getChatwootConfig();
  return {
    enabled: c.enabled,
    baseUrl: c.baseUrl,
    accountId: c.accountId,
    inboxId: c.inboxId,
    autoCreateLeads: c.autoCreateLeads,
    hasToken: Boolean(c.apiToken),
    tokenHint: c.apiToken ? `••••${c.apiToken.slice(-4)}` : null,
    hasWebhookSecret: Boolean(c.webhookSecret),
    webhookUrl: `${config.apiBaseUrl}/api/v1/webhooks/chatwoot${c.webhookSecret ? '?token=<your-webhook-secret>' : ''}`,
  };
}

async function cw<T = any>(method: string, path: string, body?: unknown, retries = 2): Promise<T> {
  const c = await getChatwootConfig();
  if (!c.enabled || !c.apiToken || !c.accountId || !c.inboxId)
    throw new HttpError(503, 'WhatsApp (Chatwoot) integration is not configured or disabled.', 'INTEGRATION_DISABLED');
  const url = `${c.baseUrl}/api/v1/accounts/${c.accountId}${path}`;
  for (let attempt = 0; ; attempt++) {
    const started = Date.now();
    let status: number | undefined;
    try {
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json', api_access_token: c.apiToken },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(15_000),
      });
      status = res.status;
      const text = await res.text();
      const data = text ? JSON.parse(text) : {};
      await logCall(method, path, status, started, res.ok ? undefined : text.slice(0, 500));
      if (res.ok) return data as T;
      if (status >= 500 && attempt < retries) {
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
        continue;
      }
      throw new HttpError(502, `Chatwoot error (${status}): ${data?.message || data?.error || text.slice(0, 200)}`, 'CHATWOOT_ERROR');
    } catch (e: any) {
      if (e instanceof HttpError) throw e;
      await logCall(method, path, status, started, String(e?.message || e));
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
        continue;
      }
      throw new HttpError(502, `Could not reach Chatwoot: ${e?.message || e}`, 'CHATWOOT_UNREACHABLE');
    }
  }
}

function logCall(method: string, endpoint: string, status: number | undefined, started: number, error?: string) {
  return prisma.integrationLog
    .create({ data: { name: 'chatwoot', method, endpoint, status, durationMs: Date.now() - started, error } })
    .catch(() => undefined);
}

const digits = (p: string) => p.replace(/\D/g, '');

export async function testConnection() {
  const c = await getChatwootConfig();
  const inbox = await cw('GET', `/inboxes/${c.inboxId}`);
  return { ok: true, inbox: { id: inbox.id, name: inbox.name, channelType: inbox.channel_type, phone: inbox.phone_number } };
}

/** Find a Chatwoot contact by phone (or create it) and make sure it is attached to our WhatsApp inbox. */
export async function ensureContact(p: { name: string; phone: string; email?: string | null }) {
  const c = await getChatwootConfig();
  const inboxId = Number(c.inboxId);
  const phone = '+' + digits(p.phone);
  const search = await cw<{ payload: any[] }>('GET', `/contacts/search?q=${encodeURIComponent(phone)}&include_contact_inboxes=true`);
  let contact = search.payload?.find((x) => digits(x.phone_number || '') === digits(phone));
  if (!contact) {
    const created = await cw<any>('POST', '/contacts', {
      inbox_id: inboxId,
      name: p.name,
      phone_number: phone,
      email: p.email || undefined,
    });
    contact = created.payload?.contact ?? created.payload ?? created;
  }
  let ci = (contact.contact_inboxes || []).find((x: any) => Number(x.inbox?.id ?? x.inbox_id) === inboxId);
  if (!ci) {
    ci = await cw<any>('POST', `/contacts/${contact.id}/contact_inboxes`, { inbox_id: inboxId, source_id: digits(phone) });
  }
  return { contactId: Number(contact.id), sourceId: String(ci.source_id) };
}

export async function ensureConversation(contactId: number, sourceId: string) {
  const c = await getChatwootConfig();
  const inboxId = Number(c.inboxId);
  const list = await cw<{ payload: any[] }>('GET', `/contacts/${contactId}/conversations`);
  const existing = (list.payload || [])
    .filter((x) => Number(x.inbox_id) === inboxId)
    .sort((a, b) => (b.last_activity_at || 0) - (a.last_activity_at || 0))[0];
  if (existing) return Number(existing.id);
  const conv = await cw<any>('POST', '/conversations', { source_id: sourceId, inbox_id: inboxId, contact_id: contactId, status: 'open' });
  return Number(conv.id);
}

export interface WaTemplate {
  name: string;
  language?: string;
  category?: string;
  params?: string[];
}

/**
 * Send a WhatsApp message through Chatwoot. Free-form content works inside the 24-hour
 * customer-service window; outside it pass `template` (an approved WhatsApp template).
 */
export async function sendWhatsApp(p: {
  phone: string;
  name: string;
  email?: string | null;
  content: string;
  template?: WaTemplate;
  conversationId?: number | null;
}) {
  let conversationId = p.conversationId ?? null;
  let contactId: number | null = null;
  if (!conversationId) {
    const ct = await ensureContact(p);
    contactId = ct.contactId;
    conversationId = await ensureConversation(ct.contactId, ct.sourceId);
  }
  const body: any = { content: p.content, message_type: 'outgoing', private: false };
  if (p.template) {
    body.template_params = {
      name: p.template.name,
      category: p.template.category || 'UTILITY',
      language: p.template.language || 'en',
      processed_params: Object.fromEntries((p.template.params || []).map((v, i) => [String(i + 1), v])),
    };
  }
  const msg = await cw<any>('POST', `/conversations/${conversationId}/messages`, body);
  return { conversationId, contactId, messageId: Number(msg.id) };
}

export async function listMessages(conversationId: number) {
  const r = await cw<any>('GET', `/conversations/${conversationId}/messages`);
  return (r.payload || []).map((m: any) => ({
    id: m.id,
    content: m.content,
    type: m.message_type === 0 ? 'incoming' : m.message_type === 1 ? 'outgoing' : m.message_type === 2 ? 'activity' : String(m.message_type),
    private: m.private,
    status: m.status,
    createdAt: new Date(m.created_at * 1000).toISOString(),
    sender: m.sender?.name,
    attachments: (m.attachments || []).map((a: any) => ({ url: a.data_url, type: a.file_type })),
  }));
}

export async function listConversations(q: { status?: string; page?: number; query?: string }) {
  const c = await getChatwootConfig();
  const params = new URLSearchParams({ inbox_id: c.inboxId, status: q.status || 'open', page: String(q.page || 1) });
  if (q.query) params.set('q', q.query);
  const r = await cw<any>('GET', `/conversations?${params}`);
  const items = r.data?.payload ?? r.payload ?? [];
  return {
    counts: r.data?.meta ?? r.meta ?? {},
    items: items.map((x: any) => ({
      id: x.id,
      status: x.status,
      unread: x.unread_count,
      lastActivityAt: x.last_activity_at ? new Date(x.last_activity_at * 1000).toISOString() : null,
      contact: { id: x.meta?.sender?.id, name: x.meta?.sender?.name, phone: x.meta?.sender?.phone_number, email: x.meta?.sender?.email },
      assignee: x.meta?.assignee?.name ?? null,
      lastMessage: x.messages?.[x.messages.length - 1]?.content ?? x.last_non_activity_message?.content ?? null,
    })),
  };
}

export async function toggleConversationStatus(conversationId: number, status: 'open' | 'resolved' | 'pending') {
  return cw('POST', `/conversations/${conversationId}/toggle_status`, { status });
}

export async function addPrivateNote(conversationId: number, content: string) {
  return cw('POST', `/conversations/${conversationId}/messages`, { content, message_type: 'outgoing', private: true });
}
