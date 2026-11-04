import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import Logo from './Logo';

export default function AuthShell({ title, subtitle, children, side }: { title: string; subtitle?: string; children: ReactNode; side?: ReactNode }) {
  return (
    <div className="grid min-h-screen lg:grid-cols-2">
      <div className="flex flex-col justify-center px-6 py-12 sm:px-12">
        <div className="mx-auto w-full max-w-sm">
          <Link to="/"><Logo /></Link>
          <h1 className="mt-10 text-2xl font-bold">{title}</h1>
          {subtitle && <p className="mt-1 text-sm text-slate-500">{subtitle}</p>}
          <div className="mt-8">{children}</div>
        </div>
      </div>
      <div className="relative hidden overflow-hidden bg-slate-950 lg:block">
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top_right,rgba(99,102,241,.55),transparent_55%),radial-gradient(ellipse_at_bottom_left,rgba(217,70,239,.4),transparent_55%)]" />
        <div className="relative flex h-full flex-col justify-end p-14 text-white">{side}</div>
      </div>
    </div>
  );
}
