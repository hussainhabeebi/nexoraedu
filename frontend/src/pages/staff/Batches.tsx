import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useCourses, useGet, useMut } from '@/lib/hooks';
import { d, label } from '@/lib/format';
import { DataTable } from '@/components/DataTable';
import { Badge, Input, Modal, PageHeader, Progress, Select } from '@/components/ui';

export function BatchModal({ open, onClose, batch }: { open: boolean; onClose: () => void; batch?: any }) {
  const courses = useCourses();
  const [f, setF] = useState<any>(batch ? { ...batch, startDate: batch.startDate.slice(0, 10), endDate: batch.endDate?.slice(0, 10) ?? '' } : { code: '', name: '', courseId: '', startDate: '', endDate: '', timing: '', capacity: 30, mode: 'Classroom', status: 'PLANNED' });
  const m = useMut(() => {
    const body = { code: f.code, name: f.name, courseId: f.courseId, startDate: f.startDate, endDate: f.endDate || null, timing: f.timing, capacity: Number(f.capacity), mode: f.mode, status: f.status };
    return batch ? api(`/academics/batches/${batch.id}`, { method: 'PATCH', body }) : api('/academics/batches', { body });
  }, { success: 'Batch saved', invalidate: ['/academics', 'site'], onSuccess: onClose });
  return (
    <Modal open={open} onClose={onClose} title={batch ? 'Edit batch' : 'New batch'} size="lg" footer={<button className="btn-primary" disabled={!f.code || !f.courseId || !f.startDate || m.isPending} onClick={() => m.mutate(undefined)}>Save</button>}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Select label="Course" required value={f.courseId} onChange={(e) => setF({ ...f, courseId: e.target.value })} placeholder="Select" options={(courses.data?.items ?? []).map((c) => ({ value: c.id, label: c.name }))} disabled={!!batch} />
        <Input label="Batch code" required value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} placeholder="FSD-2026-12" />
        <Input className="sm:col-span-2" label="Name" required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        <Input label="Start date" type="date" required value={f.startDate} onChange={(e) => setF({ ...f, startDate: e.target.value })} />
        <Input label="End date" type="date" value={f.endDate} onChange={(e) => setF({ ...f, endDate: e.target.value })} />
        <Input label="Timing" value={f.timing ?? ''} onChange={(e) => setF({ ...f, timing: e.target.value })} placeholder="10:00 AM – 1:00 PM" />
        <Input label="Capacity" type="number" min={1} value={f.capacity} onChange={(e) => setF({ ...f, capacity: e.target.value })} />
        <Select label="Mode" value={f.mode} onChange={(e) => setF({ ...f, mode: e.target.value })} options={['Classroom', 'Online', 'Hybrid'].map((v) => ({ value: v, label: v }))} />
        <Select label="Status" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })} options={['PLANNED', 'RUNNING', 'COMPLETED', 'CANCELLED'].map((v) => ({ value: v, label: label(v) }))} />
      </div>
    </Modal>
  );
}

export default function Batches() {
  const { can } = useAuth();
  const nav = useNavigate();
  const [status, setStatus] = useState('');
  const { data, isLoading } = useGet<any>(`/academics/batches${status ? `?status=${status}` : ''}`);
  const [open, setOpen] = useState(false);
  return (
    <div>
      <PageHeader title="Batches" actions={can('academics:manage') && <button className="btn-primary" onClick={() => setOpen(true)}><Plus className="h-4 w-4" /> New batch</button>} />
      <DataTable rows={data?.items ?? []} loading={isLoading} onRowClick={(r: any) => nav(`/staff/batches/${r.id}`)}
        toolbar={<select className="input w-auto" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status"><option value="">All statuses</option>{['PLANNED', 'RUNNING', 'COMPLETED', 'CANCELLED'].map((s) => <option key={s} value={s}>{label(s)}</option>)}</select>}
        columns={[
          { key: 'code', header: 'Batch', cell: (r: any) => <div><p className="font-medium">{r.code}</p><p className="text-xs text-slate-500">{r.name}</p></div> },
          { key: 'course', header: 'Course', cell: (r: any) => r.course.name },
          { key: 'start', header: 'Starts', cell: (r: any) => d(r.startDate) },
          { key: 'timing', header: 'Timing', cell: (r: any) => r.timing ?? '—' },
          { key: 'seats', header: 'Seats', cell: (r: any) => <div className="w-32"><div className="mb-1 text-xs">{r._count.students} / {r.capacity}</div><Progress value={(r._count.students / r.capacity) * 100} tone={r._count.students >= r.capacity ? 'rose' : 'brand'} /></div> },
          { key: 'status', header: 'Status', cell: (r: any) => <Badge status={r.status} /> },
        ]} />
      {open && <BatchModal open onClose={() => setOpen(false)} />}
    </div>
  );
}
