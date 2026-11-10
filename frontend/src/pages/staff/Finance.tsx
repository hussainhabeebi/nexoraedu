import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis, Legend } from 'recharts';
import { BellRing, Download, FileDown, Plus, Search } from 'lucide-react';
import { toast } from 'sonner';
import { api, download, qs } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useBatches, useCourses, useGet, useMut } from '@/lib/hooks';
import { d, inr, label } from '@/lib/format';
import { DataTable } from '@/components/DataTable';
import { RecordPaymentModal } from '@/components/StudentAccount';
import { Badge, Card, Empty, Modal, PageHeader, PageLoader, Stat, Tabs, useDebounced } from '@/components/ui';

const COLORS = ['#4f46e5', '#10b981', '#f59e0b', '#0ea5e9', '#c026d3', '#64748b'];

function StudentPicker({ onPick }: { onPick: (s: any) => void }) {
  const [q, setQ] = useState('');
  const dq = useDebounced(q);
  const { data } = useGet<any>(dq.length > 1 ? `/students?q=${encodeURIComponent(dq)}&pageSize=8` : null);
  return (
    <div>
      <div className="relative"><Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" /><input autoFocus className="input pl-9" placeholder="Search by name, ID or phone" value={q} onChange={(e) => setQ(e.target.value)} /></div>
      <ul className="mt-3 divide-y divide-slate-100">
        {data?.items.map((s: any) => <li key={s.id}><button className="flex w-full justify-between px-2 py-2.5 text-left text-sm hover:bg-slate-50" onClick={() => onPick(s)}><span><b>{s.fullName}</b> <span className="text-slate-500">{s.studentCode}</span></span><span className={s.balance > 0 ? 'text-rose-600' : 'text-emerald-600'}>{inr(s.balance)}</span></button></li>)}
      </ul>
    </div>
  );
}

function Payments() {
  const { can } = useAuth();
  const nav = useNavigate();
  const [f, setF] = useState({ q: '', mode: '', status: '', from: '', to: '' });
  const dq = useDebounced(f.q);
  const [page, setPage] = useState(1);
  const [pick, setPick] = useState(false);
  const [student, setStudent] = useState<any>(null);
  const params = { ...f, q: dq, page, pageSize: 25 };
  const { data, isLoading } = useGet<any>(`/finance/payments${qs(params)}`);
  return (
    <>
      <div className="mb-4 flex flex-wrap justify-end gap-2">
        <button className="btn-secondary" onClick={() => download(`/finance/payments${qs({ ...params, format: 'csv' })}`, 'payments.csv').catch((e) => toast.error(e.message))}><Download className="h-4 w-4" /> Export</button>
        {can('finance:collect') && <button className="btn-primary" onClick={() => setPick(true)}><Plus className="h-4 w-4" /> Record payment</button>}
      </div>
      <DataTable rows={data?.items ?? []} loading={isLoading} total={data?.total} page={page} pageSize={25} onPage={setPage}
        toolbar={<>
          <input className="input w-full sm:w-56" placeholder="Receipt, reference, student" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} aria-label="Search payments" />
          <select className="input w-auto" value={f.mode} onChange={(e) => setF({ ...f, mode: e.target.value })} aria-label="Mode"><option value="">All modes</option>{['CASH', 'UPI', 'CARD', 'BANK_TRANSFER', 'CHEQUE', 'ONLINE'].map((m) => <option key={m} value={m}>{label(m)}</option>)}</select>
          <select className="input w-auto" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })} aria-label="Status"><option value="">All statuses</option>{['POSTED', 'CANCEL_REQUESTED', 'CANCELLED'].map((m) => <option key={m} value={m}>{label(m)}</option>)}</select>
          <input type="date" className="input w-auto" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} aria-label="From" />
          <input type="date" className="input w-auto" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} aria-label="To" />
          {data && <span className="ml-auto text-sm font-medium">Total: {inr(data.sum)}</span>}
        </>}
        columns={[
          { key: 'receipt', header: 'Receipt', cell: (r: any) => <span className="font-medium">{r.receiptNumber}</span> },
          { key: 'date', header: 'Date', cell: (r: any) => d(r.paidAt) },
          { key: 'student', header: 'Student', cell: (r: any) => <button className="link" onClick={() => nav(`/staff/students/${r.student.id}?tab=fees`)}>{r.student.fullName}</button> },
          { key: 'amount', header: 'Amount', cell: (r: any) => inr(r.amount) },
          { key: 'mode', header: 'Mode', cell: (r: any) => <>{label(r.mode)}{r.reference && <span className="text-xs text-slate-500"> · {r.reference}</span>}</> },
          { key: 'status', header: 'Status', cell: (r: any) => <Badge status={r.status} /> },
          { key: 'pdf', header: '', cell: (r: any) => <button className="btn-ghost btn-sm" onClick={() => download(`/finance/payments/${r.id}/receipt.pdf`, `${r.receiptNumber}.pdf`, true)} aria-label="Receipt"><FileDown className="h-4 w-4" /></button> },
        ]} />
      <Modal open={pick} onClose={() => setPick(false)} title="Select student"><StudentPicker onPick={(s) => { setPick(false); setStudent(s); }} /></Modal>
      {student && <RecordPaymentModal open onClose={() => setStudent(null)} studentId={student.id} balance={student.balance} />}
    </>
  );
}

function Outstanding() {
  const courses = useCourses();
  const [f, setF] = useState({ courseId: '', batchId: '', onlyOverdue: 'true' });
  const batches = useBatches(f.courseId || undefined);
  const { data, isLoading } = useGet<any>(`/finance/outstanding${qs(f)}`);
  const { can } = useAuth();
  const remind = useMut((studentIds?: string[]) => api('/finance/reminders/send', { body: studentIds ? { studentIds } : { overdueOnly: true } }), { success: reminderSummary, invalidate: ['/finance/reminders'] });
  if (isLoading) return <PageLoader />;
  const b = data.buckets;
  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-5">
        <Stat label="Not yet due" value={inr(b.notDue, { decimals: false })} tone="sky" />
        <Stat label="0–30 days" value={inr(b.d0_30, { decimals: false })} tone="amber" />
        <Stat label="31–60 days" value={inr(b.d31_60, { decimals: false })} tone="amber" />
        <Stat label="61–90 days" value={inr(b.d61_90, { decimals: false })} tone="rose" />
        <Stat label="90+ days" value={inr(b.d90p, { decimals: false })} tone="rose" />
      </div>
      <DataTable rows={data.items.map((r: any) => ({ ...r, id: r.studentId }))}
        toolbar={<>
          <select className="input w-auto" value={f.courseId} onChange={(e) => setF({ ...f, courseId: e.target.value, batchId: '' })} aria-label="Course"><option value="">All courses</option>{courses.data?.items.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
          <select className="input w-auto" value={f.batchId} onChange={(e) => setF({ ...f, batchId: e.target.value })} aria-label="Batch"><option value="">All batches</option>{batches.data?.items.map((x) => <option key={x.id} value={x.id}>{x.code}</option>)}</select>
          <label className="flex items-center gap-1.5 text-sm"><input type="checkbox" className="rounded text-brand-600" checked={f.onlyOverdue === 'true'} onChange={(e) => setF({ ...f, onlyOverdue: String(e.target.checked) })} /> Overdue only</label>
          <span className="ml-auto text-sm font-medium">Total due: {inr(data.total)}</span>
          <button className="btn-secondary btn-sm" onClick={() => download(`/finance/outstanding${qs({ ...f, format: 'csv' })}`, 'outstanding.csv')}><Download className="h-4 w-4" /> CSV</button>
          {can('finance:collect') && <button className="btn-success btn-sm" disabled={remind.isPending} onClick={() => remind.mutate(undefined)} title={can('finance:manage') ? 'All overdue students' : 'Overdue students assigned to you'}><BellRing className="h-4 w-4" /> Remind all overdue</button>}
        </>}
        empty={<Empty title="No outstanding fees 🎉" />}
        columns={[
          { key: 'name', header: 'Student', cell: (r: any) => <Link className="link" to={`/staff/students/${r.studentId}?tab=fees`}>{r.name}</Link> },
          { key: 'code', header: 'ID', cell: (r: any) => r.studentCode },
          { key: 'course', header: 'Course / batch', cell: (r: any) => `${r.course}${r.batch ? ` · ${r.batch}` : ''}` },
          { key: 'phone', header: 'Phone', cell: (r: any) => r.phone },
          { key: 'due', header: 'Total due', cell: (r: any) => inr(r.due) },
          { key: 'overdue', header: 'Overdue', cell: (r: any) => <span className={r.overdue > 0 ? 'font-semibold text-rose-600' : ''}>{inr(r.overdue)}</span> },
          { key: 'days', header: 'Days overdue', cell: (r: any) => (r.maxDaysOverdue > 0 ? r.maxDaysOverdue : '—') },
          ...(can('finance:collect') ? [{ key: 'remind', header: '', cell: (r: any) => <button className="btn-ghost btn-sm" disabled={remind.isPending} onClick={() => remind.mutate([r.studentId])} aria-label={`Remind ${r.name}`}><BellRing className="h-4 w-4" /> Remind</button> }] : []),
        ]} />
    </div>
  );
}

const reminderSummary = (r: any) =>
  `${r.queued} reminder(s) for ${r.students} student(s): ${r.sent} sent${r.failed ? `, ${r.failed} failed (will retry)` : ''}${r.skipped ? `, ${r.skipped} skipped` : ''}${r.pending ? `, ${r.pending} queued` : ''}${r.duplicate ? ` · ${r.duplicate} already sent today` : ''}`;

const STAGE = (s: string) => (s.startsWith('MANUAL_') ? `Manual (${s.slice(7)})` : s === 'DUE' ? 'Due day' : s.startsWith('BEFORE_') ? `${s.slice(7)} days before` : `${s.slice(8)} day(s) overdue`);

function Reminders() {
  const { can } = useAuth();
  const [f, setF] = useState({ status: '', channel: '', trigger: '' });
  const [page, setPage] = useState(1);
  const { data, isLoading } = useGet<any>(`/finance/reminders${qs({ ...f, page, pageSize: 25 })}`);
  const retry = useMut((id: string) => api(`/finance/reminders/${id}/retry`, { body: {} }), { success: (r: any) => (r.sent ? 'Reminder sent' : `Not sent: ${r.reminder?.lastError ?? 'see status'}`), invalidate: ['/finance/reminders'] });
  const run = useMut(() => api('/finance/reminders/run', { body: {} }), { success: (r: any) => `Schedule run: ${r.queued} queued, ${r.sent} sent, ${r.failed} failed, ${r.skipped} skipped`, invalidate: ['/finance/reminders'] });
  return (
    <>
      <p className="mb-4 text-sm text-slate-600">Automatic reminders go to students and their parents / guardians 5 and 2 days before the due date, on the due date, the day after, and then every 7 days until paid (WhatsApp and email where configured, and in-app). Each reminder is sent once; failed ones are retried automatically.</p>
      <DataTable rows={data?.items ?? []} loading={isLoading} total={data?.total} page={page} pageSize={25} onPage={setPage}
        toolbar={<>
          <select className="input w-auto" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })} aria-label="Status"><option value="">All statuses</option>{['SENT', 'FAILED', 'QUEUED', 'SKIPPED'].map((m) => <option key={m} value={m}>{label(m)}</option>)}</select>
          <select className="input w-auto" value={f.channel} onChange={(e) => setF({ ...f, channel: e.target.value })} aria-label="Channel"><option value="">All channels</option>{['WHATSAPP', 'EMAIL', 'IN_APP'].map((m) => <option key={m} value={m}>{label(m)}</option>)}</select>
          <select className="input w-auto" value={f.trigger} onChange={(e) => setF({ ...f, trigger: e.target.value })} aria-label="Type"><option value="">Automatic and manual</option><option value="AUTO">Automatic</option><option value="MANUAL">Manual</option></select>
          {can('finance:manage') && <button className="btn-secondary btn-sm ml-auto" disabled={run.isPending} onClick={() => run.mutate(undefined)}><BellRing className="h-4 w-4" /> Run schedule now</button>}
        </>}
        empty={<Empty title="No reminders yet" />}
        columns={[
          { key: 'when', header: 'Created', cell: (r: any) => d(r.createdAt) },
          { key: 'student', header: 'Student', cell: (r: any) => (r.student ? <Link className="link" to={`/staff/students/${r.student.id}?tab=fees`}>{r.student.fullName}</Link> : '—') },
          { key: 'to', header: 'Recipient', cell: (r: any) => <>{r.recipient?.name}{r.recipient?.relation && <span className="text-xs text-slate-500"> · {r.recipient.relation}</span>}<div className="text-xs text-slate-500">{label(r.channel)} · {r.address}</div></> },
          { key: 'fee', header: 'Fee month', cell: (r: any) => <>{r.installment.feeMonth}<div className="text-xs text-slate-500">Due {d(r.installment.dueDate)}</div></> },
          { key: 'stage', header: 'Reminder', cell: (r: any) => STAGE(r.stage) },
          { key: 'status', header: 'Status', cell: (r: any) => <><Badge status={r.status} />{r.attempts > 1 && <span className="text-xs text-slate-500"> · {r.attempts} attempts</span>}{r.lastError && <div className="max-w-xs truncate text-xs text-rose-600" title={r.lastError}>{r.lastError}</div>}</> },
          { key: 'retry', header: '', cell: (r: any) => (r.status === 'FAILED' && can('finance:collect') ? <button className="btn-ghost btn-sm" disabled={retry.isPending} onClick={() => retry.mutate(r.id)}>Retry</button> : null) },
        ]} />
    </>
  );
}

function Collections() {
  const [f, setF] = useState({ from: new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10), to: new Date().toISOString().slice(0, 10) });
  const { data, isLoading } = useGet<any>(`/finance/collections${qs(f)}`);
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-sm"><span className="label">From</span><input type="date" className="input" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /></label>
        <label className="text-sm"><span className="label">To</span><input type="date" className="input" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></label>
        {data && <Stat label="Collected" value={inr(data.total)} tone="green" />}
      </div>
      {isLoading ? <PageLoader /> : (
        <div className="grid gap-6 lg:grid-cols-3">
          <Card title="Daily collection" className="lg:col-span-2">
            <div className="h-64"><ResponsiveContainer><BarChart data={data.byDay.map((x: any) => ({ ...x, day: d(x.day).slice(0, 6) }))}><CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" /><XAxis dataKey="day" tick={{ fontSize: 11 }} /><YAxis tick={{ fontSize: 11 }} /><Tooltip formatter={(v: any) => inr(v)} /><Bar dataKey="amount" fill="#10b981" radius={[4, 4, 0, 0]} name="Collected" /></BarChart></ResponsiveContainer></div>
          </Card>
          <Card title="By payment mode">
            {data.byMode.length ? <div className="h-64"><ResponsiveContainer><PieChart><Pie data={data.byMode} dataKey="amount" nameKey="mode" innerRadius={50} outerRadius={85}>{data.byMode.map((_: any, i: number) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}</Pie><Tooltip formatter={(v: any) => inr(v)} /><Legend formatter={(v) => label(v)} wrapperStyle={{ fontSize: 12 }} /></PieChart></ResponsiveContainer></div> : <Empty title="No collections" />}
          </Card>
          <Card title="By course" bodyClass="p-0"><ul className="divide-y divide-slate-100">{data.byCourse.map((x: any) => <li key={x.course} className="flex justify-between px-5 py-3 text-sm"><span>{x.course}</span><b>{inr(x.amount)}</b></li>)}</ul></Card>
          <Card title="By collector" bodyClass="p-0"><ul className="divide-y divide-slate-100">{data.byCollector.map((x: any) => <li key={x.collector} className="flex justify-between px-5 py-3 text-sm"><span>{x.collector}</span><b>{inr(x.amount)}</b></li>)}</ul></Card>
          <Card title="Cash / bank reconciliation" bodyClass="p-0"><ul className="divide-y divide-slate-100">{data.byMode.map((x: any) => <li key={x.mode} className="flex justify-between px-5 py-3 text-sm"><span>{label(x.mode)} <span className="text-slate-400">({x.count})</span></span><b>{inr(x.amount)}</b></li>)}</ul></Card>
        </div>
      )}
    </div>
  );
}

export default function Finance() {
  const loc = useLocation();
  const nav = useNavigate();
  const tab = (loc.pathname.split('/')[3] as 'payments' | 'outstanding' | 'reminders' | 'collections') || 'payments';
  return (
    <div>
      <PageHeader title="Fees & payments" subtitle="Record payments, track dues and reconcile collections." />
      <Tabs value={tab} onChange={(k) => nav(`/staff/finance/${k}`)} tabs={[{ key: 'payments', label: 'Payments' }, { key: 'outstanding', label: 'Outstanding & ageing' }, { key: 'reminders', label: 'Reminders' }, { key: 'collections', label: 'Collections' }]} />
      {tab === 'payments' && <Payments />}
      {tab === 'outstanding' && <Outstanding />}
      {tab === 'reminders' && <Reminders />}
      {tab === 'collections' && <Collections />}
    </div>
  );
}
