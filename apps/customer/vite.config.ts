import { defineConfig } from 'vite';

export default defineConfig({
  esbuild: { jsx: 'automatic' },
  server: {
    proxy: {
      '/api': { target: process.env.CUSTOMER_EDGE_URL ?? 'http://127.0.0.1:4000', changeOrigin: false },
      '/ws': { target: process.env.CUSTOMER_WS_URL ?? 'ws://127.0.0.1:4014', ws: true, rewrite: (path) => path.replace(/^\/ws/, '') },
    },
  },
  build: { target: 'es2022', sourcemap: false },
});
