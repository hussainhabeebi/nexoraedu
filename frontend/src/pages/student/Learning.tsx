import { useState } from 'react';
import { ExternalLink, FileText, PlayCircle } from 'lucide-react';
import { api } from '@/lib/api';
import { useGet, useMut } from '@/lib/hooks';
import { d, dt } from '@/lib/format';
import { Badge, Card, Empty, Input, Modal, PageHeader, PageLoader, Tabs, Textarea } from '@/components/ui';

export default function Learning() {
  const [tab, setTab] = useState<'materials' | 'assignments'>('materials');
  const mats = useGet<any>('/portal/materials');
  const asg = useGet<any>('/portal/assignments');
  const [sub, setSub] = useState<any>(null);
  const [f, setF] = useState({ content: '', fileUrl: '' });
  const m = useMut(() => api(`/portal/assignments/${sub.id}/submit`, { body: { content: f.content || undefined, fileUrl: f.fileUrl || undefined } }), { success: 'Submitted', invalidate: ['/portal'], onSuccess: () => setSub(null) });
  if (mats.isLoading || asg.isLoading) return <PageLoader />;
  return (
    <div>
      <PageHeader title="Learning" />
      <Tabs value={tab} onChange={setTab} tabs={[{ key: 'materials', label: 'Materials', count: mats.data.items.length }, { key: 'assignments', label: 'Assignments', count: asg.data.items.length }]} />
      {tab === 'materials' && (mats.data.items.length ? <div className="grid gap-3 md:grid-cols-2">{mats.data.items.map((x: any) => <a key={x.id} href={x.url} target="_blank" rel="noreferrer" className="card flex items-center gap-3 p-4 hover:shadow-lift">{x.type === 'VIDEO' ? <PlayCircle className="h-6 w-6 text-rose-500" /> : <FileText className="h-6 w-6 text-brand-600" />}<div className="flex-1"><p className="font-medium">{x.title}</p><p className="text-xs text-slate-500">{x.type} · {d(x.createdAt)}</p></div><ExternalLink className="h-4 w-4 text-slate-400" /></a>)}</div> : <Empty title="No materials shared yet" />)}
      {tab === 'assignments' && (asg.data.items.length ? <div className="space-y-3">{asg.data.items.map((a: any) => {
        const late = new Date(a.dueAt) < new Date();
        return <Card key={a.id}><div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between"><div><p className="font-semibold">{a.title}</p>{a.description && <p className="mt-1 whitespace-pre-line text-sm text-slate-600">{a.description}</p>}<p className={`mt-1 text-xs ${late && !a.submission ? 'text-rose-600' : 'text-slate-500'}`}>Due {dt(a.dueAt)} · {a.maxMarks} marks</p></div>
          <div className="text-right">{a.submission ? <><Badge status={a.submission.marks != null ? 'APPROVED' : 'SUBMITTED'}>{a.submission.marks != null ? `${a.submission.marks}/${a.maxMarks}` : a.submission.late ? 'Submitted late' : 'Submitted'}</Badge>{a.submission.feedback && <p className="mt-1 text-xs text-slate-500">“{a.submission.feedback}”</p>}</> : <Badge status={late ? 'OVERDUE' : 'PENDING'}>{late ? 'Overdue' : 'Pending'}</Badge>}
            {a.submission?.marks == null && <button className="btn-primary btn-sm mt-2" onClick={() => { setSub(a); setF({ content: a.submission?.content ?? '', fileUrl: a.submission?.fileUrl ?? '' }); }}>{a.submission ? 'Update' : 'Submit'}</button>}</div></div></Card>;
      })}</div> : <Empty title="No assignments" />)}
      <Modal open={!!sub} onClose={() => setSub(null)} title={sub?.title ?? ''} footer={<button className="btn-primary" disabled={(!f.content && !f.fileUrl) || m.isPending} onClick={() => m.mutate(undefined)}>Submit</button>}>
        <div className="space-y-3"><Textarea label="Answer" rows={6} value={f.content} onChange={(e) => setF({ ...f, content: e.target.value })} /><Input label="Or link to your work (Drive, GitHub…)" type="url" value={f.fileUrl} onChange={(e) => setF({ ...f, fileUrl: e.target.value })} /></div>
      </Modal>
    </div>
  );
}
