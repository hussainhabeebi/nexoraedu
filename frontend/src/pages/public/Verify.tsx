import { useState } from 'react';
import { BadgeCheck, XCircle } from 'lucide-react';
import { api } from '@/lib/api';
import { d } from '@/lib/format';
import { Input, Spinner } from '@/components/ui';

export default function Verify() {
  const [code, setCode] = useState('');
  const [res, setRes] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="mx-auto max-w-xl px-4 py-16">
      <h1 className="text-3xl font-bold">Verify a certificate</h1>
      <p className="mt-2 text-slate-600">Enter the verification code printed on the certificate.</p>
      <form className="card mt-8 flex flex-col gap-3 p-6 sm:flex-row sm:items-end" onSubmit={async (e) => { e.preventDefault(); setBusy(true); try { setRes(await api(`/public/certificates/verify/${encodeURIComponent(code.trim())}`)); } finally { setBusy(false); } }}>
        <Input className="flex-1" label="Verification code" required value={code} onChange={(e) => setCode(e.target.value)} />
        <button className="btn-primary" disabled={busy}>{busy && <Spinner className="h-4 w-4 text-white" />} Verify</button>
      </form>
      {res && (res.valid ? (
        <div className="card mt-6 flex gap-4 border-emerald-200 bg-emerald-50 p-6">
          <BadgeCheck className="h-8 w-8 shrink-0 text-emerald-600" />
          <div><p className="font-semibold text-emerald-900">Valid certificate</p><p className="mt-1 text-sm text-emerald-800">{res.name} ({res.studentCode}) completed <b>{res.course}</b>. Certificate {res.number}, issued {d(res.issuedAt)}.</p></div>
        </div>
      ) : (
        <div className="card mt-6 flex gap-4 border-rose-200 bg-rose-50 p-6"><XCircle className="h-8 w-8 shrink-0 text-rose-600" /><p className="text-rose-800">No issued certificate matches this code.</p></div>
      ))}
    </div>
  );
}
