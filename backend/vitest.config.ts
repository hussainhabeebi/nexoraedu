import { defineConfig } from 'vitest/config';
import { BaseSequencer, type TestSpecification } from 'vitest/node';

/** Owner connection (migrations, seed). The tests themselves run as the restricted app role (R7). */
const owner = process.env.TEST_DATABASE_URL || 'postgresql://nexora:nexora@localhost:5432/nexora_test?schema=public';
const u = new URL(owner);
u.username = 'nexora_app_test';
u.password = 'nexora_app_test_pw';
const appUrl = process.env.TEST_APP_DATABASE_URL || u.toString();

/** Deterministic order: files share one database, so run them alphabetically (00-… first, z-… last). */
class AlphabeticalSequencer extends BaseSequencer {
  async sort(files: TestSpecification[]) {
    return [...files].sort((a, b) => a.moduleId.localeCompare(b.moduleId));
  }
}

export default defineConfig({
  test: {
    globalSetup: './test/global-setup.ts',
    testTimeout: 30000,
    hookTimeout: 120000,
    fileParallelism: false,
    sequence: { sequencer: AlphabeticalSequencer },
    env: {
      NODE_ENV: 'test',
      APP_ENV: 'test',
      DATABASE_URL: appUrl,
      TEST_OWNER_DATABASE_URL: owner,
      AUTH_RATE_LIMIT: '100000',
      API_RATE_LIMIT: '100000',
      REFRESH_RACE_GRACE_MS: '0',
      JOBS_ENABLED: 'false',
      DEMO_PASSWORD: 'Test-Only#Passw0rd!2026',
    },
  },
});
