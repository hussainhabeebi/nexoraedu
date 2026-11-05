import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, getSession, onSession, restoreSession, setSession, type MfaChallenge, type Session } from './api';

export type LoginResult = { kind: 'session'; session: Session } | { kind: 'mfa'; challenge: MfaChallenge };

interface AuthCtx {
  /** false until the start-up session restore (cookie refresh) has finished */
  ready: boolean;
  session: Session | null;
  user: Session['user'] | null;
  can: (...perms: string[]) => boolean;
  hasRole: (...roles: string[]) => boolean;
  login: (identifier: string, password: string, portal: 'staff' | 'student') => Promise<LoginResult>;
  verifyMfa: (mfaToken: string, code: { code?: string; recoveryCode?: string }) => Promise<Session>;
  logout: () => Promise<void>;
}
const Ctx = createContext<AuthCtx>(null!);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, set] = useState(getSession());
  const [ready, setReady] = useState(false);
  useEffect(() => { const off = onSession(set); return () => { off(); }; }, []);
  useEffect(() => { restoreSession().finally(() => setReady(true)); }, []);
  const user = session?.user ?? null;
  const can = (...perms: string[]) => !!user && (user.perms.includes('*') || perms.some((p) => user.perms.includes(p)));
  const hasRole = (...roles: string[]) => !!user && roles.some((r) => user.roles.includes(r));
  const login = async (identifier: string, password: string, portal: 'staff' | 'student'): Promise<LoginResult> => {
    const r = await api<Session | MfaChallenge>('/auth/login', { body: { identifier, password, portal } });
    if ('mfaRequired' in r && r.mfaRequired) return { kind: 'mfa', challenge: r };
    setSession(r as Session);
    return { kind: 'session', session: r as Session };
  };
  const verifyMfa = async (mfaToken: string, c: { code?: string; recoveryCode?: string }) => {
    const s = await api<Session>('/auth/mfa/verify', { body: { mfaToken, ...c } });
    setSession(s);
    return s;
  };
  const logout = async () => {
    await api('/auth/logout', { body: {} }).catch(() => undefined);
    setSession(null);
  };
  return <Ctx.Provider value={{ ready, session, user, can, hasRole, login, verifyMfa, logout }}>{children}</Ctx.Provider>;
}
export const useAuth = () => useContext(Ctx);

/** Where a signed-in user must go before using the portal (forced password change, then MFA set-up). */
export function pendingStep(user: Session['user'] | null): string | null {
  if (!user) return null;
  if (user.mustChangePassword) return '/change-password';
  if (user.mfaRequired && !user.mfaVerified) return '/mfa-setup';
  return null;
}
