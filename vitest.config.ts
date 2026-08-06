import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Several suites spawn real holders, shells and HTTP servers. Run in
    // parallel they compete for CPU on a machine that always has a fleet of
    // agents resident, and the spawn waits time out — 3 of 5 full runs failed
    // that way. One file at a time costs a few seconds and removes the class.
    fileParallelism: false,
    include: [
      'packages/*/src/**/*.test.ts',
    ],
    environment: 'node',
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
});
