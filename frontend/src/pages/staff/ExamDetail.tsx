import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, CalendarCheck, Lock, Send, Shuffle, Users } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useGet, useMut } from '@/lib/hooks';
import { dt, label } from '@/lib/format';
import { Badge, Card, Empty, Input, KV, Modal, PageHeader, PageLoader, Tabs, Textarea } from '@/components/ui';

export default function ExamDetail() {
  const { id } = useParams();
  const { can } = useAuth();
  const { data: e, isLoading } = useGet<any>(`/exams/exams/${id}`);
  const bank = useGet<any>(e ? `/exams/questions?courseId=${e.courseId}&pageSize=200` : null);
  const [tab, setTab] = useState<'questions' | 'students' | 'results'>('questions');
  const [pickQ, setPickQ] = useState(false);
  const [sel, setSel] = useState<string[]>([]);
  const [rand, setRand] = useState(10);
  const [marks, setMarks] = useState<Record<string, string>>({});
  const [corr, setCorr] = useState<any>(null);
  const [cf, setCf] = useState({ newMarks: '', reason: '', evidence: '' });
  const [inel, setInel] = useState<any[]>([]);
  const inv = ['/exams', '/dashboard'];
  const setQ = useMut((body: any) => api(`/exams/exams/${id}/questions`, { method: 'PUT', body }), { success: (r: any) => `${r.count} questions · ${r.marks} marks`, invalidate: inv, onSuccess: () => setPickQ(false) });
  const assign = useMut(() => api(`/exams/exams/${id}/assign`, { body: {} }), { success: (r: any) => `${r.assigned} student(s) assigned`, invalidate: inv, onSuccess: (r: any) => setInel(r.ineligible) });
  const exception = useMut((studentId: string) => api(`/exams/exams/${id}/exception`, { body: { studentId, reason: 'Eligibility exception requested' } }), { success: 'Exception sent for approval' });
  const schedule = useMut(() => api(`/exams/exams/${id}/schedule`, { body: {} }), { success: (r: any) => `Scheduled — ${r.notified} student(s) notified`, invalidate: inv });
  const saveMarks = useMut(() => api(`/exams/exams/${id}/marks`, { body: { entries: Object.entries(marks).filter(([, v]) => v !== '').map(([studentId, m]) => ({ studentId, marks: Number(m) })) } }), { success: 'Marks saved', invalidate: inv, onSuccess: () => setMarks({}) });
  const process = useMut(() => api(`/exams/exams/${id}/process`, { body: {} }), { success: (r: any) => `${r.processed} result(s) processed`, invalidate: inv });
  const lock = useMut(() => api(`/exams/exams/${id}/lock`, { body: {} }), { success: 'Marks locked', invalidate: inv });
  const publish = useMut(() => api(`/exams/exams/${id}/publish`, { body: {} }), { success: (r: any) => `${r.published} result(s) published — students notified`, invalidate: inv });
  const correction = useMut(() => api(`/exams/results/${corr.id}/correction`, { body: { ...cf, newMarks: Number(cf.newMarks) } }), { success: 'Correction sent for approval', onSuccess: () => setCorr(null) });

  if (isLoading) return <PageLoader />;
  const st = e.students;
  const qMarks = e.questions.reduce((s: number, q: any) => s + q.question.marks, 0);
  const manage = can('exams:manage');
  return (
    <div className="space-y-6">
      <Link to="/staff/exams" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800"><ArrowLeft className="h-4 w-4" /> Exams</Link>
      <PageHeader title={<span className="flex items-center gap-3">{e.title} <Badge status={e.status} />{e.resultsPublished && <Badge status="APPROVED">Results published</Badge>}</span>} subtitle={`${e.code} · ${label(e.type)} · ${label(e.mode)} · ${dt(e.startAt)} – ${dt(e.endAt)}`}
        actions={manage && <>
          {e.status === 'DRAFT' && <button className="btn-secondary" disabled={assign.isPending} onClick={() => assign.mutate(undefined)}><Users className="h-4 w-4" /> Assign batch</button>}
          {e.status === 'DRAFT' && <button className="btn-primary" disabled={schedule.isPending} onClick={() => schedule.mutate(undefined)}><CalendarCheck className="h-4 w-4" /> Schedule & notify</button>}
          {e.mode === 'ONLINE' && e.status !== 'DRAFT' && <button className="btn-secondary" disabled={process.isPending} onClick={() => process.mutate(undefined)}>Process results</button>}
          {!!e.results.length && !e.resultsPublished && <button className="btn-secondary" onClick={() => lock.mutate(undefined)}><Lock className="h-4 w-4" /> Lock marks</button>}
          {!!e.results.length && !e.resultsPublished && <button className="btn-success" disabled={publish.isPending} onClick={() => confirm('Publish results to students? This notifies them on WhatsApp/email.') && publish.mutate(undefined)}><Send className="h-4 w-4" /> Publish</button>}
        </>} />
      <div className="grid gap-4 sm:grid-cols-4">
        <Card><KV cols={1} items={[['Duration', `${e.durationMin} min`]]} /></Card>
        <Card><KV cols={1} items={[['Marks', `${e.totalMarks} (pass ${e.passMarks})`]]} /></Card>
        <Card><KV cols={1} items={[['Attempts allowed', e.attemptLimit]]} /></Card>
        <Card><KV cols={1} items={[['Assigned / attempted', `${e.assignments.length} / ${new Set(e.attempts.map((a: any) => a.studentId)).size}`]]} /></Card>
      </div>
      {!!inel.length && <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm"><p className="font-medium text-amber-900">{inel.length} student(s) not assigned (eligibility rules):</p><ul className="mt-2 space-y-1">{inel.map((x) => <li key={x.studentId} className="flex items-center justify-between"><span>{x.studentId.slice(-6)} — {x.reasons.join(', ')}</span><button className="btn-secondary btn-sm" onClick={() => exception.mutate(x.studentId)}>Request exception</button></li>)}</ul></div>}
      <Tabs value={tab} onChange={setTab} tabs={[{ key: 'questions', label: 'Questions', count: e.questions.length }, { key: 'students', label: 'Students & attempts', count: e.assignments.length }, { key: 'results', label: 'Results', count: e.results.length }]} />
      {tab === 'questions' && (
        <Card title={`${e.questions.length} questions · ${qMarks} marks${qMarks !== e.totalMarks && e.mode === 'ONLINE' ? ` (exam total is ${e.totalMarks})` : ''}`} actions={manage && e.attempts.length === 0 && <div className="flex gap-2"><button className="btn-secondary btn-sm" onClick={() => { setSel(e.questions.map((q: any) => q.questionId)); setPickQ(true); }}>Choose questions</button><div className="flex items-center gap-1"><input className="input h-8 w-16 py-0" type="number" min={1} value={rand} onChange={(x) => setRand(Number(x.target.value))} /><button className="btn-secondary btn-sm" onClick={() => setQ.mutate({ random: { count: rand, subjectId: e.subjectId ?? undefined } })}><Shuffle className="h-4 w-4" /> Random</button></div></div>} bodyClass="p-0">
          {e.questions.length ? <ol className="divide-y divide-slate-100">{e.questions.map((q: any, i: number) => <li key={q.id} className="px-5 py-3 text-sm"><p><b>{i + 1}.</b> {q.question.text} <span className="text-xs text-slate-500">({label(q.question.type)} · {q.question.marks} mk{q.question.negativeMarks ? ` · −${q.question.negativeMarks}` : ''})</span></p>{q.question.options && <p className="mt-1 text-xs text-slate-500">{(q.question.options as string[]).join(' · ')}</p>}</li>)}</ol> : <Empty title={e.mode === 'ONLINE' ? 'Add questions from the question bank' : 'Offline exam — enter marks under Students'} />}
        </Card>
      )}
      {tab === 'students' && (
        <Card bodyClass="p-0" actions={manage && e.mode === 'OFFLINE' && Object.keys(marks).length > 0 && <button className="btn-primary btn-sm" onClick={() => saveMarks.mutate(undefined)}>Save marks</button>} title="Assigned students">
          {e.assignments.length ? (
            <table className="min-w-full divide-y divide-slate-100">
              <thead className="bg-slate-50"><tr><th className="th">Student</th><th className="th">Attempts</th><th className="th">Score</th><th className="th">Tab switches</th>{e.mode === 'OFFLINE' && manage && <th className="th">Marks (/{e.totalMarks})</th>}</tr></thead>
              <tbody className="divide-y divide-slate-100">{e.assignments.map((a: any) => {
                const at = e.attempts.filter((x: any) => x.studentId === a.studentId);
                const last = at[0];
                const res = e.results.find((r: any) => r.studentId === a.studentId);
                return <tr key={a.id}><td className="td">{st[a.studentId]?.fullName} <span className="text-xs text-slate-500">{st[a.studentId]?.studentCode}</span></td><td className="td">{at.length ? <Badge status={last.status} /> : '—'}</td><td className="td">{last ? ((last.autoScore ?? 0) + (last.manualScore ?? 0)) : '—'}</td><td className="td">{last?.tabSwitches ? <span className="text-amber-700">{last.tabSwitches}</span> : '—'}</td>
                  {e.mode === 'OFFLINE' && manage && <td className="td"><input className="input h-8 w-24" type="number" min={0} max={e.totalMarks} disabled={res?.locked} placeholder={res ? String(res.marks) : ''} value={marks[a.studentId] ?? ''} onChange={(x) => setMarks({ ...marks, [a.studentId]: x.target.value })} /></td>}</tr>;
              })}</tbody>
            </table>
          ) : <Empty title="No students assigned" hint="Use “Assign batch” to assign eligible students." />}
        </Card>
      )}
      {tab === 'results' && (
        <Card bodyClass="p-0">
          {e.results.length ? (
            <table className="min-w-full divide-y divide-slate-100">
              <thead className="bg-slate-50"><tr><th className="th">#</th><th className="th">Student</th><th className="th">Marks</th><th className="th">%</th><th className="th">Grade</th><th className="th">Result</th><th className="th" /></tr></thead>
              <tbody className="divide-y divide-slate-100">{e.results.map((r: any, i: number) => <tr key={r.id}><td className="td text-slate-400">{i + 1}</td><td className="td">{st[r.studentId]?.fullName}</td><td className="td font-medium">{r.marks}</td><td className="td">{r.percentage}%</td><td className="td">{r.grade}</td><td className="td"><Badge status={r.passed ? 'APPROVED' : 'REJECTED'}>{r.passed ? 'Pass' : 'Fail'}</Badge> {r.locked && <Lock className="inline h-3 w-3 text-slate-400" />}</td><td className="td">{r.locked && can('exams:manage', 'materials:manage') && <button className="btn-ghost btn-sm" onClick={() => { setCorr(r); setCf({ newMarks: String(r.marks), reason: '', evidence: '' }); }}>Request correction</button>}</td></tr>)}</tbody>
            </table>
          ) : <Empty title="No results yet" hint={e.mode === 'ONLINE' ? 'Process results after attempts are evaluated.' : 'Enter marks under Students.'} />}
        </Card>
      )}
      <Modal open={pickQ} onClose={() => setPickQ(false)} title="Choose questions" size="xl" footer={<button className="btn-primary" onClick={() => setQ.mutate({ questionIds: sel })}>Use {sel.length} question(s)</button>}>
        <ul className="divide-y divide-slate-100">{bank.data?.items.map((q: any) => <li key={q.id}><label className="flex cursor-pointer gap-3 py-2.5 text-sm"><input type="checkbox" className="mt-0.5 rounded text-brand-600" checked={sel.includes(q.id)} onChange={() => setSel(sel.includes(q.id) ? sel.filter((x) => x !== q.id) : [...sel, q.id])} /><span className="flex-1">{q.text} <span className="text-xs text-slate-500">({label(q.type)} · {label(q.difficulty)} · {q.marks} mk)</span></span></label></li>)}</ul>
      </Modal>
      <Modal open={!!corr} onClose={() => setCorr(null)} title="Request result correction" footer={<button className="btn-primary" disabled={cf.reason.length < 5 || cf.evidence.length < 3 || correction.isPending} onClick={() => correction.mutate(undefined)}>Submit for approval</button>}>
        <div className="space-y-3"><Input label={`New marks (current ${corr?.marks})`} type="number" value={cf.newMarks} onChange={(x) => setCf({ ...cf, newMarks: x.target.value })} /><Textarea label="Reason" required value={cf.reason} onChange={(x) => setCf({ ...cf, reason: x.target.value })} /><Textarea label="Evidence (answer sheet ref., re-evaluation note)" required value={cf.evidence} onChange={(x) => setCf({ ...cf, evidence: x.target.value })} /></div>
      </Modal>
    </div>
  );
}
