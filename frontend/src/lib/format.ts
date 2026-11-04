import { format, formatDistanceToNowStrict } from 'date-fns';

export const inr = (n: number | string | null | undefined, opts: { decimals?: boolean } = {}) =>
  n == null ? '—' : new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: opts.decimals === false ? 0 : 2, minimumFractionDigits: opts.decimals === false ? 0 : 0 }).format(Number(n));
export const num = (n: number | null | undefined) => (n == null ? '—' : new Intl.NumberFormat('en-IN').format(n));
export const d = (v?: string | Date | null) => (v ? format(new Date(v), 'dd MMM yyyy') : '—');
export const dt = (v?: string | Date | null) => (v ? format(new Date(v), 'dd MMM yyyy, h:mm a') : '—');
export const t = (v?: string | Date | null) => (v ? format(new Date(v), 'h:mm a') : '—');
export const ago = (v?: string | Date | null) => (v ? formatDistanceToNowStrict(new Date(v), { addSuffix: true }) : '—');
export const label = (s?: string | null) => (s ? s.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase()) : '—');
export const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join('');
export const toLocalInput = (v: Date) => new Date(v.getTime() - v.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
