/** Thin fetch wrapper: JSON, bearer token, automatic refresh-token rotation, friendly errors. */
export const API_BASE = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, '') ?? '';
const KEY = 'nexora.session';

export interface Session {
  accessToken: string;
  refreshToken: string;
  user: { id: string; name: string; email: string; roles: string[]; perms: string[]; studentId?: string | null; mustChangePassword?: boolean; username?: string };
}

export class ApiError extends Error {
  constructor(public status: number, message: string, public code?: string, public fields?: Record<string, string[]>, public details?: any) {
    super(message);
  }
}

let session: Session | null = (() => {
  try {
    return JSON.parse(localStorage.getItem(KEY) || 'null');
  } catch {
    return null;
  }
})();
const listeners = new Set<(s: Session | null) => void>();

export const getSession = () => session;
export function setSession(s: Session | null) {
  session = s;
  try {
    if (s) localStorage.setItem(KEY, JSON.stringify(s));
    else localStorage.removeItem(KEY);
  } catch {
    /* storage unavailable */
  }
  listeners.forEach((l) => l(s));
}
export const onSession = (l: (s: Session | null) => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

let refreshing: Promise<boolean> | null = null;
async function refresh(): Promise<boolean> {
  if (!session?.refreshToken) return false;
  refreshing ??= fetch(`${API_BASE}/api/v1/auth/refresh`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refreshToken: session.refreshToken }) })
    .then(async (r) => {
      if (!r.ok) return false;
      setSession(await r.json());
      return true;
    })
    .catch(() => false)
    .finally(() => setTimeout(() => (refreshing = null), 0));
  return refreshing;
}

type Opts = { method?: string; body?: unknown; headers?: Record<string, string>; raw?: boolean };

export async function api<T = any>(path: string, opts: Opts = {}, retry = true): Promise<T> {
  const isForm = opts.body instanceof FormData;
  const res = await fetch(`${API_BASE}/api/v1${path}`, {
    method: opts.method ?? (opts.body ? 'POST' : 'GET'),
    headers: { ...(isForm ? {} : { 'Content-Type': 'application/json' }), ...(session && { Authorization: `Bearer ${session.accessToken}` }), ...opts.headers },
    body: opts.body ? (isForm ? (opts.body as FormData) : JSON.stringify(opts.body)) : undefined,
  });
  if (res.status === 401 && retry && session && !path.startsWith('/auth/login')) {
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
    throw new ApiError(res.status, e.message || (res.status === 403 ? 'You do not have permission to do this.' : 'Something went wrong.'), e.code, e.fields, e.details);
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
