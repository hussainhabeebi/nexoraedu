import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, Clock, GraduationCap, Layers, MessageCircle } from 'lucide-react';
import { api } from '@/lib/api';
import { useSite, waLink, type Course } from '@/lib/site';
import { d, inr } from '@/lib/format';
import EnquiryForm from '@/components/EnquiryForm';
import { Badge, PageLoader } from '@/components/ui';
import { NotFound } from '../Errors';

export default function CourseDetail() {
  const { slug } = useParams();
  const site = useSite();
  const { data: c, isLoading, error } = useQuery({ queryKey: ['course', slug], queryFn: () => api<Course>(`/public/courses/${slug}`) });
  if (isLoading) return <PageLoader />;
  if (error || !c) return <NotFound />;
  return (
    <>
      <section className="bg-gradient-to-br from-slate-950 via-brand-950 to-slate-900 text-white">
        <div className="mx-auto max-w-7xl px-4 py-16 sm:px-6">
          <Link to="/courses" className="text-sm text-brand-200 hover:text-white">← All courses</Link>
          <p className="mt-4 text-sm font-semibold uppercase tracking-wider text-accent-400">{c.category}</p>
          <h1 className="mt-2 max-w-3xl text-4xl font-extrabold text-white sm:text-5xl">{c.name}</h1>
          <p className="mt-4 max-w-2xl text-lg text-slate-300">{c.summary}</p>
          <div className="mt-6 flex flex-wrap gap-5 text-sm text-slate-300">
            <span className="inline-flex items-center gap-1.5"><Clock className="h-4 w-4" /> {c.durationMonths} months</span>
            <span className="inline-flex items-center gap-1.5"><Layers className="h-4 w-4" /> {c.mode}</span>
            {c.eligibility && <span className="inline-flex items-center gap-1.5"><GraduationCap className="h-4 w-4" /> {c.eligibility}</span>}
          </div>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link to={`/apply?course=${c.id}`} className="btn-primary px-6 py-3">Apply for this course</Link>
            {site.data?.academy.whatsapp && <a href={waLink(site.data.academy.whatsapp, `Hi, I'd like details about ${c.name}.`)} target="_blank" rel="noreferrer" className="btn px-6 py-3 text-white ring-1 ring-white/30 hover:bg-white/10"><MessageCircle className="h-4 w-4" /> Ask on WhatsApp</a>}
          </div>
        </div>
      </section>
      <div className="mx-auto grid max-w-7xl gap-10 px-4 py-14 sm:px-6 lg:grid-cols-3">
        <div className="space-y-10 lg:col-span-2">
          {c.description && <section><h2 className="text-2xl font-bold">About the programme</h2><p className="mt-3 whitespace-pre-line leading-relaxed text-slate-700">{c.description}</p></section>}
          {!!c.highlights.length && (
            <section>
              <h2 className="text-2xl font-bold">Highlights</h2>
              <ul className="mt-4 grid gap-3 sm:grid-cols-2">{c.highlights.map((h) => <li key={h} className="flex gap-2 rounded-xl bg-slate-50 p-4 text-sm"><CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-500" />{h}</li>)}</ul>
            </section>
          )}
          {!!c.subjects?.length && (
            <section>
              <h2 className="text-2xl font-bold">Curriculum</h2>
              <ol className="mt-4 space-y-3">
                {c.subjects.map((s, i) => (
                  <li key={s.name} className="rounded-xl border border-slate-200 p-5">
                    <div className="flex items-center justify-between"><h3 className="font-semibold">{i + 1}. {s.name}</h3>{s.hours > 0 && <span className="text-xs text-slate-500">{s.hours} hrs</span>}</div>
                    {!!s.modules.length && <p className="mt-1 text-sm text-slate-600">{s.modules.map((m) => m.name).join(' · ')}</p>}
                  </li>
                ))}
              </ol>
            </section>
          )}
          <section>
            <h2 className="text-2xl font-bold">Upcoming batches</h2>
            <div className="mt-4 overflow-hidden rounded-xl border border-slate-200">
              <table className="min-w-full divide-y divide-slate-100 text-sm">
                <thead className="bg-slate-50"><tr><th className="th">Batch</th><th className="th">Starts</th><th className="th">Timing</th><th className="th">Seats</th></tr></thead>
                <tbody className="divide-y divide-slate-100">
                  {c.batches.map((b) => (
                    <tr key={b.id}><td className="td font-medium">{b.name}</td><td className="td">{d(b.startDate)}</td><td className="td">{b.timing ?? '—'}</td><td className="td">{b.seatsLeft > 0 ? <Badge status={b.seatsLeft < 6 ? 'PENDING' : 'APPROVED'}>{b.seatsLeft} left</Badge> : <Badge status="REJECTED">Full</Badge>}</td></tr>
                  ))}
                  {!c.batches.length && <tr><td colSpan={4} className="td text-center text-slate-500">New batches will be announced soon.</td></tr>}
                </tbody>
              </table>
            </div>
          </section>
        </div>
        <aside className="space-y-6">
          <div className="card p-6 lg:sticky lg:top-24">
            <p className="text-sm text-slate-500">Total programme fee</p>
            <p className="mt-1 text-3xl font-bold">{inr(c.totalFee, { decimals: false })}</p>
            {c.defaultInstallments > 1 && <p className="text-sm text-emerald-700">Pay in {c.defaultInstallments} monthly installments of ~{inr(c.totalFee / c.defaultInstallments, { decimals: false })}</p>}
            <ul className="mt-4 space-y-1.5 border-t border-slate-100 pt-4 text-sm">
              {c.feeComponents.map((f) => <li key={f.name} className="flex justify-between"><span className="text-slate-600">{f.name}{Number(f.taxPercent) > 0 && ` (+${Number(f.taxPercent)}% GST)`}</span><span>{inr(f.amount, { decimals: false })}</span></li>)}
            </ul>
            <Link to={`/apply?course=${c.id}`} className="btn-primary mt-6 w-full">Apply now</Link>
          </div>
          <div className="card p-6">
            <h3 className="mb-4 font-semibold">Have questions?</h3>
            <EnquiryForm courseId={c.id} compact />
          </div>
        </aside>
      </div>
    </>
  );
}
