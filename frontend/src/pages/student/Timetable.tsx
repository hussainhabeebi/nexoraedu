import { useGet } from '@/lib/hooks';
import { t } from '@/lib/format';
import { format } from 'date-fns';
import { Badge, Card, Empty, PageHeader, PageLoader, Progress } from '@/components/ui';

export default function Timetable() {
  const { data, isLoading } = useGet<any>('/portal/timetable');
  const att = useGet<any>('/portal/attendance');
  if (isLoading) return <PageLoader />;
  const byDay = new Map<string, any[]>();
  data.items.forEach((s: any) => { const k = new Date(s.startsAt).toDateString(); byDay.set(k, [...(byDay.get(k) ?? []), s]); });
  const statusOf = Object.fromEntries((att.data?.items ?? []).map((a: any) => [a.sessionId, a.status]));
  return (
    <div className="space-y-6">
      <PageHeader title="Timetable & attendance" />
      {att.data?.summary.percentage != null && <Card><div className="flex items-center gap-4"><p className="text-3xl font-bold">{att.data.summary.percentage}%</p><div className="flex-1"><Progress value={att.data.summary.percentage} tone={att.data.summary.percentage < 75 ? 'rose' : 'green'} /><p className="mt-1 text-sm text-slate-500">Attended {att.data.summary.present} of {att.data.summary.total} sessions</p></div></div></Card>}
      {byDay.size ? [...byDay.entries()].map(([day, items]) => (
        <Card key={day} title={format(new Date(day), 'EEEE, dd MMM')} bodyClass="p-0">
          <ul className="divide-y divide-slate-100">{items.map((s) => <li key={s.id} className="flex items-center justify-between px-5 py-3 text-sm"><div><p className={s.cancelled ? 'text-slate-400 line-through' : 'font-medium'}>{s.title ?? s.subjectName ?? 'Class'}</p><p className="text-xs text-slate-500">{t(s.startsAt)} – {t(s.endsAt)}{s.facultyName && ` · ${s.facultyName}`}{s.room && ` · ${s.room}`}</p></div>{s.cancelled ? <Badge status="CANCELLED" /> : statusOf[s.id] ? <Badge status={statusOf[s.id]} /> : null}</li>)}</ul>
        </Card>
      )) : <Empty title="No published sessions" hint="Your timetable will appear here once published." />}
    </div>
  );
}
