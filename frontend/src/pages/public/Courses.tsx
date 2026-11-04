import { useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import { useSite } from '@/lib/site';
import CourseCard from '@/components/CourseCard';
import { cx, Empty, PageLoader } from '@/components/ui';

export default function Courses() {
  const { data, isLoading } = useSite();
  const [q, setQ] = useState('');
  const [cat, setCat] = useState('All');
  const cats = useMemo(() => ['All', ...new Set((data?.courses ?? []).map((c) => c.category ?? 'Other'))], [data]);
  const list = (data?.courses ?? []).filter((c) => (cat === 'All' || (c.category ?? 'Other') === cat) && (c.name + c.summary).toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="mx-auto max-w-7xl px-4 py-14 sm:px-6">
      <h1 className="text-4xl font-bold">Courses</h1>
      <p className="mt-2 text-slate-600">Career-focused programmes with flexible batches and installment plans.</p>
      <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative max-w-sm flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input className="input pl-9" placeholder="Search courses" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search courses" />
        </div>
        <div className="flex flex-wrap gap-2">
          {cats.map((c) => (
            <button key={c} onClick={() => setCat(c)} className={cx('rounded-full px-4 py-1.5 text-sm font-medium transition', cat === c ? 'bg-brand-600 text-white' : 'bg-slate-100 text-slate-700 hover:bg-slate-200')}>{c}</button>
          ))}
        </div>
      </div>
      {isLoading ? <PageLoader /> : list.length ? (
        <div className="mt-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">{list.map((c) => <CourseCard key={c.id} c={c} />)}</div>
      ) : <Empty title="No courses match your search" hint="Try a different keyword or category." />}
    </div>
  );
}
