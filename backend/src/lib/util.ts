import crypto from 'crypto';
import { config } from '../config';

/** Normalize phone to E.164-ish digits. Assumes India (+91) when 10 digits given. */
export function normalizePhone(p: string): string {
  let d = (p || '').replace(/[^\d+]/g, '');
  if (d.startsWith('+')) return '+' + d.slice(1).replace(/\D/g, '');
  d = d.replace(/\D/g, '');
  if (d.startsWith('00')) return '+' + d.slice(2);
  if (d.length === 10) return '+91' + d;
  if (d.length === 11 && d.startsWith('0')) return '+91' + d.slice(1);
  if (d.length === 12 && d.startsWith('91')) return '+' + d;
  return '+' + d;
}
export const normalizeEmail = (e?: string | null) => (e ? e.trim().toLowerCase() : null);

export const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export const randomPassword = () => 'Nx@' + crypto.randomBytes(5).toString('base64url');

function key() {
  const k = config.encryptionKey;
  const buf = /^[0-9a-f]{64}$/i.test(k) ? Buffer.from(k, 'hex') : Buffer.from(k, 'base64');
  if (buf.length !== 32) throw new Error('APP_ENCRYPTION_KEY must be 32 bytes (64 hex chars or base64)');
  return buf;
}
/** AES-256-GCM encryption for credentials at rest (INT-01). */
export function encrypt(plain: string): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), enc.toString('base64')].join(':');
}
export function decrypt(blob: string): string {
  const [v, iv, tag, data] = blob.split(':');
  if (v !== 'v1') throw new Error('Unknown cipher version');
  const d = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8');
}

export const money = (n: unknown) => Math.round(Number(n || 0) * 100) / 100;
export const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

export function render(tpl: string, vars: Record<string, unknown>) {
  return tpl.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, k) => {
    const v = k.split('.').reduce((o: any, p: string) => (o == null ? o : o[p]), vars);
    return v == null ? '' : String(v);
  });
}

export function toCsv(rows: Record<string, unknown>[]): string {
  if (!rows.length) return '';
  const cols = Object.keys(rows[0]);
  const esc = (v: unknown) => {
    let s = v == null ? '' : v instanceof Date ? v.toISOString() : String(v);
    if (/^[=+\-@]/.test(s)) s = "'" + s; // CSV injection guard
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n');
}
