import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The SPA lives in web/ and builds to web/dist, which the Worker serves as
// static assets. In dev, API/auth calls are proxied to the local wrangler dev
// server so `npm run dev` runs the whole stack.
export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:8787',
      '/auth': 'http://localhost:8787',
    },
  },
});
