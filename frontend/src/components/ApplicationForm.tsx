import { useMemo, useState } from 'react';
import { Check, ChevronLeft, ChevronRight, FileUp, Plus, Trash2 } from 'lucide-react';
import { useSite } from '@/lib/site';
import { ApiError } from '@/lib/api';
import { d, inr } from '@/lib/format';
import { cx, ErrorBox, Input, KV, Select, Spinner, Textarea, useUnsavedWarning } from './ui';

export interface AppData {
  personal: { fullName: string; dob: string; gender: string; phone: string; email: string; address: string; city: string };
  guardians: { name: string; relation: string; phone: string; email: string; occupation: string }[];
  education: { level: string; institution: string; board: string; year: string; marks: string }[];
  preferences: { courseId: string; batchId: string; mode?: string };
  declaration?: boolean;
}
export const emptyApp = (p: Partial<AppData['personal']> = {}, courseId = ''): AppData => ({
  personal: { fullName: '', dob: '', gender: '', phone: '', email: '', address: '', city: '', ...p },
  guardians: [],
  education: [{ level: '', institution: '', board: '', year: '', marks: '' }],
  preferences: { courseId, batchId: '' },
  declaration: false,
});

const age = (dob: string) => {
  if (!dob) return null;
  const b = new Date(dob);
  const n = new Date();
  let a = n.getFullYear() - b.getFullYear();
  if (n.getMonth() < b.getMonth() || (n.getMonth() === b.getMonth() && n.getDate() < b.getDate())) a--;
  return a;
};

type Files = { file: File; type: string }[];

/** Multi-step application / registration (UI-12): steps with progress, inline validation, review. */
export default function ApplicationForm({ initial, mode, onSubmit, submitLabel = 'Submit application', requireBatch }: {
  initial?: AppData; mode: 'public' | 'staff'; onSubmit: (d: AppData, files: Files) => Promise<void>; submitLabel?: string; requireBatch?: boolean;
}) {
  const { data: site } = useSite();
  const [f, setF] = useState<AppData>(initial ?? emptyApp());
  const [files, setFiles] = useState<Files>([]);
  const [step, setStep] = useState(0);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [apiErr, setApiErr] = useState<ApiError | null>(null);
  const [dirty, setDirty] = useState(false);
  useUnsavedWarning(dirty && !busy);

  const steps = mode === 'public' ? ['Course', 'Personal', 'Guardian & education', 'Documents', 'Review'] : ['Course', 'Personal', 'Guardian & education', 'Review'];
  const course = site?.courses.find((c) => c.id === f.preferences.courseId);
  const minor = (age(f.personal.dob) ?? 99) < 18;
  const docTypes = site?.documentTypes ?? [];

  const up = (fn: (x: AppData) => void) => {
    const n = structuredClone(f);
    fn(n);
    setF(n);
    setDirty(true);
  };

  const validate = (s: number) => {
    const e: Record<string, string> = {};
    const name = steps[s];
    if (name === 'Course') {
      if (!f.preferences.courseId) e.courseId = 'Please choose a course';
      if (requireBatch && !f.preferences.batchId) e.batchId = 'Please choose a batch';
    }
    if (name === 'Personal') {
      const p = f.personal;
      if (p.fullName.trim().length < 2) e.fullName = 'Enter your full name';
      if (!p.dob) e.dob = 'Enter date of birth';
      else if ((age(p.dob) ?? 0) < 10) e.dob = 'Please check the date of birth';
      if (!p.gender) e.gender = 'Select gender';
      if (p.phone.replace(/\D/g, '').length < 10) e.phone = 'Enter a valid mobile number';
      if (!/^\S+@\S+\.\S+$/.test(p.email)) e.email = 'Enter a valid email';
      if (p.address.trim().length < 5) e.address = 'Enter your address';
    }
    if (name === 'Guardian & education') {
      if (minor && !f.guardians.length) e.guardians = 'Guardian details are required for applicants under 18';
      f.guardians.forEach((g, i) => {
        if (!g.name || !g.relation || g.phone.replace(/\D/g, '').length < 10) e[`g${i}`] = 'Name, relation and a valid phone are required';
      });
      f.education.forEach((x, i) => {
        if ((x.level || x.institution) && (!x.level || x.institution.length < 2)) e[`e${i}`] = 'Choose level and enter institution';
      });
    }
    if (name === 'Documents') {
      const missing = docTypes.filter((t) => t.meta?.mandatory && !files.some((x) => x.type === t.code));
      if (missing.length) e.docs = `Please upload: ${missing.map((m) => m.label).join(', ')}`;
    }
    if (name === 'Review' && mode === 'public' && !f.declaration) e.declaration = 'Please accept the declaration';
    setErrors(e);
    return !Object.keys(e).length;
  };

  const next = () => validate(step) && setStep((s) => Math.min(s + 1, steps.length - 1));
  const submit = async () => {
    if (!validate(step)) return;
    setBusy(true);
    setApiErr(null);
    try {
      const clean: AppData = { ...f, education: f.education.filter((x) => x.level && x.institution), guardians: f.guardians };
      if (mode !== 'public') delete clean.declaration; // the declaration is only part of the public application
      await onSubmit(clean, files);
      setDirty(false);
    } catch (e) {
      setApiErr(e as ApiError);
    } finally {
      setBusy(false);
    }
  };

  const batchOptions = useMemo(() => (course?.batches ?? []).map((b) => ({ value: b.id, label: `${b.name} · starts ${d(b.startDate)}${b.timing ? ` · ${b.timing}` : ''} · ${b.seatsLeft} seats left` })), [course]);

  return (
    <div>
      <ol className="mb-8 flex items-center gap-2 overflow-x-auto" aria-label="Progress">
        {steps.map((s, i) => (
          <li key={s} className="flex shrink-0 items-center gap-2">
            <button type="button" onClick={() => i < step && setStep(i)} className={cx('flex h-8 w-8 items-center justify-center rounded-full text-sm font-semibold', i < step ? 'bg-emerald-500 text-white' : i === step ? 'bg-brand-600 text-white ring-4 ring-brand-100' : 'bg-slate-100 text-slate-500')} aria-current={i === step ? 'step' : undefined}>
              {i < step ? <Check className="h-4 w-4" /> : i + 1}
            </button>
            <span className={cx('text-sm font-medium', i === step ? 'text-slate-900' : 'text-slate-500')}>{s}</span>
            {i < steps.length - 1 && <span className="mx-1 h-px w-6 bg-slate-200 sm:w-10" />}
          </li>
        ))}
      </ol>

      <div className="space-y-5">
        {steps[step] === 'Course' && (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              {site?.courses.map((c) => (
                <button type="button" key={c.id} onClick={() => up((x) => { x.preferences.courseId = c.id; x.preferences.batchId = ''; })} className={cx('rounded-xl border p-4 text-left transition', f.preferences.courseId === c.id ? 'border-brand-500 bg-brand-50 ring-2 ring-brand-200' : 'border-slate-200 hover:border-slate-300')}>
                  <p className="font-semibold">{c.name}</p>
                  <p className="mt-0.5 text-xs text-slate-500">{c.durationMonths} months · {inr(c.totalFee, { decimals: false })}</p>
                </button>
              ))}
            </div>
            {errors.courseId && <p className="text-sm text-rose-600">{errors.courseId}</p>}
            {course && <Select label="Preferred batch" required={requireBatch} value={f.preferences.batchId} onChange={(e) => up((x) => (x.preferences.batchId = e.target.value))} placeholder={requireBatch ? 'Select a batch' : 'Any / let the counselor suggest'} options={batchOptions} error={errors.batchId} />}
          </>
        )}

        {steps[step] === 'Personal' && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Input className="sm:col-span-2" label="Full name (as in certificates)" required value={f.personal.fullName} onChange={(e) => up((x) => (x.personal.fullName = e.target.value))} error={errors.fullName} autoComplete="name" />
            <Input label="Date of birth" type="date" required value={f.personal.dob} onChange={(e) => up((x) => (x.personal.dob = e.target.value))} error={errors.dob} max={new Date().toISOString().slice(0, 10)} />
            <Select label="Gender" required value={f.personal.gender} onChange={(e) => up((x) => (x.personal.gender = e.target.value))} placeholder="Select" options={['Male', 'Female', 'Other'].map((v) => ({ value: v, label: v }))} error={errors.gender} />
            <Input label="Mobile (WhatsApp)" type="tel" required value={f.personal.phone} onChange={(e) => up((x) => (x.personal.phone = e.target.value))} error={errors.phone} autoComplete="tel" placeholder="+91 98xxxxxxxx" />
            <Input label="Email" type="email" required value={f.personal.email} onChange={(e) => up((x) => (x.personal.email = e.target.value))} error={errors.email} autoComplete="email" />
            <Textarea className="sm:col-span-2" label="Address" required value={f.personal.address} onChange={(e) => up((x) => (x.personal.address = e.target.value))} error={errors.address} autoComplete="street-address" />
            <Input label="City" value={f.personal.city} onChange={(e) => up((x) => (x.personal.city = e.target.value))} autoComplete="address-level2" />
          </div>
        )}

        {steps[step] === 'Guardian & education' && (
          <>
            <div>
              <div className="mb-2 flex items-center justify-between">
                <h3 className="font-semibold">Parent / guardian {minor && <span className="text-rose-600">*</span>}</h3>
                <button type="button" className="btn-secondary btn-sm" onClick={() => up((x) => x.guardians.push({ name: '', relation: '', phone: '', email: '', occupation: '' }))}><Plus className="h-4 w-4" /> Add guardian</button>
              </div>
              {minor && <p className="mb-2 text-sm text-amber-700">Applicant is under 18 — at least one guardian is required.</p>}
              {errors.guardians && <p className="mb-2 text-sm text-rose-600">{errors.guardians}</p>}
              {f.guardians.map((g, i) => (
                <div key={i} className="mb-3 grid gap-3 rounded-xl border border-slate-200 p-4 sm:grid-cols-3">
                  <Input label="Name" required value={g.name} onChange={(e) => up((x) => (x.guardians[i].name = e.target.value))} />
                  <Select label="Relation" required value={g.relation} onChange={(e) => up((x) => (x.guardians[i].relation = e.target.value))} placeholder="Select" options={['Father', 'Mother', 'Guardian', 'Spouse', 'Sibling'].map((v) => ({ value: v, label: v }))} />
                  <Input label="Phone" required type="tel" value={g.phone} onChange={(e) => up((x) => (x.guardians[i].phone = e.target.value))} />
                  <Input label="Email" type="email" value={g.email} onChange={(e) => up((x) => (x.guardians[i].email = e.target.value))} />
                  <Input label="Occupation" value={g.occupation} onChange={(e) => up((x) => (x.guardians[i].occupation = e.target.value))} />
                  <div className="flex items-end"><button type="button" className="btn-ghost text-rose-600" onClick={() => up((x) => x.guardians.splice(i, 1))}><Trash2 className="h-4 w-4" /> Remove</button></div>
                  {errors[`g${i}`] && <p className="text-sm text-rose-600 sm:col-span-3">{errors[`g${i}`]}</p>}
                </div>
              ))}
            </div>
            <div>
              <div className="mb-2 flex items-center justify-between">
                <h3 className="font-semibold">Education</h3>
                <button type="button" className="btn-secondary btn-sm" onClick={() => up((x) => x.education.push({ level: '', institution: '', board: '', year: '', marks: '' }))}><Plus className="h-4 w-4" /> Add qualification</button>
              </div>
              {f.education.map((x0, i) => (
                <div key={i} className="mb-3 grid gap-3 rounded-xl border border-slate-200 p-4 sm:grid-cols-5">
                  <Select label="Level" value={x0.level} onChange={(e) => up((x) => (x.education[i].level = e.target.value))} placeholder="Select" options={(site?.qualifications ?? []).map((q) => ({ value: q.code, label: q.label }))} />
                  <Input className="sm:col-span-2" label="Institution" value={x0.institution} onChange={(e) => up((x) => (x.education[i].institution = e.target.value))} />
                  <Input label="Year" type="number" value={x0.year} onChange={(e) => up((x) => (x.education[i].year = e.target.value))} />
                  <Input label="Marks / grade" value={x0.marks} onChange={(e) => up((x) => (x.education[i].marks = e.target.value))} />
                  <Input className="sm:col-span-2" label="Board / university" value={x0.board} onChange={(e) => up((x) => (x.education[i].board = e.target.value))} />
                  {f.education.length > 1 && <div className="flex items-end"><button type="button" className="btn-ghost text-rose-600" onClick={() => up((x) => x.education.splice(i, 1))}><Trash2 className="h-4 w-4" /></button></div>}
                  {errors[`e${i}`] && <p className="text-sm text-rose-600 sm:col-span-5">{errors[`e${i}`]}</p>}
                </div>
              ))}
            </div>
          </>
        )}

        {steps[step] === 'Documents' && (
          <div className="space-y-3">
            <p className="text-sm text-slate-600">Upload clear photos or PDFs (max 5 MB each). You can take a photo directly from your phone.</p>
            {docTypes.map((t) => {
              const has = files.find((x) => x.type === t.code);
              return (
                <div key={t.code} className="flex flex-col gap-3 rounded-xl border border-slate-200 p-4 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <p className="font-medium">{t.label} {t.meta?.mandatory && <span className="text-rose-600">*</span>}</p>
                    {has && <p className="text-xs text-emerald-700">✓ {has.file.name} ({Math.round(has.file.size / 1024)} KB)</p>}
                  </div>
                  <label className="btn-secondary btn-sm cursor-pointer">
                    <FileUp className="h-4 w-4" /> {has ? 'Replace' : 'Upload'}
                    <input type="file" className="sr-only" accept="application/pdf,image/jpeg,image/png,image/webp" capture={t.code === 'photo' ? 'user' : undefined} onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (!file) return;
                      if (file.size > 5 * 1024 * 1024) return setErrors({ docs: `${file.name} is larger than 5 MB` });
                      setFiles((fs) => [...fs.filter((x) => x.type !== t.code), { file, type: t.code }]);
                      setDirty(true);
                    }} />
                  </label>
                </div>
              );
            })}
            {errors.docs && <p className="text-sm text-rose-600">{errors.docs}</p>}
          </div>
        )}

        {steps[step] === 'Review' && (
          <div className="space-y-5">
            <div className="rounded-xl bg-slate-50 p-5">
              <KV items={[
                ['Course', course?.name], ['Batch', course?.batches.find((b) => b.id === f.preferences.batchId)?.name ?? 'Counselor will suggest'],
                ['Name', f.personal.fullName], ['Date of birth', d(f.personal.dob)], ['Gender', f.personal.gender], ['Mobile', f.personal.phone], ['Email', f.personal.email], ['Address', `${f.personal.address}${f.personal.city ? `, ${f.personal.city}` : ''}`],
                ['Guardians', f.guardians.map((g) => `${g.name} (${g.relation})`).join(', ') || '—'], ['Education', f.education.filter((e) => e.level).map((e) => `${e.level} — ${e.institution}`).join(', ') || '—'],
                ...(mode === 'public' ? [['Documents', files.map((x) => docTypes.find((t) => t.code === x.type)?.label).join(', ') || '—'] as [string, string]] : []),
              ]} />
            </div>
            {course && <p className="text-sm text-slate-600">Programme fee: <b>{inr(course.totalFee)}</b>{course.defaultInstallments > 1 && ` (payable in ${course.defaultInstallments} installments)`}. Your fee plan will be shared after admission is confirmed.</p>}
            {mode === 'public' && (
              <label className="flex items-start gap-3 text-sm">
                <input type="checkbox" className="mt-0.5 rounded text-brand-600" checked={!!f.declaration} onChange={(e) => up((x) => (x.declaration = e.target.checked))} />
                <span>I declare that the information provided is true and I agree to Nexora Academy’s admission terms and to be contacted via WhatsApp, phone and email.</span>
              </label>
            )}
            {errors.declaration && <p className="text-sm text-rose-600">{errors.declaration}</p>}
            {apiErr && <ErrorBox error={apiErr.fields ? new Error(Object.entries(apiErr.fields).map(([k, v]) => `${k}: ${v}`).join('; ')) : apiErr} />}
          </div>
        )}
      </div>

      <div className="mt-8 flex justify-between border-t border-slate-100 pt-5">
        <button type="button" className="btn-secondary" disabled={step === 0} onClick={() => setStep((s) => s - 1)}><ChevronLeft className="h-4 w-4" /> Back</button>
        {step < steps.length - 1 ? (
          <button type="button" className="btn-primary" onClick={next}>Continue <ChevronRight className="h-4 w-4" /></button>
        ) : (
          <button type="button" className="btn-primary" onClick={submit} disabled={busy}>{busy && <Spinner className="h-4 w-4 text-white" />} {submitLabel}</button>
        )}
      </div>
    </div>
  );
}

/** Convert form data to API payload shape. */
export const toPayload = (a: AppData) => ({
  ...a,
  personal: { ...a.personal, city: a.personal.city || undefined },
  guardians: a.guardians.map((g) => ({ ...g, email: g.email || undefined, occupation: g.occupation || undefined })),
  education: a.education.map((e) => ({ ...e, year: e.year ? Number(e.year) : undefined, board: e.board || undefined, marks: e.marks || undefined })),
  preferences: { courseId: a.preferences.courseId, batchId: a.preferences.batchId || null },
});
