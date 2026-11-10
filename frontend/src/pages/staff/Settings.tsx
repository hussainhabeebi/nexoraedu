import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { CheckCircle2, Copy, Pencil, Plus, Trash2, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { confirmDelete, useDelete, useGet, useMut } from '@/lib/hooks';
import { label } from '@/lib/format';
import { Badge, Card, Input, Modal, PageHeader, PageLoader, Select, Spinner, Tabs, Textarea } from '@/components/ui';

type Tab = 'general' | 'whatsapp' | 'masters' | 'departments' | 'workflows' | 'templates';

function WhatsAppSettings() {
  const { data, isLoading } = useGet<any>('/whatsapp/config');
  const [f, setF] = useState<any>(null);
  const [test, setTest] = useState<any>(null);
  useEffect(() => { if (data) setF({ enabled: data.enabled, baseUrl: data.baseUrl, accountId: data.accountId, inboxId: data.inboxId, apiToken: '', webhookSecret: '', autoCreateLeads: data.autoCreateLeads }); }, [data]);
  const save = useMut(() => api('/whatsapp/config', { method: 'PUT', body: f }), { success: 'WhatsApp settings saved', invalidate: ['/whatsapp'] });
  const testM = useMut(() => api('/whatsapp/test', { body: {} }), { onSuccess: (r) => setTest({ ok: true, ...r }) });
  if (isLoading || !f) return <PageLoader />;
  const genSecret = () => setF({ ...f, webhookSecret: Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) => b.toString(16).padStart(2, '0')).join('') });
  const hook = `${data.webhookUrl.split('?')[0]}?token=${f.webhookSecret || '<your-webhook-secret>'}`;
  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <Card title="Chatwoot connection" className="lg:col-span-2">
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="flex items-center gap-2 text-sm sm:col-span-2"><input type="checkbox" className="rounded text-brand-600" checked={f.enabled} onChange={(e) => setF({ ...f, enabled: e.target.checked })} /> Enable WhatsApp messaging via Chatwoot</label>
          <Input className="sm:col-span-2" label="Chatwoot URL" required value={f.baseUrl} onChange={(e) => setF({ ...f, baseUrl: e.target.value })} hint="Default: https://app.aiingo.com" />
          <Input label="Account ID" required value={f.accountId} onChange={(e) => setF({ ...f, accountId: e.target.value })} hint="From the Chatwoot URL: /app/accounts/<id>/…" />
          <Input label="WhatsApp inbox ID" required value={f.inboxId} onChange={(e) => setF({ ...f, inboxId: e.target.value })} hint="Settings → Inboxes → your WhatsApp inbox" />
          <Input className="sm:col-span-2" label="API access token" type="password" value={f.apiToken} onChange={(e) => setF({ ...f, apiToken: e.target.value })} placeholder={data.hasToken ? `Saved (${data.tokenHint}) — leave blank to keep` : 'Profile settings → Access token'} hint="Stored encrypted. Never shown again after saving." autoComplete="off" />
          <div className="sm:col-span-2"><Input label="Webhook secret" type="text" value={f.webhookSecret} onChange={(e) => setF({ ...f, webhookSecret: e.target.value })} placeholder={data.hasWebhookSecret ? 'Saved — leave blank to keep' : 'Generate a random secret'} autoComplete="off" /><button className="btn-ghost btn-sm mt-1" onClick={genSecret}>Generate secret</button></div>
          <label className="flex items-center gap-2 text-sm sm:col-span-2"><input type="checkbox" className="rounded text-brand-600" checked={f.autoCreateLeads} onChange={(e) => setF({ ...f, autoCreateLeads: e.target.checked })} /> Auto-create a lead (round-robin assigned) when an unknown number messages the inbox</label>
        </div>
        <div className="mt-6 flex flex-wrap gap-2">
          <button className="btn-primary" disabled={save.isPending || !f.accountId || !f.inboxId} onClick={() => save.mutate(undefined)}>{save.isPending && <Spinner className="h-4 w-4 text-white" />} Save</button>
          <button className="btn-secondary" disabled={testM.isPending} onClick={() => { setTest(null); testM.mutate(undefined); }}>{testM.isPending && <Spinner className="h-4 w-4" />} Test connection</button>
        </div>
        {test?.ok && <p className="mt-4 flex items-center gap-2 rounded-lg bg-emerald-50 p-3 text-sm text-emerald-800"><CheckCircle2 className="h-4 w-4" /> Connected to inbox “{test.inbox.name}” ({test.inbox.channelType}{test.inbox.phone ? ` · ${test.inbox.phone}` : ''})</p>}
        {testM.error && <p className="mt-4 flex items-center gap-2 rounded-lg bg-rose-50 p-3 text-sm text-rose-800"><XCircle className="h-4 w-4" /> {testM.error.message}</p>}
      </Card>
      <Card title="Incoming messages (webhook)">
        <ol className="list-decimal space-y-2 pl-4 text-sm text-slate-600">
          <li>In Chatwoot open <b>Settings → Integrations → Webhooks → Add new webhook</b>.</li>
          <li>Paste this URL:<div className="mt-1 flex items-center gap-1"><code className="block flex-1 break-all rounded bg-slate-100 p-2 text-xs">{hook}</code><button className="btn-ghost btn-sm" onClick={() => { navigator.clipboard.writeText(hook); toast.success('Copied'); }} aria-label="Copy"><Copy className="h-4 w-4" /></button></div></li>
          <li>Select events <b>Message created</b> and <b>Message updated</b>.</li>
          <li>Save. Incoming WhatsApp messages now appear on the lead timeline and notify the owner counselor; delivery/read receipts update the notification log.</li>
        </ol>
        <p className="mt-4 text-xs text-slate-500">Messages to contacts outside WhatsApp’s 24-hour window must use an approved template — set the template name on each notification template under “Templates”.</p>
      </Card>
    </div>
  );
}

function General() {
  const { data, isLoading } = useGet<any>('/admin/settings');
  const { can, hasRole } = useAuth();
  const [f, setF] = useState<any>(null);
  useEffect(() => { if (data) setF(structuredClone(data)); }, [data]);
  const save = useMut((key: string) => api(`/admin/settings/${key}`, { method: 'PUT', body: f[key] }), { success: 'Settings saved', invalidate: ['/admin', 'site'] });
  if (isLoading || !f) return <PageLoader />;
  const field = (group: string, key: string, lbl: string, type = 'text', hint?: string) => (
    <Input label={lbl} type={type} hint={hint} value={f[group][key] ?? ''} onChange={(e) => setF({ ...f, [group]: { ...f[group], [key]: type === 'number' ? Number(e.target.value) : e.target.value } })} disabled={!can('settings:manage')} />
  );
  const groups: [string, string, JSX.Element][] = [
    ['academy', 'Academy profile', <div className="grid gap-4 sm:grid-cols-2">{field('academy', 'name', 'Academy name')}{field('academy', 'tagline', 'Tagline')}{field('academy', 'email', 'Email')}{field('academy', 'phone', 'Phone')}{field('academy', 'whatsapp', 'WhatsApp number (website button)')}{field('academy', 'logoUrl', 'Logo URL')}<div className="sm:col-span-2">{field('academy', 'address', 'Address')}</div></div>],
    ['ids', 'ID & numbering formats', <div className="grid gap-4 sm:grid-cols-2">{['student', 'lead', 'application', 'invoice', 'receipt', 'certificate'].map((k) => <div key={k}>{field('ids', k, label(k), 'text', 'Tokens: {YYYY} {YY} {MM} and #### for the counter')}</div>)}</div>],
    ['security', 'Security policy', <div className="grid gap-4 sm:grid-cols-2">{field('security', 'sessionTimeoutMin', 'Session timeout (min)', 'number')}{field('security', 'passwordMinLength', 'Minimum password length', 'number')}{field('security', 'maxFailedLogins', 'Lock after failed logins', 'number')}{field('security', 'lockMinutes', 'Lock duration (min)', 'number')}<label className="flex items-start gap-2 text-sm sm:col-span-2"><input type="checkbox" className="mt-0.5 rounded text-brand-600" checked={!!f.security.mfaRequired} disabled={!hasRole('super_admin')} onChange={(e) => setF({ ...f, security: { ...f.security, mfaRequired: e.target.checked } })} /><span><b>Require authenticator code at sign-in</b> for administrative and finance roles. When off, staff sign in with their password only. Only a Super Administrator can change this.</span></label></div>],
    ['crm', 'CRM', <div className="grid gap-4 sm:grid-cols-2"><Select label="Lead assignment" value={f.crm.autoAssign} onChange={(e) => setF({ ...f, crm: { ...f.crm, autoAssign: e.target.value } })} options={[{ value: 'round_robin', label: 'Automatic (least-loaded counselor)' }, { value: 'manual', label: 'Manual by Sales Manager' }]} />{field('crm', 'inactivityDays', 'Alert after inactive days', 'number')}</div>],
    ['finance', 'Finance', <div className="grid gap-4 sm:grid-cols-2">{field('finance', 'discountApprovalLimit', 'Discount self-approval limit (₹)', 'number')}{field('finance', 'monthlyTarget', 'Monthly collection target (₹)', 'number')}<Input label="Reminder days before due" value={f.finance.reminderDaysBefore.join(',')} onChange={(e) => setF({ ...f, finance: { ...f.finance, reminderDaysBefore: e.target.value.split(',').map(Number).filter((n) => !isNaN(n)) } })} hint="Comma separated, e.g. 3,1" /><Input label="Reminder days after due" value={f.finance.reminderDaysAfter.join(',')} onChange={(e) => setF({ ...f, finance: { ...f.finance, reminderDaysAfter: e.target.value.split(',').map(Number).filter((n) => !isNaN(n)) } })} /></div>],
    ['academics', 'Academics', <div className="grid gap-4 sm:grid-cols-2">{field('academics', 'attendanceThreshold', 'Attendance alert threshold (%)', 'number')}{field('academics', 'attendanceEditWindowHours', 'Attendance edit window (hours)', 'number')}</div>],
    ['exams', 'Examinations', <div className="grid gap-4 sm:grid-cols-2">{field('exams', 'minAttendanceForExam', 'Minimum attendance to sit exams (%)', 'number', '0 = no rule')}<label className="flex items-center gap-2 pt-6 text-sm"><input type="checkbox" className="rounded text-brand-600" checked={f.exams.requireFeesCleared} onChange={(e) => setF({ ...f, exams: { ...f.exams, requireFeesCleared: e.target.checked } })} /> Block exams when fees are overdue</label></div>],
  ];
  return <div className="space-y-6">{groups.map(([k, t, body]) => <Card key={k} title={t} actions={can('settings:manage') && <button className="btn-primary btn-sm" disabled={save.isPending} onClick={() => save.mutate(k)}>Save</button>}>{body}</Card>)}</div>;
}

function Masters() {
  const { data } = useGet<any>('/admin/masters?all=1');
  const [type, setType] = useState('lead_source');
  const [n, setN] = useState({ code: '', label: '' });
  const add = useMut(() => api('/admin/masters', { body: { type, ...n } }), { success: 'Added', invalidate: ['/admin'], onSuccess: () => setN({ code: '', label: '' }) });
  const tog = useMut((m: any) => api(`/admin/masters/${m.id}`, { method: 'PATCH', body: { isActive: !m.isActive } }), { invalidate: ['/admin'] });
  const relabel = useMut(({ id, label: l }: any) => api(`/admin/masters/${id}`, { method: 'PATCH', body: { label: l } }), { success: 'Saved', invalidate: ['/admin'] });
  const editLabel = (m: any) => {
    const l = window.prompt('Label', m.label);
    if (l && l.trim() && l.trim() !== m.label) relabel.mutate({ id: m.id, label: l.trim() });
  };
  if (!data) return <PageLoader />;
  return (
    <div className="grid gap-6 lg:grid-cols-[220px_1fr]">
      <Card bodyClass="p-2" className="h-fit"><ul>{data.types.map((t: string) => <li key={t}><button className={`w-full rounded-lg px-3 py-2 text-left text-sm ${type === t ? 'bg-brand-50 font-medium text-brand-700' : 'hover:bg-slate-50'}`} onClick={() => setType(t)}>{label(t)}</button></li>)}</ul></Card>
      <Card title={label(type)} bodyClass="p-0">
        <ul className="divide-y divide-slate-100">{data.items.filter((m: any) => m.type === type).map((m: any) => <li key={m.id} className="flex items-center justify-between px-5 py-2.5 text-sm"><span>{m.label} <span className="font-mono text-xs text-slate-400">{m.code}</span></span><span className="flex items-center gap-1"><button className="btn-ghost btn-sm" onClick={() => editLabel(m)} aria-label={`Edit ${m.label}`}><Pencil className="h-4 w-4" /></button><button className="btn-ghost btn-sm" onClick={() => tog.mutate(m)}><Badge status={m.isActive ? 'ACTIVE' : 'WITHDRAWN'}>{m.isActive ? 'Active' : 'Inactive'}</Badge></button></span></li>)}</ul>
        <div className="flex gap-2 border-t border-slate-100 p-3"><input className="input" placeholder="code_like_this" value={n.code} onChange={(e) => setN({ ...n, code: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_') })} /><input className="input" placeholder="Label" value={n.label} onChange={(e) => setN({ ...n, label: e.target.value })} /><button className="btn-secondary" disabled={!n.code || !n.label} onClick={() => add.mutate(undefined)}><Plus className="h-4 w-4" /> Add</button></div>
        <p className="px-5 pb-3 text-xs text-slate-500">Master values are deactivated rather than deleted to preserve history.</p>
      </Card>
    </div>
  );
}

function Departments() {
  const { data } = useGet<any>('/admin/departments');
  const [name, setName] = useState('');
  const add = useMut(() => api('/admin/departments', { body: { name } }), { success: 'Department added', invalidate: ['/admin'], onSuccess: () => setName('') });
  const save = useMut(({ id, body }: any) => api(`/admin/departments/${id}`, { method: 'PATCH', body }), { success: 'Saved', invalidate: ['/admin'] });
  const del = useDelete('Department', ['/admin']);
  if (!data) return <PageLoader />;
  const items = data.items ?? data;
  return (
    <Card title="Departments" bodyClass="p-0">
      <ul className="divide-y divide-slate-100">{items.map((x: any) => (
        <li key={x.id} className="flex items-center justify-between px-5 py-2.5 text-sm">
          <span>{x.name} {x.isActive === false && <Badge status="WITHDRAWN">Inactive</Badge>}</span>
          <span className="flex gap-1">
            <button className="btn-ghost btn-sm" onClick={() => { const n = window.prompt('Department name', x.name); if (n && n.trim()) save.mutate({ id: x.id, body: { name: n.trim() } }); }} aria-label={`Rename ${x.name}`}><Pencil className="h-4 w-4" /></button>
            <button className="btn-ghost btn-sm" onClick={() => save.mutate({ id: x.id, body: { isActive: x.isActive === false } })}>{x.isActive === false ? 'Activate' : 'Deactivate'}</button>
            <button className="btn-ghost btn-sm text-rose-600" onClick={() => confirmDelete(`department "${x.name}"`) && del.mutate(`/admin/departments/${x.id}`)} aria-label={`Delete ${x.name}`}><Trash2 className="h-4 w-4" /></button>
          </span>
        </li>
      ))}</ul>
      <div className="flex gap-2 border-t border-slate-100 p-3"><input className="input" placeholder="New department name" value={name} onChange={(e) => setName(e.target.value)} /><button className="btn-secondary" disabled={name.trim().length < 2 || add.isPending} onClick={() => add.mutate(undefined)}><Plus className="h-4 w-4" /> Add</button></div>
      <p className="px-5 pb-3 text-xs text-slate-500">A department can be deleted only while no user belongs to it.</p>
    </Card>
  );
}

function Workflows() {
  const { hasRole } = useAuth();
  const { data } = useGet<any>('/admin/workflows');
  const roles = useGet<any>('/admin/roles');
  const [edit, setEdit] = useState<any>(null);
  const save = useMut(() => api(`/admin/workflows/${edit.type}`, { method: 'PUT', body: { levels: edit.levels.map((l: any, i: number) => ({ level: i + 1, role: l.role, ...(l.minAmount ? { minAmount: Number(l.minAmount) } : {}) })), isActive: edit.isActive } }), { success: 'Workflow saved', invalidate: ['/admin'], onSuccess: () => setEdit(null) });
  if (!data) return <PageLoader />;
  const types = Object.entries(data.types as Record<string, string>);
  return (
    <>
      <div className="grid gap-4 md:grid-cols-2">
        {types.map(([type, name]) => {
          const wf = data.items.find((w: any) => w.type === type);
          return (
            <Card key={type} title={name} actions={hasRole('super_admin') && <button className="text-sm link" onClick={() => setEdit({ type, name, isActive: wf?.isActive ?? true, levels: wf?.levels ?? [] })}>Configure</button>}>
              {wf?.levels?.length ? <ol className="space-y-1 text-sm">{wf.levels.map((l: any) => <li key={l.level}>{l.level}. {label(l.role)}{l.minAmount ? <span className="text-slate-500"> — only when amount ≥ ₹{l.minAmount}</span> : ''}</li>)}</ol> : <p className="text-sm text-slate-500">No approval required (auto-approved)</p>}
              {wf && !wf.isActive && <Badge status="CANCELLED" className="mt-2">Disabled</Badge>}
            </Card>
          );
        })}
      </div>
      {edit && (
        <Modal open onClose={() => setEdit(null)} title={`Workflow — ${edit.name}`} footer={<button className="btn-primary" onClick={() => save.mutate(undefined)}>Save</button>}>
          <div className="space-y-3">
            {edit.levels.map((l: any, i: number) => (
              <div key={i} className="flex items-end gap-2">
                <span className="pb-2.5 text-sm font-semibold text-slate-400">{i + 1}</span>
                <Select className="flex-1" label="Approver role" value={l.role} onChange={(e) => { const x = [...edit.levels]; x[i] = { ...l, role: e.target.value }; setEdit({ ...edit, levels: x }); }} options={(roles.data?.items ?? []).filter((r: any) => r.key !== 'student').map((r: any) => ({ value: r.key, label: r.name }))} />
                <Input className="w-40" label="Only if amount ≥" type="number" value={l.minAmount ?? ''} onChange={(e) => { const x = [...edit.levels]; x[i] = { ...l, minAmount: e.target.value }; setEdit({ ...edit, levels: x }); }} />
                <button className="btn-ghost mb-0.5 text-rose-600" onClick={() => setEdit({ ...edit, levels: edit.levels.filter((_: any, j: number) => j !== i) })} aria-label="Remove level"><Trash2 className="h-4 w-4" /></button>
              </div>
            ))}
            <button className="btn-secondary btn-sm" onClick={() => setEdit({ ...edit, levels: [...edit.levels, { role: 'management' }] })}><Plus className="h-4 w-4" /> Add level</button>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="rounded text-brand-600" checked={edit.isActive} onChange={(e) => setEdit({ ...edit, isActive: e.target.checked })} /> Workflow active</label>
          </div>
        </Modal>
      )}
    </>
  );
}

function Templates() {
  const { data } = useGet<any>('/admin/templates');
  const [edit, setEdit] = useState<any>(null);
  const save = useMut(() => api(`/admin/templates/${edit.id}`, { method: 'PATCH', body: { name: edit.name, subject: edit.subject, body: edit.body, waTemplateName: edit.waTemplateName || null, waLanguage: edit.waLanguage, channels: edit.channels, isActive: edit.isActive } }), { success: 'Template saved (new version)', invalidate: ['/admin'], onSuccess: () => setEdit(null) });
  if (!data) return <PageLoader />;
  return (
    <>
      <Card bodyClass="p-0">
        <ul className="divide-y divide-slate-100">{data.items.map((t: any) => (
          <li key={t.id}><button className="flex w-full flex-col gap-1 px-5 py-3 text-left hover:bg-slate-50 sm:flex-row sm:items-center sm:justify-between" onClick={() => setEdit({ ...t })}>
            <div><p className="font-medium">{t.name} <span className="font-mono text-xs text-slate-400">{t.key} · v{t.version}</span></p><p className="line-clamp-1 text-sm text-slate-500">{t.body}</p></div>
            <div className="flex gap-1">{t.channels.map((c: string) => <span key={c} className={`chip ${c === 'WHATSAPP' ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-600'}`}>{label(c)}</span>)}{t.waTemplateName && <span className="chip bg-emerald-600 text-white">WA template</span>}{!t.isActive && <Badge status="CANCELLED">Off</Badge>}</div>
          </button></li>
        ))}</ul>
      </Card>
      {edit && (
        <Modal open onClose={() => setEdit(null)} title={`Template — ${edit.key}`} size="lg" footer={<button className="btn-primary" onClick={() => save.mutate(undefined)}>Save</button>}>
          <div className="space-y-4">
            <Input label="Name" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
            <Input label="Subject / title" value={edit.subject ?? ''} onChange={(e) => setEdit({ ...edit, subject: e.target.value })} />
            <Textarea label="Message body" rows={5} value={edit.body} onChange={(e) => setEdit({ ...edit, body: e.target.value })} hint="Use {{placeholders}} such as {{name}}. For WhatsApp templates, placeholders map to {{1}}, {{2}}… in the order they appear." />
            <div><p className="label">Channels</p><div className="flex gap-4">{['IN_APP', 'EMAIL', 'WHATSAPP'].map((c) => <label key={c} className="flex items-center gap-2 text-sm"><input type="checkbox" className="rounded text-brand-600" checked={edit.channels.includes(c)} onChange={() => setEdit({ ...edit, channels: edit.channels.includes(c) ? edit.channels.filter((x: string) => x !== c) : [...edit.channels, c] })} />{label(c)}</label>)}</div></div>
            <div className="grid gap-4 sm:grid-cols-2"><Input label="Approved WhatsApp template name" value={edit.waTemplateName ?? ''} onChange={(e) => setEdit({ ...edit, waTemplateName: e.target.value })} hint="Leave blank to send as a free-form message" /><Input label="Template language" value={edit.waLanguage} onChange={(e) => setEdit({ ...edit, waLanguage: e.target.value })} /></div>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="rounded text-brand-600" checked={edit.isActive} onChange={(e) => setEdit({ ...edit, isActive: e.target.checked })} /> Active</label>
          </div>
        </Modal>
      )}
    </>
  );
}

export default function Settings() {
  const { can } = useAuth();
  const loc = useLocation();
  const nav = useNavigate();
  const tab = ((loc.pathname.split('/')[3] as Tab) || 'general');
  const tabs = [
    { key: 'general' as Tab, label: 'General', show: can('settings:manage', 'masters:manage') },
    { key: 'whatsapp' as Tab, label: 'WhatsApp (Chatwoot)', show: can('settings:manage') },
    { key: 'masters' as Tab, label: 'Master data', show: can('masters:manage') },
    { key: 'departments' as Tab, label: 'Departments', show: can('masters:manage') },
    { key: 'workflows' as Tab, label: 'Approval workflows', show: can('settings:manage') },
    { key: 'templates' as Tab, label: 'Notification templates', show: can('notifications:manage') },
  ].filter((t) => t.show);
  return (
    <div>
      <PageHeader title="Settings" subtitle="Every configuration change is audit-logged." />
      <Tabs value={tab} onChange={(k) => nav(`/staff/settings/${k}`)} tabs={tabs} />
      {tab === 'general' && <General />}
      {tab === 'whatsapp' && <WhatsAppSettings />}
      {tab === 'masters' && <Masters />}
      {tab === 'departments' && <Departments />}
      {tab === 'workflows' && <Workflows />}
      {tab === 'templates' && <Templates />}
    </div>
  );
}
