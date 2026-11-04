import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { useGet, useMut } from '@/lib/hooks';
import { dt } from '@/lib/format';
import { Avatar, cx, Empty, PageHeader, PageLoader, Spinner } from '@/components/ui';

const OPTS = [['PRESENT', 'P', 'bg-emerald-500'], ['ABSENT', 'A', 'bg-rose-500'], ['LATE', 'L', 'bg-amber-500'], ['EXCUSED', 'E', 'bg-slate-500']] as const;

export default function Attendance() {
  const { sessionId } = useParams();
  const { data, isLoading } = useGet<any>(`/academics/sessions/${sessionId}/attendance`);
  const [rec, setRec] = useState<Record<string, string>>({});
  useEffect(() => { if (data) setRec(Object.fromEntries(data.students.map((s: any) => [s.id, s.status ?? 'PRESENT']))); }, [data]);
  const m = useMut(() => api(`/academics/sessions/${sessionId}/attendance`, { body: { records: Object.entries(rec).map(([studentId, status]) => ({ studentId, status })) } }), { invalidate: ['/academics', '/dashboard'], onSuccess: (r: any) => toast.success(r.message ?? `Attendance saved for ${r.saved} students`) });
  if (isLoading) return <PageLoader />;
  const counts = OPTS.map(([k]) => Object.values(rec).filter((v) => v === k).length);
  return (
    <div>
      <Link to="/staff/timetable" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800"><ArrowLeft className="h-4 w-4" /> Timetable</Link>
      <PageHeader title={`Attendance — ${data.session.batch.code}`} subtitle={`${data.session.title ?? 'Session'} · ${dt(data.session.startsAt)}`} actions={<>
        <button className="btn-secondary" onClick={() => setRec(Object.fromEntries(data.students.map((s: any) => [s.id, 'PRESENT'])))}>All present</button>
        <button className="btn-primary" disabled={m.isPending || !data.students.length} onClick={() => m.mutate(undefined)}>{m.isPending && <Spinner className="h-4 w-4 text-white" />} Save attendance</button>
      </>} />
      <p className="mb-4 text-sm text-slate-600">Present {counts[0]} · Absent {counts[1]} · Late {counts[2]} · Excused {counts[3]}</p>
      <div className="card divide-y divide-slate-100">
        {data.students.length ? data.students.map((s: any) => (
          <div key={s.id} className="flex items-center justify-between gap-3 px-4 py-3">
            <div className="flex items-center gap-3"><Avatar name={s.fullName} src={s.photoUrl} size="sm" /><div><p className="font-medium">{s.fullName}</p><p className="text-xs text-slate-500">{s.studentCode}</p></div></div>
            <div className="flex gap-1" role="radiogroup" aria-label={`Attendance for ${s.fullName}`}>
              {OPTS.map(([k, l, c]) => (
                <button key={k} role="radio" aria-checked={rec[s.id] === k} title={k} onClick={() => setRec({ ...rec, [s.id]: k })} className={cx('h-10 w-10 rounded-lg text-sm font-bold transition', rec[s.id] === k ? `${c} text-white` : 'bg-slate-100 text-slate-500 hover:bg-slate-200')}>{l}</button>
              ))}
            </div>
          </div>
        )) : <Empty title="No students in this batch" />}
      </div>
      <p className="mt-3 text-xs text-slate-500">Edits after the permitted window are sent to the Academic Manager for approval.</p>
    </div>
  );
}
