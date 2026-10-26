import { defineConfig } from 'vite';

// The editor lives in web/ and is built into dist/web, which the Node server serves.
// `npm run dev:web` runs Vite with hot reload and proxies the API/WS to a running server.
export default defineConfig({
  root: 'web',
  publicDir: 'public',
  build: { outDir: '../dist/web', emptyOutDir: true, chunkSizeWarningLimit: 1500 },
  server: {
    port: 5179,
    proxy: {
      '/ws': { target: 'ws://localhost:5178', ws: true },
      '/api': 'http://localhost:5178',
      '/files': 'http://localhost:5178',
    },
  },
});
