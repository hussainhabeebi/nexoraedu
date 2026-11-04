import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, getSession, onSession, setSession, type Session } from './api';

interface AuthCtx {
  session: Session | null;
  user: Session['user'] | null;
  can: (...perms: string[]) => boolean;
  hasRole: (...roles: string[]) => boolean;
  login: (identifier: string, password: string, portal: 'staff' | 'student') => Promise<Session>;
  logout: () => Promise<void>;
}
const Ctx = createContext<AuthCtx>(null!);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, set] = useState(getSession());
  useEffect(() => { const off = onSession(set); return () => { off(); }; }, []);
  const user = session?.user ?? null;
  const can = (...perms: string[]) => !!user && (user.perms.includes('*') || perms.some((p) => user.perms.includes(p)));
  const hasRole = (...roles: string[]) => !!user && roles.some((r) => user.roles.includes(r));
  const login = async (identifier: string, password: string, portal: 'staff' | 'student') => {
    const s = await api<Session>('/auth/login', { body: { identifier, password, portal } });
    setSession(s);
    return s;
  };
  const logout = async () => {
    const t = getSession()?.refreshToken;
    setSession(null);
    if (t) await api('/auth/logout', { body: { refreshToken: t } }).catch(() => undefined);
  };
  return <Ctx.Provider value={{ session, user, can, hasRole, login, logout }}>{children}</Ctx.Provider>;
}
export const useAuth = () => useContext(Ctx);
