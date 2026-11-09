/**
 * Test database bootstrap (local only): a fresh local D1 with all migrations, then reference + demo seed
 * (synthetic data, APP_ENV=test). No Super Administrator is seeded: 00-bootstrap.test.ts creates it through
 * the real bootstrap flow.
 */
import { rmSync } from 'node:fs';
import { applyMigrations, openLocalEnv, PERSIST } from './d1-env';

export default async function setup() {
  rmSync(PERSIST, { recursive: true, force: true });
  const p = await openLocalEnv();
  try {
    await applyMigrations(p.env.DB);
    const { initDb, prisma } = await import('../src/lib/prisma');
    initDb(p.env.DB);
    const { seedDemo } = await import('../src/seed/demo');
    await seedDemo(prisma as any, { ...process.env, APP_ENV: 'test', NODE_ENV: 'test', DEMO_PASSWORD: 'Test-Only#Passw0rd!2026' });
  } finally {
    await p.dispose();
  }
}
