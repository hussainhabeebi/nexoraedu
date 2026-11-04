import { useState } from 'react';
import { ChevronDown, ChevronRight, Plus, Trash2 } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useGet, useMut } from '@/lib/hooks';
import { inr } from '@/lib/format';
import { Badge, Card, Empty, Input, Modal, PageHeader, PageLoader, Select, Textarea } from '@/components/ui';

const blank = { code: '', name: '', category: 'Technology', summary: '', description: '', durationMonths: 6, eligibility: '', mode: 'Classroom', imageUrl: '', highlights: '', defaultInstallments: 1, isPublic: true, isActive: true, feeComponents: [{ name: 'Tuition fee', amount: 0, taxPercent: 18 }] };

function CourseModal({ open, onClose, course }: { open: boolean; onClose: () => void; course?: any }) {
  const [f, setF] = useState<any>(() => (course ? { ...course, highlights: course.highlights.join('\n'), feeComponents: course.feeComponents.map((x: any) => ({ name: x.name, amount: Number(x.amount), taxPercent: Number(x.taxPercent) })) } : blank));
  const m = useMut(() => {
    const body = { ...f, highlights: String(f.highlights).split('\n').map((s: string) => s.trim()).filter(Boolean), durationMonths: Number(f.durationMonths), defaultInstallments: Number(f.defaultInstallments) };
    ['id', 'slug', 'createdAt', 'updatedAt', 'subjects', 'batches', '_count', 'totalFee'].forEach((k) => delete body[k]);
    return course ? api(`/academics/courses/${course.id}`, { method: 'PATCH', body }) : api('/academics/courses', { body });
  }, { success: 'Course saved', invalidate: ['/academics', 'site'], onSuccess: onClose });
  const total = f.feeComponents.reduce((s: number, x: any) => s + Number(x.amount) * (1 + Number(x.taxPercent) / 100), 0);
  return (
    <Modal open={open} onClose={onClose} title={course ? `Edit ${course.name}` : 'New course'} size="xl" footer={<><button className="btn-secondary" onClick={onClose}>Cancel</button><button className="btn-primary" disabled={!f.code || !f.name || m.isPending} onClick={() => m.mutate(undefined)}>Save course</button></>}>
      <div className="grid gap-4 sm:grid-cols-3">
        <Input label="Code" required value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} />
        <Input className="sm:col-span-2" label="Name" required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        <Input label="Category" value={f.category ?? ''} onChange={(e) => setF({ ...f, category: e.target.value })} />
        <Input label="Duration (months)" type="number" value={f.durationMonths} onChange={(e) => setF({ ...f, durationMonths: e.target.value })} />
        <Select label="Mode" value={f.mode} onChange={(e) => setF({ ...f, mode: e.target.value })} options={['Classroom', 'Online', 'Hybrid'].map((v) => ({ value: v, label: v }))} />
        <Input className="sm:col-span-3" label="Summary" value={f.summary ?? ''} onChange={(e) => setF({ ...f, summary: e.target.value })} />
        <Textarea className="sm:col-span-3" label="Description (public website)" value={f.description ?? ''} onChange={(e) => setF({ ...f, description: e.target.value })} />
        <Textarea className="sm:col-span-2" label="Highlights (one per line)" value={f.highlights} onChange={(e) => setF({ ...f, highlights: e.target.value })} />
        <div className="space-y-4">
          <Input label="Eligibility" value={f.eligibility ?? ''} onChange={(e) => setF({ ...f, eligibility: e.target.value })} />
          <Input label="Image URL" value={f.imageUrl ?? ''} onChange={(e) => setF({ ...f, imageUrl: e.target.value })} />
        </div>
        <div className="sm:col-span-3">
          <div className="mb-2 flex items-center justify-between"><h3 className="font-semibold">Fee structure</h3><button className="btn-secondary btn-sm" onClick={() => setF({ ...f, feeComponents: [...f.feeComponents, { name: '', amount: 0, taxPercent: 0 }] })}><Plus className="h-4 w-4" /> Component</button></div>
          {f.feeComponents.map((c: any, i: number) => (
            <div key={i} className="mb-2 grid grid-cols-12 gap-2">
              <input className="input col-span-5" placeholder="Name" value={c.name} onChange={(e) => { const x = [...f.feeComponents]; x[i] = { ...c, name: e.target.value }; setF({ ...f, feeComponents: x }); }} />
              <input className="input col-span-3" type="number" placeholder="Amount" value={c.amount} onChange={(e) => { const x = [...f.feeComponents]; x[i] = { ...c, amount: e.target.value }; setF({ ...f, feeComponents: x }); }} />
              <input className="input col-span-3" type="number" placeholder="GST %" value={c.taxPercent} onChange={(e) => { const x = [...f.feeComponents]; x[i] = { ...c, taxPercent: e.target.value }; setF({ ...f, feeComponents: x }); }} />
              <button className="btn-ghost col-span-1 text-rose-600" onClick={() => setF({ ...f, feeComponents: f.feeComponents.filter((_: any, j: number) => j !== i) })} aria-label="Remove"><Trash2 className="h-4 w-4" /></button>
            </div>
          ))}
          <div className="mt-2 flex flex-wrap items-center gap-4 text-sm"><span>Total incl. tax: <b>{inr(total)}</b></span><label className="flex items-center gap-2">Default installments <input className="input w-20" type="number" min={1} value={f.defaultInstallments} onChange={(e) => setF({ ...f, defaultInstallments: e.target.value })} /></label></div>
          {course && <p className="mt-1 text-xs text-amber-700">Fee changes apply to new admissions only; existing fee plans are not changed.</p>}
        </div>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="rounded text-brand-600" checked={f.isPublic} onChange={(e) => setF({ ...f, isPublic: e.target.checked })} /> Show on public website</label>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="rounded text-brand-600" checked={f.isActive} onChange={(e) => setF({ ...f, isActive: e.target.checked })} /> Active</label>
      </div>
    </Modal>
  );
}

function Curriculum({ courseId }: { courseId: string }) {
  const { can } = useAuth();
  const { data } = useGet<any>(`/academics/courses/${courseId}`);
  const [s, setS] = useState({ code: '', name: '', hours: '' });
  const [mod, setMod] = useState<Record<string, string>>({});
  const addS = useMut(() => api(`/academics/courses/${courseId}/subjects`, { body: { code: s.code, name: s.name, hours: Number(s.hours) || 0, sequence: (data?.subjects.length ?? 0) + 1 } }), { success: 'Subject added', invalidate: ['/academics'], onSuccess: () => setS({ code: '', name: '', hours: '' }) });
  const addM = useMut((sid: string) => api(`/academics/subjects/${sid}/modules`, { body: { name: mod[sid], sequence: 99 } }), { invalidate: ['/academics'], onSuccess: () => setMod({}) });
  const toggle = useMut(({ id, completed }: any) => api(`/academics/modules/${id}`, { method: 'PATCH', body: { completed } }), { invalidate: ['/academics'] });
  if (!data) return null;
  return (
    <div className="space-y-3 border-t border-slate-100 bg-slate-50/50 p-5">
      {data.subjects.map((x: any) => (
        <div key={x.id} className="rounded-lg border border-slate-200 bg-white p-4">
          <p className="font-medium">{x.sequence}. {x.name} <span className="text-xs text-slate-500">({x.code} · {x.hours} hrs)</span></p>
          <ul className="mt-2 flex flex-wrap gap-2">
            {x.modules.map((m: any) => <li key={m.id}><button disabled={!can('academics:manage', 'attendance:mark')} onClick={() => toggle.mutate({ id: m.id, completed: !m.completed })} className={`chip ring-1 ring-inset ${m.completed ? 'bg-emerald-50 text-emerald-700 ring-emerald-200' : 'bg-slate-50 text-slate-600 ring-slate-200'}`}>{m.completed ? '✓ ' : ''}{m.name}</button></li>)}
            {can('academics:manage') && <li className="flex gap-1"><input className="input h-7 w-40 py-0 text-xs" placeholder="Add module" value={mod[x.id] ?? ''} onChange={(e) => setMod({ [x.id]: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && mod[x.id] && addM.mutate(x.id)} /></li>}
          </ul>
        </div>
      ))}
      {can('academics:manage', 'masters:manage') && (
        <div className="flex flex-wrap gap-2"><input className="input w-24" placeholder="Code" value={s.code} onChange={(e) => setS({ ...s, code: e.target.value })} /><input className="input w-56" placeholder="Subject name" value={s.name} onChange={(e) => setS({ ...s, name: e.target.value })} /><input className="input w-24" placeholder="Hours" type="number" value={s.hours} onChange={(e) => setS({ ...s, hours: e.target.value })} /><button className="btn-secondary" disabled={!s.code || !s.name} onClick={() => addS.mutate(undefined)}><Plus className="h-4 w-4" /> Subject</button></div>
      )}
    </div>
  );
}

export default function AcademicCourses() {
  const { can } = useAuth();
  const { data, isLoading } = useGet<any>('/academics/courses?all=1');
  const [edit, setEdit] = useState<any>(null);
  const [open, setOpen] = useState<string | null>(null);
  if (isLoading) return <PageLoader />;
  return (
    <div>
      <PageHeader title="Courses" subtitle="Programmes, fee structures and curriculum." actions={can('masters:manage', 'academics:manage') && <button className="btn-primary" onClick={() => setEdit('new')}><Plus className="h-4 w-4" /> New course</button>} />
      <Card bodyClass="p-0">
        {data.items.length ? data.items.map((c: any) => (
          <div key={c.id} className="border-b border-slate-100 last:border-0">
            <div className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center">
              <button className="flex flex-1 items-center gap-3 text-left" onClick={() => setOpen(open === c.id ? null : c.id)} aria-expanded={open === c.id}>
                {open === c.id ? <ChevronDown className="h-4 w-4 text-slate-400" /> : <ChevronRight className="h-4 w-4 text-slate-400" />}
                <div><p className="font-medium">{c.name} <span className="text-xs text-slate-500">{c.code}</span> {!c.isActive && <Badge status="CANCELLED">Inactive</Badge>} {!c.isPublic && <Badge>Hidden</Badge>}</p><p className="text-xs text-slate-500">{c.durationMonths} months · {c._count.subjects} subjects · {c._count.batches} batches · {c._count.students} students</p></div>
              </button>
              <span className="text-sm font-semibold">{inr(c.totalFee)}</span>
              {can('masters:manage', 'academics:manage') && <button className="btn-secondary btn-sm" onClick={() => setEdit(c)}>Edit</button>}
            </div>
            {open === c.id && <Curriculum courseId={c.id} />}
          </div>
        )) : <Empty title="No courses yet" />}
      </Card>
      {edit && <CourseModal open onClose={() => setEdit(null)} course={edit === 'new' ? undefined : edit} />}
    </div>
  );
}
