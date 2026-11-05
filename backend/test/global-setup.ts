/**
 * Test database bootstrap (local / CI only — never point TEST_DATABASE_URL at a shared or production database):
 *  1. reset + migrate as the owner
 *  2. create the restricted runtime role (prisma/sql/app-role.sql) — tests then connect as that role
 *  3. reference + demo seed (synthetic data, APP_ENV=test). No Super Administrator is seeded:
 *     00-bootstrap.test.ts creates it through the real bootstrap command.
 */
import { execSync } from 'child_process';

export default function setup() {
  const owner = process.env.TEST_DATABASE_URL || 'postgresql://nexora:nexora@localhost:5432/nexora_test?schema=public';
  if (/prod/i.test(owner)) throw new Error('Refusing to run tests against a database URL that looks like production.');
  const env = { ...process.env, DATABASE_URL: owner, APP_ENV: 'test', NODE_ENV: 'test', DEMO_PASSWORD: 'Test-Only#Passw0rd!2026' };
  execSync('npx prisma migrate reset --force --skip-seed --skip-generate', { env, stdio: 'inherit' });
  const psqlUrl = owner.replace(/\?.*$/, '');
  execSync(`psql "${psqlUrl}" -q -v app_role=nexora_app_test -v app_password=nexora_app_test_pw -f prisma/sql/app-role.sql`, { env, stdio: 'inherit' });
  execSync('npx tsx src/seed/demo.ts', { env, stdio: 'inherit' });
}
