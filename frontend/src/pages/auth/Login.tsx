import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Eye, EyeOff } from 'lucide-react';
import { pendingStep, useAuth } from '@/lib/auth';
import AuthShell from '@/components/AuthShell';
import { ErrorBox, Input, Spinner } from '@/components/ui';
import { rateLimitMessage, refreshRateLimit } from '@/lib/api';

export default function Login({ portal }: { portal: 'staff' | 'student' }) {
  const { login, verifyMfa } = useAuth();
  const [mfa, setMfa] = useState<{ token: string; code: string; recovery: boolean } | null>(null);
  const nav = useNavigate();
  const loc = useLocation() as any;
  // P2: the session restore on page load was refused as "too many attempts" — say so instead of looking signed out.
  const limited = refreshRateLimit();
  const [f, setF] = useState({ identifier: '', password: '' });
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const student = portal === 'student';
  const go = (user: Parameters<typeof pendingStep>[0]) => nav(pendingStep(user) ?? loc.state?.from ?? (student ? '/student' : '/staff/dashboard'), { replace: true });
  return (
    <AuthShell
      title={student ? 'Student portal' : 'Staff sign in'}
      subtitle={student ? 'Sign in with your Student ID or email.' : 'Nexora Academy management portal'}
      side={<>
        <p className="text-sm font-semibold uppercase tracking-wider text-brand-200">{student ? 'Student portal' : 'Centralized portal'}</p>
        <h2 className="mt-3 max-w-md text-4xl font-bold leading-tight text-white">{student ? 'Your classes, fees, exams and results — in one place.' : 'One platform for admissions, students, finance, academics and exams.'}</h2>
      </>}
    >
      {limited && <p role="alert" data-testid="rate-limit-notice" className="mb-4 rounded-lg bg-amber-50 p-3 text-sm text-amber-800">{rateLimitMessage(limited.minutes, false)}</p>}
      {!limited && loc.state?.reason === 'idle' && <p className="mb-4 rounded-lg bg-amber-50 p-3 text-sm text-amber-800">You were signed out after a period of inactivity.</p>}
      <form className="space-y-4" onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true); setErr(null);
        try {
          if (mfa) {
            const s = await verifyMfa(mfa.token, mfa.recovery ? { recoveryCode: mfa.code } : { code: mfa.code.replace(/\s/g, '') });
            return go(s.user);
          }
          const r = await login(f.identifier, f.password, portal);
          if (r.kind === 'mfa') return setMfa({ token: r.challenge.mfaToken, code: '', recovery: false });
          go(r.session.user);
        } catch (e: any) {
          setErr(e);
          if (e?.code === 'MFA_CHALLENGE_EXPIRED') setMfa(null);
        } finally { setBusy(false); }
      }}>
        <ErrorBox error={err} />
        {mfa ? (
          <div className="space-y-4">
            <p className="text-sm text-slate-600">{mfa.recovery ? 'Enter one of your one-time recovery codes.' : 'Enter the 6-digit code from your authenticator app.'}</p>
            <Input label={mfa.recovery ? 'Recovery code' : 'Authentication code'} required autoFocus autoComplete="one-time-code" inputMode={mfa.recovery ? 'text' : 'numeric'} value={mfa.code} onChange={(e) => setMfa({ ...mfa, code: e.target.value })} placeholder={mfa.recovery ? 'xxxx-xxxx-xxxx' : '123456'} />
            <div className="flex justify-between text-sm">
              <button type="button" className="link" onClick={() => setMfa({ ...mfa, recovery: !mfa.recovery, code: '' })}>{mfa.recovery ? 'Use authenticator code' : 'Use a recovery code'}</button>
              <button type="button" className="link" onClick={() => { setMfa(null); setErr(null); }}>Start again</button>
            </div>
            <button className="btn-primary w-full" disabled={busy}>{busy && <Spinner className="h-4 w-4 text-white" />} Verify</button>
          </div>
        ) : <>
        <Input label={student ? 'Student ID or email' : 'Username or email'} required autoComplete="username" value={f.identifier} onChange={(e) => setF({ ...f, identifier: e.target.value })} placeholder={student ? 'nxa-2026-00001' : 'you@nexoraed.com'} />
        <div>
          <label className="label" htmlFor="pw">Password <span className="text-rose-600">*</span></label>
          <div className="relative">
            <input id="pw" className="input pr-10" type={show ? 'text' : 'password'} required autoComplete="current-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} />
            <button type="button" className="absolute inset-y-0 right-0 px-3 text-slate-400 hover:text-slate-600" onClick={() => setShow((v) => !v)} aria-label={show ? 'Hide password' : 'Show password'}>{show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}</button>
          </div>
        </div>
        <div className="flex justify-end"><Link to="/forgot-password" className="text-sm link">Forgot password?</Link></div>
        <button className="btn-primary w-full" disabled={busy}>{busy && <Spinner className="h-4 w-4 text-white" />} Sign in</button>
        </>}
      </form>
      <p className="mt-8 text-center text-sm text-slate-500">
        {student ? <>Staff member? <Link to="/login" className="link">Staff sign in</Link></> : <>Student? <Link to="/student/login" className="link">Student portal</Link></>}
      </p>
    </AuthShell>
  );
}
