import { useState } from 'react';
import { Award, FileDown } from 'lucide-react';
import { api, download } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useGet, useMut } from '@/lib/hooks';
import { d } from '@/lib/format';
import { Badge, Card, Empty, Modal, PageHeader, PageLoader, useDebounced } from '@/components/ui';

export default function Certificates() {
  const { can } = useAuth();
  const { data, isLoading } = useGet<any>('/exams/certificates');
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const dq = useDebounced(q);
  const res = useGet<any>(dq.length > 1 ? `/students?q=${encodeURIComponent(dq)}&pageSize=8` : null);
  const gen = useMut((studentId: string) => api('/exams/certificates', { body: { studentId } }), { success: 'Certificate generated — sent for approval', invalidate: ['/exams'], onSuccess: () => setOpen(false) });
  if (isLoading) return <PageLoader />;
  return (
    <div>
      <PageHeader title="Certificates" subtitle="Eligibility: course completed, final exam passed, fees cleared." actions={can('exams:manage') && <button className="btn-primary" onClick={() => setOpen(true)}><Award className="h-4 w-4" /> Generate certificate</button>} />
      <Card bodyClass="p-0">
        {data.items.length ? (
          <table className="min-w-full divide-y divide-slate-100">
            <thead className="bg-slate-50"><tr><th className="th">Number</th><th className="th">Student</th><th className="th">Verification code</th><th className="th">Issued</th><th className="th">Status</th><th className="th" /></tr></thead>
            <tbody className="divide-y divide-slate-100">{data.items.map((c: any) => <tr key={c.id}><td className="td font-medium">{c.number}</td><td className="td">{c.student.fullName} <span className="text-xs text-slate-500">{c.student.studentCode}</span></td><td className="td font-mono text-xs">{c.verificationCode}</td><td className="td">{d(c.issuedAt)}</td><td className="td"><Badge status={c.status} /></td><td className="td">{c.status === 'ISSUED' && <button className="btn-ghost btn-sm" onClick={() => download(`/exams/certificates/${c.id}/pdf`, `${c.number}.pdf`, true)} aria-label="Download"><FileDown className="h-4 w-4" /></button>}</td></tr>)}</tbody>
          </table>
        ) : <Empty title="No certificates yet" />}
      </Card>
      <Modal open={open} onClose={() => setOpen(false)} title="Generate certificate">
        <input className="input" autoFocus placeholder="Search student" value={q} onChange={(e) => setQ(e.target.value)} />
        <ul className="mt-3 divide-y divide-slate-100">{res.data?.items.map((s: any) => <li key={s.id} className="flex items-center justify-between py-2.5 text-sm"><span>{s.fullName} <span className="text-slate-500">{s.studentCode} · {s.course.name}</span></span><button className="btn-secondary btn-sm" disabled={gen.isPending} onClick={() => gen.mutate(s.id)}>Generate</button></li>)}</ul>
      </Modal>
    </div>
  );
}
