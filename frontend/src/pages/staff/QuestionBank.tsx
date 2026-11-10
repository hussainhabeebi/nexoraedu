import { useState } from 'react';
import { Archive, Pencil, Plus, Trash2, Upload } from 'lucide-react';
import { api, qs } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { confirmDelete, useCourses, useDelete, useGet, useMut } from '@/lib/hooks';
import { label } from '@/lib/format';
import { parseCsv } from '@/lib/csv';
import { DataTable } from '@/components/DataTable';
import { Badge, Input, Modal, PageHeader, Select, Textarea } from '@/components/ui';

function QuestionModal({ open, onClose, courseId, question }: { open: boolean; onClose: () => void; courseId: string; question?: any }) {
  const courses = useCourses();
  const [f, setF] = useState<any>(() => question
    ? { courseId: question.courseId, subjectId: question.subjectId ?? '', topic: question.topic ?? '', difficulty: question.difficulty ?? 'MEDIUM', type: question.type, text: question.text, options: [...(question.options ?? []), '', '', '', ''].slice(0, Math.max(4, (question.options ?? []).length)), correct: question.correct == null ? [] : ([] as string[]).concat(question.correct).map(String), marks: Number(question.marks ?? 1), negativeMarks: Number(question.negativeMarks ?? 0) }
    : { courseId, subjectId: '', topic: '', difficulty: 'MEDIUM', type: 'MCQ_SINGLE', text: '', options: ['', '', '', ''], correct: [] as string[], marks: 1, negativeMarks: 0 });
  const course = useGet<any>(f.courseId ? `/academics/courses/${f.courseId}` : null);
  const isMcq = f.type.startsWith('MCQ');
  const m = useMut(() => {
    const options = isMcq ? f.options.filter((o: string) => o.trim()) : undefined;
    const correct = f.type === 'MCQ_SINGLE' ? f.correct[0] : f.type === 'MCQ_MULTI' ? f.correct : f.type === 'TRUE_FALSE' ? f.correct[0] : null;
    const body = { ...f, subjectId: f.subjectId || null, options, correct, marks: Number(f.marks), negativeMarks: Number(f.negativeMarks) };
    return question ? api(`/exams/questions/${question.id}`, { method: 'PATCH', body }) : api('/exams/questions', { body });
  }, { success: question ? 'Question updated' : 'Question added', invalidate: ['/exams'], onSuccess: onClose });
  const toggle = (o: string) => setF({ ...f, correct: f.type === 'MCQ_MULTI' ? (f.correct.includes(o) ? f.correct.filter((x: string) => x !== o) : [...f.correct, o]) : [o] });
  return (
    <Modal open={open} onClose={onClose} title={question ? "Edit question" : "New question"} size="lg" footer={<button className="btn-primary" disabled={!f.courseId || f.text.length < 3 || m.isPending} onClick={() => m.mutate(undefined)}>Save question</button>}>
      <div className="grid gap-4 sm:grid-cols-3">
        <Select label="Course" required value={f.courseId} onChange={(e) => setF({ ...f, courseId: e.target.value })} placeholder="Select" options={(courses.data?.items ?? []).map((c) => ({ value: c.id, label: c.name }))} />
        <Select label="Subject" value={f.subjectId} onChange={(e) => setF({ ...f, subjectId: e.target.value })} placeholder="—" options={(course.data?.subjects ?? []).map((s: any) => ({ value: s.id, label: s.name }))} />
        <Input label="Topic" value={f.topic} onChange={(e) => setF({ ...f, topic: e.target.value })} />
        <Select label="Type" value={f.type} onChange={(e) => setF({ ...f, type: e.target.value, correct: [] })} options={['MCQ_SINGLE', 'MCQ_MULTI', 'TRUE_FALSE', 'SHORT', 'LONG'].map((v) => ({ value: v, label: label(v) }))} />
        <Select label="Difficulty" value={f.difficulty} onChange={(e) => setF({ ...f, difficulty: e.target.value })} options={['EASY', 'MEDIUM', 'HARD'].map((v) => ({ value: v, label: label(v) }))} />
        <div className="grid grid-cols-2 gap-2"><Input label="Marks" type="number" value={f.marks} onChange={(e) => setF({ ...f, marks: e.target.value })} /><Input label="Negative" type="number" step="0.25" value={f.negativeMarks} onChange={(e) => setF({ ...f, negativeMarks: e.target.value })} /></div>
        <Textarea className="sm:col-span-3" label="Question" required value={f.text} onChange={(e) => setF({ ...f, text: e.target.value })} />
        {isMcq && <div className="space-y-2 sm:col-span-3"><p className="label">Options — tick the correct answer{f.type === 'MCQ_MULTI' ? 's' : ''}</p>{f.options.map((o: string, i: number) => <div key={i} className="flex items-center gap-2"><input type={f.type === 'MCQ_MULTI' ? 'checkbox' : 'radio'} name="correct" className="text-brand-600" checked={!!o && f.correct.includes(o)} onChange={() => o && toggle(o)} aria-label={`Option ${i + 1} correct`} /><input className="input" placeholder={`Option ${i + 1}`} value={o} onChange={(e) => { const x = [...f.options]; x[i] = e.target.value; setF({ ...f, options: x, correct: f.correct.filter((c: string) => c !== o) }); }} /></div>)}<button className="btn-ghost btn-sm" onClick={() => setF({ ...f, options: [...f.options, ''] })}><Plus className="h-4 w-4" /> Option</button></div>}
        {f.type === 'TRUE_FALSE' && <div className="flex gap-4 sm:col-span-3">{['True', 'False'].map((v) => <label key={v} className="flex items-center gap-2 text-sm"><input type="radio" name="tf" className="text-brand-600" checked={f.correct[0] === v} onChange={() => setF({ ...f, correct: [v] })} />{v}</label>)}</div>}
        {['SHORT', 'LONG'].includes(f.type) && <p className="text-sm text-slate-500 sm:col-span-3">Subjective answers go to an evaluator for manual marking.</p>}
      </div>
    </Modal>
  );
}

export default function QuestionBank() {
  const { can } = useAuth();
  const courses = useCourses();
  const [f, setF] = useState({ courseId: '', type: '', difficulty: '', q: '', status: 'ACTIVE' });
  const [page, setPage] = useState(1);
  const { data, isLoading } = useGet<any>(`/exams/questions${qs({ ...f, page, pageSize: 25 })}`);
  const [modal, setModal] = useState<'' | 'new' | 'import'>('');
  const [imp, setImp] = useState<{ courseId: string; rows: any[]; report?: any }>({ courseId: '', rows: [] });
  const del = useDelete('Question', ['/exams']);
  const [editing, setEditing] = useState<any>(null);
  const retire = useMut((id: string) => api(`/exams/questions/${id}`, { method: 'PATCH', body: { status: 'RETIRED' } }), { success: 'Question retired', invalidate: ['/exams'] });
  const doImport = useMut(() => api('/exams/questions/import', { body: { courseId: imp.courseId, rows: imp.rows } }), { invalidate: ['/exams'], onSuccess: (r: any) => setImp({ ...imp, report: r }) });
  return (
    <div>
      <PageHeader title="Question bank" actions={can('exams:manage') && <><button className="btn-secondary" onClick={() => setModal('import')}><Upload className="h-4 w-4" /> Import</button><button className="btn-primary" onClick={() => setModal('new')}><Plus className="h-4 w-4" /> New question</button></>} />
      <DataTable rows={data?.items ?? []} loading={isLoading} total={data?.total} page={page} pageSize={25} onPage={setPage}
        toolbar={<>
          <input className="input w-full sm:w-56" placeholder="Search text" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} aria-label="Search" />
          <select className="input w-auto" value={f.courseId} onChange={(e) => setF({ ...f, courseId: e.target.value })} aria-label="Course"><option value="">All courses</option>{courses.data?.items.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
          <select className="input w-auto" value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })} aria-label="Type"><option value="">All types</option>{['MCQ_SINGLE', 'MCQ_MULTI', 'TRUE_FALSE', 'SHORT', 'LONG'].map((v) => <option key={v} value={v}>{label(v)}</option>)}</select>
          <select className="input w-auto" value={f.difficulty} onChange={(e) => setF({ ...f, difficulty: e.target.value })} aria-label="Difficulty"><option value="">Any difficulty</option>{['EASY', 'MEDIUM', 'HARD'].map((v) => <option key={v} value={v}>{label(v)}</option>)}</select>
          <select className="input w-auto" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })} aria-label="Status"><option value="ACTIVE">Active</option><option value="RETIRED">Retired</option></select>
        </>}
        columns={[
          { key: 'text', header: 'Question', className: 'whitespace-normal', cell: (r: any) => <p className="max-w-xl">{r.text}</p> },
          { key: 'type', header: 'Type', cell: (r: any) => label(r.type) },
          { key: 'diff', header: 'Difficulty', cell: (r: any) => <Badge status={r.difficulty === 'HARD' ? 'REJECTED' : r.difficulty === 'EASY' ? 'APPROVED' : 'PENDING'}>{label(r.difficulty)}</Badge> },
          { key: 'marks', header: 'Marks', cell: (r: any) => r.marks },
          { key: 'used', header: 'Used in', cell: (r: any) => `${r._count.exams} exam(s)` },
          { key: 'act', header: '', cell: (r: any) => can('exams:manage') && (
            <span className="flex justify-end gap-1">
              {r._count.exams === 0 && <button className="btn-ghost btn-sm" onClick={() => setEditing(r)} title="Edit" aria-label="Edit question"><Pencil className="h-4 w-4" /></button>}
              {r.status === 'ACTIVE' && <button className="btn-ghost btn-sm" onClick={() => retire.mutate(r.id)} title="Retire" aria-label="Retire question"><Archive className="h-4 w-4" /></button>}
              {r._count.exams === 0 && <button className="btn-ghost btn-sm text-rose-600" onClick={() => confirmDelete('this question') && del.mutate(`/exams/questions/${r.id}`)} title="Delete" aria-label="Delete question"><Trash2 className="h-4 w-4" /></button>}
            </span>
          ) },
        ]} />
      {modal === 'new' && <QuestionModal open onClose={() => setModal('')} courseId={f.courseId} />}
      {editing && <QuestionModal open onClose={() => setEditing(null)} courseId={editing.courseId} question={editing} />}
      <Modal open={modal === 'import'} onClose={() => { setModal(''); setImp({ courseId: '', rows: [] }); }} title="Import questions" size="lg" footer={!imp.report && <button className="btn-primary" disabled={!imp.courseId || !imp.rows.length || doImport.isPending} onClick={() => doImport.mutate(undefined)}>Import {imp.rows.length}</button>}>
        {imp.report ? <div className="text-sm"><p className="font-medium">{imp.report.created} imported.</p><ul className="mt-2 max-h-64 overflow-auto text-rose-700">{imp.report.report.filter((x: any) => !x.ok).map((x: any) => <li key={x.row}>Row {x.row}: {x.error}</li>)}</ul></div> : (
          <div className="space-y-4">
            <Select label="Course" required value={imp.courseId} onChange={(e) => setImp({ ...imp, courseId: e.target.value })} placeholder="Select" options={(courses.data?.items ?? []).map((c) => ({ value: c.id, label: c.name }))} />
            <p className="text-sm text-slate-600">CSV columns: <code>type,text,options,correct,marks,negativeMarks,difficulty,topic</code>. Separate options (and multiple correct answers) with <code>|</code>.</p>
            <input type="file" accept=".csv" onChange={async (e) => { const file = e.target.files?.[0]; if (file) setImp({ ...imp, rows: parseCsv(await file.text()).map((r) => ({ ...r, type: r.type?.toUpperCase(), difficulty: r.difficulty?.toUpperCase() || undefined, marks: r.marks || 1, negativeMarks: r.negativemarks || r.negative_marks || 0 })) }); }} />
          </div>
        )}
      </Modal>
    </div>
  );
}
