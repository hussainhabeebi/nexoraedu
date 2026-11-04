import { Link } from 'react-router-dom';
import { ArrowRight, BadgeCheck, Briefcase, CalendarCheck, GraduationCap, MessageCircle, Sparkles, Users, Wallet } from 'lucide-react';
import { useSite, waLink } from '@/lib/site';
import CourseCard from '@/components/CourseCard';
import EnquiryForm from '@/components/EnquiryForm';
import { Spinner } from '@/components/ui';

const WHY = [
  [Briefcase, 'Career-first curriculum', 'Built with hiring partners — every module maps to a real job skill.'],
  [Users, 'Mentors from industry', 'Learn from practitioners, with small batches and 1:1 doubt clearing.'],
  [CalendarCheck, 'Flexible batches', 'Weekday, weekend and hybrid batches so you can learn alongside work or college.'],
  [Wallet, 'Easy installments', 'Pay in monthly installments. Instant receipts on WhatsApp and email.'],
  [BadgeCheck, 'Verified certificates', 'Every certificate carries a verification code employers can check online.'],
  [GraduationCap, 'Student portal', 'Timetable, attendance, fees, online exams and results — all in one place.'],
] as const;

const STEPS = [
  ['Talk to a counselor', 'Tell us your goals — we’ll recommend the right programme and batch.'],
  ['Apply online', 'Fill a 5-minute application and upload documents from your phone.'],
  ['Confirm admission', 'Get your Student ID, portal login and fee plan instantly on WhatsApp.'],
  ['Start learning', 'Join your batch, track progress and earn your certificate.'],
];

export default function Home() {
  const { data, isLoading } = useSite();
  return (
    <>
      <section className="relative overflow-hidden bg-slate-950 text-white">
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top_right,rgba(99,102,241,.45),transparent_50%),radial-gradient(ellipse_at_bottom_left,rgba(217,70,239,.35),transparent_50%)]" />
        <div className="relative mx-auto grid max-w-7xl items-center gap-12 px-4 py-20 sm:px-6 lg:grid-cols-2 lg:py-28">
          <div>
            <span className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/5 px-3 py-1 text-xs font-medium text-brand-200">
              <Sparkles className="h-3.5 w-3.5" /> Admissions open for the upcoming batches
            </span>
            <h1 className="mt-5 text-4xl font-extrabold leading-tight text-white sm:text-5xl lg:text-6xl">
              Learn the skills <span className="bg-gradient-to-r from-brand-300 to-accent-400 bg-clip-text text-transparent">employers hire for.</span>
            </h1>
            <p className="mt-5 max-w-xl text-lg text-slate-300">{data?.academy.tagline ?? 'Skills that shape tomorrow'}. Job-ready programmes in technology, digital marketing and commerce — with live projects, mentors and placement support.</p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link to="/apply" className="btn-primary px-6 py-3 text-base">Apply online <ArrowRight className="h-4 w-4" /></Link>
              <Link to="/courses" className="btn px-6 py-3 text-base text-white ring-1 ring-white/25 hover:bg-white/10">Explore courses</Link>
              {data?.academy.whatsapp && (
                <a href={waLink(data.academy.whatsapp)} target="_blank" rel="noreferrer" className="btn px-6 py-3 text-base text-white ring-1 ring-[#25D366]/60 hover:bg-[#25D366]/10"><MessageCircle className="h-4 w-4 text-[#25D366]" /> WhatsApp us</a>
              )}
            </div>
            <dl className="mt-12 grid max-w-md grid-cols-3 gap-6">
              {[['Programmes', data?.stats.courses ?? '—'], ['Learners', data ? `${Math.max(data.stats.students, 500)}+` : '—'], ['Placement support', '100%']].map(([k, v]) => (
                <div key={k as string}><dt className="text-xs text-slate-400">{k}</dt><dd className="font-display text-2xl font-bold">{v}</dd></div>
              ))}
            </dl>
          </div>
          <div className="rounded-2xl bg-white p-6 text-slate-800 shadow-2xl sm:p-8">
            <h2 className="text-xl font-bold">Get free career counselling</h2>
            <p className="mb-5 mt-1 text-sm text-slate-500">Leave your details — we’ll call or WhatsApp you within one working day.</p>
            <EnquiryForm compact />
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-7xl px-4 py-20 sm:px-6">
        <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
          <div>
            <p className="text-sm font-semibold uppercase tracking-wider text-brand-600">Programmes</p>
            <h2 className="mt-2 text-3xl font-bold sm:text-4xl">Choose your path</h2>
          </div>
          <Link to="/courses" className="link inline-flex items-center gap-1">View all courses <ArrowRight className="h-4 w-4" /></Link>
        </div>
        {isLoading ? <div className="py-16 text-center"><Spinner className="mx-auto" /></div> : (
          <div className="mt-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">{data?.courses.slice(0, 8).map((c) => <CourseCard key={c.id} c={c} />)}</div>
        )}
      </section>

      <section className="bg-slate-50 py-20">
        <div className="mx-auto max-w-7xl px-4 sm:px-6">
          <p className="text-sm font-semibold uppercase tracking-wider text-brand-600">Why Nexora</p>
          <h2 className="mt-2 max-w-2xl text-3xl font-bold sm:text-4xl">Everything you need to go from learner to professional</h2>
          <div className="mt-12 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {WHY.map(([Icon, t, d]) => (
              <div key={t} className="rounded-2xl border border-slate-200 bg-white p-6">
                <div className="inline-flex rounded-xl bg-brand-50 p-2.5 text-brand-600"><Icon className="h-5 w-5" /></div>
                <h3 className="mt-4 text-lg font-semibold">{t}</h3>
                <p className="mt-1.5 text-sm text-slate-600">{d}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-7xl px-4 py-20 sm:px-6">
        <h2 className="text-center text-3xl font-bold sm:text-4xl">Admission in four simple steps</h2>
        <ol className="mt-12 grid gap-6 md:grid-cols-4">
          {STEPS.map(([t, d], i) => (
            <li key={t} className="relative rounded-2xl border border-slate-200 p-6">
              <span className="flex h-9 w-9 items-center justify-center rounded-full bg-gradient-to-br from-brand-600 to-accent-500 font-bold text-white">{i + 1}</span>
              <h3 className="mt-4 font-semibold">{t}</h3>
              <p className="mt-1 text-sm text-slate-600">{d}</p>
            </li>
          ))}
        </ol>
        <div className="mt-12 flex flex-col items-center justify-between gap-6 rounded-3xl bg-gradient-to-r from-brand-600 to-accent-600 p-10 text-white md:flex-row">
          <div>
            <h3 className="text-2xl font-bold text-white">Ready to start?</h3>
            <p className="mt-1 text-brand-100">Seats are limited per batch. Apply today and lock your seat.</p>
          </div>
          <div className="flex gap-3">
            <Link to="/apply" className="btn bg-white px-6 py-3 text-brand-700 hover:bg-brand-50">Apply online</Link>
            <Link to="/track" className="btn px-6 py-3 text-white ring-1 ring-white/40 hover:bg-white/10">Track application</Link>
          </div>
        </div>
      </section>
    </>
  );
}
