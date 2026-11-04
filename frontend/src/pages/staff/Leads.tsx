import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Download, KanbanSquare, List, MessageCircle, Plus, Search, Upload, UserCog } from 'lucide-react';
import { toast } from 'sonner';
import { api, download, qs } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useCourses, useGet, useMasters, useMut, useStaff } from '@/lib/hooks';
import { ago, d, dt, label } from '@/lib/format';
import { parseCsv } from '@/lib/csv';
import { DataTable } from '@/components/DataTable';
import { Badge, cx, Empty, Input, Modal, PageHeader, Select, Spinner, Textarea, useDebounced } from '@/components/ui';

const STATUSES = ['NEW', 'CONTACTED', 'INTERESTED', 'COUNSELLED', 'APPLICATION', 'ADMITTED', 'NOT_INTERESTED', 'LOST', 'JUNK'];

export function NewLeadModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { can } = useAuth();
  const nav = useNavigate();
  const courses = useCourses();
  const sources = useMasters('lead_source');
  const staff = useStaff('counselor');
  const [f, setF] = useState({ name: '', phone: '', email: '', courseId: '', source: 'walk_in', city: '', notes: '', ownerId: '' });
  const [dup, setDup] = useState<any>(null);
  const phone = useDebounced(f.phone, 500);
  useEffect(() => {
    if (phone.replace(/\D/g, '').length < 10) return setDup(null);
    api('/crm/leads/check-duplicate', { body: { phone, email: f.email || undefined } }).then((r) => setDup(r.duplicate)).catch(() => undefined);
  }, [phone]); // eslint-disable-line
  const m = useMut((b: any) => api('/crm/leads', { body: b }), { success: 'Lead created', invalidate: ['/crm', '/dashboard'], onSuccess: (r: any) => { onClose(); nav(`/staff/leads/${r.id}`); } });
  const set = (k: keyof typeof f) => (e: any) => setF({ ...f, [k]: e.target.value });
  return (
    <Modal open={open} onClose={onClose} title="New lead" size="lg" footer={<><button className="btn-secondary" onClick={onClose}>Cancel</button><button className="btn-primary" disabled={m.isPending || !f.name || !f.phone || !!dup} onClick={() => m.mutate({ ...f, email: f.email || null, courseId: f.courseId || null, ownerId: f.ownerId || null })}>{m.isPending && <Spinner className="h-4 w-4 text-white" />} Create lead</button></>}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Input label="Name" required value={f.name} onChange={set('name')} />
        <Input label="Phone / WhatsApp" required type="tel" value={f.phone} onChange={set('phone')} />
        {dup && <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 sm:col-span-2">Possible duplicate: <b>{dup.code} — {dup.name}</b> ({label(dup.status)}, owner {dup.owner ?? 'unassigned'}). <Link className="link" to={`/staff/leads/${dup.id}`} onClick={onClose}>Open existing lead</Link></div>}
        <Input label="Email" type="email" value={f.email} onChange={set('email')} />
        <Select label="Course interest" value={f.courseId} onChange={set('courseId')} placeholder="—" options={(courses.data?.items ?? []).map((c) => ({ value: c.id, label: c.name }))} />
        <Select label="Source" required value={f.source} onChange={set('source')} options={(sources.data?.items ?? []).map((s) => ({ value: s.code, label: s.label }))} />
        <Input label="City" value={f.city} onChange={set('city')} />
        {can('leads:assign') && <Select label="Assign to" value={f.ownerId} onChange={set('ownerId')} placeholder="Auto-assign (round-robin)" options={(staff.data?.items ?? []).map((u) => ({ value: u.id, label: u.name }))} />}
        <Textarea className="sm:col-span-2" label="Notes" value={f.notes} onChange={set('notes')} />
      </div>
    </Modal>
  );
}

function ImportModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [rows, setRows] = useState<Record<string, string>[]>([]);
  const [map, setMap] = useState<Record<string, string>>({});
  const [mode, setMode] = useState<'skip' | 'merge'>('skip');
  const [report, setReport] = useState<any>(null);
  const FIELDS = ['name', 'phone', 'email', 'course', 'source', 'city', 'notes'];
  const cols = rows[0] ? Object.keys(rows[0]) : [];
  const m = useMut(() => api('/crm/leads/import', { body: { duplicates: mode, rows: rows.map((r) => Object.fromEntries(FIELDS.map((f) => [f, map[f] ? r[map[f]] : undefined]))) } }), { invalidate: ['/crm'], onSuccess: setReport });
  const template = () => {
    const blob = new Blob(['name,phone,email,course,source,city,notes\nJohn Doe,9876543210,john@example.com,FSD,website,Kochi,Interested in weekend batch\n'], { type: 'text/csv' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'lead-import-template.csv'; a.click();
  };
  return (
    <Modal open={open} onClose={() => { onClose(); setRows([]); setReport(null); }} title="Import leads" size="lg" footer={!report && rows.length > 0 ? <button className="btn-primary" disabled={!map.name || !map.phone || m.isPending} onClick={() => m.mutate(undefined)}>{m.isPending && <Spinner className="h-4 w-4 text-white" />} Import {rows.length} rows</button> : undefined}>
      {report ? (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2">{Object.entries(report.summary).map(([k, v]) => <Badge key={k} status={k === 'created' ? 'APPROVED' : k === 'error' ? 'REJECTED' : 'PENDING'}>{label(k)}: {String(v)}</Badge>)}</div>
          <div className="max-h-72 overflow-auto rounded-lg border border-slate-200 text-sm">
            <table className="min-w-full"><thead className="bg-slate-50"><tr><th className="th">Row</th><th className="th">Result</th><th className="th">Message</th></tr></thead>
              <tbody>{report.report.filter((r: any) => r.status !== 'created').map((r: any) => <tr key={r.row}><td className="td">{r.row}</td><td className="td"><Badge status={r.status === 'error' ? 'REJECTED' : 'PENDING'}>{r.status}</Badge></td><td className="td whitespace-normal">{r.message}</td></tr>)}</tbody></table>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-slate-600">Upload a CSV (export from Excel as CSV). <button className="link" onClick={template}>Download template</button></p>
          <input type="file" accept=".csv,text/csv" className="block text-sm" onChange={async (e) => {
            const file = e.target.files?.[0]; if (!file) return;
            const r = parseCsv(await file.text()); setRows(r);
            const keys = r[0] ? Object.keys(r[0]) : [];
            setMap(Object.fromEntries(FIELDS.map((f) => [f, keys.find((k) => k.includes(f)) ?? ''])));
          }} />
          {rows.length > 0 && (
            <>
              <p className="text-sm font-medium">Map columns ({rows.length} rows found)</p>
              <div className="grid gap-3 sm:grid-cols-2">{FIELDS.map((f) => <Select key={f} label={label(f)} required={f === 'name' || f === 'phone'} value={map[f] ?? ''} onChange={(e) => setMap({ ...map, [f]: e.target.value })} placeholder="— skip —" options={cols.map((c) => ({ value: c, label: c }))} />)}</div>
              <Select label="When a duplicate (same phone/email) exists" value={mode} onChange={(e) => setMode(e.target.value as any)} options={[{ value: 'skip', label: 'Skip the row' }, { value: 'merge', label: 'Merge into existing lead' }]} />
            </>
          )}
        </div>
      )}
    </Modal>
  );
}

export function BulkWhatsAppModal({ open, onClose, leadIds, batchId }: { open: boolean; onClose: () => void; leadIds?: string[]; batchId?: string }) {
  const [content, setContent] = useState('Hi {{name}}, ');
  const [tpl, setTpl] = useState({ use: false, name: '', language: 'en', params: '{{name}}' });
  const m = useMut(() => api('/whatsapp/bulk', { body: { leadIds, batchId, content, template: tpl.use ? { name: tpl.name, language: tpl.language, params: tpl.params.split('|').map((s) => s.trim()) } : undefined } }), { success: (r: any) => `Sent ${r.sent}, failed ${r.failed}`, invalidate: ['/crm'], onSuccess: onClose });
  return (
    <Modal open={open} onClose={onClose} title={`Send WhatsApp${leadIds ? ` to ${leadIds.length} lead(s)` : ' to batch'}`} footer={<><button className="btn-secondary" onClick={onClose}>Cancel</button><button className="btn-success" disabled={m.isPending || content.length < 2} onClick={() => m.mutate(undefined)}>{m.isPending ? <Spinner className="h-4 w-4 text-white" /> : <MessageCircle className="h-4 w-4" />} Send</button></>}>
      <Textarea label="Message" rows={5} value={content} onChange={(e) => setContent(e.target.value)} hint="Use {{name}} to personalise. Free-form messages reach contacts who messaged you in the last 24 hours." />
      <label className="mt-4 flex items-center gap-2 text-sm"><input type="checkbox" className="rounded text-brand-600" checked={tpl.use} onChange={(e) => setTpl({ ...tpl, use: e.target.checked })} /> Send as approved WhatsApp template (required outside the 24-hour window)</label>
      {tpl.use && <div className="mt-3 grid gap-3 sm:grid-cols-3"><Input label="Template name" value={tpl.name} onChange={(e) => setTpl({ ...tpl, name: e.target.value })} /><Input label="Language" value={tpl.language} onChange={(e) => setTpl({ ...tpl, language: e.target.value })} /><Input label="Params (| separated)" value={tpl.params} onChange={(e) => setTpl({ ...tpl, params: e.target.value })} /></div>}
    </Modal>
  );
}

function AssignModal({ open, onClose, ids }: { open: boolean; onClose: () => void; ids: string[] }) {
  const staff = useStaff('counselor');
  const [f, setF] = useState({ ownerId: '', reason: '' });
  const m = useMut(() => api('/crm/leads/assign', { body: { leadIds: ids, ...f } }), { success: 'Leads reassigned', invalidate: ['/crm'], onSuccess: onClose });
  return (
    <Modal open={open} onClose={onClose} title={`Assign ${ids.length} lead(s)`} size="sm" footer={<button className="btn-primary" disabled={!f.ownerId || f.reason.length < 2 || m.isPending} onClick={() => m.mutate(undefined)}>Assign</button>}>
      <div className="space-y-4">
        <Select label="Counselor" required value={f.ownerId} onChange={(e) => setF({ ...f, ownerId: e.target.value })} placeholder="Select" options={(staff.data?.items ?? []).map((u) => ({ value: u.id, label: u.name }))} />
        <Textarea label="Reason" required value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} />
      </div>
    </Modal>
  );
}

export default function Leads() {
  const { can } = useAuth();
  const nav = useNavigate();
  const [sp, setSp] = useSearchParams();
  const [q, setQ] = useState(sp.get('q') ?? '');
  const dq = useDebounced(q);
  const [view, setView] = useState<'table' | 'board'>(() => (localStorage.getItem('leads.view') as any) || 'table');
  const [sel, setSel] = useState<string[]>([]);
  const [modal, setModal] = useState<'' | 'new' | 'import' | 'assign' | 'wa'>('');
  const [sort, setSort] = useState<{ key: string; dir: 'asc' | 'desc' }>({ key: 'createdAt', dir: 'desc' });
  const courses = useCourses();
  const sources = useMasters('lead_source');
  const staff = useStaff('counselor');
  const page = Number(sp.get('page') || 1);
  const filters = { q: dq, status: sp.get('status') ?? '', source: sp.get('source') ?? '', courseId: sp.get('courseId') ?? '', ownerId: sp.get('ownerId') ?? '', followUp: sp.get('followUp') ?? '' };
  const pageSize = view === 'board' ? 200 : 25;
  const path = `/crm/leads${qs({ ...filters, page: view === 'board' ? 1 : page, pageSize, sort: sort.key, dir: sort.dir })}`;
  const { data, isLoading } = useGet<any>(path);
  const setFilter = (k: string, v: string) => { const n = new URLSearchParams(sp); v ? n.set(k, v) : n.delete(k); n.delete('page'); setSp(n); };
  useEffect(() => { try { localStorage.setItem('leads.view', view); } catch { /* ignore */ } }, [view]);

  const statusMut = useMut(({ id, status }: { id: string; status: string }) => api(`/crm/leads/${id}/status`, { body: { status } }), { invalidate: ['/crm'] });

  return (
    <div>
      <PageHeader title="Leads" subtitle={data ? `${data.total} lead(s)` : undefined} actions={<>
        <button className="btn-secondary" onClick={() => download(`/crm/leads${qs({ ...filters, format: 'csv' })}`, 'leads.csv').catch((e) => toast.error(e.message))}><Download className="h-4 w-4" /> Export</button>
        {can('leads:create') && <button className="btn-secondary" onClick={() => setModal('import')}><Upload className="h-4 w-4" /> Import</button>}
        {can('leads:create') && <button className="btn-primary" onClick={() => setModal('new')}><Plus className="h-4 w-4" /> New lead</button>}
      </>} />

      <div className="mb-4 flex flex-wrap gap-2">
        {['', ...STATUSES].map((s) => (
          <button key={s} onClick={() => setFilter('status', s)} className={cx('chip px-3 py-1 text-sm ring-1 ring-inset transition', filters.status === s ? 'bg-brand-600 text-white ring-brand-600' : 'bg-white text-slate-600 ring-slate-200 hover:bg-slate-50')}>
            {s ? label(s) : 'All'} {s && data?.byStatus?.[s] != null && <span className="opacity-70">{data.byStatus[s]}</span>}
          </button>
        ))}
      </div>

      {view === 'table' ? (
        <DataTable
          rows={data?.items ?? []} loading={isLoading} total={data?.total} page={page} pageSize={pageSize} onPage={(p) => { const n = new URLSearchParams(sp); n.set('page', String(p)); setSp(n); }}
          sort={sort} onSort={setSort} selectable={can('leads:assign') || can('whatsapp:send')} selected={sel} onSelect={setSel} onRowClick={(r) => nav(`/staff/leads/${r.id}`)}
          empty={<Empty title="No leads found" hint="Try clearing filters, or add a new lead." />}
          toolbar={<>
            <div className="relative w-full sm:w-64"><Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" /><input className="input pl-9" placeholder="Name, phone, email, code" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search leads" /></div>
            <select className="input w-auto" value={filters.source} onChange={(e) => setFilter('source', e.target.value)} aria-label="Source"><option value="">All sources</option>{sources.data?.items.map((s) => <option key={s.code} value={s.code}>{s.label}</option>)}</select>
            <select className="input w-auto" value={filters.courseId} onChange={(e) => setFilter('courseId', e.target.value)} aria-label="Course"><option value="">All courses</option>{courses.data?.items.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
            {can('leads:read_all') && <select className="input w-auto" value={filters.ownerId} onChange={(e) => setFilter('ownerId', e.target.value)} aria-label="Owner"><option value="">All owners</option><option value="none">Unassigned</option>{staff.data?.items.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select>}
            <label className="flex items-center gap-1.5 text-sm text-slate-600"><input type="checkbox" className="rounded text-brand-600" checked={filters.followUp === 'due'} onChange={(e) => setFilter('followUp', e.target.checked ? 'due' : '')} /> Follow-up due</label>
            {sel.length > 0 && <>
              {can('leads:assign') && <button className="btn-secondary btn-sm" onClick={() => setModal('assign')}><UserCog className="h-4 w-4" /> Assign ({sel.length})</button>}
              {can('whatsapp:send') && <button className="btn-success btn-sm" onClick={() => setModal('wa')}><MessageCircle className="h-4 w-4" /> WhatsApp ({sel.length})</button>}
            </>}
            <div className="ml-auto flex rounded-lg border border-slate-200 p-0.5">
              <button className={cx('rounded-md p-1.5', view === 'table' && 'bg-slate-100')} onClick={() => setView('table')} aria-label="Table view"><List className="h-4 w-4" /></button>
              <button className="rounded-md p-1.5" onClick={() => setView('board')} aria-label="Board view"><KanbanSquare className="h-4 w-4" /></button>
            </div>
          </>}
          columns={[
            { key: 'name', header: 'Lead', sortable: true, cell: (r: any) => <div><p className="font-medium text-slate-900">{r.name}</p><p className="text-xs text-slate-500">{r.code} · {r.phone}</p></div> },
            { key: 'status', header: 'Status', sortable: true, cell: (r: any) => <Badge status={r.status} /> },
            { key: 'course', header: 'Course', hideable: true, cell: (r: any) => r.course?.name ?? '—' },
            { key: 'source', header: 'Source', hideable: true, cell: (r: any) => label(r.source) },
            { key: 'owner', header: 'Owner', hideable: true, cell: (r: any) => r.owner?.name ?? <span className="text-amber-600">Unassigned</span> },
            { key: 'nextFollowUpAt', header: 'Next follow-up', sortable: true, hideable: true, cell: (r: any) => r.nextFollowUpAt ? <span className={new Date(r.nextFollowUpAt) < new Date() ? 'font-medium text-rose-600' : ''}>{dt(r.nextFollowUpAt)}</span> : '—' },
            { key: 'lastActivityAt', header: 'Last activity', sortable: true, hideable: true, cell: (r: any) => ago(r.lastActivityAt) },
            { key: 'createdAt', header: 'Created', sortable: true, hideable: true, cell: (r: any) => d(r.createdAt) },
          ]}
        />
      ) : (
        <div>
          <div className="mb-3 flex justify-end"><div className="flex rounded-lg border border-slate-200 bg-white p-0.5"><button className="rounded-md p-1.5" onClick={() => setView('table')} aria-label="Table view"><List className="h-4 w-4" /></button><button className="rounded-md bg-slate-100 p-1.5" aria-label="Board view"><KanbanSquare className="h-4 w-4" /></button></div></div>
          {isLoading ? <Spinner className="mx-auto" /> : (
            <div className="flex gap-4 overflow-x-auto pb-4">
              {STATUSES.slice(0, 6).map((s) => {
                const items = (data?.items ?? []).filter((l: any) => l.status === s);
                return (
                  <div key={s} className="w-72 shrink-0 rounded-xl bg-slate-100/70 p-3" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { const id = e.dataTransfer.getData('id'); if (id && s !== 'ADMITTED') statusMut.mutate({ id, status: s }); }}>
                    <div className="mb-3 flex items-center justify-between px-1"><Badge status={s} /><span className="text-xs text-slate-500">{items.length}</span></div>
                    <div className="space-y-2">
                      {items.map((l: any) => (
                        <Link key={l.id} to={`/staff/leads/${l.id}`} draggable onDragStart={(e) => e.dataTransfer.setData('id', l.id)} className="block rounded-lg border border-slate-200 bg-white p-3 shadow-sm hover:shadow">
                          <p className="font-medium">{l.name}</p>
                          <p className="text-xs text-slate-500">{l.phone}</p>
                          <div className="mt-2 flex items-center justify-between text-xs text-slate-500"><span>{l.course?.name ?? 'No course'}</span><span>{l.owner?.name?.split(' ')[0] ?? '—'}</span></div>
                          {l.nextFollowUpAt && <p className={cx('mt-1 text-xs', new Date(l.nextFollowUpAt) < new Date() ? 'text-rose-600' : 'text-slate-500')}>⏰ {dt(l.nextFollowUpAt)}</p>}
                        </Link>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
      <NewLeadModal open={modal === 'new'} onClose={() => setModal('')} />
      <ImportModal open={modal === 'import'} onClose={() => setModal('')} />
      <AssignModal open={modal === 'assign'} onClose={() => { setModal(''); setSel([]); }} ids={sel} />
      <BulkWhatsAppModal open={modal === 'wa'} onClose={() => { setModal(''); setSel([]); }} leadIds={sel} />
    </div>
  );
}
