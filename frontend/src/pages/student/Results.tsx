import { FileDown } from 'lucide-react';
import { download } from '@/lib/api';
import { useGet } from '@/lib/hooks';
import { d, label } from '@/lib/format';
import { Badge, Card, Empty, PageHeader, PageLoader, Progress } from '@/components/ui';

export default function Results() {
  const { data, isLoading } = useGet<any>('/portal/results');
  const certs = useGet<any>('/portal/certificates');
  if (isLoading) return <PageLoader />;
  return (
    <div className="space-y-6">
      <PageHeader title="Results & certificates" />
      {!!certs.data?.items.length && <Card title="Certificates" bodyClass="p-0"><ul className="divide-y divide-slate-100">{certs.data.items.map((c: any) => <li key={c.id} className="flex items-center justify-between px-5 py-3 text-sm"><span><b>{c.number}</b> · issued {d(c.issuedAt)} · code <span className="font-mono">{c.verificationCode}</span></span><button className="btn-secondary btn-sm" onClick={() => download(`/portal/certificates/${c.id}/pdf`, `${c.number}.pdf`, true)}><FileDown className="h-4 w-4" /> Download</button></li>)}</ul></Card>}
      {data.items.length ? <div className="grid gap-4 md:grid-cols-2">{data.items.map((r: any) => (
        <Card key={r.id}>
          <div className="flex items-start justify-between"><div><p className="font-semibold">{r.exam.title}</p><p className="text-sm text-slate-500">{label(r.exam.type)} · {d(r.exam.startAt)}</p></div><Badge status={r.passed ? 'APPROVED' : 'REJECTED'}>{r.passed ? 'Passed' : 'Not passed'}</Badge></div>
          <div className="mt-4 flex items-end gap-4"><p className="text-3xl font-bold">{r.marks}<span className="text-base font-normal text-slate-500">/{r.exam.totalMarks}</span></p><p className="text-2xl font-bold text-brand-600">{r.grade}</p></div>
          <div className="mt-2"><Progress value={r.percentage} tone={r.passed ? 'green' : 'rose'} /></div>
          <p className="mt-1 text-xs text-slate-500">{r.percentage}% · pass mark {r.exam.passMarks}{r.remarks && ` · ${r.remarks}`}</p>
        </Card>
      ))}</div> : <Empty title="No results published yet" />}
    </div>
  );
}
