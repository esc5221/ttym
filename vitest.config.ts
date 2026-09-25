import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { defineConfig } from 'vitest/config';

// vt의 로컬 에코 재생 테스트는 실제 터미널 렌더러가 필요하다. 서버가 이미 쓰는
// @xterm/headless · addon-serialize 를 그대로 빌린다 — 같은 버전, 설치 없이.
const fromServer = createRequire(new URL('./packages/server/package.json', import.meta.url));
const pkgDir = (name: string) => dirname(fromServer.resolve(`${name}/package.json`));

export default defineConfig({
  resolve: {
    alias: {
      '@xterm/headless': pkgDir('@xterm/headless'),
      '@xterm/addon-serialize': pkgDir('@xterm/addon-serialize'),
    },
  },
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
