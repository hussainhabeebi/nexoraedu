/**
 * Notification engine (SRS §17): in-app, email (SMTP), WhatsApp (via Chatwoot).
 * Template-based (FR-NTF-02) and every send is logged with status (FR-NTF-03).
 */
import nodemailer, { type Transporter } from 'nodemailer';
import { prisma } from '../lib/prisma';
import { config } from '../config';
import { render } from '../lib/util';
import { sendWhatsApp } from './chatwoot';

export type Channel = 'IN_APP' | 'EMAIL' | 'WHATSAPP';

export interface Recipient {
  userId?: string | null;
  name?: string;
  email?: string | null;
  phone?: string | null;
  conversationId?: number | null;
}

let transport: Transporter | null = null;
function mailer() {
  if (!config.smtp.host) return null;
  if (!transport) transport = nodemailer.createTransport(process.env.SMTP_URL || { host: config.smtp.host, port: Number(process.env.SMTP_PORT || 587), auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined });
  return transport;
}

function placeholders(tpl: string) {
  return [...tpl.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)].map((m) => m[1]);
}

/**
 * opts.sensitive: the message carries a credential (activation / reset link). It is never stored in an in-app
 * notification, and the notification log keeps a redacted body (LOG-02) — the log is readable by administrators.
 */
export async function notify(templateKey: string, to: Recipient, vars: Record<string, unknown>, opts: { channels?: Channel[]; link?: string; sensitive?: boolean } = {}) {
  const tpl = await prisma.notificationTemplate.findUnique({ where: { key: templateKey } });
  if (!tpl || !tpl.isActive) return;
  const body = render(tpl.body, vars);
  const subject = render(tpl.subject || tpl.name, vars);
  const channels = (opts.channels ?? (tpl.channels as Channel[])).filter((c) => tpl.channels.includes(c) && !(opts.sensitive && c === 'IN_APP'));
  const results: Record<string, string> = {};
  const logBody = opts.sensitive ? `[redacted: ${templateKey} contains a single-use link]` : body;

  for (const ch of channels) {
    try {
      if (ch === 'IN_APP') {
        if (!to.userId) continue;
        await prisma.notification.create({ data: { userId: to.userId, title: subject, body, link: opts.link } });
        await log(ch, to.userId, templateKey, logBody, 'SENT');
      } else if (ch === 'EMAIL') {
        if (!to.email) continue;
        const m = mailer();
        if (!m) {
          await log(ch, to.email, templateKey, logBody, 'SKIPPED', 'SMTP not configured');
          continue;
        }
        const info = await m.sendMail({ from: config.smtp.from, to: to.email, subject, text: body });
        await log(ch, to.email, templateKey, logBody, 'SENT', undefined, info.messageId);
      } else if (ch === 'WHATSAPP') {
        if (!to.phone) continue;
        const r = await sendWhatsApp({
          phone: to.phone,
          name: to.name || to.phone,
          email: to.email,
          content: body,
          conversationId: to.conversationId,
          template: tpl.waTemplateName
            ? { name: tpl.waTemplateName, language: tpl.waLanguage, category: tpl.waCategory, params: placeholders(tpl.body).map((k) => render(`{{${k}}}`, vars)) }
            : undefined,
        });
        await log(ch, to.phone, templateKey, logBody, 'SENT', undefined, `cw:${r.conversationId}:${r.messageId}`);
      }
      results[ch] = 'SENT';
    } catch (e: any) {
      results[ch] = 'FAILED';
      await log(ch, to.phone || to.email || to.userId || '-', templateKey, logBody, e?.code === 'INTEGRATION_DISABLED' ? 'SKIPPED' : 'FAILED', String(e?.message || e));
    }
  }
  return results;
}

/** Fire-and-forget wrapper so business transactions never fail because of a gateway. */
export function notifyLater(...args: Parameters<typeof notify>) {
  setImmediate(() => notify(...args).catch((e) => console.error('notify failed', e)));
}

/** In-app notification to every active user holding a role. */
export async function notifyRole(roleKey: string, title: string, body: string, link?: string) {
  const users = await prisma.user.findMany({ where: { isActive: true, roles: { some: { role: { key: roleKey } } } }, select: { id: true } });
  if (users.length) await prisma.notification.createMany({ data: users.map((u) => ({ userId: u.id, title, body, link })) });
}

export async function notifyUser(userId: string, title: string, body: string, link?: string) {
  await prisma.notification.create({ data: { userId, title, body, link } });
}

function log(channel: string, recipient: string, templateKey: string, body: string, status: string, error?: string, providerRef?: string) {
  return prisma.notificationLog.create({ data: { channel, recipient, templateKey, body, status, error, providerRef } });
}
