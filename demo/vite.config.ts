import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
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
