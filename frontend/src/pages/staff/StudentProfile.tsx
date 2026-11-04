import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { AlertTriangle, ArrowLeft, Camera, Eye, Mail, MessageCircle, Phone, Upload } from 'lucide-react';
import { api, download } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useBatches, useGet, useMasters, useMut } from '@/lib/hooks';
import { d, dt, inr, label } from '@/lib/format';
import StudentAccount from '@/components/StudentAccount';
import WaChat from '@/components/WaChat';
import { Avatar, Badge, Card, Confirm, Empty, Input, KV, Modal, PageLoader, Progress, Select, Tabs, Textarea } from '@/components/ui';

type Tab = 'overview' | 'fees' | 'academics' | 'documents' | 'history' | 'whatsapp';
const STATUSES = ['ADMITTED', 'ACTIVE', 'ON_HOLD', 'COMPLETED', 'WITHDRAWN', 'TERMINATED'];

export default function StudentProfile() {
  const { id } = useParams();
  const { can } = useAuth();
  const [sp, setSp] = useSearchParams();
  const tab = (sp.get('tab') as Tab) || 'overview';
  const { data: s, isLoading, error } = useGet<any>(`/students/${id}`);
  const docTypes = useMasters('document_type');
  const batches = useBatches(s?.courseId);
  const [modal, setModal] = useState<'' | 'status' | 'transfer' | 'edit' | 'doc'>('');
  const [st, setSt] = useState({ status: '', reason: '' });
  const [tr, setTr] = useState({ toBatchId: '', reason: '' });
  const [doc, setDoc] = useState<{ type: string; file: File | null }>({ type: '', file: null });
  const [rej, setRej] = useState<string | null>(null);
  const inv = ['/students', '/dashboard', '/approvals'];
  const statusM = useMut(() => api(`/students/${id}/status`, { body: st }), { success: 'Status updated', invalidate: inv, onSuccess: () => setModal('') });
  const trM = useMut(() => api(`/students/${id}/transfer`, { body: tr }), { success: 'Transfer sent for approval', invalidate: inv, onSuccess: () => setModal('') });
  const docM = useMut(() => { const fd = new FormData(); fd.append('type', doc.type); fd.append('file', doc.file!); return api(`/students/${id}/documents`, { body: fd }); }, { success: 'Document uploaded', invalidate: inv, onSuccess: () => setModal('') });
  const verifyM = useMut(({ docId, status, remarks }: any) => api(`/documents/${docId}/verify`, { body: { status, remarks } }), { success: 'Document updated', invalidate: inv, onSuccess: () => setRej(null) });
  const photoM = useMut((f: File) => { const fd = new FormData(); fd.append('file', f); return api(`/students/${id}/photo`, { body: fd }); }, { success: 'Photo updated', invalidate: inv });

  if (isLoading) return <PageLoader />;
  if (error) return <Empty title="Student not found" hint={(error as Error).message} />;
  const att = s.attendance;
  const setTab = (t: Tab) => setSp({ tab: t });

  return (
    <div className="space-y-6">
      <Link to="/staff/students" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800"><ArrowLeft className="h-4 w-4" /> Students</Link>
      <div className="card p-5">
        <div className="flex flex-col gap-5 sm:flex-row sm:items-center">
          <div className="relative">
            <Avatar name={s.fullName} src={s.photoUrl} size="lg" />
            {can('students:manage') && <label className="absolute -bottom-1 -right-1 cursor-pointer rounded-full bg-white p-1.5 shadow ring-1 ring-slate-200" title="Change photo"><Camera className="h-3.5 w-3.5" /><input type="file" accept="image/*" className="sr-only" onChange={(e) => e.target.files?.[0] && photoM.mutate(e.target.files[0])} /></label>}
          </div>
          <div className="flex-1">
            <div className="flex flex-wrap items-center gap-2"><h1 className="text-2xl font-bold">{s.fullName}</h1><Badge status={s.status} /></div>
            <p className="text-sm text-slate-500">{s.studentCode} · {s.course.name} · {s.batch?.name ?? 'No batch'} · admitted {d(s.admissionDate)}</p>
            <div className="mt-2 flex flex-wrap gap-2 text-sm">
              <a href={`tel:${s.phone}`} className="btn-secondary btn-sm"><Phone className="h-4 w-4" /> {s.phone}</a>
              <a href={`mailto:${s.email}`} className="btn-secondary btn-sm"><Mail className="h-4 w-4" /> {s.email}</a>
              {can('whatsapp:send') && <button className="btn-success btn-sm" onClick={() => setTab('whatsapp')}><MessageCircle className="h-4 w-4" /> WhatsApp</button>}
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {can('students:manage', 'academics:manage') && <button className="btn-secondary" onClick={() => { setSt({ status: s.status, reason: '' }); setModal('status'); }}>Change status</button>}
            {can('students:manage', 'academics:manage') && <button className="btn-secondary" onClick={() => setModal('transfer')}>Batch transfer</button>}
          </div>
        </div>
        {!!s.missingDocuments.length && <p className="mt-4 flex items-center gap-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800"><AlertTriangle className="h-4 w-4" /> Missing mandatory documents: {s.missingDocuments.join(', ')}</p>}
      </div>

      <Tabs value={tab} onChange={setTab} tabs={[
        { key: 'overview', label: 'Overview' }, ...(s.balance != null ? [{ key: 'fees' as const, label: 'Fees' }] : []), { key: 'academics', label: 'Attendance & results' },
        { key: 'documents', label: 'Documents', count: s.documents.length }, { key: 'history', label: 'History' }, ...(can('whatsapp:send') ? [{ key: 'whatsapp' as const, label: 'WhatsApp' }] : []),
      ]} />

      {tab === 'overview' && (
        <div className="grid gap-6 lg:grid-cols-3">
          <div className="space-y-6 lg:col-span-2">
            <Card title="Personal"><KV items={[['Date of birth', d(s.dob)], ['Gender', s.gender], ['Phone', s.phone], ['Email', s.email], ['Address', `${s.address}${s.city ? `, ${s.city}` : ''}`], ['Portal login', s.user ? `${s.studentCode.toLowerCase()} · last login ${s.user.lastLoginAt ? dt(s.user.lastLoginAt) : 'never'}` : '—']]} /></Card>
            <Card title="Guardians">{s.guardians.length ? <KV cols={1} items={s.guardians.map((g: any) => [g.relation, `${g.name} · ${g.phone}${g.email ? ` · ${g.email}` : ''}`])} /> : <p className="text-sm text-slate-500">None recorded</p>}</Card>
            <Card title="Education">{s.education.length ? <KV cols={1} items={s.education.map((e: any) => [label(e.level), `${e.institution}${e.board ? `, ${e.board}` : ''}${e.year ? ` (${e.year})` : ''}${e.marks ? ` — ${e.marks}` : ''}`])} /> : <p className="text-sm text-slate-500">None recorded</p>}</Card>
          </div>
          <div className="space-y-6">
            {s.balance != null && <Card title="Fees"><p className="text-3xl font-bold">{inr(s.balance)}</p><p className="text-sm text-slate-500">outstanding</p><button className="btn-secondary btn-sm mt-3" onClick={() => setTab('fees')}>Open fee account</button></Card>}
            <Card title="Attendance">{att.percentage != null ? <><p className="text-3xl font-bold">{att.percentage}%</p><Progress value={att.percentage} tone={att.percentage < 75 ? 'rose' : 'green'} /><p className="mt-1 text-sm text-slate-500">{att.present} of {att.total} sessions</p></> : <p className="text-sm text-slate-500">No sessions yet</p>}</Card>
            {s.lead && <Card title="Source"><p className="text-sm">Lead <Link className="link" to={`/staff/leads/${s.lead.id}`}>{s.lead.code}</Link> via {label(s.lead.source)}</p></Card>}
          </div>
        </div>
      )}
      {tab === 'fees' && <StudentAccount studentId={s.id} />}
      {tab === 'academics' && (
        <div className="grid gap-6 lg:grid-cols-2">
          <Card title="Attendance">{att.percentage != null ? <div className="space-y-2"><p className="text-4xl font-bold">{att.percentage}%</p><Progress value={att.percentage} tone={att.percentage < 75 ? 'rose' : 'green'} /><p className="text-sm text-slate-500">Present/late in {att.present} of {att.total} sessions</p></div> : <Empty title="No attendance records" />}</Card>
          <Card title="Exam results" bodyClass="p-0">{s.results.length ? <ul className="divide-y divide-slate-100">{s.results.map((r: any) => <li key={r.id} className="flex justify-between px-5 py-3 text-sm"><span>{r.exam.title} <span className="text-slate-400">({label(r.exam.type)})</span>{!r.exam.resultsPublished && <Badge status="DRAFT" className="ml-2">Unpublished</Badge>}</span><span className="font-medium">{r.marks} · {r.grade} <Badge status={r.passed ? 'APPROVED' : 'REJECTED'}>{r.passed ? 'Pass' : 'Fail'}</Badge></span></li>)}</ul> : <Empty title="No results yet" />}</Card>
          {!!s.certificates.length && <Card title="Certificates" bodyClass="p-0"><ul className="divide-y divide-slate-100">{s.certificates.map((c: any) => <li key={c.id} className="flex justify-between px-5 py-3 text-sm"><span>{c.number}</span><Badge status={c.status} /></li>)}</ul></Card>}
        </div>
      )}
      {tab === 'documents' && (
        <Card title="Documents" actions={can('students:manage') && <button className="btn-secondary btn-sm" onClick={() => setModal('doc')}><Upload className="h-4 w-4" /> Upload</button>} bodyClass="p-0">
          {s.documents.length ? <ul className="divide-y divide-slate-100">{s.documents.map((x: any) => (
            <li key={x.id} className="flex flex-col gap-2 px-5 py-3 text-sm sm:flex-row sm:items-center sm:justify-between">
              <div><p className="font-medium">{docTypes.data?.items.find((t) => t.code === x.type)?.label ?? label(x.type)} <Badge status={x.status} className="ml-1" /></p><p className="text-xs text-slate-500">{x.fileName} · {d(x.createdAt)}{x.remarks && ` · ${x.remarks}`}</p></div>
              <div className="flex gap-2">
                <button className="btn-secondary btn-sm" onClick={() => download(`/documents/${x.id}/download`, x.fileName, true)}><Eye className="h-4 w-4" /> View</button>
                {can('documents:verify') && x.status === 'PENDING' && <><button className="btn-success btn-sm" onClick={() => verifyM.mutate({ docId: x.id, status: 'VERIFIED' })}>Verify</button><button className="btn-secondary btn-sm text-rose-600" onClick={() => setRej(x.id)}>Reject</button></>}
              </div>
            </li>))}</ul> : <Empty title="No documents" />}
        </Card>
      )}
      {tab === 'history' && (
        <Card bodyClass="p-0">
          <ol className="divide-y divide-slate-100">{s.history.map((h: any) => <li key={h.id} className="flex gap-3 px-5 py-3 text-sm"><Badge>{label(h.type)}</Badge><span className="flex-1">{h.message}</span><span className="shrink-0 text-xs text-slate-400">{dt(h.createdAt)}</span></li>)}</ol>
        </Card>
      )}
      {tab === 'whatsapp' && <div className="card overflow-hidden"><WaChat name={s.fullName} messagesPath={s.lead?.chatwootConversationId ? `/whatsapp/conversations/${s.lead.chatwootConversationId}/messages` : null} sendPath={`/whatsapp/students/${s.id}/send`} /></div>}

      <Modal open={modal === 'status'} onClose={() => setModal('')} title="Change status" size="sm" footer={<button className="btn-primary" disabled={st.reason.length < 3 || statusM.isPending} onClick={() => statusM.mutate(undefined)}>Update</button>}>
        <div className="space-y-3"><Select label="New status" value={st.status} onChange={(e) => setSt({ ...st, status: e.target.value })} options={STATUSES.map((x) => ({ value: x, label: label(x) }))} /><Textarea label="Reason" required value={st.reason} onChange={(e) => setSt({ ...st, reason: e.target.value })} /></div>
      </Modal>
      <Modal open={modal === 'transfer'} onClose={() => setModal('')} title="Batch transfer" size="sm" footer={<button className="btn-primary" disabled={!tr.toBatchId || tr.reason.length < 3 || trM.isPending} onClick={() => trM.mutate(undefined)}>Send for approval</button>}>
        <div className="space-y-3"><Select label="Move to batch" value={tr.toBatchId} onChange={(e) => setTr({ ...tr, toBatchId: e.target.value })} placeholder="Select" options={(batches.data?.items ?? []).filter((b) => b.id !== s.batchId).map((b) => ({ value: b.id, label: `${b.code} (${b._count.students}/${b.capacity})` }))} /><Textarea label="Reason" required value={tr.reason} onChange={(e) => setTr({ ...tr, reason: e.target.value })} /></div>
      </Modal>
      <Modal open={modal === 'doc'} onClose={() => setModal('')} title="Upload document" size="sm" footer={<button className="btn-primary" disabled={!doc.type || !doc.file || docM.isPending} onClick={() => docM.mutate(undefined)}>Upload</button>}>
        <div className="space-y-3"><Select label="Type" value={doc.type} onChange={(e) => setDoc({ ...doc, type: e.target.value })} placeholder="Select" options={(docTypes.data?.items ?? []).map((t) => ({ value: t.code, label: t.label }))} /><Input label="File (PDF/JPG/PNG, max 5 MB)" type="file" accept="application/pdf,image/*" onChange={(e) => setDoc({ ...doc, file: e.target.files?.[0] ?? null })} /></div>
      </Modal>
      <Confirm open={!!rej} onClose={() => setRej(null)} title="Reject document" tone="danger" confirmLabel="Reject" requireReason busy={verifyM.isPending} onConfirm={(r) => verifyM.mutate({ docId: rej, status: 'REJECTED', remarks: r })} />
    </div>
  );
}
