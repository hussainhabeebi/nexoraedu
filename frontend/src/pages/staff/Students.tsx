import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Download, Plus, Search } from 'lucide-react';
import { toast } from 'sonner';
import { download, qs } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useBatches, useCourses, useGet } from '@/lib/hooks';
import { d, inr } from '@/lib/format';
import { DataTable } from '@/components/DataTable';
import { Avatar, Badge, Empty, PageHeader, useDebounced } from '@/components/ui';

const ST = ['ADMITTED', 'ACTIVE', 'ON_HOLD', 'COMPLETED', 'WITHDRAWN', 'TERMINATED'];

export default function Students() {
  const { can } = useAuth();
  const nav = useNavigate();
  const [sp, setSp] = useSearchParams();
  const [q, setQ] = useState(sp.get('q') ?? '');
  const dq = useDebounced(q);
  const [sort, setSort] = useState<{ key: string; dir: 'asc' | 'desc' }>({ key: 'createdAt', dir: 'desc' });
  const courses = useCourses();
  const batches = useBatches(sp.get('courseId') ?? undefined);
  const page = Number(sp.get('page') || 1);
  const f = { q: dq, status: sp.get('status') ?? '', courseId: sp.get('courseId') ?? '', batchId: sp.get('batchId') ?? '', feeStatus: sp.get('feeStatus') ?? '', from: sp.get('from') ?? '', to: sp.get('to') ?? '' };
  const { data, isLoading } = useGet<any>(`/students${qs({ ...f, page, pageSize: 25, sort: sort.key, dir: sort.dir })}`);
  const set = (k: string, v: string) => { const n = new URLSearchParams(sp); v ? n.set(k, v) : n.delete(k); n.delete('page'); if (k === 'courseId') n.delete('batchId'); setSp(n); };
  return (
    <div>
      <PageHeader title="Students" subtitle={data ? `${data.total} student(s)` : undefined} actions={<>
        <button className="btn-secondary" onClick={() => download(`/students${qs({ ...f, format: 'csv' })}`, 'students.csv').catch((e) => toast.error(e.message))}><Download className="h-4 w-4" /> Export</button>
        {can('students:manage') && <Link to="/staff/students/new" className="btn-primary"><Plus className="h-4 w-4" /> Register student</Link>}
      </>} />
      <DataTable
        rows={data?.items ?? []} loading={isLoading} total={data?.total} page={page} pageSize={25} onPage={(p) => { const n = new URLSearchParams(sp); n.set('page', String(p)); setSp(n); }}
        sort={sort} onSort={setSort} onRowClick={(r: any) => nav(`/staff/students/${r.id}`)}
        empty={<Empty title="No students match" hint="Adjust the filters or register a student." />}
        toolbar={<>
          <div className="relative w-full sm:w-64"><Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" /><input className="input pl-9" placeholder="ID, name, phone, email" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search students" /></div>
          <select className="input w-auto" value={f.status} onChange={(e) => set('status', e.target.value)} aria-label="Status"><option value="">All statuses</option>{ST.map((s) => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}</select>
          <select className="input w-auto" value={f.courseId} onChange={(e) => set('courseId', e.target.value)} aria-label="Course"><option value="">All courses</option>{courses.data?.items.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
          <select className="input w-auto" value={f.batchId} onChange={(e) => set('batchId', e.target.value)} aria-label="Batch"><option value="">All batches</option>{batches.data?.items.map((b) => <option key={b.id} value={b.id}>{b.code}</option>)}</select>
          <select className="input w-auto" value={f.feeStatus} onChange={(e) => set('feeStatus', e.target.value)} aria-label="Fee status"><option value="">Any fee status</option><option value="due">Balance due</option><option value="clear">Fees cleared</option></select>
          <input type="date" className="input w-auto" value={f.from} onChange={(e) => set('from', e.target.value)} aria-label="Admitted from" />
          <input type="date" className="input w-auto" value={f.to} onChange={(e) => set('to', e.target.value)} aria-label="Admitted to" />
        </>}
        columns={[
          { key: 'fullName', header: 'Student', sortable: true, cell: (r: any) => <div className="flex items-center gap-3"><Avatar name={r.fullName} src={r.photoUrl} size="sm" /><div><p className="font-medium">{r.fullName}</p><p className="text-xs text-slate-500">{r.studentCode}</p></div></div> },
          { key: 'phone', header: 'Phone', hideable: true, cell: (r: any) => r.phone },
          { key: 'course', header: 'Course', hideable: true, cell: (r: any) => r.course.name },
          { key: 'batch', header: 'Batch', hideable: true, cell: (r: any) => r.batch?.code ?? '—' },
          { key: 'status', header: 'Status', sortable: true, cell: (r: any) => <Badge status={r.status} /> },
          { key: 'balance', header: 'Balance', hideable: true, cell: (r: any) => <span className={r.balance > 0 ? 'font-medium text-rose-600' : 'text-emerald-700'}>{inr(r.balance)}</span> },
          { key: 'admissionDate', header: 'Admitted', sortable: true, hideable: true, cell: (r: any) => d(r.admissionDate) },
        ]}
      />
    </div>
  );
}
