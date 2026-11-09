/**
 * Local Cloudflare bindings for tests: a real D1 (SQLite in workerd) and R2, emulated by Wrangler's
 * getPlatformProxy() from the root wrangler.jsonc. Data lives in .test-d1/ and is recreated by global-setup.
 * No Cloudflare account or network is used.
 */
import path from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';
import { splitSql } from './d1-sql';

export const PERSIST = path.resolve(__dirname, '../.test-d1');
const CONFIG = path.resolve(__dirname, '../../wrangler.jsonc');

// Local bindings are reached over localhost; never send that traffic through an outbound HTTP proxy.
for (const k of ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy']) delete process.env[k];

export async function openLocalEnv() {
  const { getPlatformProxy } = await import('wrangler');
  return getPlatformProxy<{ DB: any; FILES: any }>({ configPath: CONFIG, persist: { path: PERSIST } });
}

export async function applyMigrations(db: any) {
  const dir = path.resolve(__dirname, '../migrations');
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    await db.batch(splitSql(readFileSync(path.join(dir, f), 'utf8')).map((s) => db.prepare(s)));
  }
}
