import { useNavigate, useSearchParams } from 'react-router-dom';
import { useGet } from '@/lib/hooks';
import { d, label } from '@/lib/format';
import { qs } from '@/lib/api';
import { DataTable } from '@/components/DataTable';
import { Badge, cx, PageHeader } from '@/components/ui';

const ST = ['', 'SUBMITTED', 'UNDER_REVIEW', 'PENDING_APPROVAL', 'ADMITTED', 'REJECTED'];
export default function Applications() {
  const [sp, setSp] = useSearchParams();
  const nav = useNavigate();
  const status = sp.get('status') ?? '';
  const page = Number(sp.get('page') || 1);
  const { data, isLoading } = useGet<any>(`/crm/applications${qs({ status, page, pageSize: 25 })}`);
  return (
    <div>
      <PageHeader title="Applications" subtitle="Online and counselor-created applications awaiting admission." />
      <div className="mb-4 flex flex-wrap gap-2">{ST.map((s) => <button key={s} onClick={() => setSp(s ? { status: s } : {})} className={cx('chip px-3 py-1 text-sm ring-1 ring-inset', status === s ? 'bg-brand-600 text-white ring-brand-600' : 'bg-white text-slate-600 ring-slate-200')}>{s ? label(s) : 'All'}</button>)}</div>
      <DataTable rows={data?.items ?? []} loading={isLoading} total={data?.total} page={page} pageSize={25} onPage={(p) => setSp({ ...(status && { status }), page: String(p) })} onRowClick={(r: any) => nav(`/staff/applications/${r.id}`)}
        columns={[
          { key: 'code', header: 'Application', cell: (r: any) => <div><p className="font-medium">{r.data.personal.fullName}</p><p className="text-xs text-slate-500">{r.code}</p></div> },
          { key: 'course', header: 'Course', cell: (r: any) => r.courseName },
          { key: 'phone', header: 'Phone', cell: (r: any) => r.data.personal.phone },
          { key: 'source', header: 'Source', cell: (r: any) => label(r.source) },
          { key: 'owner', header: 'Counselor', cell: (r: any) => r.lead?.owner?.name ?? '—' },
          { key: 'docs', header: 'Docs', cell: (r: any) => r._count.documents },
          { key: 'status', header: 'Status', cell: (r: any) => <Badge status={r.status} /> },
          { key: 'createdAt', header: 'Submitted', cell: (r: any) => d(r.createdAt) },
        ]} />
    </div>
  );
}
