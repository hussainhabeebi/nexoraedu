import { Link } from 'react-router-dom';
import { AlertTriangle, CalendarDays, ClipboardCheck, Trophy, Wallet } from 'lucide-react';
import { useGet } from '@/lib/hooks';
import { d, dt, inr, t } from '@/lib/format';
import { Badge, Card, Empty, PageLoader, Progress } from '@/components/ui';

export default function Home() {
  const { data, isLoading } = useGet<any>('/portal/me');
  if (isLoading || !data) return <PageLoader />;
  const s = data.student;
  const a = data.attendance;
  return (
    <div className="space-y-6">
      <div className="overflow-hidden rounded-2xl bg-gradient-to-br from-brand-600 to-accent-600 p-6 text-white">
        <p className="text-sm text-brand-100">Welcome back,</p>
        <h1 className="text-2xl font-bold text-white">{s.fullName}</h1>
        <p className="mt-1 text-sm text-brand-100">{s.studentCode} · {s.course.name}{s.batch && ` · Batch ${s.batch.code}`}</p>
        <Badge status={s.status} className="mt-3 bg-white/20 text-white ring-white/30" />
      </div>
      {a.percentage != null && a.percentage < a.threshold && <p className="flex items-center gap-2 rounded-xl bg-rose-50 p-4 text-sm text-rose-800"><AlertTriangle className="h-5 w-5 shrink-0" /> Your attendance ({a.percentage}%) is below the required {a.threshold}%. Please attend upcoming sessions.</p>}
      <div className="grid gap-4 sm:grid-cols-3">
        <Link to="/student/fees" className="card p-5 hover:shadow-lift">
          <Wallet className="h-5 w-5 text-brand-600" /><p className="mt-3 text-xs uppercase text-slate-500">Fee balance</p><p className="text-2xl font-bold">{inr(data.balance)}</p>
          {data.nextDue && <p className={`text-sm ${new Date(data.nextDue.dueDate) < new Date() ? 'font-medium text-rose-600' : 'text-slate-500'}`}>Next: {inr(data.nextDue.amount)} due {d(data.nextDue.dueDate)}</p>}
        </Link>
        <div className="card p-5"><CalendarDays className="h-5 w-5 text-emerald-600" /><p className="mt-3 text-xs uppercase text-slate-500">Attendance</p><p className="text-2xl font-bold">{a.percentage != null ? `${a.percentage}%` : '—'}</p>{a.percentage != null && <Progress value={a.percentage} tone={a.percentage < a.threshold ? 'rose' : 'green'} />}</div>
        <Link to="/student/exams" className="card p-5 hover:shadow-lift"><ClipboardCheck className="h-5 w-5 text-fuchsia-600" /><p className="mt-3 text-xs uppercase text-slate-500">Upcoming exams</p><p className="text-2xl font-bold">{data.exams.length}</p></Link>
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Upcoming classes" actions={<Link to="/student/timetable" className="text-sm link">Timetable</Link>} bodyClass="p-0">
          {data.upcoming.length ? <ul className="divide-y divide-slate-100">{data.upcoming.map((x: any) => <li key={x.id} className="flex justify-between px-5 py-3 text-sm"><span>{x.title ?? 'Class'}{x.room && <span className="text-slate-500"> · {x.room}</span>}</span><span className="text-slate-500">{d(x.startsAt)} · {t(x.startsAt)}</span></li>)}</ul> : <Empty title="No upcoming classes" />}
        </Card>
        <Card title="Exams" bodyClass="p-0">
          {data.exams.length ? <ul className="divide-y divide-slate-100">{data.exams.map((e: any) => <li key={e.id}><Link to="/student/exams" className="flex justify-between px-5 py-3 text-sm hover:bg-slate-50"><span>{e.title}</span><span className="text-slate-500">{dt(e.startAt)}</span></Link></li>)}</ul> : <Empty title="No exams scheduled" />}
        </Card>
        <Card title="Latest results" actions={<Link to="/student/results" className="text-sm link">All results</Link>} bodyClass="p-0" className="lg:col-span-2">
          {data.results.length ? <ul className="divide-y divide-slate-100">{data.results.map((r: any) => <li key={r.id} className="flex items-center justify-between px-5 py-3 text-sm"><span className="flex items-center gap-2"><Trophy className="h-4 w-4 text-amber-500" />{r.exam.title}</span><span className="font-medium">{r.marks}/{r.exam.totalMarks} · {r.grade}</span></li>)}</ul> : <Empty title="No results published yet" />}
        </Card>
      </div>
    </div>
  );
}
