import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, CalendarPlus, CheckCircle2, FileText, GitMerge, Mail, MessageCircle, MessagesSquare, Phone, PhoneCall, StickyNote, UserCog, Users } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useCourses, useGet, useMasters, useMut, useStaff } from '@/lib/hooks';
import { ago, d, dt, label, toLocalInput } from '@/lib/format';
import ApplicationForm, { emptyApp, toPayload } from '@/components/ApplicationForm';
import WaChat from '@/components/WaChat';
import { Badge, Card, cx, Empty, Input, KV, Modal, PageLoader, Select, Spinner, Tabs, Textarea } from '@/components/ui';

const STAGES = ['NEW', 'CONTACTED', 'INTERESTED', 'COUNSELLED', 'APPLICATION', 'ADMITTED'];
const ICON: Record<string, any> = { CALL: PhoneCall, EMAIL: Mail, SMS: MessagesSquare, WHATSAPP: MessageCircle, MEETING: Users, NOTE: StickyNote, STATUS: CheckCircle2, ASSIGNMENT: UserCog, SYSTEM: FileText };

export default function LeadDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const { can } = useAuth();
  const { data: lead, isLoading, error } = useGet<any>(`/crm/leads/${id}`);
  const lost = useMasters('lost_reason');
  const courses = useCourses();
  const staff = useStaff('counselor');
  const [tab, setTab] = useState<'timeline' | 'whatsapp' | 'followups' | 'counselling'>('timeline');
  const [modal, setModal] = useState<'' | 'log' | 'follow' | 'counsel' | 'close' | 'apply' | 'assign' | 'edit' | 'merge'>('');
  const inv = ['/crm', '/dashboard'];
  const statusM = useMut((b: { status: string; reason?: string }) => api(`/crm/leads/${id}/status`, { body: b }), { success: 'Status updated', invalidate: inv, onSuccess: () => setModal('') });

  if (isLoading) return <PageLoader />;
  if (error) return <Empty title="Lead not found" hint={(error as Error).message} action={<Link to="/staff/leads" className="btn-secondary">Back to leads</Link>} />;
  const closed = ['ADMITTED', 'LOST', 'JUNK', 'NOT_INTERESTED'].includes(lead.status);
  const stageIdx = STAGES.indexOf(lead.status);
  const pendingFU = lead.followUps.filter((f: any) => f.status === 'PENDING');

  return (
    <div className="space-y-6">
      <Link to="/staff/leads" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800"><ArrowLeft className="h-4 w-4" /> Leads</Link>
      <div className="card p-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <div className="flex flex-wrap items-center gap-2"><h1 className="text-2xl font-bold">{lead.name}</h1><Badge status={lead.status} /></div>
            <p className="mt-1 text-sm text-slate-500">{lead.code} · {label(lead.source)} · created {ago(lead.createdAt)} · owner <b className="text-slate-700">{lead.owner?.name ?? 'Unassigned'}</b></p>
            <div className="mt-3 flex flex-wrap gap-2">
              <a href={`tel:${lead.phone}`} className="btn-secondary btn-sm"><Phone className="h-4 w-4" /> {lead.phone}</a>
              {lead.email && <a href={`mailto:${lead.email}`} className="btn-secondary btn-sm"><Mail className="h-4 w-4" /> {lead.email}</a>}
              {can('whatsapp:send') && <button className="btn-success btn-sm" onClick={() => setTab('whatsapp')}><MessageCircle className="h-4 w-4" /> WhatsApp</button>}
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {can('leads:update') && !closed && <>
              <button className="btn-secondary" onClick={() => setModal('log')}><PhoneCall className="h-4 w-4" /> Log activity</button>
              <button className="btn-secondary" onClick={() => setModal('follow')}><CalendarPlus className="h-4 w-4" /> Follow-up</button>
              <button className="btn-secondary" onClick={() => setModal('counsel')}><Users className="h-4 w-4" /> Counselling</button>
              {lead.status !== 'APPLICATION' && <button className="btn-primary" onClick={() => setModal('apply')}><FileText className="h-4 w-4" /> Convert to application</button>}
            </>}
            {lead.student && <Link to={`/staff/students/${lead.student.id}`} className="btn-success">Student {lead.student.studentCode}</Link>}
          </div>
        </div>
        {/* Pipeline (CRM-07) */}
        <ol className="mt-6 grid grid-cols-3 gap-2 sm:grid-cols-6">
          {STAGES.map((s, i) => (
            <li key={s}>
              <button disabled={closed || !can('leads:update') || s === 'ADMITTED' || s === 'APPLICATION'} onClick={() => statusM.mutate({ status: s })} className={cx('w-full rounded-lg px-2 py-2 text-xs font-semibold transition disabled:cursor-default', i <= stageIdx && stageIdx >= 0 ? 'bg-brand-600 text-white' : 'bg-slate-100 text-slate-500 hover:bg-slate-200 disabled:hover:bg-slate-100')}>{label(s)}</button>
            </li>
          ))}
        </ol>
        {lead.closeReason && <p className="mt-3 text-sm text-slate-600">Closed: {lead.closeReason}</p>}
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Tabs value={tab} onChange={setTab} tabs={[{ key: 'timeline', label: 'Timeline', count: lead.activities.length }, ...(can('whatsapp:send') ? [{ key: 'whatsapp' as const, label: 'WhatsApp' }] : []), { key: 'followups', label: 'Follow-ups', count: pendingFU.length }, { key: 'counselling', label: 'Counselling', count: lead.counselling.length }]} />
          {tab === 'timeline' && (
            <Card bodyClass="p-0">
              {lead.activities.length ? (
                <ol className="relative space-y-0">
                  {lead.activities.map((a: any) => {
                    const I = ICON[a.type] ?? FileText;
                    return (
                      <li key={a.id} className="flex gap-3 border-b border-slate-100 px-5 py-4 last:border-0">
                        <div className={cx('mt-0.5 rounded-full p-2', a.type === 'WHATSAPP' ? 'bg-emerald-50 text-emerald-600' : 'bg-slate-100 text-slate-500')}><I className="h-4 w-4" /></div>
                        <div className="min-w-0 flex-1">
                          <p className="text-sm"><b>{label(a.type)}</b>{a.direction && <span className="text-slate-500"> · {label(a.direction)}</span>}{a.outcome && <span className="text-slate-500"> · {a.outcome}</span>}</p>
                          {a.content && <p className="mt-0.5 whitespace-pre-wrap text-sm text-slate-700">{a.content}</p>}
                          {a.nextStep && <p className="mt-0.5 text-xs text-slate-500">Next: {a.nextStep}</p>}
                          <p className="mt-1 text-xs text-slate-400">{dt(a.createdAt)} · {a.userId ? lead.userNames[a.userId] ?? 'Staff' : 'System'}</p>
                        </div>
                      </li>
                    );
                  })}
                </ol>
              ) : <Empty title="No activity yet" />}
            </Card>
          )}
          {tab === 'whatsapp' && <div className="card overflow-hidden"><WaChat name={lead.name} messagesPath={`/whatsapp/leads/${lead.id}/messages`} sendPath={`/whatsapp/leads/${lead.id}/send`} /></div>}
          {tab === 'followups' && <FollowUpList lead={lead} />}
          {tab === 'counselling' && (
            <Card bodyClass="p-0">
              {lead.counselling.length ? <ul className="divide-y divide-slate-100">{lead.counselling.map((c: any) => <li key={c.id} className="px-5 py-4 text-sm"><p className="font-medium">{d(c.date)} · {lead.userNames[c.counselorId]}</p>{c.courseAdvised && <p>Course advised: {c.courseAdvised}</p>}{c.remarks && <p className="text-slate-600">{c.remarks}</p>}{c.outcome && <p className="text-slate-500">Outcome: {c.outcome}</p>}</li>)}</ul> : <Empty title="No counselling sessions" />}
            </Card>
          )}
        </div>
        <div className="space-y-6">
          <Card title="Details" actions={can('leads:update') && <button className="text-sm link" onClick={() => setModal('edit')}>Edit</button>}>
            <KV cols={1} items={[['Course interest', lead.course?.name], ['City', lead.city], ['Next follow-up', lead.nextFollowUpAt ? dt(lead.nextFollowUpAt) : '—'], ['Last activity', ago(lead.lastActivityAt)], ['Notes', lead.notes && <span className="whitespace-pre-wrap">{lead.notes}</span>]]} />
          </Card>
          {!!lead.applications.length && (
            <Card title="Applications" bodyClass="p-0">
              <ul className="divide-y divide-slate-100">{lead.applications.map((a: any) => <li key={a.id}><Link to={`/staff/applications/${a.id}`} className="flex justify-between px-5 py-3 text-sm hover:bg-slate-50"><span className="font-medium">{a.code}</span><Badge status={a.status} /></Link></li>)}</ul>
            </Card>
          )}
          <Card title="Actions">
            <div className="grid gap-2">
              {can('leads:assign') && <button className="btn-secondary justify-start" onClick={() => setModal('assign')}><UserCog className="h-4 w-4" /> Reassign</button>}
              {can('leads:delete') && <button className="btn-secondary justify-start" onClick={() => setModal('merge')}><GitMerge className="h-4 w-4" /> Merge duplicate</button>}
              {can('leads:update') && !closed && <button className="btn-secondary justify-start text-rose-600" onClick={() => setModal('close')}>Close lead (lost / junk)</button>}
              {can('leads:update') && ['LOST', 'NOT_INTERESTED', 'JUNK'].includes(lead.status) && <button className="btn-secondary justify-start" onClick={() => statusM.mutate({ status: 'CONTACTED' })}>Re-open lead</button>}
            </div>
          </Card>
        </div>
      </div>

      <LogModal open={modal === 'log'} onClose={() => setModal('')} id={lead.id} />
      <FollowModal open={modal === 'follow'} onClose={() => setModal('')} id={lead.id} />
      <CounselModal open={modal === 'counsel'} onClose={() => setModal('')} id={lead.id} courses={courses.data?.items ?? []} />
      <CloseModal open={modal === 'close'} onClose={() => setModal('')} reasons={lost.data?.items ?? []} onSubmit={(status, reason) => statusM.mutate({ status, reason })} busy={statusM.isPending} />
      <AssignOne open={modal === 'assign'} onClose={() => setModal('')} id={lead.id} staff={staff.data?.items ?? []} />
      <EditLead open={modal === 'edit'} onClose={() => setModal('')} lead={lead} courses={courses.data?.items ?? []} />
      <MergeModal open={modal === 'merge'} onClose={() => setModal('')} id={lead.id} />
      <Modal open={modal === 'apply'} onClose={() => setModal('')} title="Convert to application" size="xl">
        <ApplicationForm
          mode="staff"
          submitLabel="Create application"
          initial={emptyApp({ fullName: lead.name, phone: lead.phone, email: lead.email ?? '', city: lead.city ?? '' }, lead.courseId ?? '')}
          onSubmit={async (a) => {
            const app = await api(`/crm/leads/${lead.id}/application`, { body: toPayload(a) });
            nav(`/staff/applications/${app.id}`);
          }}
        />
      </Modal>
    </div>
  );
}

function FollowUpList({ lead }: { lead: any }) {
  const [done, setDone] = useState<any>(null);
  const [f, setF] = useState({ outcome: '', note: '' });
  const m = useMut(() => api(`/crm/follow-ups/${done.id}/complete`, { body: f }), { success: 'Follow-up completed', invalidate: ['/crm', '/dashboard'], onSuccess: () => setDone(null) });
  return (
    <Card bodyClass="p-0">
      {lead.followUps.length ? (
        <ul className="divide-y divide-slate-100">
          {lead.followUps.map((x: any) => (
            <li key={x.id} className="flex items-center justify-between gap-3 px-5 py-3 text-sm">
              <div><p className={cx('font-medium', x.status === 'PENDING' && new Date(x.dueAt) < new Date() && 'text-rose-600')}>{dt(x.dueAt)} · {label(x.mode)}</p>{x.note && <p className="text-slate-500">{x.note}</p>}</div>
              {x.status === 'PENDING' ? <button className="btn-secondary btn-sm" onClick={() => { setDone(x); setF({ outcome: '', note: '' }); }}>Mark done</button> : <Badge status={x.status === 'DONE' ? 'APPROVED' : 'CANCELLED'}>{label(x.status)}</Badge>}
            </li>
          ))}
        </ul>
      ) : <Empty title="No follow-ups scheduled" />}
      <Modal open={!!done} onClose={() => setDone(null)} title="Complete follow-up" size="sm" footer={<button className="btn-primary" disabled={!f.outcome || m.isPending} onClick={() => m.mutate(undefined)}>Save</button>}>
        <div className="space-y-3">
          <Select label="Outcome" required value={f.outcome} onChange={(e) => setF({ ...f, outcome: e.target.value })} placeholder="Select" options={['Connected – interested', 'Connected – needs time', 'Call back later', 'No answer', 'Switched off', 'Visited centre'].map((v) => ({ value: v, label: v }))} />
          <Textarea label="Notes" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />
        </div>
      </Modal>
    </Card>
  );
}

function LogModal({ open, onClose, id }: { open: boolean; onClose: () => void; id: string }) {
  const [f, setF] = useState({ type: 'CALL', direction: 'OUTBOUND', content: '', outcome: '', nextStep: '' });
  const m = useMut(() => api(`/crm/leads/${id}/activities`, { body: f }), { success: 'Activity logged', invalidate: ['/crm'], onSuccess: () => { onClose(); setF({ ...f, content: '', outcome: '', nextStep: '' }); } });
  return (
    <Modal open={open} onClose={onClose} title="Log activity" footer={<button className="btn-primary" disabled={!f.content || m.isPending} onClick={() => m.mutate(undefined)}>Save</button>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Select label="Type" value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })} options={['CALL', 'WHATSAPP', 'EMAIL', 'SMS', 'MEETING', 'NOTE'].map((v) => ({ value: v, label: label(v) }))} />
        <Select label="Direction" value={f.direction} onChange={(e) => setF({ ...f, direction: e.target.value })} options={[{ value: 'OUTBOUND', label: 'Outbound' }, { value: 'INBOUND', label: 'Inbound' }]} />
        <Textarea className="sm:col-span-2" label="Summary" required value={f.content} onChange={(e) => setF({ ...f, content: e.target.value })} />
        <Input label="Outcome" value={f.outcome} onChange={(e) => setF({ ...f, outcome: e.target.value })} />
        <Input label="Next step" value={f.nextStep} onChange={(e) => setF({ ...f, nextStep: e.target.value })} />
      </div>
      <p className="mt-3 text-xs text-slate-500">Activity history is read-only once saved.</p>
    </Modal>
  );
}

function FollowModal({ open, onClose, id }: { open: boolean; onClose: () => void; id: string }) {
  const [f, setF] = useState({ dueAt: toLocalInput(new Date(Date.now() + 864e5)), mode: 'CALL', note: '' });
  const m = useMut(() => api(`/crm/leads/${id}/follow-ups`, { body: { ...f, dueAt: new Date(f.dueAt).toISOString() } }), { success: 'Follow-up scheduled', invalidate: ['/crm', '/dashboard'], onSuccess: onClose });
  return (
    <Modal open={open} onClose={onClose} title="Schedule follow-up" size="sm" footer={<button className="btn-primary" disabled={m.isPending} onClick={() => m.mutate(undefined)}>Schedule</button>}>
      <div className="space-y-3">
        <Input label="Date & time" type="datetime-local" required value={f.dueAt} onChange={(e) => setF({ ...f, dueAt: e.target.value })} />
        <Select label="Mode" value={f.mode} onChange={(e) => setF({ ...f, mode: e.target.value })} options={['CALL', 'WHATSAPP', 'EMAIL', 'MEETING', 'VISIT'].map((v) => ({ value: v, label: label(v) }))} />
        <Textarea label="Note" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />
      </div>
    </Modal>
  );
}

function CounselModal({ open, onClose, id, courses }: { open: boolean; onClose: () => void; id: string; courses: any[] }) {
  const [f, setF] = useState({ courseAdvised: '', remarks: '', outcome: '' });
  const m = useMut(() => api(`/crm/leads/${id}/counselling`, { body: f }), { success: 'Counselling recorded', invalidate: ['/crm'], onSuccess: onClose });
  return (
    <Modal open={open} onClose={onClose} title="Record counselling session" footer={<button className="btn-primary" disabled={m.isPending} onClick={() => m.mutate(undefined)}>Save</button>}>
      <div className="space-y-3">
        <Select label="Course advised" value={f.courseAdvised} onChange={(e) => setF({ ...f, courseAdvised: e.target.value })} placeholder="—" options={courses.map((c) => ({ value: c.name, label: c.name }))} />
        <Textarea label="Remarks" value={f.remarks} onChange={(e) => setF({ ...f, remarks: e.target.value })} />
        <Select label="Outcome" value={f.outcome} onChange={(e) => setF({ ...f, outcome: e.target.value })} placeholder="—" options={['Ready to apply', 'Needs family discussion', 'Comparing institutes', 'Fee concern', 'Not suitable'].map((v) => ({ value: v, label: v }))} />
      </div>
    </Modal>
  );
}

function CloseModal({ open, onClose, reasons, onSubmit, busy }: { open: boolean; onClose: () => void; reasons: any[]; onSubmit: (s: string, r: string) => void; busy: boolean }) {
  const [s, setS] = useState('LOST');
  const [r, setR] = useState('');
  return (
    <Modal open={open} onClose={onClose} title="Close lead" size="sm" footer={<button className="btn-danger" disabled={!r || busy} onClick={() => onSubmit(s, r)}>Close lead</button>}>
      <div className="space-y-3">
        <Select label="Close as" value={s} onChange={(e) => setS(e.target.value)} options={[{ value: 'LOST', label: 'Lost' }, { value: 'NOT_INTERESTED', label: 'Not interested' }, { value: 'JUNK', label: 'Junk / invalid' }]} />
        <Select label="Reason" required value={r} onChange={(e) => setR(e.target.value)} placeholder="Select a reason" options={reasons.map((x) => ({ value: x.label, label: x.label }))} />
      </div>
    </Modal>
  );
}

function AssignOne({ open, onClose, id, staff }: { open: boolean; onClose: () => void; id: string; staff: any[] }) {
  const [f, setF] = useState({ ownerId: '', reason: '' });
  const m = useMut(() => api('/crm/leads/assign', { body: { leadIds: [id], ...f } }), { success: 'Lead reassigned', invalidate: ['/crm'], onSuccess: onClose });
  return (
    <Modal open={open} onClose={onClose} title="Reassign lead" size="sm" footer={<button className="btn-primary" disabled={!f.ownerId || f.reason.length < 2 || m.isPending} onClick={() => m.mutate(undefined)}>Reassign</button>}>
      <div className="space-y-3">
        <Select label="New owner" required value={f.ownerId} onChange={(e) => setF({ ...f, ownerId: e.target.value })} placeholder="Select" options={staff.map((u) => ({ value: u.id, label: u.name }))} />
        <Textarea label="Reason" required value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} />
      </div>
    </Modal>
  );
}

function EditLead({ open, onClose, lead, courses }: { open: boolean; onClose: () => void; lead: any; courses: any[] }) {
  const [f, setF] = useState({ name: lead.name, phone: lead.phone, email: lead.email ?? '', courseId: lead.courseId ?? '', city: lead.city ?? '', notes: lead.notes ?? '' });
  const m = useMut(() => api(`/crm/leads/${lead.id}`, { method: 'PATCH', body: { ...f, courseId: f.courseId || null } }), { success: 'Lead updated', invalidate: ['/crm'], onSuccess: onClose });
  return (
    <Modal open={open} onClose={onClose} title="Edit lead" footer={<button className="btn-primary" disabled={m.isPending} onClick={() => m.mutate(undefined)}>Save</button>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Input label="Name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        <Input label="Phone" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} />
        <Input label="Email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
        <Select label="Course" value={f.courseId} onChange={(e) => setF({ ...f, courseId: e.target.value })} placeholder="—" options={courses.map((c) => ({ value: c.id, label: c.name }))} />
        <Input label="City" value={f.city} onChange={(e) => setF({ ...f, city: e.target.value })} />
        <Textarea className="sm:col-span-2" label="Notes" value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />
      </div>
    </Modal>
  );
}

function MergeModal({ open, onClose, id }: { open: boolean; onClose: () => void; id: string }) {
  const [q, setQ] = useState('');
  const res = useGet<any>(q.length > 2 ? `/crm/leads?q=${encodeURIComponent(q)}&pageSize=10` : null);
  const m = useMut((dup: string) => api(`/crm/leads/${id}/merge`, { body: { duplicateId: dup } }), { success: 'Leads merged', invalidate: ['/crm'], onSuccess: onClose });
  return (
    <Modal open={open} onClose={onClose} title="Merge a duplicate into this lead">
      <Input label="Find duplicate" placeholder="Name, phone or code" value={q} onChange={(e) => setQ(e.target.value)} />
      <ul className="mt-3 divide-y divide-slate-100">
        {res.data?.items.filter((l: any) => l.id !== id).map((l: any) => (
          <li key={l.id} className="flex items-center justify-between py-2 text-sm"><span>{l.code} · {l.name} · {l.phone}</span><button className="btn-secondary btn-sm" disabled={m.isPending} onClick={() => m.mutate(l.id)}>{m.isPending ? <Spinner className="h-3 w-3" /> : 'Merge'}</button></li>
        ))}
      </ul>
      <p className="mt-3 text-xs text-slate-500">The duplicate’s activities, follow-ups and applications move here; the duplicate is closed as Junk.</p>
    </Modal>
  );
}
