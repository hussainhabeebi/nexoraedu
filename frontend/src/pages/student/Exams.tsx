import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Clock } from 'lucide-react';
import { useGet } from '@/lib/hooks';
import { dt, label } from '@/lib/format';
import { Badge, Card, Empty, Modal, PageHeader, PageLoader } from '@/components/ui';

export default function Exams() {
  const nav = useNavigate();
  const { data, isLoading } = useGet<any>('/portal/exams', { refetchInterval: 30_000 });
  const [intro, setIntro] = useState<any>(null);
  const [ack, setAck] = useState(false);
  if (isLoading) return <PageLoader />;
  const now = Date.now();
  return (
    <div>
      <PageHeader title="Exams" />
      {data.items.length ? <div className="grid gap-4 md:grid-cols-2">{data.items.map((e: any) => {
        const open = now >= new Date(e.startAt).getTime() && now <= new Date(e.endAt).getTime();
        const canStart = e.mode === 'ONLINE' && open && (e.inProgress || e.attemptsUsed < e.attemptLimit);
        return (
          <Card key={e.id}>
            <div className="flex items-start justify-between gap-2"><div><p className="font-semibold">{e.title}</p><p className="text-sm text-slate-500">{label(e.type)} · {label(e.mode)} · {e.totalMarks} marks</p></div>{e.resultsPublished ? <Badge status="APPROVED">Result out</Badge> : e.inProgress ? <Badge status="IN_PROGRESS" /> : e.attemptsUsed ? <Badge status="SUBMITTED" /> : <Badge status="SCHEDULED" />}</div>
            <p className="mt-3 flex items-center gap-1.5 text-sm text-slate-600"><Clock className="h-4 w-4" /> {dt(e.startAt)} – {dt(e.endAt)} · {e.durationMin} min</p>
            <p className="text-xs text-slate-500">Attempts: {e.attemptsUsed}/{e.attemptLimit} · {e.questions} questions</p>
            {canStart && <button className="btn-primary mt-4 w-full" onClick={() => (e.inProgress ? nav(`/student/exam/${e.id}`) : (setAck(false), setIntro(e)))}>{e.inProgress ? 'Resume exam' : 'Start exam'}</button>}
            {e.mode === 'ONLINE' && !open && now < new Date(e.startAt).getTime() && <p className="mt-4 rounded-lg bg-slate-50 p-2 text-center text-sm text-slate-600">Opens {dt(e.startAt)}</p>}
          </Card>
        );
      })}</div> : <Empty title="No exams assigned" />}
      {intro && (
        <Modal open onClose={() => setIntro(null)} title={intro.title} footer={<button className="btn-primary" disabled={!ack} onClick={() => nav(`/student/exam/${intro.id}`, { state: { acknowledged: true } })}>Begin — timer starts now</button>}>
          <div className="space-y-4 text-sm">
            <p><b>{intro.questions}</b> questions · <b>{intro.durationMin}</b> minutes · <b>{intro.totalMarks}</b> marks</p>
            {intro.instructions && <div className="whitespace-pre-line rounded-lg bg-slate-50 p-4">{intro.instructions}</div>}
            <label className="flex items-start gap-2"><input type="checkbox" className="mt-0.5 rounded text-brand-600" checked={ack} onChange={(e) => setAck(e.target.checked)} /> I have read the instructions and will not switch tabs or use unfair means.</label>
          </div>
        </Modal>
      )}
    </div>
  );
}
