/** Per-test-file: connect the app to the local D1/R2 bindings prepared by global-setup. */
import { afterAll } from 'vitest';
import { openLocalEnv } from './d1-env';

const p = await openLocalEnv();
const { initDb } = await import('../src/lib/prisma');
const { initFiles } = await import('../src/lib/files');
initDb(p.env.DB);
initFiles(p.env.FILES);
(globalThis as any).__NEXORA_ENV__ = p.env;
afterAll(async () => { await p.dispose(); });
