import { FileDown } from 'lucide-react';
import { download } from '@/lib/api';
import { d, inr, label } from '@/lib/format';
import { Badge, Card, Empty } from '@/components/ui';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const monthLabel = (m: string) => {
  const [y, mo] = m.split('-').map(Number);
  return `${MONTHS[mo - 1]} ${y}`;
};

/**
 * Ledger by fee month: total, paid, outstanding, due date, status and the receipts that paid each month.
 * `receiptPath` builds the download URL for the viewer's API (staff, student portal or parent portal).
 */
export function FeeMonthsTable({ data, receiptPath }: { data: { rows: any[]; totals: any }; receiptPath: (paymentId: string) => string }) {
  if (!data.rows.length) return <Card title="Fees by month"><Empty title="No fee schedule yet" /></Card>;
  return (
    <Card title="Fees by month" bodyClass="p-0">
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-slate-100">
          <thead className="bg-slate-50"><tr><th className="th">Fee month</th><th className="th">Due date</th><th className="th">Total</th><th className="th">Paid</th><th className="th">Outstanding</th><th className="th">Status</th><th className="th">Payments</th></tr></thead>
          <tbody className="divide-y divide-slate-100">
            {data.rows.map((r) => (
              <tr key={r.installmentId}>
                <td className="td font-medium">{monthLabel(r.feeMonth)}</td>
                <td className="td">{d(r.dueDate)}</td>
                <td className="td">{inr(r.total)}</td>
                <td className="td">{inr(r.paid)}</td>
                <td className={`td ${r.outstanding > 0 ? 'font-semibold text-rose-600' : ''}`}>{inr(r.outstanding)}</td>
                <td className="td"><Badge status={r.overdue ? 'OVERDUE' : r.status} />{r.overdueDays > 0 && <span className="text-xs text-slate-500"> · {r.overdueDays} d</span>}</td>
                <td className="td text-xs">
                  {r.payments.length ? r.payments.map((p: any) => (
                    <div key={p.paymentId + r.installmentId} className={`flex items-center gap-1 ${p.status === 'CANCELLED' ? 'text-slate-400 line-through' : ''}`}>
                      <span>{d(p.paidAt)} · {inr(p.amount)} · {label(p.mode)}</span>
                      <button className="btn-ghost btn-sm" onClick={() => download(receiptPath(p.paymentId), `${p.receiptNumber}.pdf`, true)} aria-label={`Receipt ${p.receiptNumber}`}><FileDown className="h-3.5 w-3.5" /></button>
                    </div>
                  )) : <span className="text-slate-400">—</span>}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot className="bg-slate-50 text-sm font-semibold"><tr><td className="td" colSpan={2}>Total</td><td className="td">{inr(data.totals.total)}</td><td className="td">{inr(data.totals.paid)}</td><td className="td">{inr(data.totals.outstanding)}</td><td className="td" colSpan={2}>{data.totals.overdue > 0 && <span className="text-rose-600">Overdue {inr(data.totals.overdue)}</span>}</td></tr></tfoot>
        </table>
      </div>
    </Card>
  );
}
