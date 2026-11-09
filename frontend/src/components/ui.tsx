import { useEffect, useId, useRef, useState, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import clsx from 'clsx';
import { AlertTriangle, Inbox, Loader2, X } from 'lucide-react';
import { initials, label } from '@/lib/format';
import { api } from '@/lib/api';

export const cx = clsx;

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cx('h-5 w-5 animate-spin text-brand-600', className)} aria-label="Loading" />;
}
export function PageLoader() {
  return (
    <div className="flex h-64 items-center justify-center">
      <Spinner className="h-7 w-7" />
    </div>
  );
}

export function PageHeader({ title, subtitle, actions, back }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; back?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div>
        {back}
        <h1 className="text-2xl font-bold">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-slate-500">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function Card({ title, actions, children, className, bodyClass }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; bodyClass?: string }) {
  return (
    <section className={cx('card', className)}>
      {(title || actions) && (
        <header className="flex items-center justify-between gap-2 border-b border-slate-100 px-5 py-3.5">
          <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
          {actions}
        </header>
      )}
      <div className={cx('p-5', bodyClass)}>{children}</div>
    </section>
  );
}

export function Stat({ label: l, value, hint, icon, tone = 'brand' }: { label: string; value: ReactNode; hint?: ReactNode; icon?: ReactNode; tone?: 'brand' | 'green' | 'amber' | 'rose' | 'sky' | 'violet' }) {
  const tones = { brand: 'bg-brand-50 text-brand-700', green: 'bg-emerald-50 text-emerald-700', amber: 'bg-amber-50 text-amber-700', rose: 'bg-rose-50 text-rose-700', sky: 'bg-sky-50 text-sky-700', violet: 'bg-fuchsia-50 text-fuchsia-700' };
  return (
    <div className="card flex items-start gap-4 p-5">
      {icon && <div className={cx('rounded-xl p-2.5', tones[tone])}>{icon}</div>}
      <div className="min-w-0">
        <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{l}</p>
        <p className="mt-1 truncate text-2xl font-bold text-slate-900">{value}</p>
        {hint && <p className="mt-0.5 text-xs text-slate-500">{hint}</p>}
      </div>
    </div>
  );
}

const STATUS_TONE: Record<string, string> = {
  NEW: 'bg-sky-50 text-sky-700 ring-sky-200', CONTACTED: 'bg-indigo-50 text-indigo-700 ring-indigo-200', INTERESTED: 'bg-violet-50 text-violet-700 ring-violet-200',
  COUNSELLED: 'bg-fuchsia-50 text-fuchsia-700 ring-fuchsia-200', APPLICATION: 'bg-amber-50 text-amber-700 ring-amber-200', ADMITTED: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  NOT_INTERESTED: 'bg-slate-100 text-slate-600 ring-slate-200', LOST: 'bg-rose-50 text-rose-700 ring-rose-200', JUNK: 'bg-slate-100 text-slate-500 ring-slate-200',
  ACTIVE: 'bg-emerald-50 text-emerald-700 ring-emerald-200', ON_HOLD: 'bg-amber-50 text-amber-700 ring-amber-200', COMPLETED: 'bg-sky-50 text-sky-700 ring-sky-200',
  WITHDRAWN: 'bg-slate-100 text-slate-600 ring-slate-200', TERMINATED: 'bg-rose-50 text-rose-700 ring-rose-200', APPLIED: 'bg-amber-50 text-amber-700 ring-amber-200',
  PENDING: 'bg-amber-50 text-amber-700 ring-amber-200', APPROVED: 'bg-emerald-50 text-emerald-700 ring-emerald-200', REJECTED: 'bg-rose-50 text-rose-700 ring-rose-200', RETURNED: 'bg-slate-100 text-slate-700 ring-slate-200',
  VERIFIED: 'bg-emerald-50 text-emerald-700 ring-emerald-200', POSTED: 'bg-emerald-50 text-emerald-700 ring-emerald-200', CANCELLED: 'bg-rose-50 text-rose-700 ring-rose-200', CANCEL_REQUESTED: 'bg-amber-50 text-amber-700 ring-amber-200',
  PAID: 'bg-emerald-50 text-emerald-700 ring-emerald-200', PARTIAL: 'bg-amber-50 text-amber-700 ring-amber-200', DUE: 'bg-slate-100 text-slate-700 ring-slate-200', OVERDUE: 'bg-rose-50 text-rose-700 ring-rose-200',
  PLANNED: 'bg-sky-50 text-sky-700 ring-sky-200', RUNNING: 'bg-emerald-50 text-emerald-700 ring-emerald-200', DRAFT: 'bg-slate-100 text-slate-700 ring-slate-200', SCHEDULED: 'bg-indigo-50 text-indigo-700 ring-indigo-200',
  SUBMITTED: 'bg-sky-50 text-sky-700 ring-sky-200', UNDER_REVIEW: 'bg-indigo-50 text-indigo-700 ring-indigo-200', PENDING_APPROVAL: 'bg-amber-50 text-amber-700 ring-amber-200',
  ISSUED: 'bg-emerald-50 text-emerald-700 ring-emerald-200', REVOKED: 'bg-rose-50 text-rose-700 ring-rose-200', EVALUATED: 'bg-emerald-50 text-emerald-700 ring-emerald-200', IN_PROGRESS: 'bg-amber-50 text-amber-700 ring-amber-200',
  PRESENT: 'bg-emerald-50 text-emerald-700 ring-emerald-200', ABSENT: 'bg-rose-50 text-rose-700 ring-rose-200', LATE: 'bg-amber-50 text-amber-700 ring-amber-200', EXCUSED: 'bg-slate-100 text-slate-700 ring-slate-200',
  SENT: 'bg-emerald-50 text-emerald-700 ring-emerald-200', DELIVERED: 'bg-emerald-50 text-emerald-700 ring-emerald-200', READ: 'bg-sky-50 text-sky-700 ring-sky-200', FAILED: 'bg-rose-50 text-rose-700 ring-rose-200', SKIPPED: 'bg-slate-100 text-slate-500 ring-slate-200',
  APPLIED_: '',
};
/** Status chip — text label always present (UI-22: never colour alone). */
export function Badge({ status, children, className }: { status?: string; children?: ReactNode; className?: string }) {
  return <span className={cx('chip ring-1 ring-inset', STATUS_TONE[status ?? ''] ?? 'bg-slate-100 text-slate-700 ring-slate-200', className)}>{children ?? label(status)}</span>;
}

/** Protected images (student photos) need the bearer token, so they are fetched and shown as blob URLs. */
function useProtectedImage(src?: string | null) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!src || !src.startsWith('/api/v1/')) return setUrl(src ?? null);
    let alive = true;
    let obj: string | null = null;
    api(src.replace(/^\/api\/v1/, ''), { raw: true })
      .then((r: Response) => r.blob())
      .then((b) => { if (alive) { obj = URL.createObjectURL(b); setUrl(obj); } })
      .catch(() => alive && setUrl(null));
    return () => { alive = false; if (obj) URL.revokeObjectURL(obj); };
  }, [src]);
  return url;
}

export function Avatar({ name, src, size = 'md' }: { name: string; src?: string | null; size?: 'sm' | 'md' | 'lg' }) {
  const s = { sm: 'h-8 w-8 text-xs', md: 'h-10 w-10 text-sm', lg: 'h-16 w-16 text-lg' }[size];
  const url = useProtectedImage(src);
  if (url) return <img src={url} alt="" className={cx('rounded-full object-cover', s)} />;
  return <div className={cx('flex shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-brand-500 to-accent-500 font-semibold text-white', s)}>{initials(name)}</div>;
}

export function Empty({ title, hint, action, icon }: { title: string; hint?: string; action?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-12 text-center">
      <div className="mb-3 rounded-full bg-slate-100 p-3 text-slate-400">{icon ?? <Inbox className="h-6 w-6" />}</div>
      <p className="font-medium text-slate-700">{title}</p>
      {hint && <p className="mt-1 max-w-sm text-sm text-slate-500">{hint}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function ErrorBox({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <div role="alert" className="flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      <span>{(error as Error).message}</span>
    </div>
  );
}

// ── Form fields (UI-11 inline validation, mandatory markers) ──
type FieldProps = { label?: ReactNode; error?: string | string[]; hint?: ReactNode; required?: boolean; className?: string };
function FieldWrap({ id, label: l, error, hint, required, className, children }: FieldProps & { id: string; children: ReactNode }) {
  const err = Array.isArray(error) ? error[0] : error;
  return (
    <div className={className}>
      {l && (
        <label htmlFor={id} className="label">
          {l} {required && <span className="text-rose-600" aria-hidden>*</span>}
        </label>
      )}
      {children}
      {err ? <p className="mt-1 text-xs text-rose-600" id={`${id}-err`}>{err}</p> : hint ? <p className="mt-1 text-xs text-slate-500">{hint}</p> : null}
    </div>
  );
}
export function Input({ label: l, error, hint, required, className, ...p }: FieldProps & InputHTMLAttributes<HTMLInputElement>) {
  const id = useId();
  return (
    <FieldWrap id={id} label={l} error={error} hint={hint} required={required} className={className}>
      <input id={id} required={required} aria-invalid={!!error} aria-describedby={error ? `${id}-err` : undefined} className={cx('input', error && 'border-rose-400')} {...p} />
    </FieldWrap>
  );
}
export function Select({ label: l, error, hint, required, className, options, placeholder, ...p }: FieldProps & SelectHTMLAttributes<HTMLSelectElement> & { options: { value: string; label: string }[]; placeholder?: string }) {
  const id = useId();
  return (
    <FieldWrap id={id} label={l} error={error} hint={hint} required={required} className={className}>
      <select id={id} required={required} aria-invalid={!!error} className={cx('input', error && 'border-rose-400')} {...p}>
        {placeholder !== undefined && <option value="">{placeholder}</option>}
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </FieldWrap>
  );
}
export function Textarea({ label: l, error, hint, required, className, ...p }: FieldProps & TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const id = useId();
  return (
    <FieldWrap id={id} label={l} error={error} hint={hint} required={required} className={className}>
      <textarea id={id} required={required} rows={3} aria-invalid={!!error} className={cx('input', error && 'border-rose-400')} {...p} />
    </FieldWrap>
  );
}

export function Modal({ open, onClose, title, children, footer, size = 'md' }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode; size?: 'sm' | 'md' | 'lg' | 'xl' }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    ref.current?.querySelector<HTMLElement>('input,select,textarea,button')?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  const w = { sm: 'max-w-md', md: 'max-w-lg', lg: 'max-w-2xl', xl: 'max-w-4xl' }[size];
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/40 p-0 backdrop-blur-sm sm:items-center sm:p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} role="dialog" aria-modal="true" className={cx('flex max-h-[92vh] w-full animate-fade-in flex-col rounded-t-2xl bg-white shadow-xl sm:rounded-2xl', w)}>
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
          <h2 className="text-base font-semibold">{title}</h2>
          <button className="btn-ghost -mr-2 p-2" onClick={onClose} aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="overflow-y-auto px-5 py-4">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-slate-100 px-5 py-3">{footer}</div>}
      </div>
    </div>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { key: T; label: ReactNode; count?: number }[]; value: T; onChange: (k: T) => void }) {
  return (
    <div className="mb-5 flex gap-1 overflow-x-auto border-b border-slate-200" role="tablist">
      {tabs.map((t) => (
        <button
          key={t.key}
          role="tab"
          aria-selected={value === t.key}
          onClick={() => onChange(t.key)}
          className={cx('-mb-px flex items-center gap-2 whitespace-nowrap border-b-2 px-4 py-2.5 text-sm font-medium transition', value === t.key ? 'border-brand-600 text-brand-700' : 'border-transparent text-slate-500 hover:text-slate-800')}
        >
          {t.label}
          {t.count != null && <span className="rounded-full bg-slate-100 px-1.5 text-xs text-slate-600">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function KV({ items, cols = 2 }: { items: [ReactNode, ReactNode][]; cols?: 1 | 2 | 3 }) {
  return (
    <dl className={cx('grid gap-x-6 gap-y-3', cols === 1 ? 'grid-cols-1' : cols === 2 ? 'grid-cols-1 sm:grid-cols-2' : 'grid-cols-1 sm:grid-cols-3')}>
      {items.map(([k, v], i) => (
        <div key={i}>
          <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">{k}</dt>
          <dd className="mt-0.5 text-sm text-slate-900">{v ?? '—'}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Progress({ value, tone = 'brand' }: { value: number; tone?: 'brand' | 'green' | 'amber' | 'rose' }) {
  const c = { brand: 'bg-brand-600', green: 'bg-emerald-500', amber: 'bg-amber-500', rose: 'bg-rose-500' }[tone];
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-slate-100" role="progressbar" aria-valuenow={Math.round(value)} aria-valuemin={0} aria-valuemax={100}>
      <div className={cx('h-full rounded-full transition-all', c)} style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
    </div>
  );
}

/** Warn on unsaved changes (UI-13). */
export function useUnsavedWarning(dirty: boolean) {
  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty]);
}

export function useDebounced<T>(v: T, ms = 300) {
  const [s, set] = useState(v);
  useEffect(() => {
    const t = setTimeout(() => set(v), ms);
    return () => clearTimeout(t);
  }, [v, ms]);
  return s;
}

export function Confirm({ open, onClose, onConfirm, title, message, confirmLabel = 'Confirm', tone = 'primary', busy, requireReason, reasonLabel = 'Reason' }: {
  open: boolean; onClose: () => void; onConfirm: (reason: string) => void; title: string; message?: ReactNode; confirmLabel?: string; tone?: 'primary' | 'danger'; busy?: boolean; requireReason?: boolean; reasonLabel?: string;
}) {
  const [reason, setReason] = useState('');
  useEffect(() => setReason(''), [open]);
  return (
    <Modal open={open} onClose={onClose} title={title} size="sm"
      footer={<>
        <button className="btn-secondary" onClick={onClose}>Cancel</button>
        <button className={tone === 'danger' ? 'btn-danger' : 'btn-primary'} disabled={busy || (requireReason && reason.trim().length < 3)} onClick={() => onConfirm(reason)}>{busy && <Spinner className="h-4 w-4 text-white" />}{confirmLabel}</button>
      </>}>
      {message && <div className="text-sm text-slate-600">{message}</div>}
      {requireReason && <Textarea className="mt-3" label={reasonLabel} required value={reason} onChange={(e) => setReason(e.target.value)} />}
    </Modal>
  );
}
