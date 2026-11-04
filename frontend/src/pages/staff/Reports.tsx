import { useState } from 'react';
import { BarChart3, Download, Printer } from 'lucide-react';
import { toast } from 'sonner';
import { download, qs } from '@/lib/api';
import { useGet } from '@/lib/hooks';
import { d } from '@/lib/format';
import { Card, cx, Empty, PageHeader, PageLoader } from '@/components/ui';

export default function Reports() {
  const list = useGet<any>('/dashboard/reports');
  const [key, setKey] = useState('');
  const [f, setF] = useState({ from: new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10), to: new Date().toISOString().slice(0, 10) });
  const rep = useGet<any>(key ? `/dashboard/reports/${key}${qs(f)}` : null);
  if (list.isLoading) return <PageLoader />;
  const rows = rep.data?.rows ?? [];
  const cols = rows[0] ? Object.keys(rows[0]) : [];
  return (
    <div>
      <PageHeader title="Reports" subtitle="Run, print or export any report to Excel (CSV)." />
      <div className="grid gap-6 lg:grid-cols-[260px_1fr]">
        <Card bodyClass="p-2" className="h-fit print:hidden">
          <ul>{list.data.items.map((r: any) => <li key={r.key}><button onClick={() => setKey(r.key)} className={cx('flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm', key === r.key ? 'bg-brand-50 font-medium text-brand-700' : 'hover:bg-slate-50')}><BarChart3 className="h-4 w-4" />{r.title}</button></li>)}</ul>
        </Card>
        <div className="min-w-0 space-y-4">
          <div className="flex flex-wrap items-end gap-3 print:hidden">
            <label><span className="label">From</span><input type="date" className="input" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /></label>
            <label><span className="label">To</span><input type="date" className="input" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></label>
            {key && <><button className="btn-secondary" onClick={() => download(`/dashboard/reports/${key}${qs({ ...f, format: 'csv' })}`, `${key}.csv`).catch((e) => toast.error(e.message))}><Download className="h-4 w-4" /> Export CSV</button><button className="btn-secondary" onClick={() => window.print()}><Printer className="h-4 w-4" /> Print / PDF</button></>}
          </div>
          {!key ? <div className="card"><Empty title="Choose a report" hint="Pick a report from the list to view it." /></div> : rep.isLoading ? <PageLoader /> : (
            <Card title={`${rep.data?.title} · ${d(f.from)} – ${d(f.to)} · ${rows.length} rows`} bodyClass="p-0">
              {rows.length ? <div className="max-h-[65vh] overflow-auto"><table className="min-w-full divide-y divide-slate-100"><thead className="sticky top-0 bg-slate-50"><tr>{cols.map((c) => <th key={c} className="th">{c}</th>)}</tr></thead><tbody className="divide-y divide-slate-100">{rows.map((r: any, i: number) => <tr key={i}>{cols.map((c) => <td key={c} className="td">{r[c] instanceof Object ? JSON.stringify(r[c]) : String(r[c] ?? '')}</td>)}</tr>)}</tbody></table></div> : <Empty title="No data for this period" />}
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
