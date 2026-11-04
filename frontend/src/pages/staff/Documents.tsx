import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Check, Eye, X } from 'lucide-react';
import { api, download } from '@/lib/api';
import { useGet, useMut } from '@/lib/hooks';
import { ago, label } from '@/lib/format';
import { Card, Confirm, Empty, PageHeader, PageLoader } from '@/components/ui';

export default function Documents() {
  const { data, isLoading } = useGet<any>('/documents/pending');
  const [rej, setRej] = useState<string | null>(null);
  const m = useMut(({ id, status, remarks }: any) => api(`/documents/${id}/verify`, { body: { status, remarks } }), { success: 'Document updated', invalidate: ['/documents', '/students', '/dashboard'], onSuccess: () => setRej(null) });
  if (isLoading) return <PageLoader />;
  return (
    <div>
      <PageHeader title="Document verification" subtitle={`${data.items.length} document(s) awaiting verification`} />
      <Card bodyClass="p-0">
        {data.items.length ? (
          <ul className="divide-y divide-slate-100">
            {data.items.map((d0: any) => (
              <li key={d0.id} className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="font-medium">{label(d0.type)} · <span className="text-slate-500">{d0.fileName}</span></p>
                  <p className="text-sm text-slate-500">
                    {d0.student ? <Link className="link" to={`/staff/students/${d0.student.id}?tab=documents`}>{d0.student.fullName} ({d0.student.studentCode})</Link> : d0.application ? <Link className="link" to={`/staff/applications/${d0.application.id}`}>Application {d0.application.code}</Link> : '—'} · uploaded {ago(d0.createdAt)} · {Math.round(d0.size / 1024)} KB
                  </p>
                </div>
                <div className="flex gap-2">
                  <button className="btn-secondary btn-sm" onClick={() => download(`/documents/${d0.id}/download`, d0.fileName, true)}><Eye className="h-4 w-4" /> View</button>
                  <button className="btn-success btn-sm" onClick={() => m.mutate({ id: d0.id, status: 'VERIFIED' })}><Check className="h-4 w-4" /> Verify</button>
                  <button className="btn-secondary btn-sm text-rose-600" onClick={() => setRej(d0.id)}><X className="h-4 w-4" /> Reject</button>
                </div>
              </li>
            ))}
          </ul>
        ) : <Empty title="All documents verified" />}
      </Card>
      <Confirm open={!!rej} onClose={() => setRej(null)} title="Reject document" tone="danger" confirmLabel="Reject" requireReason busy={m.isPending} onConfirm={(r) => m.mutate({ id: rej, status: 'REJECTED', remarks: r })} />
    </div>
  );
}
