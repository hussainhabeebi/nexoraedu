import { useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Check, CornerUpLeft, X } from 'lucide-react';
import { api } from '@/lib/api';
import { useGet, useMut } from '@/lib/hooks';
import { ago, dt, inr, label } from '@/lib/format';
import { Badge, Card, cx, Empty, Modal, PageHeader, PageLoader, Spinner, Tabs, Textarea } from '@/components/ui';

function Detail({ id, onClose }: { id: string; onClose: () => void }) {
  const { data: r, isLoading } = useGet<any>(`/approvals/${id}`);
  const [comment, setComment] = useState('');
  const m = useMut((action: string) => api(`/approvals/${id}/act`, { body: { action, comment: comment || undefined } }), { success: (x: any) => `Request ${x.status === 'PENDING' ? 'moved to next level' : x.status.toLowerCase()}`, invalidate: ['/approvals', '/dashboard', '/crm', '/students', '/finance', '/exams'], onSuccess: onClose });
  return (
    <Modal open onClose={onClose} title="Approval request" size="lg" footer={r?.canAct && <>
      <button className="btn-secondary" disabled={m.isPending || !comment} onClick={() => m.mutate('RETURN')} title="Comment required"><CornerUpLeft className="h-4 w-4" /> Return</button>
      <button className="btn-danger" disabled={m.isPending || !comment} onClick={() => m.mutate('REJECT')} title="Comment required"><X className="h-4 w-4" /> Reject</button>
      <button className="btn-success" disabled={m.isPending} onClick={() => m.mutate('APPROVE')}>{m.isPending ? <Spinner className="h-4 w-4 text-white" /> : <Check className="h-4 w-4" />} Approve</button>
    </>}>
      {isLoading || !r ? <Spinner /> : (
        <div className="space-y-5">
          <div><p className="text-xs font-semibold uppercase text-slate-500">{r.typeLabel}</p><p className="mt-1 text-lg font-semibold">{r.title}</p><p className="text-sm text-slate-500">Requested by {r.requestedBy} · {dt(r.createdAt)}{r.amount && ` · ${inr(r.amount)}`}</p></div>
          {r.payload && Object.keys(r.payload).length > 0 && <dl className="grid gap-2 rounded-lg bg-slate-50 p-4 text-sm sm:grid-cols-2">{Object.entries(r.payload).filter(([k]) => !/id$/i.test(k)).map(([k, v]) => <div key={k}><dt className="text-xs uppercase text-slate-500">{label(k)}</dt><dd>{String(v)}</dd></div>)}</dl>}
          <ol className="space-y-2">
            {(r.levels as any[]).map((l, i) => {
              const act = r.actions.find((a: any) => a.level === l.level);
              const state = act ? act.action : r.status === 'PENDING' && r.currentLevel === i + 1 ? 'WAITING' : r.currentLevel > i + 1 ? 'APPROVE' : '';
              return <li key={i} className="flex items-start gap-3 text-sm"><span className={cx('mt-0.5 flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold', state === 'APPROVE' ? 'bg-emerald-500 text-white' : state === 'REJECT' ? 'bg-rose-500 text-white' : state === 'WAITING' ? 'bg-amber-400 text-white' : 'bg-slate-200 text-slate-500')}>{i + 1}</span><div><p className="font-medium">{label(l.role)}{l.minAmount ? ` (≥ ${inr(l.minAmount)})` : ''}</p>{act ? <p className="text-slate-500">{label(act.action)} by {act.userName} · {ago(act.createdAt)}{act.comment && ` — “${act.comment}”`}</p> : state === 'WAITING' && <p className="text-amber-700">Awaiting decision</p>}</div></li>;
            })}
          </ol>
          {r.canAct && <Textarea label="Comment" value={comment} onChange={(e) => setComment(e.target.value)} hint="Required to reject or return." />}
          {!r.canAct && r.status === 'PENDING' && <p className="text-sm text-slate-500">This request is waiting for another approver.</p>}
        </div>
      )}
    </Modal>
  );
}

export default function Approvals() {
  const { id } = useParams();
  const nav = useNavigate();
  const [sp, setSp] = useSearchParams();
  const box = (sp.get('box') as 'mine' | 'requested' | 'all') || 'mine';
  const { data, isLoading } = useGet<any>(`/approvals?box=${box}`);
  return (
    <div>
      <PageHeader title="Approvals" subtitle="Admissions, discounts, refunds, cancellations, transfers, result corrections and certificates." />
      <Tabs value={box} onChange={(k) => setSp({ box: k })} tabs={[{ key: 'mine', label: 'Awaiting me' }, { key: 'requested', label: 'Raised by me' }, { key: 'all', label: 'All' }]} />
      {isLoading ? <PageLoader /> : (
        <Card bodyClass="p-0">
          {data.items.length ? <ul className="divide-y divide-slate-100">{data.items.map((r: any) => (
            <li key={r.id}><button className="flex w-full flex-col gap-1 px-5 py-4 text-left hover:bg-slate-50 sm:flex-row sm:items-center sm:justify-between" onClick={() => nav(`/staff/approvals/${r.id}?box=${box}`)}>
              <div><p className="text-xs font-semibold uppercase text-slate-500">{r.typeLabel}</p><p className="font-medium">{r.title}</p><p className="text-xs text-slate-500">by {r.requestedBy} · {ago(r.createdAt)} · level {r.currentLevel}/{(r.levels as any[]).length || 1}</p></div>
              <div className="flex items-center gap-2">{r.amount && <span className="text-sm font-medium">{inr(r.amount)}</span>}<Badge status={r.status} />{r.canAct && <Badge status="PENDING">Your action</Badge>}</div>
            </button></li>
          ))}</ul> : <Empty title={box === 'mine' ? 'Nothing awaiting your approval' : 'No requests'} />}
        </Card>
      )}
      {id && <Detail id={id} onClose={() => nav(`/staff/approvals?box=${box}`)} />}
    </div>
  );
}
