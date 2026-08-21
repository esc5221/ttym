import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    // esbuild(기본)는 이 번들에서 xterm을 깨뜨린다. rollup이 내놓은
    //   requestMode(e, i8) { let r5; (...)(r5 || (r5 = {})); ... }
    // 를 minify하면서 `let r5` 선언을 지우고 대입만 남겨
    //   (void 0 || (i = {}))
    // 로 만든다 — 선언되지 않은 이름이라 ESM(strict)에서 ReferenceError다.
    // 터미널이 DECRQM(`CSI ? 2026 $p` 등 — Antigravity CLI가 켤 때 보낸다)에
    // 닿는 순간 던지고, 그 예외가 xterm의 write 루프를 끊어 남은 바이트가
    // 통째로 버려진다. 증상은 "pane이 멈췄다가 새로고침하면 보인다"였다.
    // 배포판 xterm.mjs 자체는 멀쩡하고 esbuild 단독으로도 재현되지 않는다 —
    // 번들 전체를 한 번에 minify할 때만 나온다.
    // terser는 같은 입력을 바르게 줄이고 결과도 더 작다 (gzip 205KB → 198KB).
    minify: 'terser',
  },
  server: {
    port: 3300,
    host: '0.0.0.0',
    allowedHosts: true,
    proxy: {
      '/api': { target: 'http://127.0.0.1:7690', changeOrigin: true },
      '/ws': { target: 'ws://127.0.0.1:7690', ws: true },
    },
  },
});
