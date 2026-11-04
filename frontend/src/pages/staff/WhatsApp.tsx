import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, CheckCircle2, ExternalLink, RotateCcw, Search, Settings2 } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useGet, useMut } from '@/lib/hooks';
import { ago } from '@/lib/format';
import WaChat from '@/components/WaChat';
import { Avatar, Badge, cx, Empty, PageHeader, PageLoader, Tabs, useDebounced } from '@/components/ui';

export default function WhatsApp() {
  const { can } = useAuth();
  const cfg = useGet<any>('/whatsapp/config');
  const [status, setStatus] = useState<'open' | 'pending' | 'resolved'>('open');
  const [q, setQ] = useState('');
  const dq = useDebounced(q, 400);
  const list = useGet<any>(cfg.data?.enabled ? `/whatsapp/conversations?status=${status}${dq ? `&q=${encodeURIComponent(dq)}` : ''}` : null, { refetchInterval: 15_000, retry: false });
  const [active, setActive] = useState<any>(null);
  const toggle = useMut(({ id, s }: { id: number; s: string }) => api(`/whatsapp/conversations/${id}/status`, { body: { status: s } }), { success: 'Conversation updated', invalidate: ['/whatsapp'], onSuccess: () => setActive(null) });

  if (cfg.isLoading) return <PageLoader />;
  if (!cfg.data?.enabled)
    return <div><PageHeader title="WhatsApp inbox" /><div className="card"><Empty icon={<Settings2 className="h-6 w-6" />} title="Connect your Chatwoot WhatsApp inbox" hint="WhatsApp messaging runs through Chatwoot (app.aiingo.com). Add the account ID, inbox ID and API access token to start." action={can('settings:manage') && <Link to="/staff/settings/whatsapp" className="btn-primary">Open WhatsApp settings</Link>} /></div></div>;

  return (
    <div>
      <PageHeader title="WhatsApp inbox" subtitle={`Chatwoot inbox #${cfg.data.inboxId} · ${cfg.data.baseUrl.replace('https://', '')}`} actions={<a className="btn-secondary" href={`${cfg.data.baseUrl}/app/accounts/${cfg.data.accountId}/inbox/${cfg.data.inboxId}`} target="_blank" rel="noreferrer"><ExternalLink className="h-4 w-4" /> Open in Chatwoot</a>} />
      <div className="card grid overflow-hidden lg:grid-cols-[340px_1fr]">
        <aside className={cx('border-r border-slate-200', active && 'hidden lg:block')}>
          <div className="space-y-2 border-b border-slate-100 p-3">
            <div className="relative"><Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" /><input className="input pl-9" placeholder="Search conversations" value={q} onChange={(e) => setQ(e.target.value)} /></div>
            <div className="-mb-5"><Tabs value={status} onChange={setStatus} tabs={[{ key: 'open', label: 'Open', count: list.data?.counts?.all_count }, { key: 'pending', label: 'Pending' }, { key: 'resolved', label: 'Resolved' }]} /></div>
          </div>
          <ul className="max-h-[560px] divide-y divide-slate-100 overflow-y-auto">
            {list.isLoading && <li className="p-6"><PageLoader /></li>}
            {list.error && <li className="p-4 text-sm text-rose-700">{(list.error as Error).message}</li>}
            {list.data?.items.map((c: any) => (
              <li key={c.id}>
                <button className={cx('flex w-full gap-3 px-4 py-3 text-left hover:bg-slate-50', active?.id === c.id && 'bg-brand-50')} onClick={() => setActive(c)}>
                  <Avatar name={c.contact.name || c.contact.phone || '?'} size="sm" />
                  <div className="min-w-0 flex-1">
                    <div className="flex justify-between gap-2"><p className="truncate text-sm font-medium">{c.contact.name || c.contact.phone}</p><span className="shrink-0 text-[11px] text-slate-400">{ago(c.lastActivityAt)}</span></div>
                    <p className="truncate text-xs text-slate-500">{c.lastMessage ?? '—'}</p>
                    <div className="mt-1 flex gap-1">{c.student && <Badge status="ACTIVE">Student</Badge>}{c.lead && !c.student && <Badge status={c.lead.status ?? 'NEW'}>Lead</Badge>}{c.unread > 0 && <span className="chip bg-emerald-500 text-white">{c.unread}</span>}</div>
                  </div>
                </button>
              </li>
            ))}
            {list.data && !list.data.items.length && <li><Empty title="No conversations" /></li>}
          </ul>
        </aside>
        <section className={cx(!active && 'hidden lg:block')}>
          {active ? (
            <>
              <header className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-3">
                <div className="flex items-center gap-3">
                  <button className="btn-ghost p-1 lg:hidden" onClick={() => setActive(null)} aria-label="Back"><ArrowLeft className="h-4 w-4" /></button>
                  <div><p className="font-medium">{active.contact.name || active.contact.phone}</p><p className="text-xs text-slate-500">{active.contact.phone}{active.assignee && ` · assigned to ${active.assignee}`}</p></div>
                </div>
                <div className="flex gap-2">
                  {active.student && <Link className="btn-secondary btn-sm" to={`/staff/students/${active.student.id}`}>Student {active.student.studentCode}</Link>}
                  {active.lead?.id && <Link className="btn-secondary btn-sm" to={`/staff/leads/${active.lead.id}`}>Lead {active.lead.code}</Link>}
                  {active.status !== 'resolved' ? <button className="btn-secondary btn-sm" onClick={() => toggle.mutate({ id: active.id, s: 'resolved' })}><CheckCircle2 className="h-4 w-4" /> Resolve</button> : <button className="btn-secondary btn-sm" onClick={() => toggle.mutate({ id: active.id, s: 'open' })}><RotateCcw className="h-4 w-4" /> Reopen</button>}
                </div>
              </header>
              <WaChat key={active.id} name={active.contact.name || ''} messagesPath={`/whatsapp/conversations/${active.id}/messages`} sendPath={active.lead?.id ? `/whatsapp/leads/${active.lead.id}/send` : active.student ? `/whatsapp/students/${active.student.id}/send` : `/whatsapp/conversations/${active.id}/reply`} height="h-[480px]" />
            </>
          ) : <Empty title="Select a conversation" hint="Incoming WhatsApp messages automatically create or update leads." />}
        </section>
      </div>
    </div>
  );
}
