import { useEffect, useState } from 'react';
import { AlertTriangle, Bot, Play, RotateCcw } from 'lucide-react';
import { api } from '@/lib/api';
import { useGet, useMut } from '@/lib/hooks';
import { dt, label } from '@/lib/format';
import { Badge, Card, Empty, Input, PageLoader, Spinner, Textarea } from '@/components/ui';

/**
 * Settings → WhatsApp AI Chatbot (Admin / Super Admin, permission chatbot:manage). The prompt is saved in the Nexora
 * database through the API; nothing is kept in the browser.
 */
export default function ChatbotSettings() {
  const { data, isLoading } = useGet<any>('/admin/chatbot');
  const [f, setF] = useState<any>(null);
  const [keywords, setKeywords] = useState('');
  const [test, setTest] = useState({ message: '' });
  const [result, setResult] = useState<any>(null);
  const [page, setPage] = useState(1);
  const events = useGet<any>(`/admin/chatbot/events?page=${page}&pageSize=15`);
  useEffect(() => {
    if (data) {
      setF({ ...data.config });
      setKeywords((data.config.handoverKeywords ?? []).join(', '));
    }
  }, [data]);
  const body = () => ({ ...f, maxBotReplies: Number(f.maxBotReplies), dailyAiLimit: Number(f.dailyAiLimit ?? 300), handoverKeywords: keywords.split(',').map((k) => k.trim()).filter(Boolean) });
  const save = useMut((v: any) => api('/admin/chatbot', { method: 'PUT', body: v }), { success: 'Chatbot settings saved', invalidate: ['/admin/chatbot'] });
  const run = useMut(() => api('/admin/chatbot/test', { body: { message: test.message, draft: { systemPrompt: f.systemPrompt, knowledge: f.knowledge } } }), { onSuccess: (r: any) => setResult(r) });
  const resume = useMut((id: number) => api(`/admin/chatbot/conversations/${id}/resume`, { body: {} }), { success: 'The assistant will answer this conversation again', invalidate: ['/admin/chatbot'] });
  if (isLoading || !f) return <PageLoader />;
  const st = data.status;
  const missing = [!st.aiConfigured && 'the ANTHROPIC_API_KEY secret on this Worker (Cloudflare → Workers & Pages → this Worker → Settings → Variables and Secrets)', !st.chatwootReady && 'a working Chatwoot connection (Settings → WhatsApp)'].filter(Boolean);
  const dirty = JSON.stringify(body()) !== JSON.stringify({ ...data.config, maxBotReplies: Number(data.config.maxBotReplies), dailyAiLimit: Number(data.config.dailyAiLimit ?? 300) });

  return (
    <div className="space-y-6">
      <Card title={<span className="flex items-center gap-2"><Bot className="h-4 w-4" /> Assistant status</span>}>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Badge status={st.active ? 'ACTIVE' : st.enabled ? 'PENDING' : 'INACTIVE'}>{st.active ? 'On — answering new WhatsApp enquiries' : st.enabled ? 'On, but not ready' : 'Off'}</Badge>
          <Badge status={st.aiConfigured ? 'ACTIVE' : 'FAILED'}>AI key {st.aiConfigured ? 'configured' : 'missing'}</Badge>
          <Badge status={st.chatwootReady ? 'ACTIVE' : 'FAILED'}>Chatwoot {st.chatwootReady ? 'connected' : 'not connected'}</Badge>
          <span className="text-slate-500">Model: {st.model} · {data.publishedCourses} published course(s) used as facts</span>
        </div>
        {missing.length > 0 && (
          <p className="mt-4 flex items-start gap-2 rounded-lg bg-amber-50 p-3 text-sm text-amber-800"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /><span>Required before the assistant can be turned on: {missing.join('; ')}.</span></p>
        )}
        {Object.keys(data.last7Days ?? {}).length > 0 && (
          <p className="mt-3 text-xs text-slate-500">Last 7 days: {Object.entries(data.last7Days).filter(([k]) => k !== 'OFF').map(([k, n]) => `${label(k)} ${n}`).join(' · ') || 'no assistant activity'}</p>
        )}
      </Card>

      <Card title="Behaviour" actions={<button className="btn-primary btn-sm" disabled={save.isPending || !dirty} onClick={() => save.mutate(body())}>{save.isPending && <Spinner className="h-4 w-4 text-white" />} Save</button>}>
        <div className="space-y-4">
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-0.5 rounded text-brand-600" checked={!!f.enabled} disabled={!f.enabled && (!st.aiConfigured || !st.chatwootReady)} onChange={(e) => setF({ ...f, enabled: e.target.checked })} />
            <span><b>Enable the WhatsApp AI assistant.</b> It answers new enquiries (unknown numbers and leads) on the Chatwoot WhatsApp inbox. Students and parents are always answered by staff.</span>
          </label>
          <Textarea label="System prompt" rows={14} value={f.systemPrompt} onChange={(e) => setF({ ...f, systemPrompt: e.target.value })} hint="How the assistant should behave. Safety rules are always added after this (shown below) and cannot be removed." />
          <Textarea label="Additional knowledge" rows={8} value={f.knowledge} onChange={(e) => setF({ ...f, knowledge: e.target.value })} hint="Verified facts not in the course data: office timings, documents needed, how to apply, payment options… The assistant uses only this and the published course data (courses, fees, batches)." />
          <details className="rounded-lg bg-slate-50 p-3 text-xs text-slate-600"><summary className="cursor-pointer font-medium">Fixed safety rules (always applied)</summary><pre className="mt-2 whitespace-pre-wrap font-sans">{data.fixedRules}</pre></details>
        </div>
      </Card>

      <Card title="Human handover">
        <div className="grid gap-4 sm:grid-cols-2">
          <Input className="sm:col-span-2" label="Hand over when the customer writes" value={keywords} onChange={(e) => setKeywords(e.target.value)} hint="Comma separated words or phrases, e.g. human, counsellor, call me, refund" />
          <Input label="Maximum assistant replies per conversation" type="number" min={1} max={50} value={f.maxBotReplies} onChange={(e) => setF({ ...f, maxBotReplies: e.target.value })} hint="Then a counsellor takes over" />
          <Input label="Daily AI reply limit (cost safeguard)" type="number" min={1} max={5000} value={f.dailyAiLimit ?? 300} onChange={(e) => setF({ ...f, dailyAiLimit: e.target.value })} hint="After this many AI replies in a day, new conversations go to the team" />
          <div className="sm:col-span-2"><Textarea label="Message sent to the customer on handover" rows={2} value={f.handoverMessage} onChange={(e) => setF({ ...f, handoverMessage: e.target.value })} /></div>
          <p className="text-xs text-slate-500 sm:col-span-2">The assistant also hands over when it cannot answer from verified information, when the customer is upset or asks about payments, refunds or an existing admission, and as soon as any staff member replies. The lead owner (or the Sales Managers) is notified, and the conversation shows a private note in Chatwoot.</p>
        </div>
      </Card>

      <Card title="Test the assistant">
        <div className="space-y-3">
          <Textarea label="Customer message" rows={2} value={test.message} onChange={(e) => setTest({ message: e.target.value })} placeholder="e.g. Hi, what is the fee for the full stack course?" />
          <div className="flex items-center gap-2">
            <button className="btn-secondary" disabled={!st.aiConfigured || !test.message.trim() || run.isPending} onClick={() => { setResult(null); run.mutate(undefined); }}>{run.isPending ? <Spinner className="h-4 w-4" /> : <Play className="h-4 w-4" />} Generate reply</button>
            <span className="text-xs text-slate-500">Uses the prompt above (even unsaved). Nothing is sent to WhatsApp and no record changes.</span>
          </div>
          {!st.aiConfigured && <p className="text-xs text-amber-700">Testing needs the ANTHROPIC_API_KEY secret.</p>}
          {run.error && <p className="rounded-lg bg-rose-50 p-3 text-sm text-rose-800">{run.error.message}</p>}
          {result && (
            <div className="space-y-2 rounded-lg border border-slate-200 p-3 text-sm">
              {(result.handover || result.keywordHandover) && <p><Badge status="PENDING">Hand over</Badge> <span className="text-slate-600">{result.keywordHandover ? 'Handover keyword used' : result.handover_reason}</span></p>}
              {result.reply && <p className="whitespace-pre-wrap rounded-lg bg-emerald-50 p-3">{result.reply}</p>}
              <p className="text-xs text-slate-500">Details noted: {Object.entries(result.lead ?? {}).filter(([, v]) => v).map(([k, v]) => `${label(k)}: ${v}`).join(' · ') || 'none'} · {result.inputTokens} in / {result.outputTokens} out tokens</p>
            </div>
          )}
        </div>
      </Card>

      <Card title="Recent assistant activity" bodyClass="p-0">
        {events.data?.items?.length ? (
          <table className="min-w-full divide-y divide-slate-100 text-sm">
            <thead className="bg-slate-50"><tr><th className="th">When</th><th className="th">Contact</th><th className="th">Result</th><th className="th">Assistant message</th><th className="th"></th></tr></thead>
            <tbody className="divide-y divide-slate-100">
              {events.data.items.map((e: any) => (
                <tr key={e.id}>
                  <td className="td whitespace-nowrap">{dt(e.createdAt)}</td>
                  <td className="td">{label(e.contactKind)}{e.leadId && <a className="link ml-1 text-xs" href={`/staff/leads/${e.leadId}`}>lead</a>}</td>
                  <td className="td"><Badge status={e.botStatus === 'REPLIED' ? 'ACTIVE' : e.botStatus === 'FAILED' ? 'FAILED' : 'PENDING'}>{label(e.botStatus)}</Badge>{e.botReason && <div className="max-w-xs text-xs text-slate-500">{e.botReason}</div>}</td>
                  <td className="td max-w-md whitespace-pre-wrap text-xs">{e.botReplyText ?? '—'}</td>
                  <td className="td">{e.conversationMode === 'HUMAN' && <button className="btn-ghost btn-sm" disabled={resume.isPending} onClick={() => resume.mutate(e.conversationId)} title="Let the assistant answer this conversation again"><RotateCcw className="h-4 w-4" /> Resume</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <Empty title="No assistant activity yet" />}
        {(events.data?.total ?? 0) > 15 && (
          <div className="flex justify-end gap-2 p-3"><button className="btn-ghost btn-sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button><button className="btn-ghost btn-sm" disabled={page * 15 >= events.data.total} onClick={() => setPage(page + 1)}>Next</button></div>
        )}
      </Card>
    </div>
  );
}
