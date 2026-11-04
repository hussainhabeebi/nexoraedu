import { useState } from 'react';
import { CheckCircle2 } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { useSite } from '@/lib/site';
import { ErrorBox, Input, Select, Spinner, Textarea } from './ui';

export default function EnquiryForm({ courseId, compact }: { courseId?: string; compact?: boolean }) {
  const { data } = useSite();
  const [f, setF] = useState({ name: '', phone: '', email: '', courseId: courseId ?? '', message: '', website: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<ApiError | null>(null);
  const [done, setDone] = useState(false);
  const set = (k: keyof typeof f) => (e: any) => setF({ ...f, [k]: e.target.value });
  if (done)
    return (
      <div className="flex flex-col items-center py-8 text-center">
        <CheckCircle2 className="h-12 w-12 text-emerald-500" />
        <p className="mt-3 text-lg font-semibold">Thank you, {f.name.split(' ')[0]}!</p>
        <p className="mt-1 text-sm text-slate-500">A counselor will reach you on WhatsApp / phone shortly.</p>
      </div>
    );
  return (
    <form
      className="grid gap-4"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setErr(null);
        try {
          await api('/public/enquiry', { body: { ...f, courseId: f.courseId || null } });
          setDone(true);
        } catch (e) {
          setErr(e as ApiError);
        } finally {
          setBusy(false);
        }
      }}
    >
      <ErrorBox error={err && !err.fields ? err : null} />
      <div className={compact ? 'grid gap-4' : 'grid gap-4 sm:grid-cols-2'}>
        <Input label="Full name" required value={f.name} onChange={set('name')} error={err?.fields?.name} autoComplete="name" />
        <Input label="Mobile / WhatsApp" required type="tel" value={f.phone} onChange={set('phone')} error={err?.fields?.phone} autoComplete="tel" placeholder="+91 98xxxxxxxx" />
        <Input label="Email" type="email" value={f.email} onChange={set('email')} error={err?.fields?.email} autoComplete="email" />
        <Select label="Course of interest" value={f.courseId} onChange={set('courseId')} placeholder="Not sure yet" options={(data?.courses ?? []).map((c) => ({ value: c.id, label: c.name }))} />
      </div>
      <Textarea label="Message" value={f.message} onChange={set('message')} placeholder="Preferred timing, questions about fees…" />
      <input type="text" name="website" value={f.website} onChange={set('website')} className="hidden" tabIndex={-1} autoComplete="off" aria-hidden />
      <button className="btn-primary w-full sm:w-auto" disabled={busy}>{busy && <Spinner className="h-4 w-4 text-white" />} Request a call back</button>
      <p className="text-xs text-slate-500">By submitting, you agree to be contacted by Nexora Academy via phone, email or WhatsApp.</p>
    </form>
  );
}
