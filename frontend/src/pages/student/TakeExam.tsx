import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, ChevronLeft, ChevronRight, Flag, Loader2 } from 'lucide-react';
import { api } from '@/lib/api';
import Logo from '@/components/Logo';
import { cx, ErrorBox, Modal, PageLoader } from '@/components/ui';

/** Online exam player (EXM-09/11): server-authoritative timer, auto-save, auto-submit, navigation palette, tab-switch logging. */
export default function TakeExam() {
  const { id } = useParams();
  const nav = useNavigate();
  const [att, setAtt] = useState<any>(null);
  const [err, setErr] = useState<unknown>(null);
  const [answers, setAnswers] = useState<Record<string, any>>({});
  const [flags, setFlags] = useState<string[]>([]);
  const [idx, setIdx] = useState(0);
  const [left, setLeft] = useState(0);
  const [saving, setSaving] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [confirm, setConfirm] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [warn, setWarn] = useState(0);
  const dirty = useRef<Record<string, any>>({});
  const offset = useRef(0);

  useEffect(() => {
    api(`/portal/exams/${id}/start`, { body: { acknowledged: true } })
      .then((a) => { setAtt(a); setAnswers(a.answers ?? {}); offset.current = new Date(a.serverTime).getTime() - Date.now(); })
      .catch(setErr);
  }, [id]);

  const flush = useCallback(async () => {
    if (!att || !Object.keys(dirty.current).length) return;
    const batch = dirty.current;
    dirty.current = {};
    setSaving('saving');
    try {
      await api(`/portal/attempts/${att.attemptId}/answers`, { method: 'PUT', body: { answers: batch } });
      setSaving('saved');
    } catch (e: any) {
      if (e.status === 409) setDone(e.message);
      else { dirty.current = { ...batch, ...dirty.current }; setSaving('error'); }
    }
  }, [att]);

  const submit = useCallback(async () => {
    if (!att) return;
    try {
      const r = await api(`/portal/attempts/${att.attemptId}/submit`, { body: { answers: { ...dirty.current } } });
      dirty.current = {};
      setDone(r.message);
    } catch (e: any) { setDone(e.message); }
  }, [att]);

  // Timer (server time based) + auto-submit
  useEffect(() => {
    if (!att || done) return;
    const tick = () => {
      const ms = new Date(att.deadline).getTime() - (Date.now() + offset.current);
      setLeft(Math.max(0, ms));
      if (ms <= 0) submit();
    };
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [att, done, submit]);

  // Auto-save every 5s
  useEffect(() => { const t = setInterval(flush, 5000); return () => clearInterval(t); }, [flush]);

  // Tab-switch logging (EXM-11) + leave warning
  useEffect(() => {
    if (!att || done) return;
    const onVis = () => { if (document.hidden) { setWarn((w) => w + 1); api(`/portal/attempts/${att.attemptId}/event`, { body: { type: 'TAB_SWITCH' } }).catch(() => undefined); } };
    const onLeave = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('beforeunload', onLeave);
    return () => { document.removeEventListener('visibilitychange', onVis); window.removeEventListener('beforeunload', onLeave); };
  }, [att, done]);

  const setAns = (qid: string, v: any) => { setAnswers((a) => ({ ...a, [qid]: v })); dirty.current[qid] = v; setSaving('idle'); };

  if (err) return <div className="mx-auto max-w-lg p-8"><ErrorBox error={err} /><button className="btn-secondary mt-4" onClick={() => nav('/student/exams')}>Back to exams</button></div>;
  if (done) return <div className="flex min-h-screen flex-col items-center justify-center p-6 text-center"><CheckCircle2 className="h-16 w-16 text-emerald-500" /><h1 className="mt-4 text-2xl font-bold">Exam submitted</h1><p className="mt-2 max-w-md text-slate-600">{done}</p><button className="btn-primary mt-6" onClick={() => nav('/student/exams')}>Back to exams</button></div>;
  if (!att) return <PageLoader />;

  const q = att.questions[idx];
  const mm = Math.floor(left / 60000), ss = Math.floor((left % 60000) / 1000);
  const answered = att.questions.filter((x: any) => answers[x.id] != null && answers[x.id] !== '' && !(Array.isArray(answers[x.id]) && !answers[x.id].length)).length;

  return (
    <div className="flex min-h-screen flex-col bg-slate-50">
      <header className="sticky top-0 z-10 flex items-center gap-4 border-b border-slate-200 bg-white px-4 py-3">
        <Logo compact />
        <p className="truncate font-semibold">{att.exam.title}</p>
        <span className="ml-auto text-xs text-slate-500">{saving === 'saving' ? <span className="inline-flex items-center gap-1"><Loader2 className="h-3 w-3 animate-spin" /> Saving</span> : saving === 'saved' ? 'All answers saved' : saving === 'error' ? <span className="text-rose-600">Offline — will retry</span> : ''}</span>
        <div className={cx('rounded-lg px-3 py-1.5 font-mono text-lg font-bold', left < 5 * 60000 ? 'bg-rose-100 text-rose-700' : 'bg-slate-100')} role="timer" aria-live="polite">{String(mm).padStart(2, '0')}:{String(ss).padStart(2, '0')}</div>
        <button className="btn-primary" onClick={() => { flush(); setConfirm(true); }}>Submit</button>
      </header>
      {warn > 0 && <p className="flex items-center justify-center gap-2 bg-amber-100 py-2 text-sm text-amber-900"><AlertTriangle className="h-4 w-4" /> Leaving the exam window is recorded ({warn}).</p>}
      <div className="mx-auto grid w-full max-w-6xl flex-1 gap-6 p-4 lg:grid-cols-[1fr_260px]">
        <main className="card p-6">
          <div className="mb-4 flex items-center justify-between text-sm text-slate-500"><span>Question {q.n} of {att.questions.length}</span><span>{q.marks} mark{q.marks > 1 ? 's' : ''}{q.negativeMarks ? ` · −${q.negativeMarks} if wrong` : ''}</span></div>
          <p className="whitespace-pre-wrap text-lg font-medium text-slate-900">{q.text}</p>
          <div className="mt-6 space-y-3">
            {(q.type === 'MCQ_SINGLE' || q.type === 'TRUE_FALSE') && (q.options ?? ['True', 'False']).map((o: string) => (
              <label key={o} className={cx('flex cursor-pointer items-center gap-3 rounded-xl border p-4 transition', answers[q.id] === o ? 'border-brand-500 bg-brand-50 ring-2 ring-brand-100' : 'border-slate-200 hover:border-slate-300')}>
                <input type="radio" name={q.id} className="text-brand-600" checked={answers[q.id] === o} onChange={() => setAns(q.id, o)} />{o}
              </label>
            ))}
            {q.type === 'MCQ_MULTI' && q.options.map((o: string) => { const cur: string[] = answers[q.id] ?? []; return (
              <label key={o} className={cx('flex cursor-pointer items-center gap-3 rounded-xl border p-4', cur.includes(o) ? 'border-brand-500 bg-brand-50' : 'border-slate-200')}>
                <input type="checkbox" className="rounded text-brand-600" checked={cur.includes(o)} onChange={() => setAns(q.id, cur.includes(o) ? cur.filter((x) => x !== o) : [...cur, o])} />{o}
              </label>); })}
            {(q.type === 'SHORT' || q.type === 'LONG') && <textarea className="input" rows={q.type === 'LONG' ? 10 : 3} value={answers[q.id] ?? ''} onChange={(e) => setAns(q.id, e.target.value)} placeholder="Type your answer" aria-label="Answer" />}
          </div>
          <div className="mt-8 flex flex-wrap justify-between gap-2">
            <button className="btn-secondary" disabled={idx === 0} onClick={() => setIdx(idx - 1)}><ChevronLeft className="h-4 w-4" /> Previous</button>
            <div className="flex gap-2">
              {answers[q.id] != null && <button className="btn-ghost" onClick={() => setAns(q.id, q.type === 'MCQ_MULTI' ? [] : '')}>Clear</button>}
              <button className={cx('btn-ghost', flags.includes(q.id) && 'text-amber-600')} onClick={() => setFlags(flags.includes(q.id) ? flags.filter((x) => x !== q.id) : [...flags, q.id])}><Flag className="h-4 w-4" /> {flags.includes(q.id) ? 'Flagged' : 'Flag'}</button>
            </div>
            <button className="btn-primary" disabled={idx === att.questions.length - 1} onClick={() => { flush(); setIdx(idx + 1); }}>Next <ChevronRight className="h-4 w-4" /></button>
          </div>
        </main>
        <aside className="card h-fit p-4">
          <p className="mb-3 text-sm font-medium">{answered} / {att.questions.length} answered</p>
          <div className="grid grid-cols-6 gap-2 lg:grid-cols-5">
            {att.questions.map((x: any, i: number) => { const a = answers[x.id] != null && answers[x.id] !== '' && !(Array.isArray(answers[x.id]) && !answers[x.id].length); return (
              <button key={x.id} onClick={() => { flush(); setIdx(i); }} aria-label={`Question ${i + 1}${a ? ', answered' : ''}${flags.includes(x.id) ? ', flagged' : ''}`} className={cx('relative h-10 rounded-lg text-sm font-semibold', i === idx && 'ring-2 ring-brand-500', a ? 'bg-emerald-500 text-white' : 'bg-slate-100 text-slate-600')}>
                {i + 1}{flags.includes(x.id) && <span className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full bg-amber-500" />}
              </button>); })}
          </div>
          <div className="mt-4 space-y-1 text-xs text-slate-500"><p><span className="mr-1 inline-block h-2.5 w-2.5 rounded bg-emerald-500" />Answered</p><p><span className="mr-1 inline-block h-2.5 w-2.5 rounded bg-slate-200" />Not answered</p><p><span className="mr-1 inline-block h-2.5 w-2.5 rounded-full bg-amber-500" />Flagged for review</p></div>
        </aside>
      </div>
      <Modal open={confirm} onClose={() => setConfirm(false)} title="Submit exam?" size="sm" footer={<><button className="btn-secondary" onClick={() => setConfirm(false)}>Keep working</button><button className="btn-primary" onClick={submit}>Submit now</button></>}>
        <p className="text-sm text-slate-600">You have answered <b>{answered}</b> of <b>{att.questions.length}</b> questions{flags.length ? ` and flagged ${flags.length}` : ''}. You cannot change answers after submitting.</p>
      </Modal>
    </div>
  );
}
