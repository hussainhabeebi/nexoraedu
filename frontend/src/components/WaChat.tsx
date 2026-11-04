import { useEffect, useRef, useState } from 'react';
import { Check, CheckCheck, MessageCircle, Send, Settings2 } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useGet, useMut } from '@/lib/hooks';
import { dt } from '@/lib/format';
import { cx, Empty, Input, Spinner } from './ui';

const QUICK = [
  'Hi {{name}}, thanks for your interest in Nexora Academy! When is a good time to call you?',
  'Hi {{name}}, sharing the course brochure and fee details. Let me know if you have any questions.',
  'Hi {{name}}, a gentle reminder about your pending application. Need any help completing it?',
];

/** WhatsApp conversation via Chatwoot. Polls for new messages every 10s. */
export default function WaChat({ messagesPath, sendPath, name, height = 'h-[460px]' }: { messagesPath: string | null; sendPath: string; name: string; height?: string }) {
  const qc = useQueryClient();
  const cfg = useGet<any>('/whatsapp/config', { staleTime: 5 * 60_000, retry: false });
  const msgs = useGet<{ items: any[] }>(cfg.data?.enabled ? messagesPath : null, { refetchInterval: 10_000, retry: false });
  const [text, setText] = useState('');
  const [tplMode, setTplMode] = useState(false);
  const [tpl, setTpl] = useState({ name: '', language: 'en', params: '' });
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ behavior: "smooth" }); }, [msgs.data?.items.length]);
  const send = useMut(
    () => api(sendPath, { body: { content: text.replace(/\{\{name\}\}/g, name.split(' ')[0]), template: tplMode && tpl.name ? { name: tpl.name, language: tpl.language, params: tpl.params ? tpl.params.split('|').map((s) => s.trim()) : [] } : undefined } }),
    { onSuccess: () => { setText(''); qc.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).startsWith('/whatsapp') || String(q.queryKey[0]).startsWith('/crm/leads') }); } },
  );

  if (cfg.isLoading) return <div className="p-6"><Spinner /></div>;
  if (!cfg.data?.enabled)
    return <Empty icon={<Settings2 className="h-6 w-6" />} title="WhatsApp is not connected" hint="An administrator can connect the Chatwoot WhatsApp inbox (app.aiingo.com) in Settings → WhatsApp." />;

  return (
    <div className="flex flex-col">
      <div className={cx('space-y-2 overflow-y-auto bg-[#efeae2] p-4', height)} style={{ backgroundImage: 'radial-gradient(rgba(0,0,0,.04) 1px, transparent 1px)', backgroundSize: '16px 16px' }}>
        {msgs.isLoading && <Spinner className="mx-auto" />}
        {msgs.error && <p className="rounded-lg bg-white/80 p-3 text-sm text-rose-700">{(msgs.error as Error).message}</p>}
        {msgs.data && !msgs.data.items.length && <p className="mx-auto mt-10 w-fit rounded-lg bg-white/80 px-4 py-2 text-center text-sm text-slate-600"><MessageCircle className="mx-auto mb-1 h-5 w-5 text-emerald-600" />No WhatsApp messages yet. Start the conversation below.</p>}
        {msgs.data?.items.filter((m) => m.type !== 'activity').map((m) => (
          <div key={m.id} className={cx('flex', m.type === 'outgoing' ? 'justify-end' : 'justify-start')}>
            <div className={cx('max-w-[80%] rounded-lg px-3 py-2 text-sm shadow-sm', m.private ? 'bg-amber-100' : m.type === 'outgoing' ? 'bg-[#d9fdd3]' : 'bg-white')}>
              {m.private && <p className="text-[10px] font-semibold uppercase text-amber-700">Private note</p>}
              <p className="whitespace-pre-wrap break-words">{m.content}</p>
              {m.attachments?.map((a: any, i: number) => <a key={i} href={a.url} target="_blank" rel="noreferrer" className="block text-xs text-brand-700 underline">Attachment ({a.type})</a>)}
              <p className="mt-0.5 flex items-center justify-end gap-1 text-[10px] text-slate-500">{m.type === 'outgoing' && m.sender && <span>{m.sender} ·</span>}{dt(m.createdAt)}{m.type === 'outgoing' && (m.status === 'read' ? <CheckCheck className="h-3 w-3 text-sky-500" /> : m.status === 'delivered' ? <CheckCheck className="h-3 w-3" /> : <Check className="h-3 w-3" />)}</p>
            </div>
          </div>
        ))}
        <div ref={end} />
      </div>
      <div className="space-y-2 border-t border-slate-200 bg-white p-3">
        <div className="flex gap-1.5 overflow-x-auto">
          {QUICK.map((q, i) => <button key={i} className="shrink-0 rounded-full bg-slate-100 px-3 py-1 text-xs text-slate-700 hover:bg-slate-200" onClick={() => setText(q)}>{q.slice(0, 32)}…</button>)}
        </div>
        {tplMode && <div className="grid grid-cols-3 gap-2"><Input placeholder="Template name" value={tpl.name} onChange={(e) => setTpl({ ...tpl, name: e.target.value })} /><Input placeholder="Lang (en)" value={tpl.language} onChange={(e) => setTpl({ ...tpl, language: e.target.value })} /><Input placeholder="Params a|b" value={tpl.params} onChange={(e) => setTpl({ ...tpl, params: e.target.value })} /></div>}
        <form className="flex items-end gap-2" onSubmit={(e) => { e.preventDefault(); if (text.trim()) send.mutate(undefined); }}>
          <textarea className="input min-h-[42px] flex-1 resize-none" rows={1} placeholder="Type a WhatsApp message…" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (text.trim()) send.mutate(undefined); } }} aria-label="Message" />
          <button type="button" className={cx('btn-ghost btn-sm', tplMode && 'bg-slate-100')} onClick={() => setTplMode((v) => !v)} title="Send as approved template (outside 24h window)">Template</button>
          <button className="btn-success h-[42px] px-3" disabled={send.isPending || !text.trim()} aria-label="Send">{send.isPending ? <Spinner className="h-4 w-4 text-white" /> : <Send className="h-4 w-4" />}</button>
        </form>
      </div>
    </div>
  );
}
