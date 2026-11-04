import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, Eye, GraduationCap } from 'lucide-react';
import { api, download } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useBatches, useCourses, useGet, useMut } from '@/lib/hooks';
import { d, dt, label } from '@/lib/format';
import { Badge, Card, Confirm, KV, Modal, PageHeader, PageLoader, Select, Spinner } from '@/components/ui';

export default function ApplicationDetail() {
  const { id } = useParams();
  const { can } = useAuth();
  const { data: a, isLoading } = useGet<any>(`/crm/applications/${id}`);
  const courses = useCourses();
  const batches = useBatches(a?.courseId);
  const [admit, setAdmit] = useState(false);
  const [reject, setReject] = useState(false);
  const [f, setF] = useState({ batchId: '', installments: '' });
  const inv = ['/crm', '/approvals', '/dashboard', '/students'];
  const admitM = useMut(() => api(`/crm/applications/${id}/admit`, { body: { batchId: f.batchId || a.batchId, installments: f.installments ? Number(f.installments) : undefined } }), { success: (r: any) => r.message, invalidate: inv, onSuccess: () => setAdmit(false) });
  const rejectM = useMut((remarks: string) => api(`/crm/applications/${id}`, { method: 'PATCH', body: { status: 'REJECTED', remarks } }), { success: 'Application rejected', invalidate: inv, onSuccess: () => setReject(false) });
  if (isLoading) return <PageLoader />;
  const p = a.data.personal;
  const course = courses.data?.items.find((c) => c.id === a.courseId);
  const editable = ['SUBMITTED', 'UNDER_REVIEW', 'APPROVED'].includes(a.status);
  return (
    <div className="space-y-6">
      <Link to="/staff/applications" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800"><ArrowLeft className="h-4 w-4" /> Applications</Link>
      <PageHeader title={<span className="flex items-center gap-3">{p.fullName} <Badge status={a.status} /></span>} subtitle={`${a.code} · ${course?.name ?? ''} · submitted ${dt(a.createdAt)} via ${label(a.source)}`}
        actions={<>
          {a.lead && <Link to={`/staff/leads/${a.lead.id}`} className="btn-secondary">Lead {a.lead.code}</Link>}
          {a.studentId && <Link to={`/staff/students/${a.studentId}`} className="btn-success"><GraduationCap className="h-4 w-4" /> View student</Link>}
          {editable && can('leads:update', 'students:manage') && <button className="btn-secondary text-rose-600" onClick={() => setReject(true)}>Reject</button>}
          {editable && can('leads:update', 'students:manage') && <button className="btn-primary" onClick={() => { setF({ batchId: a.batchId ?? '', installments: '' }); setAdmit(true); }}>Request admission</button>}
        </>} />
      {a.approval && a.status === 'PENDING_APPROVAL' && <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">Awaiting admission approval (level {a.approval.currentLevel}). <Link to={`/staff/approvals/${a.approval.id}`} className="link">Open approval</Link></div>}
      {a.remarks && <div className="rounded-lg bg-slate-100 p-4 text-sm">Remarks: {a.remarks}</div>}
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card title="Personal details"><KV items={[['Full name', p.fullName], ['Date of birth', d(p.dob)], ['Gender', p.gender], ['Phone', p.phone], ['Email', p.email], ['City', p.city], ['Address', p.address]]} /></Card>
          <Card title="Guardians">{a.data.guardians.length ? <KV items={a.data.guardians.map((g: any) => [g.relation, `${g.name} · ${g.phone}${g.email ? ` · ${g.email}` : ''}${g.occupation ? ` · ${g.occupation}` : ''}`])} cols={1} /> : <p className="text-sm text-slate-500">None provided</p>}</Card>
          <Card title="Education">{a.data.education.length ? <KV cols={1} items={a.data.education.map((e: any) => [label(e.level), `${e.institution}${e.board ? `, ${e.board}` : ''}${e.year ? ` (${e.year})` : ''}${e.marks ? ` — ${e.marks}` : ''}`])} /> : <p className="text-sm text-slate-500">None provided</p>}</Card>
        </div>
        <div className="space-y-6">
          <Card title="Preferences"><KV cols={1} items={[['Course', course?.name], ['Batch', batches.data?.items.find((b) => b.id === a.batchId)?.name ?? 'Not chosen']]} /></Card>
          <Card title="Documents" bodyClass="p-0">
            {a.documents.length ? <ul className="divide-y divide-slate-100">{a.documents.map((doc: any) => <li key={doc.id} className="flex items-center justify-between px-5 py-3 text-sm"><span>{label(doc.type)} <Badge status={doc.status} className="ml-1" /></span><button className="btn-ghost btn-sm" onClick={() => download(`/documents/${doc.id}/download`, doc.fileName, true)}><Eye className="h-4 w-4" /></button></li>)}</ul> : <p className="p-5 text-sm text-slate-500">No documents uploaded</p>}
          </Card>
        </div>
      </div>
      <Modal open={admit} onClose={() => setAdmit(false)} title="Request admission" footer={<><button className="btn-secondary" onClick={() => setAdmit(false)}>Cancel</button><button className="btn-primary" disabled={!(f.batchId || a.batchId) || admitM.isPending} onClick={() => admitM.mutate(undefined)}>{admitM.isPending && <Spinner className="h-4 w-4 text-white" />} Send for approval</button></>}>
        <div className="space-y-4">
          <Select label="Allocate batch" required value={f.batchId} onChange={(e) => setF({ ...f, batchId: e.target.value })} placeholder="Select batch" options={(batches.data?.items ?? []).filter((b) => ['PLANNED', 'RUNNING'].includes(b.status)).map((b) => ({ value: b.id, label: `${b.name} (${b._count.students}/${b.capacity})` }))} />
          <Select label="Installments" value={f.installments} onChange={(e) => setF({ ...f, installments: e.target.value })} placeholder={`Course default (${course?.defaultInstallments ?? 1})`} options={[1, 2, 3, 4, 6, 12].map((n) => ({ value: String(n), label: `${n} installment${n > 1 ? 's' : ''}` }))} />
          <p className="text-sm text-slate-600">On approval by the Sales Manager the student record, Student ID, portal login and fee plan are created automatically and the student is notified on WhatsApp.</p>
        </div>
      </Modal>
      <Confirm open={reject} onClose={() => setReject(false)} title="Reject application" tone="danger" confirmLabel="Reject" requireReason reasonLabel="Remarks" busy={rejectM.isPending} onConfirm={(r) => rejectM.mutate(r)} />
    </div>
  );
}
