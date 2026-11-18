/**
 * Settings → WhatsApp AI Chatbot (mounted at /api/v1/admin/chatbot). Administrators and Super Administrators only
 * (permission chatbot:manage). The prompt and options are stored in the settings table (key "chatbot") and every change
 * is audit-logged. The AI key is never returned: only whether it is configured.
 */
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { ah, badRequest, paging } from '../lib/http';
import { can } from '../lib/auth';
import { audit } from '../lib/audit';
import { atomic } from '../lib/db';
import { getSettings, invalidateSettings } from '../lib/settings';
import { chatbotState, testBot } from '../services/chatbot/bot';
import { FIXED_RULES } from '../services/chatbot/claude';
import { academyFacts } from '../services/chatbot/facts';

const r = Router();
r.use(can('chatbot:manage'));

const configSchema = z.object({
  enabled: z.boolean(),
  systemPrompt: z.string().trim().min(20, 'The system prompt is too short').max(20_000),
  knowledge: z.string().max(20_000),
  maxBotReplies: z.number().int().min(1).max(50),
  dailyAiLimit: z.number().int().min(1).max(5000).default(300),
  handoverKeywords: z.array(z.string().trim().min(2).max(60)).max(40),
  handoverMessage: z.string().trim().min(5).max(500),
});

r.get('/', ah(async (_req, res) => {
  const s = await getSettings();
  const since = new Date(Date.now() - 7 * 864e5);
  const counts = await prisma.chatwootMessageEvent.groupBy({ by: ['botStatus'], where: { createdAt: { gte: since } }, _count: true });
  const facts = await academyFacts();
  res.json({
    config: s.chatbot,
    status: await chatbotState(),
    fixedRules: FIXED_RULES,
    publishedCourses: facts.courses.length,
    last7Days: Object.fromEntries(counts.map((c) => [c.botStatus, c._count])),
  });
}));

r.put('/', ah(async (req, res) => {
  const d = configSchema.parse(req.body);
  const before = (await getSettings()).chatbot;
  const st = await chatbotState();
  if (d.enabled && !before.enabled) {
    if (!st.aiConfigured) throw badRequest('Add the ANTHROPIC_API_KEY secret to this Worker in Cloudflare before turning the chatbot on.');
    if (!st.chatwootReady) throw badRequest('Connect Chatwoot (Settings → WhatsApp) before turning the chatbot on.');
  }
  const value = { ...before, ...d, handoverKeywords: [...new Set(d.handoverKeywords.map((k) => k.toLowerCase()))] };
  await atomic(async (tx) => {
    await tx.setting.upsert({ where: { key: 'chatbot' }, create: { key: 'chatbot', value }, update: { value } });
    await audit(tx, req, 'UPDATE', 'setting', 'chatbot', before, value);
  });
  invalidateSettings();
  res.json({ config: value, status: await chatbotState() });
}));

// Try the assistant with a message (and optionally an unsaved draft prompt). Sends nothing to WhatsApp, changes no record.
r.post('/test', ah(async (req, res) => {
  const d = z.object({
    message: z.string().trim().min(1).max(2000),
    history: z.array(z.object({ role: z.enum(['user', 'assistant']), text: z.string().max(2000) })).max(10).default([]),
    draft: configSchema.pick({ systemPrompt: true, knowledge: true }).partial().optional(),
  }).parse(req.body);
  const st = await chatbotState();
  if (!st.aiConfigured) throw badRequest('The AI is not configured: add the ANTHROPIC_API_KEY secret to this Worker in Cloudflare.');
  const s = (await getSettings()).chatbot;
  const out = await testBot({ ...s, ...(d.draft ?? {}) }, d.message, d.history);
  await audit(prisma, req, 'CHATBOT_TEST', 'setting', 'chatbot', null, { handover: out.handover, inputTokens: out.inputTokens, outputTokens: out.outputTokens });
  res.json(out);
}));

// Recent assistant activity (no phone numbers or customer messages; the assistant's own replies only).
r.get('/events', ah(async (req, res) => {
  const { skip, take, page, pageSize } = paging(req.query);
  const where = req.query.status ? { botStatus: String(req.query.status) } : { botStatus: { not: 'OFF' } };
  const [items, total] = await Promise.all([
    prisma.chatwootMessageEvent.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take, select: { id: true, conversationId: true, contactKind: true, leadId: true, botStatus: true, botReason: true, botReplyText: true, botModel: true, inputTokens: true, outputTokens: true, createdAt: true } }),
    prisma.chatwootMessageEvent.count({ where }),
  ]);
  const convs = await prisma.chatbotConversation.findMany({ where: { conversationId: { in: [...new Set(items.map((i) => i.conversationId))] } } });
  res.json({ page, pageSize, total, items: items.map((i) => ({ ...i, conversationMode: convs.find((c) => c.conversationId === i.conversationId)?.mode ?? 'BOT' })) });
}));

// Give a handed-over conversation back to the assistant (its reply counter restarts).
r.post('/conversations/:conversationId/resume', ah(async (req, res) => {
  const conversationId = Number(req.params.conversationId);
  if (!Number.isInteger(conversationId) || conversationId <= 0) throw badRequest('Invalid conversation');
  const before = await prisma.chatbotConversation.findUnique({ where: { conversationId } });
  await prisma.chatbotConversation.upsert({ where: { conversationId }, create: { conversationId }, update: { mode: 'BOT', botReplies: 0, handedOverAt: null, handoverReason: null } });
  await audit(prisma, req, 'CHATBOT_RESUME', 'chatbot_conversation', String(conversationId), before ? { mode: before.mode } : null, { mode: 'BOT' });
  res.json({ ok: true });
}));

export default r;
