import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom';
import { BookOpen, CalendarDays, ClipboardCheck, Home, LogOut, Trophy, User, Wallet } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import Logo from './Logo';
import { NotificationBell } from './StaffLayout';
import { Avatar, cx } from './ui';

const NAV = [
  ['/student', 'Home', Home],
  ['/student/timetable', 'Timetable', CalendarDays],
  ['/student/fees', 'Fees', Wallet],
  ['/student/exams', 'Exams', ClipboardCheck],
  ['/student/results', 'Results', Trophy],
  ['/student/learning', 'Learning', BookOpen],
  ['/student/profile', 'Profile', User],
] as const;

export default function StudentLayout() {
  const { user, logout } = useAuth();
  const nav = useNavigate();
  return (
    <div className="min-h-screen pb-20 md:pb-0">
      <header className="sticky top-0 z-20 border-b border-slate-200 bg-white/90 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center gap-4 px-4">
          <Link to="/student"><Logo /></Link>
          <nav className="ml-6 hidden gap-1 md:flex" aria-label="Student">
            {NAV.map(([to, l]) => (
              <NavLink key={to} to={to} end={to === '/student'} className={({ isActive }) => cx('rounded-lg px-3 py-2 text-sm font-medium', isActive ? 'bg-brand-50 text-brand-700' : 'text-slate-600 hover:bg-slate-100')}>{l}</NavLink>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <NotificationBell base="" />
            <Avatar name={user!.name} size="sm" />
            <button className="btn-ghost p-2" aria-label="Sign out" onClick={async () => { await logout(); nav('/student/login'); }}><LogOut className="h-4 w-4" /></button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl animate-fade-in px-4 py-6"><Outlet /></main>
      {/* Mobile bottom navigation (UI-19/20: touch-friendly) */}
      <nav className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-5 border-t border-slate-200 bg-white md:hidden" aria-label="Student mobile">
        {NAV.slice(0, 5).map(([to, l, Icon]) => (
          <NavLink key={to} to={to} end={to === '/student'} className={({ isActive }) => cx('flex min-h-[56px] flex-col items-center justify-center gap-0.5 text-[11px] font-medium', isActive ? 'text-brand-700' : 'text-slate-500')}>
            <Icon className="h-5 w-5" />{l}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
