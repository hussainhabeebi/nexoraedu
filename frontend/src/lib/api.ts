/**
 * Thin fetch wrapper: JSON, bearer token, automatic refresh, friendly errors.
 * SEC-05 / S9: the access token lives in memory only; the refresh token is an HttpOnly cookie the
 * browser sends to /api/v1/auth/refresh — JavaScript can never read it. Nothing is stored in localStorage.
 */
export const API_BASE = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, '') ?? '';
/** CSRF defence: the API requires this header on cookie-authenticated endpoints. */
const CSRF_HEADER = { 'X-Requested-With': 'nexora' };

export interface SessionUser {
  id: string; name: string; email: string; roles: string[]; perms: string[]; studentId?: string | null; username?: string; phone?: string | null;
  mustChangePassword?: boolean; mfaRequired?: boolean; mfaEnrolled?: boolean; mfaVerified?: boolean;
}
export interface Session {
  accessToken: string;
  expiresIn?: number;
  user: SessionUser;
  mfaEnrollmentRequired?: boolean;
  passwordChangeRequired?: boolean;
}
export interface MfaChallenge { mfaRequired: true; mfaToken: string; expiresIn: number }

export class ApiError extends Error {
  constructor(public status: number, message: string, public code?: string, public fields?: Record<string, string[]>, public details?: any, public ref?: string) {
    super(message);
  }
}

let session: Session | null = null;
const listeners = new Set<(s: Session | null) => void>();

// Clean up anything an older build left in localStorage (it used to hold the refresh token).
try { localStorage.removeItem('nexora.session'); } catch { /* storage unavailable */ }

export const getSession = () => session;
export function setSession(s: Session | null) {
  session = s;
  listeners.forEach((l) => l(s));
}
export const onSession = (l: (s: Session | null) => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

let refreshing: Promise<boolean> | null = null;
async function doRefresh(retry = true): Promise<boolean> {
  const r = await fetch(`${API_BASE}/api/v1/auth/refresh`, { method: 'POST', credentials: 'include', headers: { ...CSRF_HEADER } });
  if (r.ok) {
    setSession(await r.json());
    return true;
  }
  // Another tab rotated the cookie at the same moment: the browser now holds the new one, so try once more.
  const body = await r.json().catch(() => ({}));
  if (retry && body?.error?.code === 'REFRESH_RACE') {
    await new Promise((res) => setTimeout(res, 400));
    return doRefresh(false);
  }
  return false;
}
async function refresh(): Promise<boolean> {
  refreshing ??= doRefresh()
    .catch(() => false)
    .finally(() => setTimeout(() => (refreshing = null), 0));
  return refreshing;
}
/** Re-reads the session from the server (e.g. after MFA enrolment changed it). */
export const reloadSession = () => refresh();
/** Called once at start-up: restores the session from the HttpOnly cookie, if any. */
export async function restoreSession(): Promise<Session | null> {
  if (session) return session;
  return (await refresh()) ? session : null;
}

type Opts = { method?: string; body?: unknown; headers?: Record<string, string>; raw?: boolean };

export async function api<T = any>(path: string, opts: Opts = {}, retry = true): Promise<T> {
  const isForm = opts.body instanceof FormData;
  const res = await fetch(`${API_BASE}/api/v1${path}`, {
    method: opts.method ?? (opts.body ? 'POST' : 'GET'),
    credentials: 'include',
    headers: { ...CSRF_HEADER, ...(isForm ? {} : { 'Content-Type': 'application/json' }), ...(session && { Authorization: `Bearer ${session.accessToken}` }), ...opts.headers },
    body: opts.body ? (isForm ? (opts.body as FormData) : JSON.stringify(opts.body)) : undefined,
  });
  if (res.status === 401 && retry && session && !path.startsWith('/auth/login') && !path.startsWith('/auth/mfa/verify')) {
    if (await refresh()) return api(path, opts, false);
    setSession(null);
  }
  if (opts.raw) {
    if (!res.ok) throw new ApiError(res.status, 'Download failed');
    return res as any;
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const e = data.error ?? {};
    throw new ApiError(res.status, e.message || (res.status === 403 ? 'You do not have permission to do this.' : 'Something went wrong.'), e.code, e.fields, e.details, e.ref);
  }
  return data as T;
}

/** Download a protected file (CSV/PDF) with auth and open/save it. */
export async function download(path: string, filename: string, open = false) {
  const res: Response = await api(path, { raw: true });
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  if (open) window.open(url, '_blank');
  else {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
  }
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export const qs = (o: Record<string, unknown>) => {
  const p = new URLSearchParams();
  Object.entries(o).forEach(([k, v]) => v !== undefined && v !== null && v !== '' && p.set(k, String(v)));
  const s = p.toString();
  return s ? `?${s}` : '';
};
