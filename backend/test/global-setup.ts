import { execSync } from 'child_process';

export default function setup() {
  const url = process.env.TEST_DATABASE_URL || 'postgresql://nexora:nexora@localhost:5432/nexora_test?schema=public';
  process.env.DATABASE_URL = url;
  const env = { ...process.env, DATABASE_URL: url, SEED_DEMO: 'true' };
  execSync('npx prisma migrate reset --force --skip-seed --skip-generate', { env, stdio: 'inherit' });
  execSync('npx tsx prisma/seed.ts', { env, stdio: 'inherit' });
}
