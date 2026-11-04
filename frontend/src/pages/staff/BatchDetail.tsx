import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, MessageCircle, Plus, Trash2 } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useGet, useMut } from '@/lib/hooks';
import { d } from '@/lib/format';
import { BatchModal } from './Batches';
import { BulkWhatsAppModal } from './Leads';
import { Badge, Card, Empty, KV, PageHeader, PageLoader, Progress, Select } from '@/components/ui';

export default function BatchDetail() {
  const { id } = useParams();
  const { can } = useAuth();
  const { data: b, isLoading } = useGet<any>(`/academics/batches/${id}`);
  const att = useGet<any>(`/academics/batches/${id}/attendance-summary`);
  const fac = useGet<any>(can('academics:read') ? '/academics/faculty' : null);
  const [edit, setEdit] = useState(false);
  const [wa, setWa] = useState(false);
  const [al, setAl] = useState({ subjectId: '', facultyId: '' });
  const add = useMut(() => api(`/academics/batches/${id}/allocations`, { body: al }), { success: 'Faculty allocated', invalidate: ['/academics'], onSuccess: () => setAl({ subjectId: '', facultyId: '' }) });
  const del = useMut((aid: string) => api(`/academics/allocations/${aid}`, { method: 'DELETE' }), { invalidate: ['/academics'] });
  if (isLoading) return <PageLoader />;
  const subj = Object.fromEntries(b.course.subjects.map((s: any) => [s.id, s.name]));
  const facN = Object.fromEntries(b.faculty.map((f: any) => [f.id, f.name]));
  const pct = Object.fromEntries((att.data?.items ?? []).map((x: any) => [x.id, x]));
  const modules = b.course.subjects.flatMap((s: any) => s.modules);
  const done = modules.filter((m: any) => m.completed).length;
  return (
    <div className="space-y-6">
      <Link to="/staff/batches" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800"><ArrowLeft className="h-4 w-4" /> Batches</Link>
      <PageHeader title={<span className="flex items-center gap-3">{b.code} <Badge status={b.status} /></span>} subtitle={`${b.name} · ${b.course.name}`} actions={<>
        {can('whatsapp:send') && <button className="btn-success" onClick={() => setWa(true)}><MessageCircle className="h-4 w-4" /> WhatsApp batch</button>}
        <Link to={`/staff/timetable?batchId=${b.id}`} className="btn-secondary">Timetable</Link>
        {can('academics:manage') && <button className="btn-secondary" onClick={() => setEdit(true)}>Edit</button>}
      </>} />
      <div className="grid gap-6 lg:grid-cols-3">
        <Card title="Details"><KV cols={1} items={[['Dates', `${d(b.startDate)} – ${d(b.endDate)}`], ['Timing', b.timing], ['Mode', b.mode], ['Seats', `${b.students.length} / ${b.capacity}`]]} /></Card>
        <Card title="Course progress"><p className="text-3xl font-bold">{modules.length ? Math.round((done / modules.length) * 100) : 0}%</p><Progress value={modules.length ? (done / modules.length) * 100 : 0} tone="green" /><p className="mt-1 text-sm text-slate-500">{done} of {modules.length} modules completed</p></Card>
        <Card title="Faculty allocation" bodyClass="p-0">
          <ul className="divide-y divide-slate-100">{b.allocations.map((a: any) => <li key={a.id} className="flex items-center justify-between px-5 py-2.5 text-sm"><span>{subj[a.subjectId]} — <b>{facN[a.facultyId]}</b></span>{can('academics:manage') && <button className="btn-ghost btn-sm text-rose-600" onClick={() => del.mutate(a.id)} aria-label="Remove"><Trash2 className="h-4 w-4" /></button>}</li>)}</ul>
          {can('academics:manage') && <div className="flex gap-2 border-t border-slate-100 p-3"><Select className="flex-1" value={al.subjectId} onChange={(e) => setAl({ ...al, subjectId: e.target.value })} placeholder="Subject" options={b.course.subjects.map((s: any) => ({ value: s.id, label: s.name }))} /><Select className="flex-1" value={al.facultyId} onChange={(e) => setAl({ ...al, facultyId: e.target.value })} placeholder="Faculty" options={(fac.data?.items ?? []).map((f: any) => ({ value: f.id, label: f.name }))} /><button className="btn-secondary" disabled={!al.subjectId || !al.facultyId} onClick={() => add.mutate(undefined)} aria-label="Add"><Plus className="h-4 w-4" /></button></div>}
        </Card>
      </div>
      <Card title={`Students (${b.students.length})`} bodyClass="p-0">
        {b.students.length ? (
          <table className="min-w-full divide-y divide-slate-100">
            <thead className="bg-slate-50"><tr><th className="th">Student</th><th className="th">Phone</th><th className="th">Status</th><th className="th">Attendance</th></tr></thead>
            <tbody className="divide-y divide-slate-100">{b.students.map((s: any) => { const a = pct[s.id]; return (
              <tr key={s.id}><td className="td"><Link className="link" to={`/staff/students/${s.id}`}>{s.fullName}</Link> <span className="text-xs text-slate-500">{s.studentCode}</span></td><td className="td">{s.phone}</td><td className="td"><Badge status={s.status} /></td>
                <td className="td">{a?.percentage != null ? <div className="flex w-40 items-center gap-2"><Progress value={a.percentage} tone={a.belowThreshold ? 'rose' : 'green'} /><span className={`text-xs ${a.belowThreshold ? 'font-semibold text-rose-600' : ''}`}>{a.percentage}%</span></div> : '—'}</td></tr>); })}</tbody>
          </table>
        ) : <Empty title="No students in this batch yet" />}
      </Card>
      {edit && <BatchModal open onClose={() => setEdit(false)} batch={b} />}
      <BulkWhatsAppModal open={wa} onClose={() => setWa(false)} batchId={b.id} />
    </div>
  );
}
