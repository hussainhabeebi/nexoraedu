import { Link } from 'react-router-dom';
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Legend, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { AlertTriangle, CalendarClock, CheckSquare, ClipboardCheck, FileCheck2, GraduationCap, IndianRupee, PhoneCall, TrendingUp, UserPlus, Users, Wallet } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { useGet } from '@/lib/hooks';
import { ago, d, dt, inr, label, num, t } from '@/lib/format';
import { Badge, Card, Empty, PageHeader, PageLoader, Progress, Stat } from '@/components/ui';

const COLORS = ['#4f46e5', '#c026d3', '#0ea5e9', '#10b981', '#f59e0b', '#f43f5e', '#64748b', '#8b5cf6', '#14b8a6'];
const PIPE = ['NEW', 'CONTACTED', 'INTERESTED', 'COUNSELLED', 'APPLICATION', 'ADMITTED'];

export default function Dashboard() {
  const { user } = useAuth();
  const { data, isLoading } = useGet<any>('/dashboard', { refetchInterval: 120_000 });
  if (isLoading || !data) return <PageLoader />;
  const hour = new Date().getHours();
  const greet = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const m = data.management, s = data.sales, f = data.finance, a = data.academic, fac = data.faculty, ex = data.exams, ad = data.admin;

  return (
    <div className="space-y-8">
      <PageHeader title={`${greet}, ${user!.name.split(' ')[0]}`} subtitle={new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })} />

      {!!data.approvals?.awaitingMe?.length && (
        <Card title={<span className="flex items-center gap-2"><CheckSquare className="h-4 w-4 text-amber-500" /> Awaiting your approval</span>} actions={<Link to="/staff/approvals" className="text-sm link">View all</Link>} bodyClass="p-0">
          <ul className="divide-y divide-slate-100">
            {data.approvals.awaitingMe.map((r: any) => (
              <li key={r.id}><Link to={`/staff/approvals/${r.id}`} className="flex items-center justify-between gap-3 px-5 py-3 hover:bg-slate-50"><span className="text-sm">{r.title}</span><span className="shrink-0 text-xs text-slate-500">{ago(r.createdAt)}</span></Link></li>
            ))}
          </ul>
        </Card>
      )}

      {m && (
        <section className="space-y-4">
          <h2 className="text-lg font-semibold">Management overview</h2>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Stat label="Admissions this month" value={num(m.kpis.admissionsThisMonth)} icon={<GraduationCap className="h-5 w-5" />} />
            <Stat label="Revenue this month" value={inr(m.kpis.revenueThisMonth, { decimals: false })} icon={<IndianRupee className="h-5 w-5" />} tone="green" />
            <Stat label="Outstanding fees" value={inr(m.kpis.outstanding, { decimals: false })} icon={<Wallet className="h-5 w-5" />} tone="amber" />
            <Stat label="Active students" value={num(m.kpis.activeStudents)} icon={<Users className="h-5 w-5" />} tone="sky" />
            <Stat label="Lead conversion (90d)" value={`${m.kpis.conversionRate}%`} icon={<TrendingUp className="h-5 w-5" />} tone="violet" />
            <Stat label="Attendance (30d)" value={m.kpis.attendanceAvg != null ? `${m.kpis.attendanceAvg}%` : '—'} icon={<CalendarClock className="h-5 w-5" />} tone="sky" />
            <Stat label="Pass rate" value={m.kpis.passRate != null ? `${m.kpis.passRate}%` : '—'} icon={<ClipboardCheck className="h-5 w-5" />} tone="green" />
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <Card title="Revenue trend (6 months)">
              <div className="h-64">
                <ResponsiveContainer>
                  <AreaChart data={m.trend}>
                    <defs><linearGradient id="rv" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#4f46e5" stopOpacity={0.3} /><stop offset="1" stopColor="#4f46e5" stopOpacity={0} /></linearGradient></defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                    <XAxis dataKey="month" tick={{ fontSize: 12 }} /><YAxis tick={{ fontSize: 12 }} tickFormatter={(v) => `₹${v >= 1e5 ? (v / 1e5).toFixed(1) + 'L' : v >= 1e3 ? (v / 1e3).toFixed(0) + 'k' : v}`} />
                    <Tooltip formatter={(v: any) => inr(v)} />
                    <Area type="monotone" dataKey="revenue" stroke="#4f46e5" fill="url(#rv)" strokeWidth={2} name="Revenue" />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </Card>
            <Card title="Leads vs admissions">
              <div className="h-64">
                <ResponsiveContainer>
                  <BarChart data={m.trend}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                    <XAxis dataKey="month" tick={{ fontSize: 12 }} /><YAxis allowDecimals={false} tick={{ fontSize: 12 }} />
                    <Tooltip /><Legend />
                    <Bar dataKey="leads" fill="#c7d2fe" name="Leads" radius={[4, 4, 0, 0]} />
                    <Bar dataKey="admissions" fill="#4f46e5" name="Admissions" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </Card>
          </div>
        </section>
      )}

      {ad && (
        <section className="space-y-4">
          <h2 className="text-lg font-semibold">Administration</h2>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            <Link to="/staff/students"><Stat label="New registrations (7d)" value={ad.kpis.newRegistrations7d} icon={<GraduationCap className="h-5 w-5" />} /></Link>
            <Link to="/staff/documents"><Stat label="Documents to verify" value={ad.kpis.pendingDocuments} icon={<FileCheck2 className="h-5 w-5" />} tone="amber" /></Link>
            <Link to="/staff/applications"><Stat label="Applications to process" value={ad.kpis.pendingApplications} icon={<UserPlus className="h-5 w-5" />} tone="violet" /></Link>
            <Link to="/staff/approvals?box=all"><Stat label="Pending approvals" value={ad.kpis.pendingApprovals} icon={<CheckSquare className="h-5 w-5" />} tone="sky" /></Link>
            <Link to="/staff/users"><Stat label="Inactive users (30d)" value={ad.kpis.inactiveUsers} icon={<Users className="h-5 w-5" />} tone="rose" /></Link>
            <Link to="/staff/audit?tab=notifications"><Stat label="Failed notifications (24h)" value={ad.kpis.failedNotifications24h} icon={<AlertTriangle className="h-5 w-5" />} tone={ad.kpis.failedNotifications24h ? 'rose' : 'green'} /></Link>
          </div>
        </section>
      )}

      {s && (
        <section className="space-y-4">
          <h2 className="text-lg font-semibold">Sales & counselling</h2>
          <div className="grid gap-4 sm:grid-cols-3">
            <Link to="/staff/leads"><Stat label="New leads today" value={s.kpis.newLeadsToday} icon={<UserPlus className="h-5 w-5" />} /></Link>
            <Link to="/staff/follow-ups"><Stat label="Follow-ups due today" value={s.kpis.followUpsDueToday} icon={<PhoneCall className="h-5 w-5" />} tone="sky" /></Link>
            <Link to="/staff/follow-ups?when=overdue"><Stat label="Overdue follow-ups" value={s.kpis.followUpsOverdue} icon={<AlertTriangle className="h-5 w-5" />} tone={s.kpis.followUpsOverdue ? 'rose' : 'green'} /></Link>
          </div>
          <div className="grid gap-4 lg:grid-cols-3">
            <Card title="Conversion funnel" className="lg:col-span-2">
              <div className="space-y-3">
                {PIPE.map((st, i) => {
                  const reached = PIPE.slice(i).reduce((sum, k) => sum + (s.pipeline[k] ?? 0), 0);
                  const top = PIPE.reduce((sum, k) => sum + (s.pipeline[k] ?? 0), 0) || 1;
                  return (
                    <Link key={st} to={`/staff/leads?status=${st}`} className="block">
                      <div className="mb-1 flex justify-between text-sm"><span className="font-medium">{label(st)}</span><span className="text-slate-500">{s.pipeline[st] ?? 0} now · {reached} reached</span></div>
                      <Progress value={(reached / top) * 100} tone={st === 'ADMITTED' ? 'green' : 'brand'} />
                    </Link>
                  );
                })}
              </div>
            </Card>
            <Card title="Lead sources">
              {s.sources.length ? (
                <div className="h-56">
                  <ResponsiveContainer>
                    <PieChart>
                      <Pie data={s.sources} dataKey="leads" nameKey="source" innerRadius={45} outerRadius={80} paddingAngle={2}>
                        {s.sources.map((_: any, i: number) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                      </Pie>
                      <Tooltip formatter={(v: any, n: any) => [v, label(n)]} /><Legend formatter={(v) => label(v)} wrapperStyle={{ fontSize: 12 }} />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
              ) : <Empty title="No leads yet" />}
            </Card>
          </div>
          {s.leaderboard && (
            <Card title="Counselor leaderboard" bodyClass="p-0">
              <table className="min-w-full divide-y divide-slate-100">
                <thead className="bg-slate-50"><tr><th className="th">#</th><th className="th">Counselor</th><th className="th">Leads</th><th className="th">Admissions</th><th className="th">Conversion</th><th className="th">Contacts (30d)</th></tr></thead>
                <tbody className="divide-y divide-slate-100">
                  {s.leaderboard.map((r: any, i: number) => (
                    <tr key={r.id}><td className="td font-semibold text-slate-400">{i + 1}</td><td className="td font-medium">{r.name}</td><td className="td">{r.leads}</td><td className="td">{r.admitted}</td><td className="td"><div className="flex w-32 items-center gap-2"><Progress value={r.conversion} tone="green" /><span className="text-xs">{r.conversion}%</span></div></td><td className="td">{r.activities}</td></tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}
        </section>
      )}

      {f && (
        <section className="space-y-4">
          <h2 className="text-lg font-semibold">Finance</h2>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Stat label="Today’s collection" value={inr(f.kpis.todayCollection, { decimals: false })} icon={<IndianRupee className="h-5 w-5" />} tone="green" />
            <div className="card p-5">
              <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Month vs target</p>
              <p className="mt-1 text-2xl font-bold">{inr(f.kpis.monthCollection, { decimals: false })}</p>
              <div className="mt-2"><Progress value={(f.kpis.monthCollection / (f.kpis.monthTarget || 1)) * 100} tone="green" /></div>
              <p className="mt-1 text-xs text-slate-500">Target {inr(f.kpis.monthTarget, { decimals: false })}</p>
            </div>
            <Link to="/staff/finance/outstanding"><Stat label="Overdue" value={inr(f.kpis.overdueTotal, { decimals: false })} icon={<AlertTriangle className="h-5 w-5" />} tone="rose" /></Link>
            <Link to="/staff/approvals?box=all"><Stat label="Pending discounts / refunds" value={`${f.kpis.pendingDiscounts} / ${f.kpis.pendingRefunds}`} icon={<CheckSquare className="h-5 w-5" />} tone="amber" /></Link>
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <Card title="Overdue by ageing">
              <div className="h-56">
                <ResponsiveContainer>
                  <BarChart data={[['0–30 days', f.ageing.d0_30], ['31–60', f.ageing.d31_60], ['61–90', f.ageing.d61_90], ['90+', f.ageing.d90p]].map(([k, v]) => ({ k, v }))}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" /><XAxis dataKey="k" tick={{ fontSize: 12 }} /><YAxis tick={{ fontSize: 12 }} />
                    <Tooltip formatter={(v: any) => inr(v)} /><Bar dataKey="v" name="Overdue" radius={[4, 4, 0, 0]}>{[0, 1, 2, 3].map((i) => <Cell key={i} fill={['#fbbf24', '#f97316', '#ef4444', '#991b1b'][i]} />)}</Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </Card>
            <Card title="Installments due in the next 7 days" bodyClass="p-0">
              {f.upcoming.length ? (
                <ul className="divide-y divide-slate-100">{f.upcoming.map((u: any) => <li key={u.id}><Link to={`/staff/students/${u.student.id}?tab=fees`} className="flex justify-between px-5 py-3 text-sm hover:bg-slate-50"><span>{u.student.fullName} <span className="text-slate-400">{u.student.studentCode}</span></span><span className="font-medium">{inr(u.amount)} · {d(u.due)}</span></Link></li>)}</ul>
              ) : <Empty title="Nothing due this week" />}
            </Card>
          </div>
        </section>
      )}

      {a && (
        <section className="space-y-4">
          <h2 className="text-lg font-semibold">Academics</h2>
          <div className="grid gap-4 sm:grid-cols-3">
            <Link to="/staff/batches"><Stat label="Running batches" value={a.kpis.runningBatches} icon={<Users className="h-5 w-5" />} /></Link>
            <Link to="/staff/timetable"><Stat label="Sessions today" value={a.kpis.todaySessions} icon={<CalendarClock className="h-5 w-5" />} tone="sky" /></Link>
            <Stat label="At-risk (low attendance)" value={a.lowAttendance.length} icon={<AlertTriangle className="h-5 w-5" />} tone={a.lowAttendance.length ? 'rose' : 'green'} />
          </div>
          <div className="grid gap-4 lg:grid-cols-3">
            <Card title="Attendance by batch">
              {a.attendanceByBatch.length ? <div className="space-y-3">{a.attendanceByBatch.map((b: any) => <div key={b.code}><div className="mb-1 flex justify-between text-sm"><span>{b.code}</span><span>{b.pct}%</span></div><Progress value={b.pct} tone={b.pct < 75 ? 'rose' : 'green'} /></div>)}</div> : <Empty title="No attendance yet" />}
            </Card>
            <Card title="Low-attendance students" bodyClass="p-0">
              {a.lowAttendance.length ? <ul className="divide-y divide-slate-100">{a.lowAttendance.map((x: any) => <li key={x.id}><Link to={`/staff/students/${x.id}`} className="flex justify-between px-5 py-2.5 text-sm hover:bg-slate-50"><span>{x.name}</span><Badge status="ABSENT">{x.pct}%</Badge></Link></li>)}</ul> : <Empty title="No at-risk students" />}
            </Card>
            <Card title="Faculty workload (this week)">
              {a.facultyWorkload.length ? <div className="h-52"><ResponsiveContainer><BarChart data={a.facultyWorkload} layout="vertical"><XAxis type="number" allowDecimals={false} tick={{ fontSize: 12 }} /><YAxis type="category" dataKey="name" width={90} tick={{ fontSize: 12 }} /><Tooltip /><Bar dataKey="sessions" fill="#0ea5e9" radius={[0, 4, 4, 0]} /></BarChart></ResponsiveContainer></div> : <Empty title="No sessions scheduled" />}
            </Card>
          </div>
        </section>
      )}

      {fac && (
        <section className="grid gap-4 lg:grid-cols-3">
          <Card title="My sessions today" bodyClass="p-0">
            {fac.today.length ? <ul className="divide-y divide-slate-100">{fac.today.map((x: any) => <li key={x.id}><Link to={`/staff/attendance/${x.id}`} className="flex justify-between px-5 py-3 text-sm hover:bg-slate-50"><span>{x.title ?? 'Class'} · {x.batch.code}</span><span className="text-slate-500">{t(x.startsAt)}</span></Link></li>)}</ul> : <Empty title="No sessions today" />}
          </Card>
          <Card title="Attendance to mark" bodyClass="p-0">
            {fac.attendanceToMark.length ? <ul className="divide-y divide-slate-100">{fac.attendanceToMark.map((x: any) => <li key={x.id}><Link to={`/staff/attendance/${x.id}`} className="flex justify-between px-5 py-3 text-sm hover:bg-slate-50"><span>{x.batch.code}</span><span className="text-rose-600">{dt(x.startsAt)}</span></Link></li>)}</ul> : <Empty title="All attendance marked" />}
          </Card>
          <Stat label="Submissions to grade" value={fac.submissionsToGrade} icon={<ClipboardCheck className="h-5 w-5" />} tone="violet" />
        </section>
      )}

      {ex && (
        <section className="grid gap-4 lg:grid-cols-3">
          <Link to="/staff/evaluation"><Stat label="Pending evaluations" value={ex.kpis.pendingEvaluations} icon={<ClipboardCheck className="h-5 w-5" />} tone="amber" /></Link>
          <Link to="/staff/exams"><Stat label="Results to publish" value={ex.kpis.resultsToPublish} icon={<CheckSquare className="h-5 w-5" />} tone="violet" /></Link>
          <Card title="Upcoming exams" bodyClass="p-0">
            {ex.upcoming.length ? <ul className="divide-y divide-slate-100">{ex.upcoming.map((x: any) => <li key={x.id}><Link to={`/staff/exams/${x.id}`} className="flex justify-between px-5 py-3 text-sm hover:bg-slate-50"><span>{x.title}</span><span className="text-slate-500">{dt(x.startAt)}</span></Link></li>)}</ul> : <Empty title="No upcoming exams" />}
          </Card>
        </section>
      )}
    </div>
  );
}
