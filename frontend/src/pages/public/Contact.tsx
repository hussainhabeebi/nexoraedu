import { Mail, MapPin, MessageCircle, Phone } from 'lucide-react';
import { useSite, waLink } from '@/lib/site';
import EnquiryForm from '@/components/EnquiryForm';

export default function Contact() {
  const { data } = useSite();
  const a = data?.academy;
  return (
    <div className="mx-auto grid max-w-6xl gap-10 px-4 py-14 sm:px-6 lg:grid-cols-5">
      <div className="lg:col-span-2">
        <h1 className="text-4xl font-bold">Talk to us</h1>
        <p className="mt-3 text-slate-600">Questions about courses, batches, fees or admissions? We usually reply within a few hours.</p>
        <ul className="mt-8 space-y-4">
          {a?.whatsapp && <li><a href={waLink(a.whatsapp)} target="_blank" rel="noreferrer" className="flex items-center gap-3 rounded-xl border border-emerald-200 bg-emerald-50 p-4 font-medium text-emerald-800 hover:bg-emerald-100"><MessageCircle className="h-5 w-5" /> Chat on WhatsApp</a></li>}
          {a?.phone && <li className="flex items-center gap-3 text-slate-700"><Phone className="h-5 w-5 text-brand-600" /><a href={`tel:${a.phone}`}>{a.phone}</a></li>}
          {a?.email && <li className="flex items-center gap-3 text-slate-700"><Mail className="h-5 w-5 text-brand-600" /><a href={`mailto:${a.email}`}>{a.email}</a></li>}
          {a?.address && <li className="flex items-center gap-3 text-slate-700"><MapPin className="h-5 w-5 text-brand-600" />{a.address}</li>}
        </ul>
      </div>
      <div className="card p-6 sm:p-8 lg:col-span-3"><EnquiryForm /></div>
    </div>
  );
}
