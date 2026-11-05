/** WhatsApp control centre backed by Chatwoot (app.aiingo.com). */
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { ah, badRequest, notFound } from '../lib/http';
import { can, userCan } from '../lib/auth';
import { audit } from '../lib/audit';
import { render } from '../lib/util';
import * as cw from '../services/chatwoot';

const r = Router();

// Integration settings (Super Admin / settings:manage) — INT-01 token stored encrypted, never returned.
r.get('/config', can('settings:manage', 'whatsapp:send'), ah(async (_req, res) => res.json(await cw.publicChatwootConfig())));
r.put('/config', can('settings:manage'), ah(async (req, res) => {
  const d = z.object({
    enabled: z.boolean(),
    baseUrl: z.string().url(),
    accountId: z.string().regex(/^\d+$/, 'Account ID must be numeric'),
    inboxId: z.string().regex(/^\d+$/, 'Inbox ID must be numeric'),
    apiToken: z.string().min(10).optional().or(z.literal('')),
    webhookSecret: z.string().min(12).optional().or(z.literal('')),
    autoCreateLeads: z.boolean().default(true),
  }).parse(req.body);
  await cw.saveChatwootConfig({ ...d, apiToken: d.apiToken || undefined, webhookSecret: d.webhookSecret || undefined });
  await audit(prisma, req, 'UPDATE', 'integration', 'chatwoot', null, { ...d, apiToken: d.apiToken ? '***' : undefined, webhookSecret: d.webhookSecret ? '***' : undefined });
  res.json(await cw.publicChatwootConfig());
}));
r.post('/test', can('settings:manage', 'whatsapp:send'), ah(async (_req, res) => res.json(await cw.testConnection())));

// Inbox (conversations list) for staff
r.get('/conversations', can('whatsapp:send'), ah(async (req, res) => {
  const data = await cw.listConversations({ status: String(req.query.status || 'open'), page: Number(req.query.page) || 1, query: req.query.q ? String(req.query.q) : undefined });
  // Link Chatwoot contacts to Nexora leads/students by phone
  const phones = data.items.map((i: any) => i.contact.phone).filter(Boolean);
  const [leads, students] = await Promise.all([
    prisma.lead.findMany({ where: { phoneNormalized: { in: phones } }, select: { id: true, code: true, name: true, status: true, phoneNormalized: true, ownerId: true } }),
    prisma.student.findMany({ where: { phoneNormalized: { in: phones } }, select: { id: true, studentCode: true, fullName: true, phoneNormalized: true } }),
  ]);
  const allLeads = userCan(req, 'leads:read_all');
  res.json({
    ...data,
    items: data.items.map((i: any) => {
      const lead = leads.find((l) => l.phoneNormalized === i.contact.phone);
      return { ...i, lead: lead && (allLeads || lead.ownerId === req.user!.id) ? lead : lead ? { id: null, code: lead.code, restricted: true } : null, student: students.find((s) => s.phoneNormalized === i.contact.phone) ?? null };
    }),
  });
}));
r.get('/conversations/:id/messages', can('whatsapp:send'), ah(async (req, res) => {
  res.json({ items: await cw.listMessages(Number(req.params.id)) });
}));
r.post('/conversations/:id/status', can('whatsapp:send'), ah(async (req, res) => {
  const { status } = z.object({ status: z.enum(['open', 'resolved', 'pending']) }).parse(req.body);
  res.json(await cw.toggleConversationStatus(Number(req.params.id), status));
}));

const sendSchema = z.object({
  content: z.string().min(1).max(4096),
  template: z.object({ name: z.string(), language: z.string().default('en'), category: z.string().default('UTILITY'), params: z.array(z.string()).default([]) }).optional(),
});

r.post('/conversations/:id/reply', can('whatsapp:send'), ah(async (req, res) => {
  const d = sendSchema.parse(req.body);
  const out = await cw.replyToConversation(Number(req.params.id), d.content, d.template);
  await audit(prisma, req, 'WHATSAPP_REPLY', 'whatsapp', String(req.params.id));
  res.json(out);
}));

async function logLeadWa(leadId: string, userId: string, content: string, conversationId: number) {
  await prisma.$transaction([
    prisma.leadActivity.create({ data: { leadId, type: 'WHATSAPP', direction: 'OUTBOUND', content, userId, meta: { conversationId } } }),
    prisma.lead.update({ where: { id: leadId }, data: { chatwootConversationId: conversationId, lastActivityAt: new Date() } }),
  ]);
}

// Send to a lead (owner or leads:read_all)
r.post('/leads/:id/send', can('whatsapp:send'), ah(async (req, res) => {
  const d = sendSchema.parse(req.body);
  const lead = await prisma.lead.findFirst({ where: { id: req.params.id, ...(userCan(req, 'leads:read_all') ? {} : { ownerId: req.user!.id }) } });
  if (!lead) throw notFound('Lead not found');
  const out = await cw.sendWhatsApp({ phone: lead.phoneNormalized, name: lead.name, email: lead.email, content: d.content, template: d.template, conversationId: lead.chatwootConversationId });
  await logLeadWa(lead.id, req.user!.id, d.content, out.conversationId!);
  if (out.contactId && !lead.chatwootContactId) await prisma.lead.update({ where: { id: lead.id }, data: { chatwootContactId: out.contactId } });
  res.json(out);
}));
r.get('/leads/:id/messages', can('whatsapp:send'), ah(async (req, res) => {
  const lead = await prisma.lead.findFirst({ where: { id: req.params.id, ...(userCan(req, 'leads:read_all') ? {} : { ownerId: req.user!.id }) } });
  if (!lead) throw notFound('Lead not found');
  if (!lead.chatwootConversationId) return res.json({ items: [], conversationId: null });
  res.json({ items: await cw.listMessages(lead.chatwootConversationId), conversationId: lead.chatwootConversationId });
}));

r.post('/students/:id/send', can('whatsapp:send'), ah(async (req, res) => {
  const d = sendSchema.parse(req.body);
  const st = await prisma.student.findUniqueOrThrow({ where: { id: req.params.id }, include: { lead: true } });
  const out = await cw.sendWhatsApp({ phone: st.phoneNormalized, name: st.fullName, email: st.email, content: d.content, template: d.template, conversationId: st.lead?.chatwootConversationId });
  if (st.lead) await logLeadWa(st.lead.id, req.user!.id, d.content, out.conversationId!);
  await prisma.studentHistory.create({ data: { studentId: st.id, type: 'COMMUNICATION', message: `WhatsApp sent: ${d.content.slice(0, 120)}`, userId: req.user!.id } });
  res.json(out);
}));

// UI-15 bulk send (leads or a batch) with {{name}} personalisation
r.post('/bulk', can('whatsapp:send'), ah(async (req, res) => {
  const d = sendSchema.extend({ leadIds: z.array(z.string()).max(500).optional(), batchId: z.string().optional() }).parse(req.body);
  if (!d.leadIds?.length && !d.batchId) throw badRequest('Choose leads or a batch.');
  const targets: { name: string; phone: string; email?: string | null; leadId?: string; conv?: number | null }[] = [];
  if (d.leadIds?.length) {
    const leads = await prisma.lead.findMany({ where: { id: { in: d.leadIds }, ...(userCan(req, 'leads:read_all') ? {} : { ownerId: req.user!.id }) } });
    targets.push(...leads.map((l) => ({ name: l.name, phone: l.phoneNormalized, email: l.email, leadId: l.id, conv: l.chatwootConversationId })));
  }
  if (d.batchId) {
    const sts = await prisma.student.findMany({ where: { batchId: d.batchId, status: { in: ['ADMITTED', 'ACTIVE'] } }, include: { lead: true } });
    targets.push(...sts.map((s) => ({ name: s.fullName, phone: s.phoneNormalized, email: s.email, leadId: s.lead?.id, conv: s.lead?.chatwootConversationId })));
  }
  const results = [];
  for (const t of targets) {
    const content = render(d.content, { name: t.name });
    try {
      const out = await cw.sendWhatsApp({ phone: t.phone, name: t.name, email: t.email, content, template: d.template && { ...d.template, params: d.template.params.map((p) => render(p, { name: t.name })) }, conversationId: t.conv });
      if (t.leadId) await logLeadWa(t.leadId, req.user!.id, content, out.conversationId!);
      await prisma.notificationLog.create({ data: { channel: 'WHATSAPP', recipient: t.phone, templateKey: 'bulk', body: content, status: 'SENT', providerRef: `cw:${out.conversationId}:${out.messageId}` } });
      results.push({ phone: t.phone, ok: true });
    } catch (e: any) {
      await prisma.notificationLog.create({ data: { channel: 'WHATSAPP', recipient: t.phone, templateKey: 'bulk', body: content, status: 'FAILED', error: e.message } });
      results.push({ phone: t.phone, ok: false, error: e.message });
    }
  }
  await audit(prisma, req, 'BULK_WHATSAPP', 'whatsapp', null, null, { count: targets.length });
  res.json({ sent: results.filter((x) => x.ok).length, failed: results.filter((x) => !x.ok).length, results });
}));

export default r;
