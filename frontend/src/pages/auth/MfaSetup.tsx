import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import QRCode from 'qrcode';
import { toast } from 'sonner';
import { api, reloadSession } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import AuthShell from '@/components/AuthShell';
import { ErrorBox, Input, Spinner } from '@/components/ui';

/** SEC-06: authenticator-app enrolment. Mandatory for Super Admin, Admin, Management and Finance roles. */
export default function MfaSetup() {
  const { user, logout } = useAuth();
  const nav = useNavigate();
  const [setup, setSetup] = useState<{ secret: string; otpauthUrl: string; qr: string } | null>(null);
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const isStudent = user?.roles.includes('student') && user.roles.length === 1;

  useEffect(() => {
    if (user?.mfaEnrolled && user.mfaVerified) return;
    api<{ secret: string; otpauthUrl: string }>('/auth/mfa/enroll/start', { body: {} })
      .then(async (r) => setSetup({ ...r, qr: await QRCode.toDataURL(r.otpauthUrl, { margin: 1, width: 220 }) }))
      .catch(setErr);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (codes) {
    return (
      <AuthShell title="Save your recovery codes" subtitle="Each code works once if you lose your phone. Store them somewhere safe — they will not be shown again.">
        <ul className="grid grid-cols-2 gap-2 rounded-lg bg-slate-50 p-4 font-mono text-sm">{codes.map((c) => <li key={c}>{c}</li>)}</ul>
        <div className="mt-4 flex gap-2">
          <button className="btn-secondary flex-1" onClick={() => { navigator.clipboard?.writeText(codes.join('\n')); toast.success('Copied'); }}>Copy</button>
          <button className="btn-primary flex-1" onClick={async () => { await reloadSession(); nav(isStudent ? '/student' : '/staff/dashboard', { replace: true }); }}>I have saved them</button>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell title="Set up two-factor authentication" subtitle={user?.mfaRequired ? 'Your role requires an authenticator app (for example Google Authenticator or Microsoft Authenticator).' : 'Protect your account with an authenticator app.'}>
      <ErrorBox error={err} />
      {!setup ? <div className="flex justify-center py-8"><Spinner className="h-6 w-6" /></div> : (
        <form className="space-y-4" onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true); setErr(null);
          try {
            const r = await api<{ recoveryCodes: string[] }>('/auth/mfa/enroll/confirm', { body: { code: code.replace(/\s/g, '') } });
            setCodes(r.recoveryCodes);
          } catch (e) { setErr(e); } finally { setBusy(false); }
        }}>
          <ol className="list-decimal space-y-1 pl-5 text-sm text-slate-600">
            <li>Open your authenticator app and scan this code.</li>
            <li>Enter the 6-digit code it shows.</li>
          </ol>
          <img src={setup.qr} alt="QR code for your authenticator app" className="mx-auto h-56 w-56 rounded-lg border" />
          <p className="text-center text-xs text-slate-500">Can't scan? Enter this key manually: <span className="select-all font-mono text-slate-700">{setup.secret.match(/.{1,4}/g)?.join(' ')}</span></p>
          <Input label="6-digit code" required inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="123456" />
          <button className="btn-primary w-full" disabled={busy}>{busy && <Spinner className="h-4 w-4 text-white" />} Verify and turn on</button>
          <button type="button" className="btn-ghost w-full" onClick={async () => { await logout(); nav('/login', { replace: true }); }}>Sign out</button>
        </form>
      )}
    </AuthShell>
  );
}
