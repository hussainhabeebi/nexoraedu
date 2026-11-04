import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useBatches, useCourses, useGet, useMut } from '@/lib/hooks';
import { dt, label, toLocalInput } from '@/lib/format';
import { DataTable } from '@/components/DataTable';
import { Badge, Input, Modal, PageHeader, Select, Textarea } from '@/components/ui';

function ExamModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const nav = useNavigate();
  const courses = useCourses();
  const [f, setF] = useState<any>({ title: '', courseId: '', batchId: '', subjectId: '', type: 'MODULE_TEST', mode: 'ONLINE', startAt: toLocalInput(new Date(Date.now() + 864e5)), endAt: toLocalInput(new Date(Date.now() + 864e5 + 3 * 3600e3)), durationMin: 60, totalMarks: 50, passMarks: 20, weightage: 100, attemptLimit: 1, shuffle: true, instructions: 'Read every question carefully.\nDo not switch tabs — tab switches are logged.\nAnswers are auto-saved; the exam auto-submits when time runs out.' });
  const batches = useBatches(f.courseId || undefined);
  const course = useGet<any>(f.courseId ? `/academics/courses/${f.courseId}` : null);
  const m = useMut(() => api('/exams/exams', { body: { ...f, batchId: f.batchId || null, subjectId: f.subjectId || null, startAt: new Date(f.startAt), endAt: new Date(f.endAt) } }), { success: 'Exam created', invalidate: ['/exams'], onSuccess: (r: any) => { onClose(); nav(`/staff/exams/${r.id}`); } });
  const s = (k: string) => (e: any) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  return (
    <Modal open={open} onClose={onClose} title="New exam" size="xl" footer={<button className="btn-primary" disabled={!f.title || !f.courseId || m.isPending} onClick={() => m.mutate(undefined)}>Create exam</button>}>
      <div className="grid gap-4 sm:grid-cols-3">
        <Input className="sm:col-span-3" label="Title" required value={f.title} onChange={s('title')} />
        <Select label="Course" required value={f.courseId} onChange={(e) => setF({ ...f, courseId: e.target.value, batchId: '', subjectId: '' })} placeholder="Select" options={(courses.data?.items ?? []).map((c) => ({ value: c.id, label: c.name }))} />
        <Select label="Batch" value={f.batchId} onChange={s('batchId')} placeholder="—" options={(batches.data?.items ?? []).map((b) => ({ value: b.id, label: b.code }))} />
        <Select label="Subject" value={f.subjectId} onChange={s('subjectId')} placeholder="—" options={(course.data?.subjects ?? []).map((x: any) => ({ value: x.id, label: x.name }))} />
        <Select label="Type" value={f.type} onChange={s('type')} options={['INTERNAL', 'MODULE_TEST', 'MID_TERM', 'FINAL', 'PRACTICAL'].map((v) => ({ value: v, label: label(v) }))} />
        <Select label="Mode" value={f.mode} onChange={s('mode')} options={[{ value: 'ONLINE', label: 'Online' }, { value: 'OFFLINE', label: 'Offline' }]} />
        <Input label="Duration (min)" type="number" value={f.durationMin} onChange={s('durationMin')} />
        <Input label="Window opens" type="datetime-local" value={f.startAt} onChange={s('startAt')} />
        <Input label="Window closes" type="datetime-local" value={f.endAt} onChange={s('endAt')} />
        <Input label="Attempts allowed" type="number" min={1} value={f.attemptLimit} onChange={s('attemptLimit')} />
        <Input label="Total marks" type="number" value={f.totalMarks} onChange={s('totalMarks')} />
        <Input label="Pass marks" type="number" value={f.passMarks} onChange={s('passMarks')} />
        <Input label="Weightage (%)" type="number" value={f.weightage} onChange={s('weightage')} />
        <Textarea className="sm:col-span-3" label="Instructions (shown before start)" rows={4} value={f.instructions} onChange={s('instructions')} />
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="rounded text-brand-600" checked={f.shuffle} onChange={s('shuffle')} /> Shuffle questions & options</label>
      </div>
    </Modal>
  );
}

export default function Exams() {
  const { can } = useAuth();
  const nav = useNavigate();
  const { data, isLoading } = useGet<any>('/exams/exams');
  const [open, setOpen] = useState(false);
  return (
    <div>
      <PageHeader title="Exams" actions={can('exams:manage') && <button className="btn-primary" onClick={() => setOpen(true)}><Plus className="h-4 w-4" /> New exam</button>} />
      <DataTable rows={data?.items ?? []} loading={isLoading} onRowClick={(r: any) => nav(`/staff/exams/${r.id}`)}
        columns={[
          { key: 'title', header: 'Exam', cell: (r: any) => <div><p className="font-medium">{r.title}</p><p className="text-xs text-slate-500">{r.code} · {label(r.type)} · {label(r.mode)}</p></div> },
          { key: 'when', header: 'Window', cell: (r: any) => dt(r.startAt) },
          { key: 'q', header: 'Questions', cell: (r: any) => r._count.questions },
          { key: 'a', header: 'Assigned', cell: (r: any) => r._count.assignments },
          { key: 'att', header: 'Attempts', cell: (r: any) => r._count.attempts },
          { key: 'status', header: 'Status', cell: (r: any) => <><Badge status={r.status} /> {r.resultsPublished && <Badge status="APPROVED">Published</Badge>}</> },
        ]} />
      {open && <ExamModal open onClose={() => setOpen(false)} />}
    </div>
  );
}
