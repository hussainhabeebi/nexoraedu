import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { qs } from '@/lib/api';
import { useGet } from '@/lib/hooks';
import { dt, label } from '@/lib/format';
import { DataTable } from '@/components/DataTable';
import { Badge, Modal, PageHeader, Tabs } from '@/components/ui';

type T = 'audit' | 'logins' | 'notifications' | 'integrations';
export default function Audit() {
  const [sp, setSp] = useSearchParams();
  const tab = (sp.get('tab') as T) || 'audit';
  const [page, setPage] = useState(1);
  const [entity, setEntity] = useState('');
  const [view, setView] = useState<any>(null);
  const path = { audit: `/admin/audit-logs${qs({ page, pageSize: 50, entity })}`, logins: `/admin/login-logs?page=${page}&pageSize=50`, notifications: `/admin/notification-logs?page=${page}&pageSize=50`, integrations: `/admin/integration-logs?page=${page}&pageSize=50` }[tab];
  const { data, isLoading } = useGet<any>(path);
  const cols: Record<T, any[]> = {
    audit: [
      { key: 'at', header: 'When', cell: (r: any) => dt(r.createdAt) }, { key: 'user', header: 'User', cell: (r: any) => r.userName ?? '—' },
      { key: 'action', header: 'Action', cell: (r: any) => <Badge>{r.action}</Badge> }, { key: 'entity', header: 'Entity', cell: (r: any) => `${label(r.entity)}${r.entityId ? ` · ${r.entityId.slice(-8)}` : ''}` },
      { key: 'ip', header: 'IP', cell: (r: any) => r.ip ?? '—' }, { key: 'v', header: '', cell: (r: any) => (r.oldValues || r.newValues) && <button className="link text-sm" onClick={() => setView(r)}>Changes</button> },
    ],
    logins: [{ key: 'at', header: 'When', cell: (r: any) => dt(r.createdAt) }, { key: 'id', header: 'Identifier', cell: (r: any) => r.identifier }, { key: 'ok', header: 'Result', cell: (r: any) => <Badge status={r.success ? 'APPROVED' : 'REJECTED'}>{r.success ? 'Success' : 'Failed'}</Badge> }, { key: 'ip', header: 'IP', cell: (r: any) => r.ip }, { key: 'ua', header: 'Device', className: 'max-w-xs truncate', cell: (r: any) => r.userAgent }],
    notifications: [{ key: 'at', header: 'When', cell: (r: any) => dt(r.createdAt) }, { key: 'ch', header: 'Channel', cell: (r: any) => label(r.channel) }, { key: 'to', header: 'Recipient', cell: (r: any) => r.recipient }, { key: 'tpl', header: 'Template', cell: (r: any) => r.templateKey }, { key: 'st', header: 'Status', cell: (r: any) => <Badge status={r.status} /> }, { key: 'err', header: 'Error', className: 'max-w-xs truncate', cell: (r: any) => r.error ?? '' }],
    integrations: [{ key: 'at', header: 'When', cell: (r: any) => dt(r.createdAt) }, { key: 'n', header: 'Integration', cell: (r: any) => r.name }, { key: 'ep', header: 'Call', className: 'max-w-xs truncate', cell: (r: any) => `${r.method} ${r.endpoint}` }, { key: 's', header: 'Status', cell: (r: any) => <Badge status={r.status && r.status < 400 ? 'APPROVED' : 'REJECTED'}>{r.status ?? 'ERR'}</Badge> }, { key: 'd', header: 'Duration', cell: (r: any) => `${r.durationMs} ms` }, { key: 'e', header: 'Error', className: 'max-w-xs truncate', cell: (r: any) => r.error ?? '' }],
  };
  return (
    <div>
      <PageHeader title="Audit & logs" subtitle="Append-only records — they cannot be edited or deleted." />
      <Tabs value={tab} onChange={(k) => { setPage(1); setSp({ tab: k }); }} tabs={[{ key: 'audit', label: 'Audit trail' }, { key: 'logins', label: 'Logins' }, { key: 'notifications', label: 'Notifications' }, { key: 'integrations', label: 'Integrations' }]} />
      <DataTable rows={data?.items ?? []} loading={isLoading} total={data?.total} page={page} pageSize={50} onPage={setPage} columns={cols[tab]}
        toolbar={tab === 'audit' && <select className="input w-auto" value={entity} onChange={(e) => { setEntity(e.target.value); setPage(1); }} aria-label="Entity"><option value="">All entities</option>{['user', 'role', 'lead', 'application', 'student', 'payment', 'discount', 'refund', 'exam', 'exam_results', 'approval_request', 'setting', 'integration', 'course', 'batch', 'document'].map((x) => <option key={x} value={x}>{label(x)}</option>)}</select>} />
      {view && <Modal open onClose={() => setView(null)} title={`${view.action} · ${label(view.entity)}`} size="lg"><div className="grid gap-4 sm:grid-cols-2"><div><p className="label">Before</p><pre className="max-h-96 overflow-auto rounded-lg bg-slate-50 p-3 text-xs">{JSON.stringify(view.oldValues, null, 2)}</pre></div><div><p className="label">After</p><pre className="max-h-96 overflow-auto rounded-lg bg-slate-50 p-3 text-xs">{JSON.stringify(view.newValues, null, 2)}</pre></div></div></Modal>}
    </div>
  );
}
