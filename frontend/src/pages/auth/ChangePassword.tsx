import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { api, setSession } from '@/lib/api';
import { pendingStep, useAuth } from '@/lib/auth';
import AuthShell from '@/components/AuthShell';
import { ErrorBox, Input, Spinner } from '@/components/ui';

export default function ChangePassword() {
  const { user } = useAuth();
  const nav = useNavigate();
  const [f, setF] = useState({ current: '', a: '', b: '' });
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const isStudent = user?.roles.includes('student') && user.roles.length === 1;
  return (
    <AuthShell title={user?.mustChangePassword ? 'Set your password' : 'Change password'} subtitle={user?.mustChangePassword ? 'For your security, please replace the temporary password before continuing.' : undefined}>
      <form className="space-y-4" onSubmit={async (e) => {
        e.preventDefault();
        if (f.a !== f.b) return setErr(new Error('New passwords do not match.'));
        setBusy(true); setErr(null);
        try {
          const s = await api('/auth/change-password', { body: { currentPassword: f.current, newPassword: f.a } });
          setSession(s);
          toast.success('Password updated');
          nav(pendingStep(s.user) ?? (isStudent ? '/student' : '/staff/dashboard'), { replace: true });
        } catch (e) { setErr(e); } finally { setBusy(false); }
      }}>
        <ErrorBox error={err} />
        <Input label="Current / temporary password" type="password" required value={f.current} onChange={(e) => setF({ ...f, current: e.target.value })} autoComplete="current-password" />
        <Input label="New password" type="password" required minLength={10} value={f.a} onChange={(e) => setF({ ...f, a: e.target.value })} hint="At least 10 characters, using three of: lower-case, upper-case, numbers, symbols. Not a common password or one of your last 5." autoComplete="new-password" />
        <Input label="Confirm new password" type="password" required value={f.b} onChange={(e) => setF({ ...f, b: e.target.value })} autoComplete="new-password" />
        <button className="btn-primary w-full" disabled={busy}>{busy && <Spinner className="h-4 w-4 text-white" />} Save password</button>
        {!user?.mustChangePassword && <button type="button" className="btn-ghost w-full" onClick={() => history.back()}>Cancel</button>}
      </form>
    </AuthShell>
  );
}
