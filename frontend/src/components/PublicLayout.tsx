import { useState } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import { Mail, MapPin, Menu, MessageCircle, Phone, X } from 'lucide-react';
import { useEffect } from 'react';
import Logo from './Logo';
import { cx } from './ui';
import { useSite, waLink } from '@/lib/site';

const NAV = [
  ['/', 'Home'],
  ['/courses', 'Courses'],
  ['/apply', 'Apply online'],
  ['/track', 'Track application'],
  ['/contact', 'Contact'],
];

export default function PublicLayout() {
  const [open, setOpen] = useState(false);
  const { data } = useSite();
  const loc = useLocation();
  useEffect(() => {
    setOpen(false);
    window.scrollTo(0, 0);
  }, [loc.pathname]);
  const a = data?.academy;
  return (
    <div className="flex min-h-screen flex-col bg-white">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded focus:bg-white focus:px-3 focus:py-2">Skip to content</a>
      <header className="sticky top-0 z-40 border-b border-slate-100 bg-white/85 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6">
          <Link to="/" aria-label="Nexora Academy home"><Logo /></Link>
          <nav className="hidden items-center gap-1 lg:flex" aria-label="Main">
            {NAV.map(([to, l]) => (
              <NavLink key={to} to={to} end={to === '/'} className={({ isActive }) => cx('rounded-lg px-3 py-2 text-sm font-medium transition', isActive ? 'text-brand-700' : 'text-slate-600 hover:text-slate-900')}>{l}</NavLink>
            ))}
          </nav>
          <div className="hidden items-center gap-2 lg:flex">
            <Link to="/student/login" className="btn-ghost">Student login</Link>
            <Link to="/login" className="btn-secondary">Staff</Link>
            <Link to="/apply" className="btn-primary">Apply now</Link>
          </div>
          <button className="btn-ghost p-2 lg:hidden" onClick={() => setOpen((v) => !v)} aria-label="Menu" aria-expanded={open}>
            {open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>
        </div>
        {open && (
          <div className="border-t border-slate-100 bg-white px-4 pb-4 lg:hidden">
            {NAV.map(([to, l]) => (
              <NavLink key={to} to={to} end={to === '/'} className="block rounded-lg px-3 py-3 text-base font-medium text-slate-700 hover:bg-slate-50">{l}</NavLink>
            ))}
            <div className="mt-2 grid grid-cols-2 gap-2">
              <Link to="/student/login" className="btn-secondary">Student login</Link>
              <Link to="/login" className="btn-secondary">Staff login</Link>
            </div>
          </div>
        )}
      </header>
      <main id="main" className="flex-1"><Outlet /></main>
      <footer className="bg-slate-950 text-slate-400">
        <div className="mx-auto grid max-w-7xl gap-10 px-4 py-14 sm:px-6 md:grid-cols-4">
          <div className="md:col-span-2">
            <Logo light />
            <p className="mt-4 max-w-sm text-sm leading-relaxed">{a?.tagline ?? 'Skills that shape tomorrow'}. Career-focused programmes with mentors from industry, live projects and placement support.</p>
          </div>
          <div>
            <h3 className="mb-3 text-sm font-semibold text-white">Explore</h3>
            <ul className="space-y-2 text-sm">
              <li><Link to="/courses" className="hover:text-white">All courses</Link></li>
              <li><Link to="/apply" className="hover:text-white">Apply online</Link></li>
              <li><Link to="/track" className="hover:text-white">Track application</Link></li>
              <li><Link to="/verify" className="hover:text-white">Verify certificate</Link></li>
            </ul>
          </div>
          <div>
            <h3 className="mb-3 text-sm font-semibold text-white">Contact</h3>
            <ul className="space-y-2 text-sm">
              {a?.phone && <li className="flex gap-2"><Phone className="h-4 w-4 shrink-0" /><a href={`tel:${a.phone}`} className="hover:text-white">{a.phone}</a></li>}
              {a?.email && <li className="flex gap-2"><Mail className="h-4 w-4 shrink-0" /><a href={`mailto:${a.email}`} className="hover:text-white">{a.email}</a></li>}
              {a?.address && <li className="flex gap-2"><MapPin className="h-4 w-4 shrink-0" />{a.address}</li>}
            </ul>
          </div>
        </div>
        <div className="border-t border-white/10 py-5 text-center text-xs">© {new Date().getFullYear()} {a?.name ?? 'Nexora Academy'} · nexoraed.com</div>
      </footer>
      {a?.whatsapp && (
        <a href={waLink(a.whatsapp)} target="_blank" rel="noreferrer" className="fixed bottom-5 right-5 z-40 flex items-center gap-2 rounded-full bg-[#25D366] px-4 py-3 font-semibold text-white shadow-lg transition hover:scale-105" aria-label="Chat with us on WhatsApp">
          <MessageCircle className="h-5 w-5" /> <span className="hidden sm:inline">Chat on WhatsApp</span>
        </a>
      )}
    </div>
  );
}
