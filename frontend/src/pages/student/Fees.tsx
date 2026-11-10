import { FileDown } from 'lucide-react';
import { download } from '@/lib/api';
import { useGet } from '@/lib/hooks';
import { d, inr, label } from '@/lib/format';
import { Badge, Card, Empty, PageHeader, PageLoader, Stat } from '@/components/ui';
import { FeeMonthsTable } from '@/components/FeeMonths';

export default function Fees() {
  const { data, isLoading } = useGet<any>('/portal/fees');
  if (isLoading) return <PageLoader />;
  const p = data.plans[0];
  return (
    <div className="space-y-6">
      <PageHeader title="Fees" />
      <div className="grid gap-4 sm:grid-cols-3">
        <Stat label="Total fee" value={inr(p ? Number(p.grossAmount) - Number(p.discount) : 0)} />
        <Stat label="Paid" value={inr(data.payments.filter((x: any) => x.status !== 'CANCELLED').reduce((s: number, x: any) => s + Number(x.amount), 0))} tone="green" />
        <Stat label="Balance" value={inr(data.balance)} tone={data.balance > 0 ? 'rose' : 'green'} />
      </div>
      {data.balance > 0 && (data.paymentInfo.upi || data.paymentInfo.bank) && (
        <Card title="How to pay"><div className="space-y-1 text-sm">{data.paymentInfo.upi && <p>UPI: <b className="font-mono">{data.paymentInfo.upi}</b></p>}{data.paymentInfo.bank && <p className="whitespace-pre-line">{data.paymentInfo.bank}</p>}<p className="text-slate-500">Mention your Student ID in the payment note. Your receipt is sent on WhatsApp once accounts confirm the payment.</p></div></Card>
      )}
      {data.months?.rows?.length ? <FeeMonthsTable data={data.months} receiptPath={(id) => `/portal/payments/${id}/receipt.pdf`} /> : (
        <Card title="Installments" bodyClass="p-0">
          {p ? <ul className="divide-y divide-slate-100">{p.installments.map((i: any) => { const overdue = i.status !== 'PAID' && new Date(i.dueDate) < new Date(); return <li key={i.id} className="flex items-center justify-between px-5 py-3 text-sm"><span>#{i.seq} · due {d(i.dueDate)}</span><span className="flex items-center gap-2">{inr(Number(i.amount) - Number(i.paidAmount))} <Badge status={overdue ? 'OVERDUE' : i.status} /></span></li>; })}</ul> : <Empty title="No fee plan yet" />}
        </Card>
      )}
      <Card title="Receipts" bodyClass="p-0">
        {data.payments.length ? <ul className="divide-y divide-slate-100">{data.payments.map((x: any) => <li key={x.id} className="flex items-center justify-between px-5 py-3 text-sm"><span>{x.receiptNumber} · {d(x.paidAt)} · {label(x.mode)}</span><span className="flex items-center gap-2"><b>{inr(x.amount)}</b>{x.status !== 'POSTED' && <Badge status={x.status} />}<button className="btn-ghost btn-sm" onClick={() => download(`/portal/payments/${x.id}/receipt.pdf`, `${x.receiptNumber}.pdf`, true)} aria-label="Download receipt"><FileDown className="h-4 w-4" /></button></span></li>)}</ul> : <Empty title="No payments yet" />}
      </Card>
    </div>
  );
}
