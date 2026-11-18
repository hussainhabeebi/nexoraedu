/**
 * WhatsApp AI chatbot on the existing Chatwoot inbox.
 *
 * For each incoming message already recorded (exactly once) in chatwoot_message_events:
 *   1. the bot must be enabled, the AI key configured, the contact must be a prospect (not a student or parent),
 *      and the conversation must not be handed over;
 *   2. handover keywords and the reply limit hand the conversation to a person without calling the AI;
 *   3. otherwise Claude answers from the saved prompt + published academy facts (services/chatbot/claude.ts);
 *   4. the reply goes out through the existing Chatwoot integration; details the customer gave fill EMPTY lead fields.
 * Replies only ever answer a customer message, so they are always inside WhatsApp's 24-hour window.
 *
 * Handover: the customer gets the configured handover message, Chatwoot gets a private note and the conversation is
 * set open, the lead owner (or the Sales Managers) is notified, and the bot stays silent in that conversation until
 * an admin resumes it. A staff reply (from Chatwoot or from Nexora) also hands the conversation over.
 */
import { prisma } from '../../lib/prisma';
import { getSettings, type Settings } from '../../lib/settings';
import { formatDate, toCalendarDate, zonedTimeToUtc } from '../../lib/caldate';
import { normalizeEmail } from '../../lib/util';
import * as cw from '../chatwoot';
import { notifyRole, notifyUser } from '../notify';
import { academyFacts } from './facts';
import { aiConfigured, BotRefusal, CHATBOT_MODEL, generateBotReply, systemText, type BotOutput, type ChatTurn } from './claude';

const HISTORY = 12;
const ECHO_WINDOW_MS = 15 * 60_000;
const isUnique = (e: any) => e?.code === 'P2002' || /UNIQUE constraint failed/i.test(String(e?.message ?? e));

export async function chatbotState() {
  const s = await getSettings();
  const c = await cw.getChatwootConfig();
  const chatwootReady = !!(c.enabled && c.apiToken && c.accountId && c.inboxId);
  return { enabled: !!s.chatbot.enabled, aiConfigured: aiConfigured(), chatwootReady, model: CHATBOT_MODEL, active: !!s.chatbot.enabled && aiConfigured() && chatwootReady };
}

async function conversationState(conversationId: number) {
  const found = await prisma.chatbotConversation.findUnique({ where: { conversationId } });
  if (found) return found;
  try {
    return await prisma.chatbotConversation.create({ data: { conversationId } });
  } catch (e) {
    if (!isUnique(e)) throw e;
    return prisma.chatbotConversation.findUniqueOrThrow({ where: { conversationId } });
  }
}

const setEvent = (id: string, data: Record<string, unknown>) => prisma.chatwootMessageEvent.update({ where: { id }, data });

/** Normalised keyword check (case- and accent-insensitive, whole words or phrases). */
export function wantsHuman(text: string, keywords: string[]) {
  const t = ` ${text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ')} `;
  return keywords.some((k) => {
    const w = k.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    return w && t.includes(` ${w} `);
  });
}

/** Sends a bot message, recording its text first so Chatwoot's copy of it is never mistaken for a staff reply. */
async function sendAsBot(eventId: string, conversationId: number, text: string) {
  await setEvent(eventId, { botReplyText: text, botStatus: 'SENDING' });
  const out = await cw.replyToConversation(conversationId, text);
  await setEvent(eventId, { botReplyMessageId: String(out.messageId) });
  return out;
}

export async function handOver(conversationId: number, reason: string, opts: { eventId?: string; leadId?: string | null; message?: string | null; userId?: string | null; finalStatus?: 'HANDOVER' | 'FAILED' } = {}) {
  const s = await getSettings();
  const conv = await conversationState(conversationId);
  const finalStatus = opts.finalStatus ?? 'HANDOVER';
  let why = reason.slice(0, 300);
  const finish = () => (opts.eventId ? setEvent(opts.eventId, { botStatus: finalStatus, botReason: why }) : Promise.resolve());
  const moved = await prisma.chatbotConversation.updateMany({ where: { id: conv.id, mode: 'BOT' }, data: { mode: 'HUMAN', handedOverAt: new Date(), handoverReason: why } });
  if (moved.count !== 1) {
    await finish(); // already with a person
    return false;
  }
  const text = opts.message === undefined ? s.chatbot.handoverMessage : opts.message;
  try {
    if (text && opts.eventId) await sendAsBot(opts.eventId, conversationId, text);
  } catch (e: any) {
    why = `${why} (handover message not sent: ${String(e?.message ?? e).slice(0, 150)})`;
  }
  await cw.addPrivateNote(conversationId, `🤖 Nexora assistant handed this conversation to the team: ${reason}`).catch(() => undefined);
  await cw.toggleConversationStatus(conversationId, 'open').catch(() => undefined);
  const lead = opts.leadId ? await prisma.lead.findUnique({ where: { id: opts.leadId }, select: { id: true, name: true, ownerId: true } }) : null;
  if (lead) await prisma.leadActivity.create({ data: { leadId: lead.id, type: 'SYSTEM', content: `WhatsApp assistant handed over to the team: ${reason}`, userId: opts.userId ?? null, meta: { conversationId, chatbot: true } } });
  const title = `WhatsApp needs a person${lead ? `: ${lead.name}` : ''}`;
  if (lead?.ownerId) await notifyUser(lead.ownerId, title, reason, `/staff/leads/${lead.id}`).catch(() => undefined);
  else await notifyRole('sales_manager', title, reason, '/staff/whatsapp').catch(() => undefined);
  await finish(); // only now is the event final (everything above has happened)
  return true;
}

/** A staff member replied (Chatwoot or Nexora): the bot steps back for that conversation. */
export async function markHumanReply(conversationId: number, source: string) {
  const conv = await prisma.chatbotConversation.findUnique({ where: { conversationId } });
  if (conv && conv.mode === 'HUMAN') return;
  if (conv) await prisma.chatbotConversation.updateMany({ where: { id: conv.id, mode: 'BOT' }, data: { mode: 'HUMAN', handedOverAt: new Date(), handoverReason: `Staff replied (${source})` } });
  else await prisma.chatbotConversation.create({ data: { conversationId, mode: 'HUMAN', handedOverAt: new Date(), handoverReason: `Staff replied (${source})` } }).catch(() => undefined);
}

/** Chatwoot "message_created" for an OUTGOING message: the bot's own echo, or a staff reply. */
export async function onOutgoingMessage(conversationId: number, messageId: string, content: string) {
  const since = new Date(Date.now() - ECHO_WINDOW_MS);
  const own = await prisma.chatwootMessageEvent.findFirst({
    where: { conversationId, createdAt: { gte: since }, OR: [{ botReplyMessageId: messageId }, { botReplyText: content }] },
    select: { id: true },
  });
  if (own) return 'bot';
  await markHumanReply(conversationId, 'Chatwoot');
  return 'staff';
}

/** Fills only EMPTY lead fields with details the customer stated, and notes the rest on the lead timeline. */
export async function applyLeadDetails(leadId: string, d: BotOutput['lead'], courses: { id: string; code: string; name: string }[]) {
  const lead = await prisma.lead.findUnique({ where: { id: leadId } });
  if (!lead) return;
  const data: Record<string, unknown> = {};
  const noted: string[] = [];
  const clean = (v: string | null) => (v ?? '').trim().slice(0, 120);
  const name = clean(d.name);
  if (name && /^\+?[\d\s-]+$/.test(lead.name)) data.name = name;
  const email = normalizeEmail(clean(d.email));
  if (email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && !lead.email) Object.assign(data, { email, emailNormalized: email });
  const city = clean(d.city);
  if (city && !lead.city) data.city = city;
  const interest = clean(d.course_interest);
  if (interest) {
    const i = interest.toLowerCase();
    const course = courses.find((c) => c.code.toLowerCase() === i || c.name.toLowerCase() === i) ?? courses.find((c) => c.name.toLowerCase().includes(i) || i.includes(c.name.toLowerCase()));
    if (course && !lead.courseId) data.courseId = course.id;
    noted.push(`course interest: ${interest}`);
  }
  const qual = clean(d.qualification);
  if (qual) noted.push(`qualification: ${qual}`);
  if (Object.keys(data).length) await prisma.lead.update({ where: { id: lead.id }, data });
  const filled = Object.keys(data).filter((k) => k !== 'emailNormalized');
  if (filled.length || noted.length) await prisma.leadActivity.create({ data: { leadId: lead.id, type: 'SYSTEM', content: `WhatsApp assistant noted ${[...noted, ...filled.filter((k) => k !== 'courseId').map((k) => `${k}: ${data[k]}`)].join('; ')}`, meta: { chatbot: true, filled } } });
}

/** Recent conversation from Chatwoot as chat turns (customer = user, academy = assistant); private notes excluded. */
async function conversationTurns(conversationId: number, current: { id: string; content: string }): Promise<ChatTurn[]> {
  let items: any[] = [];
  try {
    items = await cw.listMessages(conversationId);
  } catch {
    items = [];
  }
  const turns: ChatTurn[] = items
    .filter((m) => !m.private && (m.type === 'incoming' || m.type === 'outgoing') && String(m.content ?? '').trim())
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
    .map((m) => ({ role: m.type === 'incoming' ? ('user' as const) : ('assistant' as const), text: String(m.content), id: String(m.id) }) as ChatTurn & { id: string });
  if (!turns.some((t: any) => t.id === current.id)) turns.push({ role: 'user', text: current.content });
  return turns.slice(-HISTORY);
}

export interface IncomingForBot { eventId: string; conversationId: number; messageId: string; content: string; kind: string; leadId: string | null }

/** Runs the bot for one recorded incoming message. Never throws (the webhook has already answered Chatwoot). */
export async function runBot(m: IncomingForBot) {
  try {
    const s = await getSettings();
    const st = await chatbotState();
    if (!st.enabled) return setEvent(m.eventId, { botStatus: 'OFF' });
    if (!st.aiConfigured) return setEvent(m.eventId, { botStatus: 'SKIPPED', botReason: 'AI is not configured (ANTHROPIC_API_KEY missing)' });
    if (m.kind === 'STUDENT' || m.kind === 'PARENT') return setEvent(m.eventId, { botStatus: 'SKIPPED', botReason: `Existing ${m.kind === 'STUDENT' ? 'student' : 'parent'}: answered by staff` });
    const conv = await conversationState(m.conversationId);
    if (conv.mode === 'HUMAN') return setEvent(m.eventId, { botStatus: 'SKIPPED', botReason: 'Conversation is with a person' });
    if (!m.content.trim()) return setEvent(m.eventId, { botStatus: 'SKIPPED', botReason: 'No text (attachment or empty message)' });
    if (wantsHuman(m.content, s.chatbot.handoverKeywords)) return void (await handOver(m.conversationId, 'The customer asked for a person', { eventId: m.eventId, leadId: m.leadId }));
    if (conv.botReplies >= s.chatbot.maxBotReplies) return void (await handOver(m.conversationId, `Reply limit reached (${s.chatbot.maxBotReplies} assistant replies)`, { eventId: m.eventId, leadId: m.leadId }));

    // Cost safeguard: at most dailyAiLimit AI calls per academy day; beyond it the team answers.
    const dayStart = zonedTimeToUtc(toCalendarDate(new Date(), s.academy.timeZone), s.academy.timeZone);
    const usedToday = await prisma.chatwootMessageEvent.count({ where: { createdAt: { gte: dayStart }, inputTokens: { not: null } } });
    if (usedToday >= (s.chatbot.dailyAiLimit ?? 300)) return void (await handOver(m.conversationId, `Daily AI limit reached (${s.chatbot.dailyAiLimit ?? 300} replies today)`, { eventId: m.eventId, leadId: m.leadId }));

    await setEvent(m.eventId, { botStatus: 'PENDING', botModel: CHATBOT_MODEL });
    const facts = await academyFacts();
    const turns = await conversationTurns(m.conversationId, { id: m.messageId, content: m.content });
    let result;
    try {
      result = await generateBotReply({ system: systemText(s.chatbot.systemPrompt, s.chatbot.knowledge, facts.text, formatDate(new Date(), s.academy.timeZone)), turns });
    } catch (e: any) {
      const why = e instanceof BotRefusal ? 'The AI could not answer this message' : `The AI was unavailable (${String(e?.message ?? e).slice(0, 120)})`;
      return void (await handOver(m.conversationId, why, { eventId: m.eventId, leadId: m.leadId, finalStatus: 'FAILED' }));
    }
    await setEvent(m.eventId, { botModel: result.model, inputTokens: result.inputTokens, outputTokens: result.outputTokens });
    if (m.leadId) await applyLeadDetails(m.leadId, result.output.lead, facts.courses).catch(() => undefined);

    // While the AI was thinking: a person may have replied, or the customer may have sent another message
    // (that newer message's run answers both, so the customer gets one reply, not several).
    const fresh = await prisma.chatbotConversation.findUniqueOrThrow({ where: { conversationId: m.conversationId } });
    if (fresh.mode === 'HUMAN') return setEvent(m.eventId, { botStatus: 'SKIPPED', botReason: 'A person replied meanwhile' });
    const self = await prisma.chatwootMessageEvent.findUniqueOrThrow({ where: { id: m.eventId } });
    const newer = await prisma.chatwootMessageEvent.count({ where: { conversationId: m.conversationId, createdAt: { gt: self.createdAt }, id: { not: m.eventId } } });
    if (newer > 0) return setEvent(m.eventId, { botStatus: 'SKIPPED', botReason: 'A newer customer message is being answered' });

    const reply = result.output.reply.trim();
    if (result.output.handover || !reply) {
      return void (await handOver(m.conversationId, result.output.handover_reason.trim() || 'The assistant could not answer', { eventId: m.eventId, leadId: m.leadId, message: reply || undefined }));
    }
    await sendAsBot(m.eventId, m.conversationId, reply.slice(0, 4000));
    await prisma.chatbotConversation.update({ where: { id: fresh.id }, data: { botReplies: fresh.botReplies + 1 } });
    await setEvent(m.eventId, { botStatus: 'REPLIED', botReason: null });
    if (m.leadId) {
      await prisma.leadActivity.create({ data: { leadId: m.leadId, type: 'WHATSAPP', direction: 'OUTBOUND', content: reply.slice(0, 2000), meta: { conversationId: m.conversationId, chatbot: true } } });
      await prisma.lead.update({ where: { id: m.leadId }, data: { lastActivityAt: new Date() } });
    }
  } catch (e: any) {
    await setEvent(m.eventId, { botStatus: 'FAILED', botReason: String(e?.message ?? e).slice(0, 300) }).catch(() => undefined);
  }
}

/** Admin test: generates a reply with the given (or saved) prompt; sends nothing and touches no CRM record. */
export async function testBot(s: Settings['chatbot'], message: string, history: ChatTurn[] = []) {
  const settings = await getSettings();
  const facts = await academyFacts();
  const r = await generateBotReply({ system: systemText(s.systemPrompt, s.knowledge, facts.text, formatDate(new Date(), settings.academy.timeZone)), turns: [...history, { role: 'user', text: message }] });
  return { ...r.output, model: r.model, inputTokens: r.inputTokens, outputTokens: r.outputTokens, keywordHandover: wantsHuman(message, s.handoverKeywords) };
}
