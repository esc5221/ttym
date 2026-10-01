import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// The embed panel (/embed/v1/): a second build next to the app, every URL relative
// so it works behind a consumer's path prefix. docs/embedding.md.
export default defineConfig({
  root: resolve(__dirname, 'embed'),
  base: './',
  publicDir: resolve(__dirname, 'embed/public'),
  build: {
    outDir: resolve(__dirname, 'dist/embed/v1'),
    emptyOutDir: true,
    // Same reason as vite.config.ts: esbuild's minify breaks xterm in a full bundle.
    minify: 'terser',
  },
});
