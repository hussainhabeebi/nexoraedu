/**
 * Background work (notifications, WhatsApp/e-mail delivery) that must not delay or fail the request.
 *  - Inside atomic(): queued and started only AFTER the batch commits (never for a rolled-back or retried batch).
 *  - On Cloudflare the work is registered with waitUntil(), so it finishes after the response is sent.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export const afterCommitQueue = new AsyncLocalStorage<(() => unknown)[]>();

let runner: (p: Promise<unknown>) => void = (p) => void p;
export function setBackgroundRunner(fn: (p: Promise<unknown>) => void) {
  runner = fn;
}

export function background(fn: () => Promise<unknown> | unknown) {
  const go = () => runner(Promise.resolve().then(fn).catch((e) => console.error('[background]', e)));
  const queue = afterCommitQueue.getStore();
  if (queue) queue.push(go);
  else go();
}
