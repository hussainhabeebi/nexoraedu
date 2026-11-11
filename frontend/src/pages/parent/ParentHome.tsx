import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { FileDown, LogOut } from 'lucide-react';
import { download } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useGet } from '@/lib/hooks';
import { d, inr, label } from '@/lib/format';
import Logo from '@/components/Logo';
import { NotificationBell } from '@/components/StaffLayout';
import { FeeMonthsTable } from '@/components/FeeMonths';
import { Avatar, Badge, Card, Empty, PageHeader, PageLoader, Stat, cx } from '@/components/ui';

/** Parent / guardian portal: fees and receipts of the children linked to this account, nothing else. */
function ChildFees({ studentId }: { studentId: string }) {
  const { data, isLoading } = useGet<any>(`/parent/children/${studentId}/fees`);
  if (isLoading || !data) return <PageLoader />;
  const receipt = (paymentId: string) => `/parent/children/${studentId}/payments/${paymentId}/receipt.pdf`;
  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-3">
        <Stat label="Total billed" value={inr(data.months.totals.total)} />
        <Stat label="Paid" value={inr(data.months.totals.paid)} tone="green" />
        <Stat label="Balance" value={inr(data.balance)} tone={data.balance > 0 ? 'rose' : 'green'} />
      </div>
      {data.balance > 0 && (data.paymentInfo.upi || data.paymentInfo.bank) && (
        <Card title="How to pay"><div className="space-y-1 text-sm">{data.paymentInfo.upi && <p>UPI: <b className="font-mono">{data.paymentInfo.upi}</b></p>}{data.paymentInfo.bank && <p className="whitespace-pre-line">{data.paymentInfo.bank}</p>}<p className="text-slate-500">Mention the Student ID ({data.student.studentCode}) in the payment note.</p></div></Card>
      )}
      <FeeMonthsTable data={data.months} receiptPath={receipt} />
      <Card title="Receipts" bodyClass="p-0">
        {data.payments.length ? (
          <ul className="divide-y divide-slate-100">
            {data.payments.map((x: any) => (
              <li key={x.id} className="flex items-center justify-between px-5 py-3 text-sm">
                <span>{x.receiptNumber} · {d(x.paidAt)} · {label(x.mode)}</span>
                <span className="flex items-center gap-2"><b>{inr(x.amount)}</b>{x.status !== 'POSTED' && <Badge status={x.status} />}
                  <button className="btn-ghost btn-sm" onClick={() => download(receipt(x.id), `${x.receiptNumber}.pdf`, true)} aria-label={`Download receipt ${x.receiptNumber}`}><FileDown className="h-4 w-4" /></button>
                </span>
              </li>
            ))}
          </ul>
        ) : <Empty title="No payments yet" />}
      </Card>
    </div>
  );
}

export default function ParentHome() {
  const { user, logout } = useAuth();
  const nav = useNavigate();
  const { data, isLoading } = useGet<any>('/parent/children');
  const [sel, setSel] = useState('');
  const kids = data?.items ?? [];
  const cur = kids.find((k: any) => k.id === sel) ?? kids[0];
  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-20 border-b border-slate-200 bg-white/90 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center gap-4 px-4">
          <Link to="/parent"><Logo /></Link>
          <span className="hidden text-sm font-medium text-slate-600 sm:inline">Parent portal</span>
          <div className="ml-auto flex items-center gap-2">
            <NotificationBell base="" />
            <Avatar name={user!.name} size="sm" />
            <button className="btn-ghost p-2" aria-label="Sign out" onClick={async () => { await logout(); nav('/login'); }}><LogOut className="h-4 w-4" /></button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl animate-fade-in space-y-6 px-4 py-6">
        <PageHeader title="Fees & receipts" subtitle={cur ? `${cur.fullName} · ${cur.studentCode} · ${cur.course.name}${cur.batch ? ` / ${cur.batch.code}` : ''}` : undefined} />
        {isLoading ? <PageLoader /> : !kids.length ? <Empty title="No students are linked to this account" /> : (
          <>
            {kids.length > 1 && (
              <div className="flex flex-wrap gap-2" role="tablist" aria-label="Children">
                {kids.map((k: any) => (
                  <button key={k.id} role="tab" aria-selected={k.id === cur.id} className={cx('rounded-lg px-3 py-2 text-sm font-medium', k.id === cur.id ? 'bg-brand-50 text-brand-700' : 'text-slate-600 hover:bg-slate-100')} onClick={() => setSel(k.id)}>
                    {k.fullName} <span className={k.balance > 0 ? 'text-rose-600' : 'text-emerald-600'}>· {inr(k.balance)}</span>
                  </button>
                ))}
              </div>
            )}
            <ChildFees key={cur.id} studentId={cur.id} />
          </>
        )}
      </main>
    </div>
  );
}
