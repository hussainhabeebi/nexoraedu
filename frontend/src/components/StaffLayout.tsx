import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Award, BarChart3, Bell, BookOpen, CalendarDays, CheckSquare, ClipboardCheck, FileCheck2, FileText, GraduationCap, KeyRound, LayoutDashboard, Layers, ListChecks,
  LogOut, Menu, MessageCircle, PhoneCall, Search, Settings, ShieldCheck, UserPlus, Users, Wallet, X, FileQuestion,
} from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { api } from '@/lib/api';
import { ago } from '@/lib/format';
import Logo from './Logo';
import { Avatar, cx } from './ui';

type Item = { to: string; label: string; icon: any; perm?: string[] };
const GROUPS: { title: string; items: Item[] }[] = [
  { title: '', items: [{ to: '/staff/dashboard', label: 'Dashboard', icon: LayoutDashboard }, { to: '/staff/approvals', label: 'Approvals', icon: CheckSquare, perm: ['approvals:act', 'leads:create', 'finance:collect', 'exams:manage', 'students:manage', 'academics:manage'] }] },
  {
    title: 'Admissions',
    items: [
      { to: '/staff/leads', label: 'Leads', icon: UserPlus, perm: ['leads:read'] },
      { to: '/staff/follow-ups', label: 'Follow-ups', icon: PhoneCall, perm: ['leads:read'] },
      { to: '/staff/applications', label: 'Applications', icon: FileText, perm: ['leads:read', 'students:read'] },
      { to: '/staff/whatsapp', label: 'WhatsApp inbox', icon: MessageCircle, perm: ['whatsapp:send'] },
    ],
  },
  {
    title: 'Students',
    items: [
      { to: '/staff/students', label: 'Students', icon: GraduationCap, perm: ['students:read', 'students:read_batch'] },
      { to: '/staff/documents', label: 'Document verification', icon: FileCheck2, perm: ['documents:verify'] },
    ],
  },
  { title: 'Finance', items: [{ to: '/staff/finance', label: 'Fees & payments', icon: Wallet, perm: ['finance:read'] }] },
  {
    title: 'Academics',
    items: [
      { to: '/staff/courses', label: 'Courses', icon: BookOpen, perm: ['academics:read', 'masters:manage'] },
      { to: '/staff/batches', label: 'Batches', icon: Layers, perm: ['academics:read'] },
      { to: '/staff/timetable', label: 'Timetable & attendance', icon: CalendarDays, perm: ['academics:read', 'attendance:mark'] },
    ],
  },
  {
    title: 'Examinations',
    items: [
      { to: '/staff/exams', label: 'Exams', icon: ClipboardCheck, perm: ['exams:read'] },
      { to: '/staff/question-bank', label: 'Question bank', icon: FileQuestion, perm: ['exams:read'] },
      { to: '/staff/evaluation', label: 'Evaluation', icon: ListChecks, perm: ['exams:manage'] },
      { to: '/staff/certificates', label: 'Certificates', icon: Award, perm: ['exams:read'] },
    ],
  },
  {
    title: 'Insights & admin',
    items: [
      { to: '/staff/reports', label: 'Reports', icon: BarChart3, perm: ['reports:read'] },
      { to: '/staff/users', label: 'Users & roles', icon: Users, perm: ['users:read'] },
      { to: '/staff/settings', label: 'Settings', icon: Settings, perm: ['settings:manage', 'masters:manage', 'notifications:manage'] },
      { to: '/staff/audit', label: 'Audit logs', icon: ShieldCheck, perm: ['audit:read'] },
    ],
  },
];

export function useIdleLogout(minutes: number, onIdle: () => void) {
  useEffect(() => {
    let t: ReturnType<typeof setTimeout>;
    const reset = () => {
      clearTimeout(t);
      t = setTimeout(onIdle, minutes * 60_000);
    };
    const ev = ['mousemove', 'keydown', 'click', 'touchstart', 'scroll'];
    ev.forEach((e) => window.addEventListener(e, reset, { passive: true }));
    reset();
    return () => {
      clearTimeout(t);
      ev.forEach((e) => window.removeEventListener(e, reset));
    };
  }, [minutes, onIdle]);
}

export function NotificationBell({ base }: { base: string }) {
  const [open, setOpen] = useState(false);
  const qc = useQueryClient();
  const nav = useNavigate();
  const { data } = useQuery({ queryKey: ['notifications'], queryFn: () => api<{ items: any[]; unread: number }>('/notifications'), refetchInterval: 60_000 });
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);
  const markAll = async () => {
    await api('/notifications/read', { body: {} });
    qc.invalidateQueries({ queryKey: ['notifications'] });
  };
  return (
    <div className="relative" ref={ref}>
      <button className="btn-ghost relative p-2" onClick={() => setOpen((v) => !v)} aria-label={`Notifications${data?.unread ? `, ${data.unread} unread` : ''}`}>
        <Bell className="h-5 w-5" />
        {!!data?.unread && <span className="absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-rose-500 px-1 text-[10px] font-bold text-white">{data.unread > 9 ? '9+' : data.unread}</span>}
      </button>
      {open && (
        <div className="absolute right-0 z-50 mt-2 w-80 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xl sm:w-96">
          <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
            <span className="text-sm font-semibold">Notifications</span>
            {!!data?.unread && <button className="text-xs font-medium text-brand-700 hover:underline" onClick={markAll}>Mark all read</button>}
          </div>
          <ul className="max-h-96 divide-y divide-slate-100 overflow-y-auto">
            {!data?.items.length && <li className="px-4 py-8 text-center text-sm text-slate-500">You’re all caught up.</li>}
            {data?.items.map((n) => (
              <li key={n.id}>
                <button
                  className={cx('block w-full px-4 py-3 text-left hover:bg-slate-50', !n.readAt && 'bg-brand-50/40')}
                  onClick={async () => {
                    setOpen(false);
                    await api('/notifications/read', { body: { ids: [n.id] } });
                    qc.invalidateQueries({ queryKey: ['notifications'] });
                    if (n.link) nav(n.link.startsWith('/staff') || n.link.startsWith('/student') ? n.link : `${base}${n.link}`);
                  }}
                >
                  <p className="text-sm font-medium text-slate-900">{n.title}</p>
                  <p className="line-clamp-2 text-xs text-slate-600">{n.body}</p>
                  <p className="mt-1 text-[11px] text-slate-400">{ago(n.createdAt)}</p>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export default function StaffLayout() {
  const { user, can, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const [menu, setMenu] = useState(false);
  const [q, setQ] = useState('');
  const nav = useNavigate();
  const loc = useLocation();
  useEffect(() => setOpen(false), [loc.pathname]);
  useIdleLogout(30, () => {
    logout();
    nav('/login', { state: { reason: 'idle' } });
  });

  const groups = GROUPS.map((g) => ({ ...g, items: g.items.filter((i) => !i.perm || can(...i.perm)) })).filter((g) => g.items.length);
  const sidebar = (
    <nav className="flex h-full flex-col gap-5 overflow-y-auto px-3 py-4" aria-label="Staff">
      {groups.map((g) => (
        <div key={g.title}>
          {g.title && <p className="mb-1 px-3 text-[11px] font-semibold uppercase tracking-wider text-slate-400">{g.title}</p>}
          {g.items.map((i) => (
            <NavLink key={i.to} to={i.to} className={({ isActive }) => cx('flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition', isActive ? 'bg-brand-50 text-brand-700' : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900')}>
              <i.icon className="h-4 w-4 shrink-0" /> {i.label}
            </NavLink>
          ))}
        </div>
      ))}
    </nav>
  );

  const search = (e: React.FormEvent) => {
    e.preventDefault();
    if (!q.trim()) return;
    nav(can('students:read') && (/^nxa/i.test(q) || !can('leads:read')) ? `/staff/students?q=${encodeURIComponent(q)}` : `/staff/leads?q=${encodeURIComponent(q)}`);
  };

  return (
    <div className="min-h-screen lg:pl-64">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 flex-col border-r border-slate-200 bg-white lg:flex">
        <div className="flex h-16 items-center border-b border-slate-100 px-5">
          <Link to="/staff"><Logo /></Link>
        </div>
        {sidebar}
      </aside>
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-slate-900/40" onClick={() => setOpen(false)} />
          <aside className="absolute inset-y-0 left-0 flex w-72 flex-col bg-white shadow-xl">
            <div className="flex h-16 items-center justify-between border-b border-slate-100 px-5">
              <Logo />
              <button className="btn-ghost p-2" onClick={() => setOpen(false)} aria-label="Close menu"><X className="h-5 w-5" /></button>
            </div>
            {sidebar}
          </aside>
        </div>
      )}
      <header className="sticky top-0 z-20 flex h-16 items-center gap-3 border-b border-slate-200 bg-white/90 px-4 backdrop-blur sm:px-6">
        <button className="btn-ghost p-2 lg:hidden" onClick={() => setOpen(true)} aria-label="Open menu"><Menu className="h-5 w-5" /></button>
        <form onSubmit={search} className="relative max-w-md flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input className="input pl-9" placeholder="Search students, leads by name, phone, ID…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Quick search" />
        </form>
        <div className="ml-auto flex items-center gap-1">
          <NotificationBell base="" />
          <div className="relative">
            <button className="flex items-center gap-2 rounded-lg p-1.5 hover:bg-slate-100" onClick={() => setMenu((v) => !v)} aria-expanded={menu}>
              <Avatar name={user!.name} size="sm" />
              <span className="hidden text-left sm:block">
                <span className="block text-sm font-medium leading-tight">{user!.name}</span>
                <span className="block text-xs capitalize leading-tight text-slate-500">{user!.roles.map((r) => r.replace(/_/g, ' ')).join(', ')}</span>
              </span>
            </button>
            {menu && (
              <div className="absolute right-0 z-50 mt-2 w-52 rounded-xl border border-slate-200 bg-white p-1 shadow-xl" onMouseLeave={() => setMenu(false)}>
                <Link to="/change-password" className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm hover:bg-slate-50"><KeyRound className="h-4 w-4" /> Change password</Link>
                <button className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-rose-600 hover:bg-rose-50" onClick={async () => { await logout(); nav('/login'); }}><LogOut className="h-4 w-4" /> Sign out</button>
              </div>
            )}
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-7xl animate-fade-in px-4 py-6 sm:px-6 lg:px-8">
        <Outlet />
      </main>
    </div>
  );
}
