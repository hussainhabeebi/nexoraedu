import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import AuthShell from '@/components/AuthShell';
import { ErrorBox, Spinner } from '@/components/ui';

type S = { id: string; ip?: string; userAgent?: string; createdAt: string; lastSeenAt: string; current: boolean; mfaVerified: boolean };

/** SEC-05: users can view and end their active sessions; MFA status (SEC-06). */
export default function Security() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['sessions'], queryFn: () => api<{ items: S[] }>('/auth/sessions') });
  const end = async (id?: string) => {
    try {
      if (id) await api(`/auth/sessions/${id}`, { method: 'DELETE' });
      else await api('/auth/sessions/revoke-others', { body: {} });
      toast.success(id ? 'Session ended' : 'Other sessions ended');
      qc.invalidateQueries({ queryKey: ['sessions'] });
    } catch (e: any) { toast.error(e.message); }
  };
  return (
    <AuthShell title="Security" subtitle="Your sign-in methods and active sessions.">
      <div className="space-y-6">
        <section className="rounded-lg border p-4 text-sm">
          <p className="font-medium">Two-factor authentication</p>
          <p className="mt-1 text-slate-600">{user?.mfaEnrolled ? 'On — an authenticator app is required at sign-in.' : 'Off.'} {!user?.mfaEnrolled && <Link className="link" to="/mfa-setup">Turn on</Link>}</p>
          {user?.mfaEnrolled && <p className="mt-1 text-xs text-slate-500">Lost your device? Ask a Super Administrator to reset it.</p>}
        </section>
        <section>
          <div className="mb-2 flex items-center justify-between"><p className="font-medium text-sm">Active sessions</p><button className="btn-secondary text-xs" onClick={() => end()}>Sign out other sessions</button></div>
          <ErrorBox error={q.error} />
          {q.isLoading ? <Spinner className="h-5 w-5" /> : (
            <ul className="divide-y rounded-lg border text-sm">
              {q.data?.items.map((s) => (
                <li key={s.id} className="flex items-center justify-between gap-3 p-3">
                  <div className="min-w-0"><p className="truncate">{s.userAgent ?? 'Unknown device'}</p><p className="text-xs text-slate-500">{s.ip ?? '—'} · last active {new Date(s.lastSeenAt).toLocaleString()} {s.current && <span className="ml-1 rounded bg-emerald-50 px-1.5 py-0.5 text-emerald-700">This device</span>}</p></div>
                  {!s.current && <button className="btn-ghost text-xs text-rose-600" onClick={() => end(s.id)}>End</button>}
                </li>
              ))}
            </ul>
          )}
        </section>
        <div className="flex gap-2"><Link to="/change-password" className="btn-secondary flex-1 text-center">Change password</Link><button className="btn-ghost flex-1" onClick={() => history.back()}>Back</button></div>
      </div>
    </AuthShell>
  );
}
