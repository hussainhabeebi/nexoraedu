/**
 * Node.js scripts (local development only): connect to the SAME local D1 database that `npm run dev`
 * (the Worker running locally) uses, in the repository's .wrangler/ folder. Never touches Cloudflare.
 * In staging/production these tasks run inside the Worker instead (migrations by Workers Builds,
 * Super Admin bootstrap through POST /api/v1/auth/bootstrap, reconciliation by the API and the daily cron).
 */
import path from 'node:path';
import { initDb, prisma } from '../lib/prisma';

export async function withLocalDb<T>(fn: (db: typeof prisma) => Promise<T>): Promise<T> {
  const { getPlatformProxy } = await import('wrangler');
  const root = path.resolve(__dirname, '../../..');
  for (const k of ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy']) delete process.env[k]; // local only
  const p = await getPlatformProxy<{ DB: any }>({ configPath: path.join(root, 'wrangler.jsonc'), persist: { path: path.join(root, '.wrangler/state/v3') } });
  try {
    initDb(p.env.DB);
    return await fn(prisma);
  } finally {
    await p.dispose();
  }
}
