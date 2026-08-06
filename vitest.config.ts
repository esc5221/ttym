import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'client/src/**/*.test.ts',
      'server/src/**/*.test.ts',
      'packages/*/src/**/*.test.ts',
    ],
    environment: 'node',
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
});
