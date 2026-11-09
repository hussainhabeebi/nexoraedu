/**
 * Cloudflare Worker entry: nexoraed.com.
 *  - Static assets (the built React app) are served by Workers Static Assets (wrangler.jsonc `assets`).
 *  - /api/* and /health run the Express API (Node.js compatibility, `httpServerHandler`).
 *  - Cron Triggers run the scheduled jobs (wrangler.jsonc `triggers.crons`).
 * Bindings: DB (D1), FILES (R2), ASSETS. Configuration comes from vars and secrets (process.env).
 */
import { httpServerHandler } from 'cloudflare:node';
import { env, waitUntil } from 'cloudflare:workers';
import { createApp } from './app';
import { initDb } from './lib/prisma';
import { initFiles } from './lib/files';
import { preflightProblems } from './preflight';
import { runScheduled } from './jobs/scheduler';
import { setBackgroundRunner } from './lib/background';

type Env = { DB: any; FILES: any; ASSETS: { fetch: (r: Request) => Promise<Response> } };

initDb((env as unknown as Env).DB);
initFiles((env as unknown as Env).FILES);
setBackgroundRunner((p) => waitUntil(p));

const PORT = 8080;
createApp().listen(PORT);
const api = httpServerHandler({ port: PORT }) as { fetch: (req: Request, env: unknown, ctx: unknown) => Promise<Response> };

/** Checked once per Worker instance: a misconfigured environment answers 503 instead of serving. */
let preflight: Promise<string[]> | undefined;

export default {
  async fetch(request: Request, workerEnv: Env, ctx: ExecutionContext): Promise<Response> {
    preflight ??= preflightProblems().catch((e) => [`Startup check failed: ${e?.message ?? e}`]);
    const problems = await preflight;
    if (problems.length) {
      preflight = undefined; // re-check on the next request (e.g. after a secret is fixed)
      console.error(`Refusing to serve:\n - ${problems.join('\n - ')}`);
      return Response.json({ error: { code: 'NOT_CONFIGURED', message: 'The service is not configured correctly. The administrator has been notified in the logs.' } }, { status: 503 });
    }
    return api.fetch(request, workerEnv, ctx);
  },

  async scheduled(controller: ScheduledController, _env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runScheduled(controller.cron, new Date(controller.scheduledTime)));
  },
};
