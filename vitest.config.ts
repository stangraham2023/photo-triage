import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['./tests/fixtures/globalSetup.ts'],
    testTimeout: 30_000,
  },
});
