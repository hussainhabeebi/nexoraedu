import { defineConfig } from 'vitest/config';
import { BaseSequencer, type TestSpecification } from 'vitest/node';

/** Deterministic order: files share one database, so run them alphabetically (00-… first, z-… last). */
class AlphabeticalSequencer extends BaseSequencer {
  async sort(files: TestSpecification[]) {
    return [...files].sort((a, b) => a.moduleId.localeCompare(b.moduleId));
  }
}

export default defineConfig({
  // Tests run in Node.js against a local D1/R2 (see test/d1-env.ts). `#prisma` (package.json "imports")
  // resolves to the Node.js Prisma client here and to the Cloudflare client in the Worker build.
  test: {
    globalSetup: './test/global-setup.ts',
    setupFiles: ['./test/setup-d1.ts'],
    testTimeout: 30000,
    hookTimeout: 120000,
    fileParallelism: false,
    sequence: { sequencer: AlphabeticalSequencer },
    env: {
      NODE_ENV: 'test',
      APP_ENV: 'test',
      AUTH_RATE_LIMIT: '100000',
      AUTH_ACCOUNT_RATE_LIMIT: '100000',
      AUTH_IP_RATE_LIMIT: '100000',
      REFRESH_RATE_LIMIT: '100000',
      REFRESH_ANON_RATE_LIMIT: '100000',
      API_RATE_LIMIT: '100000',
      REFRESH_RACE_GRACE_MS: '0',
      JOBS_ENABLED: 'false',
      DEMO_PASSWORD: 'Test-Only#Passw0rd!2026',
    },
  },
});
