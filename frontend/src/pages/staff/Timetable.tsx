import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { addDays, format, startOfWeek } from 'date-fns';
import { ChevronLeft, ChevronRight, ClipboardCheck, Pencil, Plus, Send, Trash2, XCircle } from 'lucide-react';
import { api, qs } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { confirmDelete, useBatches, useDelete, useGet, useMut } from '@/lib/hooks';
import { t } from '@/lib/format';
import { Badge, cx, Empty, Input, Modal, PageHeader, PageLoader, Select } from '@/components/ui';

function SessionModal({ open, onClose, batchId, session }: { open: boolean; onClose: () => void; batchId?: string; session?: any }) {
  const batches = useBatches();
  const [f, setF] = useState(() => session
    ? { batchId: session.batchId, subjectId: session.subjectId ?? '', facultyId: session.facultyId ?? '', title: session.title ?? '', date: format(new Date(session.startsAt), 'yyyy-MM-dd'), start: format(new Date(session.startsAt), 'HH:mm'), end: format(new Date(session.endsAt), 'HH:mm'), room: session.room ?? '', repeatWeeks: 1 }
    : { batchId: batchId ?? '', subjectId: '', facultyId: '', title: '', date: format(new Date(), 'yyyy-MM-dd'), start: '10:00', end: '11:30', room: '', repeatWeeks: 1 });
  // Editing changes one session (date, time, subject, faculty, room, title); the batch stays the same.
  const save = useMut(() => api(`/academics/timetable/${session.id}`, { method: 'PATCH', body: { subjectId: f.subjectId || null, facultyId: f.facultyId || null, title: f.title || null, room: f.room || null, startsAt: new Date(`${f.date}T${f.start}`), endsAt: new Date(`${f.date}T${f.end}`) } }), { success: 'Session updated', invalidate: ['/academics'], onSuccess: onClose });
  const batch = useGet<any>(f.batchId ? `/academics/batches/${f.batchId}` : null);
  const fac = useGet<any>('/academics/faculty');
  const m = useMut(() => api('/academics/timetable', { body: { batchId: f.batchId, subjectId: f.subjectId || null, facultyId: f.facultyId || null, title: f.title || null, room: f.room || null, startsAt: new Date(`${f.date}T${f.start}`), endsAt: new Date(`${f.date}T${f.end}`), repeatWeeks: Number(f.repeatWeeks) } }), { success: (r: any) => `${r.items.length} session(s) created`, invalidate: ['/academics'], onSuccess: onClose });
  return (
    <Modal open={open} onClose={onClose} title={session ? 'Edit session' : 'Schedule session'} size="lg" footer={session
      ? <button className="btn-primary" disabled={save.isPending} onClick={() => save.mutate(undefined)}>Save</button>
      : <button className="btn-primary" disabled={!f.batchId || m.isPending} onClick={() => m.mutate(undefined)}>Create</button>}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Select label="Batch" required disabled={!!session} value={f.batchId} onChange={(e) => setF({ ...f, batchId: e.target.value, subjectId: '' })} placeholder="Select" options={(batches.data?.items ?? []).filter((b) => ['PLANNED', 'RUNNING'].includes(b.status)).map((b) => ({ value: b.id, label: b.code }))} />
        <Select label="Subject" value={f.subjectId} onChange={(e) => setF({ ...f, subjectId: e.target.value })} placeholder="—" options={(batch.data?.course.subjects ?? []).map((s: any) => ({ value: s.id, label: s.name }))} />
        <Select label="Faculty" value={f.facultyId} onChange={(e) => setF({ ...f, facultyId: e.target.value })} placeholder="—" options={(fac.data?.items ?? []).map((x: any) => ({ value: x.id, label: `${x.name} (${x.sessionsThisWeek} this week)` }))} />
        <Input label="Title" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="e.g. React hooks lab" />
        <Input label="Date" type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} />
        <div className="grid grid-cols-2 gap-2"><Input label="Start" type="time" value={f.start} onChange={(e) => setF({ ...f, start: e.target.value })} /><Input label="End" type="time" value={f.end} onChange={(e) => setF({ ...f, end: e.target.value })} /></div>
        <Input label="Room" value={f.room} onChange={(e) => setF({ ...f, room: e.target.value })} />
        {!session && <Input label="Repeat weekly for (weeks)" type="number" min={1} max={52} value={f.repeatWeeks} onChange={(e) => setF({ ...f, repeatWeeks: Number(e.target.value) })} />}
      </div>
      <p className="mt-3 text-xs text-slate-500">Clashes for the same batch, faculty or room are blocked automatically.</p>
    </Modal>
  );
}

export default function Timetable() {
  const { can } = useAuth();
  const [sp, setSp] = useSearchParams();
  const [week, setWeek] = useState(() => startOfWeek(new Date(), { weekStartsOn: 1 }));
  const batchId = sp.get('batchId') ?? '';
  const mine = !can('academics:manage') && can('attendance:mark');
  const batches = useBatches();
  const { data, isLoading } = useGet<any>(`/academics/timetable${qs({ from: week.toISOString(), to: addDays(week, 7).toISOString(), batchId, mine: mine ? 'true' : undefined })}`);
  const [open, setOpen] = useState(false);
  const publish = useMut(() => api('/academics/timetable/publish', { body: { batchId, from: week, to: addDays(week, 7) } }), { success: (r: any) => `${r.published} session(s) published — students notified`, invalidate: ['/academics'] });
  const cancel = useMut((id: string) => api(`/academics/timetable/${id}`, { method: 'PATCH', body: { cancelled: true } }), { success: 'Session cancelled', invalidate: ['/academics'] });
  const del = useDelete('Session', ['/academics']);
  const [editing, setEditing] = useState<any>(null);
  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(week, i)), [week]);
  const unpublished = (data?.items ?? []).filter((s: any) => !s.published && !s.cancelled).length;

  return (
    <div>
      <PageHeader title="Timetable & attendance" subtitle={mine ? 'Your sessions. Open a session to mark attendance.' : 'Plan sessions, publish to students and track attendance.'} actions={<>
        {can('academics:manage') && batchId && unpublished > 0 && <button className="btn-secondary" disabled={publish.isPending} onClick={() => publish.mutate(undefined)}><Send className="h-4 w-4" /> Publish week ({unpublished})</button>}
        {can('academics:manage') && <button className="btn-primary" onClick={() => setOpen(true)}><Plus className="h-4 w-4" /> Schedule</button>}
      </>} />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1 rounded-lg border border-slate-200 bg-white p-1">
          <button className="btn-ghost btn-sm" onClick={() => setWeek(addDays(week, -7))} aria-label="Previous week"><ChevronLeft className="h-4 w-4" /></button>
          <span className="px-2 text-sm font-medium">{format(week, 'dd MMM')} – {format(addDays(week, 6), 'dd MMM yyyy')}</span>
          <button className="btn-ghost btn-sm" onClick={() => setWeek(addDays(week, 7))} aria-label="Next week"><ChevronRight className="h-4 w-4" /></button>
        </div>
        <button className="btn-ghost btn-sm" onClick={() => setWeek(startOfWeek(new Date(), { weekStartsOn: 1 }))}>This week</button>
        {!mine && <select className="input w-auto" value={batchId} onChange={(e) => setSp(e.target.value ? { batchId: e.target.value } : {})} aria-label="Batch"><option value="">All batches</option>{batches.data?.items.map((b) => <option key={b.id} value={b.id}>{b.code}</option>)}</select>}
      </div>
      {isLoading ? <PageLoader /> : (
        <div className="grid gap-3 md:grid-cols-7">
          {days.map((day) => {
            const items = (data?.items ?? []).filter((s: any) => new Date(s.startsAt).toDateString() === day.toDateString());
            const today = day.toDateString() === new Date().toDateString();
            return (
              <div key={day.toISOString()} className={cx('min-h-[140px] rounded-xl border bg-white p-2', today ? 'border-brand-300 ring-2 ring-brand-100' : 'border-slate-200')}>
                <p className={cx('mb-2 px-1 text-xs font-semibold uppercase', today ? 'text-brand-700' : 'text-slate-500')}>{format(day, 'EEE dd')}</p>
                <div className="space-y-2">
                  {items.map((s: any) => (
                    <div key={s.id} className={cx('rounded-lg border p-2 text-xs', s.cancelled ? 'border-slate-200 bg-slate-50 text-slate-400 line-through' : s.published ? 'border-brand-200 bg-brand-50' : 'border-dashed border-amber-300 bg-amber-50')}>
                      <p className="font-semibold text-slate-800">{t(s.startsAt)}–{t(s.endsAt)}</p>
                      <p className="truncate">{s.title ?? s.subjectName ?? 'Session'}</p>
                      <p className="truncate text-slate-500">{s.batch.code}{s.facultyName && ` · ${s.facultyName}`}{s.room && ` · ${s.room}`}</p>
                      {!s.published && !s.cancelled && <Badge status="DRAFT" className="mt-1">Draft</Badge>}
                      {!s.cancelled && (
                        <div className="mt-1.5 flex gap-1">
                          {can('attendance:mark') && new Date(s.startsAt) <= new Date(Date.now() + 15 * 60_000) && <Link to={`/staff/attendance/${s.id}`} className="inline-flex items-center gap-1 rounded bg-white px-1.5 py-0.5 font-medium text-brand-700 ring-1 ring-brand-200"><ClipboardCheck className="h-3 w-3" />{s._count.attendance ? 'Edit' : 'Mark'}</Link>}
                          {can('academics:manage') && <button onClick={() => confirm('Cancel this session? Students will be notified if published.') && cancel.mutate(s.id)} className="rounded px-1 text-rose-600 hover:bg-rose-50" aria-label="Cancel session"><XCircle className="h-3.5 w-3.5" /></button>}
                          {can('academics:manage') && <button onClick={() => setEditing(s)} className="rounded px-1 text-slate-600 hover:bg-slate-100" aria-label="Edit session"><Pencil className="h-3.5 w-3.5" /></button>}
                          {can('academics:manage') && <button onClick={() => confirmDelete('this session') && del.mutate(`/academics/timetable/${s.id}`)} className="rounded px-1 text-rose-600 hover:bg-rose-50" aria-label="Delete session"><Trash2 className="h-3.5 w-3.5" /></button>}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
      {data && !data.items.length && <Empty title="No sessions this week" hint={can('academics:manage') ? 'Use “Schedule” to add sessions.' : undefined} />}
      {open && <SessionModal open onClose={() => setOpen(false)} batchId={batchId} />}
      {editing && <SessionModal open onClose={() => setEditing(null)} session={editing} />}
    </div>
  );
}
