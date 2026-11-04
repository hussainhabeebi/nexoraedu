import { Link, useSearchParams } from 'react-router-dom';
import { MessageCircle, Phone } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { useGet } from '@/lib/hooks';
import { dt, label } from '@/lib/format';
import { Badge, Card, cx, Empty, PageHeader, PageLoader, Tabs } from '@/components/ui';

export default function FollowUps() {
  const [sp, setSp] = useSearchParams();
  const { can } = useAuth();
  const when = (sp.get('when') as 'today' | 'overdue' | 'all') || 'today';
  const all = sp.get('all') === 'true';
  const { data, isLoading } = useGet<any>(`/crm/follow-ups?when=${when === 'all' ? '' : when}${all ? '&all=true' : ''}`, { refetchInterval: 60_000 });
  return (
    <div>
      <PageHeader title="Follow-ups" subtitle="Calls and messages you’ve scheduled with leads." actions={can('leads:read_all') && <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="rounded text-brand-600" checked={all} onChange={(e) => { const n = new URLSearchParams(sp); e.target.checked ? n.set('all', 'true') : n.delete('all'); setSp(n); }} /> Whole team</label>} />
      <Tabs value={when} onChange={(k) => { const n = new URLSearchParams(sp); n.set('when', k); setSp(n); }} tabs={[{ key: 'today', label: 'Due today' }, { key: 'overdue', label: 'Overdue' }, { key: 'all', label: 'All pending' }]} />
      {isLoading ? <PageLoader /> : (
        <Card bodyClass="p-0">
          {data.items.length ? (
            <ul className="divide-y divide-slate-100">
              {data.items.map((f: any) => (
                <li key={f.id} className="flex flex-col gap-2 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <Link to={`/staff/leads/${f.lead.id}`} className="font-medium hover:underline">{f.lead.name}</Link> <Badge status={f.lead.status} className="ml-1" />
                    <p className={cx('text-sm', new Date(f.dueAt) < new Date() ? 'font-medium text-rose-600' : 'text-slate-500')}>{label(f.mode)} · {dt(f.dueAt)}{f.note && ` — ${f.note}`}</p>
                  </div>
                  <div className="flex gap-2">
                    <a href={`tel:${f.lead.phone}`} className="btn-secondary btn-sm"><Phone className="h-4 w-4" /> Call</a>
                    <Link to={`/staff/leads/${f.lead.id}`} className="btn-success btn-sm"><MessageCircle className="h-4 w-4" /> Open</Link>
                  </div>
                </li>
              ))}
            </ul>
          ) : <Empty title="Nothing pending 🎉" hint="Schedule follow-ups from a lead’s page." />}
        </Card>
      )}
    </div>
  );
}
