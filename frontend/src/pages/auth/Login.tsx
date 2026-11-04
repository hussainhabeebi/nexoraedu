import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Eye, EyeOff } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import AuthShell from '@/components/AuthShell';
import { ErrorBox, Input, Spinner } from '@/components/ui';

export default function Login({ portal }: { portal: 'staff' | 'student' }) {
  const { login } = useAuth();
  const nav = useNavigate();
  const loc = useLocation() as any;
  const [f, setF] = useState({ identifier: '', password: '' });
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const student = portal === 'student';
  return (
    <AuthShell
      title={student ? 'Student portal' : 'Staff sign in'}
      subtitle={student ? 'Sign in with your Student ID or email.' : 'Nexora Academy management portal'}
      side={<>
        <p className="text-sm font-semibold uppercase tracking-wider text-brand-200">{student ? 'Student portal' : 'Centralized portal'}</p>
        <h2 className="mt-3 max-w-md text-4xl font-bold leading-tight text-white">{student ? 'Your classes, fees, exams and results — in one place.' : 'One platform for admissions, students, finance, academics and exams.'}</h2>
      </>}
    >
      {loc.state?.reason === 'idle' && <p className="mb-4 rounded-lg bg-amber-50 p-3 text-sm text-amber-800">You were signed out after a period of inactivity.</p>}
      <form className="space-y-4" onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true); setErr(null);
        try {
          const s = await login(f.identifier, f.password, portal);
          if (s.user.mustChangePassword) nav('/change-password');
          else nav(loc.state?.from ?? (student ? '/student' : '/staff/dashboard'), { replace: true });
        } catch (e) { setErr(e); } finally { setBusy(false); }
      }}>
        <ErrorBox error={err} />
        <Input label={student ? 'Student ID or email' : 'Username or email'} required autoComplete="username" value={f.identifier} onChange={(e) => setF({ ...f, identifier: e.target.value })} placeholder={student ? 'nxa-2026-00001' : 'you@nexoraedu.com'} />
        <div>
          <label className="label" htmlFor="pw">Password <span className="text-rose-600">*</span></label>
          <div className="relative">
            <input id="pw" className="input pr-10" type={show ? 'text' : 'password'} required autoComplete="current-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} />
            <button type="button" className="absolute inset-y-0 right-0 px-3 text-slate-400 hover:text-slate-600" onClick={() => setShow((v) => !v)} aria-label={show ? 'Hide password' : 'Show password'}>{show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}</button>
          </div>
        </div>
        <div className="flex justify-end"><Link to="/forgot-password" className="text-sm link">Forgot password?</Link></div>
        <button className="btn-primary w-full" disabled={busy}>{busy && <Spinner className="h-4 w-4 text-white" />} Sign in</button>
      </form>
      <p className="mt-8 text-center text-sm text-slate-500">
        {student ? <>Staff member? <Link to="/login" className="link">Staff sign in</Link></> : <>Student? <Link to="/student/login" className="link">Student portal</Link></>}
      </p>
    </AuthShell>
  );
}
