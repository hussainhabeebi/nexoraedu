import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Check } from 'lucide-react';
import { api } from '@/lib/api';
import { d, label } from '@/lib/format';
import { cx, ErrorBox, Input, Spinner } from '@/components/ui';

const FLOW = ['SUBMITTED', 'UNDER_REVIEW', 'PENDING_APPROVAL', 'ADMITTED'];

export default function Track() {
  const [f, setF] = useState({ code: '', phone: '' });
  const [res, setRes] = useState<any>(null);
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const idx = res ? (res.status === 'APPROVED' ? 2 : FLOW.indexOf(res.status)) : -1;
  return (
    <div className="mx-auto max-w-xl px-4 py-16">
      <h1 className="text-3xl font-bold">Track your application</h1>
      <p className="mt-2 text-slate-600">Enter the application number you received and your registered mobile number.</p>
      <form className="card mt-8 grid gap-4 p-6" onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true); setErr(null); setRes(null);
        try { setRes(await api(`/public/applications/status?code=${encodeURIComponent(f.code)}&phone=${encodeURIComponent(f.phone)}`)); } catch (e) { setErr(e); } finally { setBusy(false); }
      }}>
        <Input label="Application number" required placeholder="APP-2026-00001" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} />
        <Input label="Mobile number" type="tel" required value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} />
        <ErrorBox error={err} />
        <button className="btn-primary" disabled={busy}>{busy && <Spinner className="h-4 w-4 text-white" />} Check status</button>
      </form>
      {res && (
        <div className="card mt-6 p-6">
          <p className="text-sm text-slate-500">{res.code} · {res.course} · submitted {d(res.submittedAt)}</p>
          {res.status === 'REJECTED' ? (
            <p className="mt-4 rounded-lg bg-rose-50 p-4 text-rose-800">Your application was not accepted. Please contact us for details.</p>
          ) : (
            <ol className="mt-6 space-y-4">
              {FLOW.map((s, i) => (
                <li key={s} className="flex items-center gap-3">
                  <span className={cx('flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold', i <= idx ? 'bg-emerald-500 text-white' : 'bg-slate-100 text-slate-400')}>{i <= idx ? <Check className="h-4 w-4" /> : i + 1}</span>
                  <span className={cx('font-medium', i <= idx ? 'text-slate-900' : 'text-slate-400')}>{s === 'PENDING_APPROVAL' ? 'Admission approval' : label(s)}</span>
                </li>
              ))}
            </ol>
          )}
          {res.studentCode && <p className="mt-6 rounded-lg bg-emerald-50 p-4 text-emerald-800">🎉 Admitted! Your Student ID is <b>{res.studentCode}</b>. <Link to="/student/login" className="link">Sign in to the student portal</Link>.</p>}
        </div>
      )}
    </div>
  );
}
