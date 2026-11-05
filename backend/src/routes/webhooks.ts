/** Inbound integrations (SRS §26.10, API-09). */
import { Router } from 'express';
import crypto from 'crypto';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { isHardened } from '../config';
import { ah, HttpError } from '../lib/http';
import { normalizePhone } from '../lib/util';
import { getChatwootConfig } from '../services/chatwoot';
import { notifyUser } from '../services/notify';
import { createLead, findDuplicateLead } from './crm';
import { recordPayment } from '../services/finance';

const r = Router();

const safeEq = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

/**
 * Chatwoot webhook (Settings → Integrations → Webhooks in Chatwoot, events: message_created,
 * conversation_created, conversation_status_changed, message_updated).
 * URL: {API_BASE_URL}/api/v1/webhooks/chatwoot?token={webhookSecret}  (or header X-Webhook-Token)
 */
r.post('/chatwoot', ah(async (req, res) => {
  const c = await getChatwootConfig();
  // S16 / LOG-02: header preferred. The ?token= form is still accepted because Chatwoot webhooks may not support custom
  // headers (to be verified for the deployed Chatwoot version); our access/error logs strip query strings.
  const token = String(req.get('x-webhook-token') || req.query.token || '');
  if (c.webhookSecret && !safeEq(token, c.webhookSecret)) throw new HttpError(401, 'Invalid webhook token', 'UNAUTHORIZED');
  if (!c.webhookSecret && (isHardened || process.env.NODE_ENV === 'production')) throw new HttpError(401, 'Webhook secret not configured', 'UNAUTHORIZED');
  const e = req.body ?? {};
  const started = Date.now();
  try {
    const inboxId = String(e.inbox?.id ?? e.conversation?.inbox_id ?? '');
    if (inboxId && c.inboxId && inboxId !== c.inboxId) return res.json({ ignored: 'other inbox' });

    if (e.event === 'message_created' && (e.message_type === 'incoming' || e.message_type === 0) && !e.private) {
      const sender = e.sender ?? e.conversation?.meta?.sender ?? {};
      const rawPhone = sender.phone_number || e.conversation?.contact_inbox?.source_id;
      if (!rawPhone) return res.json({ ignored: 'no phone' });
      const phone = normalizePhone(String(rawPhone));
      const conversationId = Number(e.conversation?.id);
      let lead = await prisma.lead.findFirst({ where: { phoneNormalized: phone }, orderBy: { createdAt: 'desc' } });
      const student = await prisma.student.findUnique({ where: { phoneNormalized: phone } });
      if (!lead && !student && c.autoCreateLeads) {
        lead = await prisma.$transaction((tx) => createLead(tx, { name: sender.name || phone, phone, email: sender.email || null, source: 'whatsapp', notes: `First WhatsApp message: ${String(e.content ?? '').slice(0, 500)}` }, undefined, { chatwootContactId: Number(sender.id) || null, chatwootConversationId: conversationId || null }));
      }
      if (lead) {
        await prisma.$transaction([
          prisma.leadActivity.create({ data: { leadId: lead.id, type: 'WHATSAPP', direction: 'INBOUND', content: String(e.content ?? '[attachment]'), meta: { conversationId, messageId: e.id } } }),
          prisma.lead.update({ where: { id: lead.id }, data: { lastActivityAt: new Date(), chatwootConversationId: conversationId || lead.chatwootConversationId, chatwootContactId: Number(sender.id) || lead.chatwootContactId } }),
        ]);
        if (lead.ownerId) await notifyUser(lead.ownerId, `WhatsApp from ${lead.name}`, String(e.content ?? '').slice(0, 140), `/staff/leads/${lead.id}`);
      }
      if (student) {
        await prisma.studentHistory.create({ data: { studentId: student.id, type: 'COMMUNICATION', message: `WhatsApp received: ${String(e.content ?? '').slice(0, 200)}` } });
      }
    } else if (e.event === 'message_updated' && e.id) {
      // Delivery/read status updates for messages we sent
      const status = String(e.status || '').toUpperCase();
      if (['SENT', 'DELIVERED', 'READ', 'FAILED'].includes(status))
        await prisma.notificationLog.updateMany({ where: { providerRef: { endsWith: `:${e.id}` } }, data: { status, error: e.content_attributes?.external_error ?? undefined } });
    }
    await prisma.integrationLog.create({ data: { name: 'chatwoot-webhook', method: 'POST', endpoint: String(e.event ?? 'unknown'), status: 200, durationMs: Date.now() - started } });
    res.json({ ok: true });
  } catch (err: any) {
    await prisma.integrationLog.create({ data: { name: 'chatwoot-webhook', method: 'POST', endpoint: String(e.event ?? 'unknown'), status: 500, durationMs: Date.now() - started, error: String(err?.message) } });
    throw err;
  }
}));

/** CRM-02: website / landing-page enquiry form. Header: X-API-Key = WEBSITE_LEADS_API_KEY */
r.post('/website-leads', ah(async (req, res) => {
  const key = process.env.WEBSITE_LEADS_API_KEY;
  if (!key || !safeEq(String(req.get('x-api-key') || ''), key)) throw new HttpError(401, 'Invalid API key', 'UNAUTHORIZED');
  const d = z.object({ name: z.string().min(2), phone: z.string().min(7), email: z.string().email().optional(), course: z.string().optional(), message: z.string().optional(), source: z.string().default('website') }).parse(req.body);
  const course = d.course ? await prisma.course.findFirst({ where: { OR: [{ code: d.course.toUpperCase() }, { slug: d.course }, { id: d.course }] } }) : null;
  const dup = await findDuplicateLead(prisma, d.phone, d.email);
  if (dup) {
    await prisma.leadActivity.create({ data: { leadId: dup.id, type: 'SYSTEM', content: `Repeat enquiry via ${d.source}: ${d.message ?? ''}` } });
    return res.json({ ok: true, duplicate: true });
  }
  await prisma.$transaction((tx) => createLead(tx, { name: d.name, phone: d.phone, email: d.email, courseId: course?.id, source: d.source, notes: d.message }));
  res.status(201).json({ ok: true });
}));

/**
 * Payment gateway confirmation. Signature: HMAC-SHA256(secret, `${timestamp}.${rawBody}`) in X-Signature,
 * timestamp in X-Timestamp (±5 min). Matched/deduplicated by transaction reference.
 */
r.post('/payment', ah(async (req: any, res) => {
  const secret = process.env.PAYMENT_WEBHOOK_SECRET;
  const ts = String(req.get('x-timestamp') || '');
  const sig = String(req.get('x-signature') || '');
  if (!secret) throw new HttpError(503, 'Payment webhook not configured', 'DISABLED');
  if (!ts || Math.abs(Date.now() / 1000 - Number(ts)) > 300) throw new HttpError(401, 'Stale timestamp', 'UNAUTHORIZED');
  const expected = crypto.createHmac('sha256', secret).update(`${ts}.${req.rawBody ?? ''}`).digest('hex');
  if (!safeEq(sig, expected)) throw new HttpError(401, 'Invalid signature', 'UNAUTHORIZED');
  const d = z.object({ transactionId: z.string(), studentCode: z.string(), amount: z.number().positive(), status: z.enum(['SUCCESS', 'FAILED']), method: z.string().optional() }).parse(req.body);
  if (d.status !== 'SUCCESS') return res.json({ ok: true, ignored: true });
  const st = await prisma.student.findUnique({ where: { studentCode: d.studentCode } });
  if (!st) throw new HttpError(404, 'Unknown student', 'NOT_FOUND');
  const existing = await prisma.payment.findUnique({ where: { gatewayRef: d.transactionId } });
  if (existing) return res.json({ ok: true, duplicate: true, receipt: existing.receiptNumber });
  const p = await prisma.$transaction((tx) => recordPayment(tx, { studentId: st.id, amount: d.amount, mode: 'ONLINE', reference: d.transactionId, gatewayRef: d.transactionId, payer: st.fullName }));
  res.json({ ok: true, receipt: p.receiptNumber });
}));

export default r;
