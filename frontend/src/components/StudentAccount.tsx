import { useState } from 'react';
import { CalendarClock, FileDown, Percent, Plus, Trash2, Undo2, XCircle } from 'lucide-react';
import { api, download } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useGet, useMasters, useMut } from '@/lib/hooks';
import { d, dt, inr, label } from '@/lib/format';
import { Badge, Card, Confirm, Empty, Input, Modal, PageLoader, Progress, Select, Spinner, Stat, Textarea } from './ui';

export function RecordPaymentModal({ open, onClose, studentId, balance }: { open: boolean; onClose: () => void; studentId: string; balance: number }) {
  const [f, setF] = useState({ amount: '', mode: 'UPI', reference: '', payer: '', paidAt: new Date().toISOString().slice(0, 10) });
  const [key] = useState(() => crypto.randomUUID());
  const m = useMut(() => api('/finance/payments', { body: { studentId, ...f, amount: Number(f.amount), paidAt: new Date(f.paidAt) }, headers: { 'Idempotency-Key': key } }), {
    success: (r: any) => `Payment recorded — receipt ${r.receiptNumber}`, invalidate: ['/finance', '/students', '/dashboard'], onSuccess: (r: any) => { onClose(); download(`/finance/payments/${r.id}/receipt.pdf`, `${r.receiptNumber}.pdf`, true); },
  });
  const needsRef = ['CHEQUE', 'BANK_TRANSFER', 'UPI', 'CARD'].includes(f.mode);
  return (
    <Modal open={open} onClose={onClose} title="Record payment" footer={<><button className="btn-secondary" onClick={onClose}>Cancel</button><button className="btn-primary" disabled={!f.amount || Number(f.amount) <= 0 || Number(f.amount) > balance || (needsRef && !f.reference) || m.isPending} onClick={() => m.mutate(undefined)}>{m.isPending && <Spinner className="h-4 w-4 text-white" />} Record & issue receipt</button></>}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Input label="Amount (₹)" type="number" min={1} step="0.01" required value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} hint={`Outstanding: ${inr(balance)}`} error={Number(f.amount) > balance ? 'Amount exceeds the outstanding balance' : undefined} />
        <Select label="Mode" value={f.mode} onChange={(e) => setF({ ...f, mode: e.target.value })} options={['CASH', 'UPI', 'CARD', 'BANK_TRANSFER', 'CHEQUE'].map((v) => ({ value: v, label: label(v) }))} />
        <Input label="Reference / transaction no." required={needsRef} value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} />
        <Input label="Payment date" type="date" value={f.paidAt} onChange={(e) => setF({ ...f, paidAt: e.target.value })} max={new Date().toISOString().slice(0, 10)} />
        <Input className="sm:col-span-2" label="Paid by" value={f.payer} onChange={(e) => setF({ ...f, payer: e.target.value })} placeholder="Student / parent name" />
      </div>
      <p className="mt-3 text-xs text-slate-500">The amount is allocated to the oldest unpaid installments. Posted payments cannot be edited — only cancelled with approval.</p>
    </Modal>
  );
}

type Row = { dueDate: string; amount: string };
const today = () => new Date().toISOString().slice(0, 10);
const plusMonths = (iso: string, n: number) => { const x = new Date(iso + 'T00:00:00'); x.setMonth(x.getMonth() + n); return x.toISOString().slice(0, 10); };
const paise = (v: string | number) => Math.round(Number(v || 0) * 100);

/** SRS 22.6: waiver or custom installment plan — always submitted for approval, applied only when approved. */
function FeeAdjustmentModal({ open, onClose, studentId, plan, unpaid }: { open: boolean; onClose: () => void; studentId: string; plan: any; unpaid: number }) {
  const [kind, setKind] = useState<'WAIVER' | 'RESCHEDULE'>('WAIVER');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [rows, setRows] = useState<Row[]>([]);
  const split = (n: number) => {
    const total = paise(unpaid), base = Math.floor(total / n);
    setRows(Array.from({ length: n }, (_, i) => ({ dueDate: plusMonths(today(), i), amount: ((i === n - 1 ? total - base * (n - 1) : base) / 100).toFixed(2) })));
  };
  const sum = rows.reduce((s, r) => s + paise(r.amount), 0);
  const m = useMut(() => api('/finance/adjustments', { body: kind === 'WAIVER' ? { kind, studentId, feePlanId: plan.id, amount: Number(amount), reason } : { kind, studentId, feePlanId: plan.id, reason, schedule: rows.map((r) => ({ dueDate: r.dueDate, amount: Number(r.amount) })) } }), {
    success: 'Fee adjustment sent for approval', invalidate: ['/finance', '/students', '/approvals'], onSuccess: () => { onClose(); setAmount(''); setReason(''); setRows([]); },
  });
  const valid = reason.trim().length >= 5 && (kind === 'WAIVER' ? Number(amount) > 0 && paise(amount) <= paise(unpaid) : rows.length > 0 && sum === paise(unpaid) && rows.every((r) => r.dueDate >= today() && Number(r.amount) > 0));
  return (
    <Modal open={open} onClose={onClose} title="Fee adjustment" size="lg" footer={<><button className="btn-secondary" onClick={onClose}>Cancel</button><button className="btn-primary" disabled={!valid || m.isPending} onClick={() => m.mutate(undefined)}>{m.isPending && <Spinner className="h-4 w-4 text-white" />} Submit for approval</button></>}>
      <div className="space-y-4">
        <Select label="Adjustment" value={kind} onChange={(e) => { setKind(e.target.value as any); if (e.target.value === 'RESCHEDULE' && !rows.length) split(2); }} options={[{ value: 'WAIVER', label: 'Waive unpaid amount' }, { value: 'RESCHEDULE', label: 'Custom installment plan (reschedule unpaid amount)' }]} />
        <p className="text-sm text-slate-600">Unpaid on this plan: <span className="font-medium">{inr(unpaid)}</span>. Paid amounts cannot be waived — use a refund instead.</p>
        {kind === 'WAIVER' ? (
          <Input label="Amount to waive (₹)" type="number" min={1} step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} error={paise(amount) > paise(unpaid) ? 'More than the unpaid amount' : undefined} hint="Reduces the last installments first." />
        ) : (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2 text-sm"><span className="text-slate-500">Split evenly into</span>{[1, 2, 3, 4, 6].map((n) => <button key={n} type="button" className="btn-secondary btn-sm" onClick={() => split(n)}>{n}</button>)}</div>
            {rows.map((r, i) => (
              <div key={i} className="flex items-end gap-2">
                <Input className="flex-1" label={`#${i + 1} due date`} type="date" min={today()} value={r.dueDate} onChange={(e) => setRows(rows.map((x, k) => (k === i ? { ...x, dueDate: e.target.value } : x)))} />
                <Input className="flex-1" label="Amount (₹)" type="number" step="0.01" min={0} value={r.amount} onChange={(e) => setRows(rows.map((x, k) => (k === i ? { ...x, amount: e.target.value } : x)))} />
                <button type="button" className="btn-ghost btn-sm text-rose-600" aria-label="Remove installment" onClick={() => setRows(rows.filter((_, k) => k !== i))}><Trash2 className="h-4 w-4" /></button>
              </div>
            ))}
            <button type="button" className="btn-secondary btn-sm" disabled={rows.length >= 24} onClick={() => setRows([...rows, { dueDate: plusMonths(rows[rows.length - 1]?.dueDate ?? today(), 1), amount: '' }])}><Plus className="h-4 w-4" /> Add installment</button>
            <p className={`text-sm ${sum === paise(unpaid) ? 'text-emerald-700' : 'text-rose-600'}`}>Total {inr(sum / 100)} of {inr(unpaid)}{sum !== paise(unpaid) && ' — must match exactly'}</p>
          </div>
        )}
        <Textarea label="Reason" required value={reason} onChange={(e) => setReason(e.target.value)} hint="At least 5 characters. Shown to the approvers and kept in the audit history." />
        <p className="text-xs text-slate-500">Needs Finance Manager approval (Management above the configured threshold). Nothing changes until it is approved; if payments change the unpaid amount meanwhile, the request must be re-submitted.</p>
      </div>
    </Modal>
  );
}

export default function StudentAccount({ studentId }: { studentId: string }) {
  const { can } = useAuth();
  const { data, isLoading } = useGet<any>(`/finance/students/${studentId}/account`);
  const reasons = useMasters('discount_reason');
  const [modal, setModal] = useState<'' | 'pay' | 'discount' | 'refund' | 'plan' | 'adjust'>('');
  const [planId, setPlanId] = useState('');
  const [cancel, setCancel] = useState<any>(null);
  const [payRefund, setPayRefund] = useState<any>(null);
  const [disc, setDisc] = useState({ kind: 'FIXED', value: '', reason: '' });
  const [ref, setRef] = useState({ amount: '', reason: '' });
  const [plan, setPlan] = useState('1');
  const inv = ['/finance', '/students', '/dashboard', '/approvals'];
  const cancelM = useMut((reason: string) => api(`/finance/payments/${cancel.id}/cancel-request`, { body: { reason } }), { success: 'Cancellation sent for approval', invalidate: inv, onSuccess: () => setCancel(null) });
  const discM = useMut(() => api('/finance/discounts', { body: { studentId, ...disc, value: Number(disc.value) } }), { success: (r: any) => (r.approval.status === 'APPROVED' ? 'Discount applied' : 'Discount sent for approval'), invalidate: inv, onSuccess: () => setModal('') });
  const refM = useMut(() => api('/finance/refunds', { body: { studentId, amount: Number(ref.amount), reason: ref.reason } }), { success: 'Refund request sent for approval', invalidate: inv, onSuccess: () => setModal('') });
  const payRefM = useMut((reference: string) => api(`/finance/refunds/${payRefund.id}/pay`, { body: { reference } }), { success: 'Refund marked paid', invalidate: inv, onSuccess: () => setPayRefund(null) });
  const planM = useMut(() => api(`/finance/students/${studentId}/fee-plan`, { body: { installments: Number(plan) } }), { success: 'Fee plan created', invalidate: inv, onSuccess: () => setModal('') });

  if (isLoading || !data) return <PageLoader />;
  // Plans are newest first; after a course change the student can have one plan per course enrollment.
  const p = data.plans.find((x: any) => x.id === planId) ?? data.plans[0];
  const gross = p ? Number(p.grossAmount) : 0;
  const discount = p ? Number(p.discount) : 0;
  const waived = p ? Number(p.waived ?? 0) : 0;
  const unpaid = p ? p.installments.filter((i: any) => ['DUE', 'PARTIAL'].includes(i.status)).reduce((s: number, i: any) => s + Number(i.amount) - Number(i.paidAmount), 0) : 0;
  const pendingAdj = p ? data.adjustments?.find((a: any) => a.feePlanId === p.id && a.status === 'PENDING_APPROVAL') : null;
  const paid = data.payments.filter((x: any) => x.status !== 'CANCELLED').reduce((s: number, x: any) => s + Number(x.amount), 0);

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-4">
        <Stat label="Total fee" value={inr(gross)} />
        <Stat label={waived ? 'Discounts / waived' : 'Discounts'} value={waived ? `${inr(discount)} / ${inr(waived)}` : inr(discount)} tone="violet" />
        <Stat label="Paid" value={inr(paid)} tone="green" />
        <Stat label="Balance" value={inr(data.balance)} tone={data.balance > 0 ? 'rose' : 'green'} />
      </div>
      {gross > 0 && <Progress value={((paid + discount + waived) / gross) * 100} tone="green" />}
      {data.plans.length > 1 && (
        <Select label="Fee plan" value={p.id} onChange={(e) => setPlanId(e.target.value)} options={data.plans.map((x: any) => ({ value: x.id, label: `${x.enrollment?.course?.name ?? 'Plan'}${x.enrollment?.batch ? ' / ' + x.enrollment.batch.code : ''} — ${d(x.createdAt)}${x.enrollment ? ` (${label(x.enrollment.status)})` : ''}` }))} />
      )}
      <div className="flex flex-wrap gap-2">
        {can('finance:collect') && data.balance > 0 && <button className="btn-primary" onClick={() => setModal('pay')}><Plus className="h-4 w-4" /> Record payment</button>}
        {can('finance:collect', 'finance:manage') && p && <button className="btn-secondary" onClick={() => setModal('discount')}><Percent className="h-4 w-4" /> Discount / scholarship</button>}
        {can('finance:collect', 'finance:manage') && paid > 0 && <button className="btn-secondary" onClick={() => setModal('refund')}><Undo2 className="h-4 w-4" /> Request refund</button>}
        {can('finance:collect', 'finance:manage') && p && unpaid > 0 && <button className="btn-secondary" disabled={!!pendingAdj} title={pendingAdj ? 'An adjustment for this plan is awaiting approval' : undefined} onClick={() => setModal('adjust')}><CalendarClock className="h-4 w-4" /> Fee adjustment</button>}
        {can('finance:manage') && !p && <button className="btn-primary" onClick={() => setModal('plan')}>Create fee plan</button>}
      </div>

      <Card title="Installments" bodyClass="p-0">
        {p ? (
          <table className="min-w-full divide-y divide-slate-100">
            <thead className="bg-slate-50"><tr><th className="th">#</th><th className="th">Due date</th><th className="th">Amount</th><th className="th">Paid</th><th className="th">Status</th><th className="th">Invoice</th></tr></thead>
            <tbody className="divide-y divide-slate-100">
              {p.installments.map((i: any) => {
                const overdue = ['DUE', 'PARTIAL'].includes(i.status) && new Date(i.dueDate) < new Date();
                return <tr key={i.id} className={i.status === 'SUPERSEDED' ? 'text-slate-400' : undefined}><td className="td">{i.seq}{i.adjustmentId && <span className="ml-1 text-xs text-indigo-600">custom</span>}</td><td className="td">{d(i.dueDate)}</td><td className="td">{inr(i.amount)}</td><td className="td">{inr(i.paidAmount)}</td><td className="td"><Badge status={overdue ? 'OVERDUE' : i.status} /></td><td className="td text-xs text-slate-500">{data.invoices.find((x: any) => x.installmentId === i.id)?.number}</td></tr>;
              })}
            </tbody>
          </table>
        ) : <Empty title="No fee plan" />}
      </Card>

      <Card title="Payments & receipts" bodyClass="p-0">
        {data.payments.length ? (
          <table className="min-w-full divide-y divide-slate-100">
            <thead className="bg-slate-50"><tr><th className="th">Receipt</th><th className="th">Date</th><th className="th">Amount</th><th className="th">Mode</th><th className="th">Status</th><th className="th" /></tr></thead>
            <tbody className="divide-y divide-slate-100">
              {data.payments.map((x: any) => (
                <tr key={x.id}>
                  <td className="td font-medium">{x.receiptNumber}</td><td className="td">{d(x.paidAt)}</td><td className="td">{inr(x.amount)}</td><td className="td">{label(x.mode)}{x.reference && <span className="text-xs text-slate-500"> · {x.reference}</span>}</td><td className="td"><Badge status={x.status} /></td>
                  <td className="td text-right">
                    <button className="btn-ghost btn-sm" onClick={() => download(`/finance/payments/${x.id}/receipt.pdf`, `${x.receiptNumber}.pdf`, true)} aria-label="Receipt PDF"><FileDown className="h-4 w-4" /></button>
                    {can('finance:collect') && x.status === 'POSTED' && <button className="btn-ghost btn-sm text-rose-600" onClick={() => setCancel(x)} aria-label="Request cancellation"><XCircle className="h-4 w-4" /></button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <Empty title="No payments yet" />}
      </Card>

      {(data.discounts.length > 0 || data.refunds.length > 0 || data.adjustments?.length > 0) && (
        <Card title="Discounts, adjustments & refunds" bodyClass="p-0">
          <ul className="divide-y divide-slate-100">
            {data.adjustments?.map((x: any) => <li key={x.id} className="flex justify-between px-5 py-3 text-sm"><span>{x.kind === 'WAIVER' ? 'Waiver' : `Custom plan (${(x.schedule ?? []).length} installments)`} — {x.reason}</span><span className="flex items-center gap-2">{inr(x.amount)} <Badge status={x.status === 'APPLIED' ? 'APPROVED' : x.status}>{label(x.status)}</Badge></span></li>)}
            {data.discounts.map((x: any) => <li key={x.id} className="flex justify-between px-5 py-3 text-sm"><span>{label(x.kind)} {x.kind === 'PERCENT' && `${Number(x.value)}%`} — {x.reason}</span><span className="flex items-center gap-2">{inr(x.amount)} <Badge status={x.status === 'APPLIED' ? 'APPROVED' : x.status} >{label(x.status)}</Badge></span></li>)}
            {data.refunds.map((x: any) => <li key={x.id} className="flex justify-between px-5 py-3 text-sm"><span>Refund — {x.reason}{x.reference && ` (ref ${x.reference})`}</span><span className="flex items-center gap-2">{inr(x.amount)} <Badge status={x.status} />{x.status === 'APPROVED' && can('finance:manage') && <button className="btn-secondary btn-sm" onClick={() => setPayRefund(x)}>Mark paid</button>}</span></li>)}
          </ul>
        </Card>
      )}

      <Card title="Ledger (immutable)" bodyClass="p-0">
        <div className="max-h-80 overflow-auto">
          <table className="min-w-full divide-y divide-slate-100">
            <thead className="sticky top-0 bg-slate-50"><tr><th className="th">Date</th><th className="th">Type</th><th className="th">Narration</th><th className="th text-right">Debit</th><th className="th text-right">Credit</th><th className="th text-right">Balance</th></tr></thead>
            <tbody className="divide-y divide-slate-100">
              {data.ledger.map((e: any) => <tr key={e.id}><td className="td">{dt(e.createdAt)}</td><td className="td"><Badge>{label(e.type)}</Badge></td><td className="td whitespace-normal">{e.narration}</td><td className="td text-right">{Number(e.debit) ? inr(e.debit) : ''}</td><td className="td text-right">{Number(e.credit) ? inr(e.credit) : ''}</td><td className="td text-right font-medium">{inr(e.balance)}</td></tr>)}
            </tbody>
          </table>
        </div>
      </Card>

      {p && <FeeAdjustmentModal open={modal === 'adjust'} onClose={() => setModal('')} studentId={studentId} plan={p} unpaid={unpaid} />}
      <RecordPaymentModal open={modal === 'pay'} onClose={() => setModal('')} studentId={studentId} balance={data.balance} />
      <Modal open={modal === 'discount'} onClose={() => setModal('')} title="Discount / scholarship" footer={<button className="btn-primary" disabled={!disc.value || !disc.reason || discM.isPending} onClick={() => discM.mutate(undefined)}>Submit</button>}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Select label="Type" value={disc.kind} onChange={(e) => setDisc({ ...disc, kind: e.target.value })} options={[{ value: 'FIXED', label: 'Fixed amount' }, { value: 'PERCENT', label: 'Percentage' }, { value: 'SCHOLARSHIP', label: 'Scholarship' }]} />
          <Input label={disc.kind === 'PERCENT' ? 'Percent (%)' : 'Amount (₹)'} type="number" min={0} value={disc.value} onChange={(e) => setDisc({ ...disc, value: e.target.value })} />
          <Select className="sm:col-span-2" label="Reason" required value={disc.reason} onChange={(e) => setDisc({ ...disc, reason: e.target.value })} placeholder="Select" options={(reasons.data?.items ?? []).map((r) => ({ value: r.label, label: r.label }))} />
        </div>
        <p className="mt-3 text-xs text-slate-500">Discounts above the configured limit and all scholarships go through the approval workflow.</p>
      </Modal>
      <Modal open={modal === 'refund'} onClose={() => setModal('')} title="Request refund" footer={<button className="btn-primary" disabled={!ref.amount || ref.reason.length < 5 || refM.isPending} onClick={() => refM.mutate(undefined)}>Submit for approval</button>}>
        <div className="space-y-4">
          <Input label="Amount (₹)" type="number" min={1} value={ref.amount} onChange={(e) => setRef({ ...ref, amount: e.target.value })} hint={`Paid so far: ${inr(paid)}`} />
          <Textarea label="Reason (as per refund policy)" required value={ref.reason} onChange={(e) => setRef({ ...ref, reason: e.target.value })} />
        </div>
      </Modal>
      <Modal open={modal === 'plan'} onClose={() => setModal('')} title="Create fee plan" size="sm" footer={<button className="btn-primary" disabled={planM.isPending} onClick={() => planM.mutate(undefined)}>Create</button>}>
        <Select label="Installments" value={plan} onChange={(e) => setPlan(e.target.value)} options={[1, 2, 3, 4, 6, 12].map((n) => ({ value: String(n), label: String(n) }))} />
      </Modal>
      <Confirm open={!!cancel} onClose={() => setCancel(null)} title={`Cancel receipt ${cancel?.receiptNumber ?? ''}`} message="Cancellation needs Finance Manager approval. The receipt is retained and marked cancelled; a reversing ledger entry is posted." tone="danger" confirmLabel="Request cancellation" requireReason busy={cancelM.isPending} onConfirm={(r) => cancelM.mutate(r)} />
      <Confirm open={!!payRefund} onClose={() => setPayRefund(null)} title="Mark refund as paid" requireReason reasonLabel="Payment reference (UTR / cheque no.)" busy={payRefM.isPending} onConfirm={(r) => payRefM.mutate(r)} />
    </div>
  );
}
