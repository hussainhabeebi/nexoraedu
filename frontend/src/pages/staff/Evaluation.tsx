import { useState } from 'react';
import { api } from '@/lib/api';
import { useGet, useMut } from '@/lib/hooks';
import { dt, label } from '@/lib/format';
import { Card, Empty, Modal, PageHeader, PageLoader } from '@/components/ui';

function EvalModal({ id, onClose }: { id: string; onClose: () => void }) {
  const { data: a } = useGet<any>(`/exams/attempts/${id}`);
  const [marks, setMarks] = useState<Record<string, string>>({});
  const m = useMut(() => api(`/exams/attempts/${id}/evaluate`, { body: { marks: Object.fromEntries(Object.entries(marks).map(([k, v]) => [k, Number(v || 0)])) } }), { success: 'Evaluation saved', invalidate: ['/exams', '/dashboard'], onSuccess: onClose });
  if (!a) return null;
  const subj = a.exam.questions.filter((q: any) => ['SHORT', 'LONG'].includes(q.question.type));
  return (
    <Modal open onClose={onClose} title={`Evaluate — ${a.student.fullName}`} size="xl" footer={<button className="btn-primary" disabled={m.isPending} onClick={() => m.mutate(undefined)}>Save marks</button>}>
      <p className="mb-4 text-sm text-slate-600">{a.exam.title} · auto-graded score {a.autoScore ?? 0} · submitted {dt(a.submittedAt)} · tab switches {a.tabSwitches}</p>
      <ol className="space-y-4">
        {subj.map((q: any, i: number) => (
          <li key={q.id} className="rounded-xl border border-slate-200 p-4">
            <p className="text-sm font-medium">{i + 1}. {q.question.text} <span className="text-xs text-slate-500">({label(q.question.type)}, max {q.question.marks})</span></p>
            <p className="mt-2 whitespace-pre-wrap rounded-lg bg-slate-50 p-3 text-sm">{(a.answers as any)[q.questionId] || <i className="text-slate-400">No answer</i>}</p>
            <label className="mt-2 flex items-center gap-2 text-sm">Marks <input className="input w-24" type="number" min={0} max={q.question.marks} step="0.5" value={marks[q.questionId] ?? ''} onChange={(e) => setMarks({ ...marks, [q.questionId]: e.target.value })} /> / {q.question.marks}</label>
          </li>
        ))}
      </ol>
    </Modal>
  );
}

export default function Evaluation() {
  const { data, isLoading } = useGet<any>('/exams/attempts/pending');
  const [open, setOpen] = useState<string | null>(null);
  if (isLoading) return <PageLoader />;
  return (
    <div>
      <PageHeader title="Evaluation" subtitle="Submitted attempts with subjective answers awaiting manual marks." />
      <Card bodyClass="p-0">
        {data.items.length ? <ul className="divide-y divide-slate-100">{data.items.map((a: any) => <li key={a.id} className="flex items-center justify-between px-5 py-3 text-sm"><span><b>{a.student.fullName}</b> <span className="text-slate-500">{a.student.studentCode}</span> · {a.exam.title} · submitted {dt(a.submittedAt)}</span><button className="btn-primary btn-sm" onClick={() => setOpen(a.id)}>Evaluate</button></li>)}</ul> : <Empty title="Nothing to evaluate" />}
      </Card>
      {open && <EvalModal id={open} onClose={() => setOpen(null)} />}
    </div>
  );
}
