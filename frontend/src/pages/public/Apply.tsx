import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { CheckCircle2, MessageCircle } from 'lucide-react';
import { api } from '@/lib/api';
import { useSite, waLink } from '@/lib/site';
import ApplicationForm, { emptyApp, toPayload } from '@/components/ApplicationForm';
import { PageLoader } from '@/components/ui';

export default function Apply() {
  const [sp] = useSearchParams();
  const { data, isLoading } = useSite();
  const [code, setCode] = useState<string | null>(null);
  if (isLoading) return <PageLoader />;
  if (code)
    return (
      <div className="mx-auto max-w-xl px-4 py-20 text-center">
        <CheckCircle2 className="mx-auto h-16 w-16 text-emerald-500" />
        <h1 className="mt-4 text-3xl font-bold">Application submitted!</h1>
        <p className="mt-2 text-slate-600">Your application number is</p>
        <p className="mt-2 inline-block rounded-xl bg-brand-50 px-5 py-3 font-mono text-2xl font-bold text-brand-700">{code}</p>
        <p className="mt-4 text-slate-600">We’ve sent the details to your WhatsApp and email. A counselor will contact you to complete admission.</p>
        <div className="mt-8 flex justify-center gap-3">
          <Link to="/track" className="btn-primary">Track application</Link>
          {data?.academy.whatsapp && <a href={waLink(data.academy.whatsapp, `Hi, I just submitted application ${code}.`)} className="btn-secondary" target="_blank" rel="noreferrer"><MessageCircle className="h-4 w-4" /> WhatsApp us</a>}
        </div>
      </div>
    );
  return (
    <div className="mx-auto max-w-4xl px-4 py-12 sm:px-6">
      <h1 className="text-3xl font-bold sm:text-4xl">Online registration</h1>
      <p className="mt-2 text-slate-600">Takes about 5 minutes. Keep your ID proof and latest marksheet handy.</p>
      <div className="card mt-8 p-5 sm:p-8">
        <ApplicationForm
          mode="public"
          initial={emptyApp({}, sp.get('course') ?? '')}
          onSubmit={async (a, files) => {
            const fd = new FormData();
            fd.append('data', JSON.stringify(toPayload(a)));
            files.forEach((f) => {
              fd.append('files', f.file);
              fd.append('fileTypes', f.type);
            });
            const r = await api<{ code: string }>('/public/applications', { body: fd });
            setCode(r.code);
            window.scrollTo(0, 0);
          }}
        />
      </div>
    </div>
  );
}
