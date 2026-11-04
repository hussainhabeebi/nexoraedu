import { Link } from 'react-router-dom';
import { ArrowRight, Clock, Layers } from 'lucide-react';
import type { Course } from '@/lib/site';
import { inr } from '@/lib/format';

const GRAD: Record<string, string> = { Technology: 'from-brand-600 to-sky-500', Marketing: 'from-fuchsia-600 to-rose-500', Commerce: 'from-emerald-600 to-teal-500' };

export default function CourseCard({ c }: { c: Course }) {
  const next = c.batches.find((b) => b.status === 'PLANNED') ?? c.batches[0];
  return (
    <Link to={`/courses/${c.slug}`} className="group flex flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white transition hover:-translate-y-1 hover:shadow-lift">
      <div className={`relative h-36 bg-gradient-to-br ${GRAD[c.category ?? ''] ?? 'from-brand-600 to-accent-500'} p-5 text-white`}>
        {c.imageUrl && <img src={c.imageUrl} alt="" className="absolute inset-0 h-full w-full object-cover opacity-30" />}
        <span className="relative rounded-full bg-white/20 px-2.5 py-0.5 text-xs font-semibold backdrop-blur">{c.category ?? 'Programme'}</span>
        <h3 className="relative mt-3 font-display text-xl font-bold leading-snug text-white">{c.name}</h3>
      </div>
      <div className="flex flex-1 flex-col p-5">
        <p className="line-clamp-2 text-sm text-slate-600">{c.summary}</p>
        <div className="mt-4 flex flex-wrap gap-3 text-xs text-slate-500">
          <span className="inline-flex items-center gap-1"><Clock className="h-3.5 w-3.5" /> {c.durationMonths} months</span>
          <span className="inline-flex items-center gap-1"><Layers className="h-3.5 w-3.5" /> {c.mode}</span>
          {next && <span className="inline-flex items-center gap-1 text-emerald-700">Next batch {new Date(next.startDate).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}</span>}
        </div>
        <div className="mt-auto flex items-end justify-between pt-5">
          <div>
            <p className="text-xs text-slate-500">Total fee</p>
            <p className="text-lg font-bold text-slate-900">{inr(c.totalFee, { decimals: false })}</p>
            {c.defaultInstallments > 1 && <p className="text-xs text-slate-500">or {c.defaultInstallments} installments</p>}
          </div>
          <span className="inline-flex items-center gap-1 text-sm font-semibold text-brand-700 group-hover:gap-2 transition-all">Details <ArrowRight className="h-4 w-4" /></span>
        </div>
      </div>
    </Link>
  );
}
