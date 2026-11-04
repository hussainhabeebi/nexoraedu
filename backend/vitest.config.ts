import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: { globalSetup: './test/global-setup.ts', testTimeout: 30000, hookTimeout: 120000, fileParallelism: false, env: { NODE_ENV: 'test' } },
});
