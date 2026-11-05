import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '@/lib/api';
import AuthShell from '@/components/AuthShell';
import { ErrorBox, Input, Spinner } from '@/components/ui';

export default function Reset() {
  const [sp] = useSearchParams();
  const [pw, setPw] = useState({ a: '', b: '' });
  const [done, setDone] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const activate = sp.get('activate') === '1';
  return (
    <AuthShell title={activate ? 'Activate your account' : 'Choose a new password'} subtitle={activate ? 'Set your password. Administrative accounts then set up an authenticator app.' : undefined}>
      {done ? <p className="rounded-lg bg-emerald-50 p-4 text-sm text-emerald-800">Password {activate ? 'set' : 'updated'}. <Link to="/login" className="link">Sign in</Link></p> : (
        <form className="space-y-4" onSubmit={async (e) => {
          e.preventDefault();
          if (pw.a !== pw.b) return setErr(new Error('Passwords do not match.'));
          setBusy(true); setErr(null);
          try { await api('/auth/reset-password', { body: { token: sp.get('token'), newPassword: pw.a } }); setDone(true); } catch (e) { setErr(e); } finally { setBusy(false); }
        }}>
          <ErrorBox error={err} />
          <Input label="New password" type="password" required minLength={10} value={pw.a} onChange={(e) => setPw({ ...pw, a: e.target.value })} hint="At least 10 characters, using three of: lower-case, upper-case, numbers, symbols. Not a common password or one of your last 5." autoComplete="new-password" />
          <Input label="Confirm password" type="password" required value={pw.b} onChange={(e) => setPw({ ...pw, b: e.target.value })} autoComplete="new-password" />
          <button className="btn-primary w-full" disabled={busy}>{busy && <Spinner className="h-4 w-4 text-white" />} Update password</button>
        </form>
      )}
    </AuthShell>
  );
}
