import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    env: { NODE_ENV: 'test' },
    // All test files share one database, so run them one file at a time.
    fileParallelism: false,
    globalSetup: './tests/global-setup.ts',
    testTimeout: 30_000,
  },
});
