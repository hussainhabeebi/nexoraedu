import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '@/lib/api';
import AuthShell from '@/components/AuthShell';
import { Input, Spinner } from '@/components/ui';

export default function Forgot() {
  const [id, setId] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <AuthShell title="Reset your password" subtitle="We’ll send a reset link to your registered email and WhatsApp.">
      {msg ? <p className="rounded-lg bg-emerald-50 p-4 text-sm text-emerald-800">{msg}</p> : (
        <form className="space-y-4" onSubmit={async (e) => { e.preventDefault(); setBusy(true); try { setMsg((await api('/auth/forgot-password', { body: { identifier: id } })).message); } finally { setBusy(false); } }}>
          <Input label="Username, Student ID or email" required value={id} onChange={(e) => setId(e.target.value)} />
          <button className="btn-primary w-full" disabled={busy}>{busy && <Spinner className="h-4 w-4 text-white" />} Send reset link</button>
        </form>
      )}
      <p className="mt-6 text-center text-sm"><Link to="/login" className="link">Back to sign in</Link></p>
    </AuthShell>
  );
}
