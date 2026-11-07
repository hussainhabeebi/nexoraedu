import { useState } from 'react';
import { KeyRound, Plus, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { api, qs } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useGet, useMut } from '@/lib/hooks';
import { ago } from '@/lib/format';
import { parseCsv } from '@/lib/csv';
import { DataTable } from '@/components/DataTable';
import { Avatar, Badge, Card, cx, Input, Modal, PageHeader, PageLoader, Select, Tabs, useDebounced } from '@/components/ui';

function UserModal({ open, onClose, user, roles, departments }: { open: boolean; onClose: () => void; user?: any; roles: any[]; departments: any[] }) {
  const { hasRole } = useAuth();
  const [f, setF] = useState<any>(user ? { name: user.name, email: user.email, username: user.username, phone: user.phone ?? '', designation: user.designation ?? '', departmentId: user.department?.id ?? '', roles: user.roles.map((r: any) => r.key), isActive: user.isActive } : { name: '', email: '', username: '', phone: '', designation: '', departmentId: '', roles: [], isActive: true });
  const [notice, setNotice] = useState<{ title: string; text: string } | null>(null);
  const m = useMut(() => (user ? api(`/admin/users/${user.id}`, { method: 'PATCH', body: { ...f, departmentId: f.departmentId || null } }) : api('/admin/users', { body: { ...f, departmentId: f.departmentId || null } })), {
    success: 'User saved', invalidate: ['/admin'],
    onSuccess: (r: any) => {
      const pending = r.pendingRoles?.length ? ` Privileged role(s) ${r.pendingRoles.join(', ')} await approval by another Super Administrator.` : '';
      if (r.activationSent) setNotice({ title: 'Activation link sent', text: `A single-use activation link (valid ${r.activationHours} hours) was sent to the user's email/WhatsApp. No password is created or shown.${pending}` });
      else if (pending) setNotice({ title: 'Saved — approval needed', text: pending.trim() });
      else onClose();
    },
  });
  const reset = useMut(() => api(`/admin/users/${user.id}/reset-password`, { body: {} }), { onSuccess: () => setNotice({ title: 'Reset link sent', text: "A single-use password reset link (valid 24 hours) was sent to the user's registered email/WhatsApp. Their current sessions were ended." }) });
  const resend = useMut(() => api(`/admin/users/${user.id}/resend-activation`, { body: {} }), { onSuccess: (r: any) => setNotice({ title: 'Activation link re-sent', text: `A new activation link (valid ${r.activationHours} hours) was sent. Earlier links no longer work.` }) });
  if (notice) return <Modal open onClose={onClose} title={notice.title} size="sm" footer={<button className="btn-primary" onClick={onClose}>Done</button>}><p className="text-sm text-slate-600">{notice.text}</p></Modal>;
  const available = roles.filter((r) => r.key !== 'student' && (r.key !== 'super_admin' || hasRole('super_admin')));
  return (
    <Modal open={open} onClose={onClose} title={user ? `Edit ${user.name}` : 'New user'} size="lg" footer={<>{user && <><button className="btn-secondary mr-auto" onClick={() => reset.mutate(undefined)}><KeyRound className="h-4 w-4" /> Send reset link</button><button className="btn-ghost" onClick={() => resend.mutate(undefined)}>Resend activation</button></>}<button className="btn-secondary" onClick={onClose}>Cancel</button><button className="btn-primary" disabled={!f.name || !f.email || !f.username || !f.roles.length || m.isPending} onClick={() => m.mutate(undefined)}>Save</button></>}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Input label="Full name" required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        <Input label="Email" type="email" required value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
        <Input label="Username" required value={f.username} onChange={(e) => setF({ ...f, username: e.target.value.toLowerCase() })} />
        <Input label="Phone (WhatsApp)" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} />
        <Input label="Designation" value={f.designation} onChange={(e) => setF({ ...f, designation: e.target.value })} />
        <Select label="Department" value={f.departmentId} onChange={(e) => setF({ ...f, departmentId: e.target.value })} placeholder="—" options={departments.map((d) => ({ value: d.id, label: d.name }))} />
        <div className="sm:col-span-2"><p className="label">Roles <span className="text-rose-600">*</span></p><div className="flex flex-wrap gap-2">{available.map((r) => <button key={r.key} type="button" onClick={() => setF({ ...f, roles: f.roles.includes(r.key) ? f.roles.filter((x: string) => x !== r.key) : [...f.roles, r.key] })} className={cx('chip px-3 py-1.5 text-sm ring-1 ring-inset', f.roles.includes(r.key) ? 'bg-brand-600 text-white ring-brand-600' : 'bg-white ring-slate-200')}>{r.name}</button>)}</div></div>
        {user && <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="rounded text-brand-600" checked={f.isActive} onChange={(e) => setF({ ...f, isActive: e.target.checked })} /> Active (users are deactivated, never deleted)</label>}
      </div>
    </Modal>
  );
}

function RolesTab() {
  const { hasRole } = useAuth();
  const { data } = useGet<any>('/admin/roles');
  const [edit, setEdit] = useState<any>(null);
  const m = useMut(() => api(`/admin/roles/${edit.id}`, { method: 'PATCH', body: { permissions: edit.permissions } }), { success: 'Role updated — users get new permissions at next sign-in', invalidate: ['/admin'], onSuccess: () => setEdit(null) });
  if (!data) return <PageLoader />;
  const perms = Object.entries(data.permissions as Record<string, string>);
  return (
    <>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {data.items.map((r: any) => (
          <Card key={r.id} title={<span>{r.name} <span className="text-xs font-normal text-slate-500">{r._count.users} user(s)</span></span>} actions={hasRole('super_admin') && r.key !== 'super_admin' && <button className="text-sm link" onClick={() => setEdit({ ...r })}>Edit</button>}>
            <div className="flex flex-wrap gap-1">{r.permissions.includes('*') ? <Badge status="APPROVED">All permissions</Badge> : r.permissions.map((p: string) => <span key={p} className="chip bg-slate-100 text-slate-700">{p}</span>)}</div>
          </Card>
        ))}
      </div>
      {edit && (
        <Modal open onClose={() => setEdit(null)} title={`Permissions — ${edit.name}`} size="lg" footer={<button className="btn-primary" disabled={m.isPending} onClick={() => m.mutate(undefined)}>Save</button>}>
          <div className="grid gap-2 sm:grid-cols-2">{perms.map(([k, v]) => <label key={k} className="flex items-start gap-2 rounded-lg p-2 text-sm hover:bg-slate-50"><input type="checkbox" className="mt-0.5 rounded text-brand-600" checked={edit.permissions.includes(k)} onChange={() => setEdit({ ...edit, permissions: edit.permissions.includes(k) ? edit.permissions.filter((x: string) => x !== k) : [...edit.permissions, k] })} /><span><b className="font-mono text-xs">{k}</b><br /><span className="text-slate-500">{v}</span></span></label>)}</div>
        </Modal>
      )}
    </>
  );
}

export default function Users() {
  const { can } = useAuth();
  const [tab, setTab] = useState<'users' | 'roles'>('users');
  const [q, setQ] = useState('');
  const [role, setRole] = useState('');
  const [page, setPage] = useState(1);
  const dq = useDebounced(q);
  const { data, isLoading } = useGet<any>(`/admin/users${qs({ q: dq, role, page, pageSize: 25 })}`);
  const roles = useGet<any>('/admin/roles');
  const deps = useGet<any>('/admin/departments');
  const [edit, setEdit] = useState<any>(null);
  const importM = useMut((rows: any[]) => api('/admin/users/import', { body: { rows } }), { invalidate: ['/admin'], onSuccess: (r: any) => toast.success(`${r.results.filter((x: any) => x.ok).length} imported (activation links sent), ${r.results.filter((x: any) => !x.ok).length} failed`) });
  return (
    <div>
      <PageHeader title="Users & roles" actions={can('users:manage') && tab === 'users' && <>
        <label className="btn-secondary cursor-pointer"><Upload className="h-4 w-4" /> Bulk import<input type="file" accept=".csv" className="sr-only" onChange={async (e) => { const f = e.target.files?.[0]; if (f) importM.mutate(parseCsv(await f.text()).map((r) => ({ name: r.name, email: r.email, username: r.username, phone: r.phone || undefined, designation: r.designation || undefined, roles: (r.roles || '').split('|').filter(Boolean) }))); }} /></label>
        <button className="btn-primary" onClick={() => setEdit('new')}><Plus className="h-4 w-4" /> New user</button>
      </>} />
      <Tabs value={tab} onChange={setTab} tabs={[{ key: 'users', label: 'Users' }, { key: 'roles', label: 'Roles & permissions' }]} />
      {tab === 'users' ? (
        <DataTable rows={data?.items ?? []} loading={isLoading} total={data?.total} page={page} pageSize={25} onPage={setPage} onRowClick={can('users:manage') ? (r) => setEdit(r) : undefined}
          toolbar={<><input className="input w-full sm:w-64" placeholder="Search name, email, username" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search users" /><select className="input w-auto" value={role} onChange={(e) => setRole(e.target.value)} aria-label="Role"><option value="">All staff roles</option>{roles.data?.items.filter((r: any) => r.key !== 'student').map((r: any) => <option key={r.key} value={r.key}>{r.name}</option>)}</select></>}
          columns={[
            { key: 'name', header: 'User', cell: (r: any) => <div className="flex items-center gap-3"><Avatar name={r.name} size="sm" /><div><p className="font-medium">{r.name}</p><p className="text-xs text-slate-500">{r.username} · {r.email}</p></div></div> },
            { key: 'roles', header: 'Roles', cell: (r: any) => <div className="flex flex-wrap gap-1">{r.roles.map((x: any) => <span key={x.key} className="chip bg-brand-50 text-brand-700">{x.name}</span>)}</div> },
            { key: 'dept', header: 'Department', cell: (r: any) => r.department?.name ?? '—' },
            { key: 'last', header: 'Last login', cell: (r: any) => (r.lastLoginAt ? ago(r.lastLoginAt) : 'Never') },
            { key: 'status', header: 'Status', cell: (r: any) => <Badge status={r.isActive ? 'ACTIVE' : 'WITHDRAWN'}>{r.isActive ? 'Active' : 'Inactive'}</Badge> },
          ]} />
      ) : <RolesTab />}
      {edit && <UserModal open onClose={() => setEdit(null)} user={edit === 'new' ? undefined : edit} roles={roles.data?.items ?? []} departments={deps.data?.items ?? []} />}
    </div>
  );
}
