import { useState } from 'react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useGet, useMut } from '@/lib/hooks';
import { d, inr, label } from '@/lib/format';
import { Badge, Card, Confirm, Empty, PageLoader } from '@/components/ui';

/** Enrollment history (SRS 20.4, STU-10): every course/batch period, current first; cancel only for Admin. */
export default function EnrollmentHistory({ studentId }: { studentId: string }) {
  const { can } = useAuth();
  const { data, isLoading } = useGet<{ items: any[] }>(`/students/${studentId}/enrollments`);
  const [cancel, setCancel] = useState<string | null>(null);
  const cancelM = useMut((v: { id: string; reason: string }) => api(`/students/${studentId}/enrollments/${v.id}/cancel`, { body: { reason: v.reason } }), {
    success: (r: any) => (r.unpaidInstallments ? `Enrollment cancelled — ${r.unpaidInstallments} unpaid installment(s) need a Finance fee adjustment` : 'Enrollment cancelled'),
    invalidate: ['/students'],
    onSuccess: () => setCancel(null),
  });
  if (isLoading) return <PageLoader />;
  const items = data?.items ?? [];
  if (!items.length) return <Card><Empty title="No enrollments recorded" /></Card>;
  return (
    <Card title="Enrollment history" bodyClass="p-0">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
            <tr><th className="px-4 py-2">Course / batch</th><th className="px-4 py-2">Status</th><th className="px-4 py-2">From</th><th className="px-4 py-2">To</th><th className="px-4 py-2">How</th><th className="px-4 py-2">Attendance</th>{items[0]?.fees && <th className="px-4 py-2">Fees outstanding</th>}<th className="px-4 py-2" /></tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {items.map((e) => (
              <tr key={e.id} className={e.current ? 'bg-emerald-50/40' : ''}>
                <td className="px-4 py-3"><p className="font-medium">{e.course.name}</p><p className="text-xs text-slate-500">{e.batch ? `${e.batch.code} · ${e.batch.name}` : 'Batch to be allotted'}</p></td>
                <td className="px-4 py-3"><Badge status={e.current ? 'APPROVED' : e.status === 'CANCELLED' ? 'REJECTED' : 'DRAFT'}>{label(e.status)}</Badge>{e.endReason && <p className="mt-1 max-w-xs text-xs text-slate-500">{e.endReason}</p>}</td>
                <td className="px-4 py-3">{d(e.startDate)}</td>
                <td className="px-4 py-3">{e.endedAt ? d(e.endedAt) : '—'}</td>
                <td className="px-4 py-3">{label(e.source)}{e.application && <p className="text-xs text-slate-500">{e.application.code}</p>}</td>
                <td className="px-4 py-3">{e._count.attendance} session(s)</td>
                {e.fees && <td className="px-4 py-3">{e.fees.length ? e.fees.map((f: any) => <span key={f.id} className="block">{inr(f.outstanding)}</span>) : <span className="text-slate-400">No fee plan</span>}</td>}
                <td className="px-4 py-3 text-right">{e.current && can('students:manage') && <button className="btn-ghost btn-sm text-rose-600" onClick={() => setCancel(e.id)}>Cancel</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Confirm open={!!cancel} onClose={() => setCancel(null)} title="Cancel enrollment" tone="danger" confirmLabel="Cancel enrollment" requireReason busy={cancelM.isPending}
        onConfirm={(reason) => cancelM.mutate({ id: cancel!, reason })} />
    </Card>
  );
}
