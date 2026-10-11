import { defineConfig } from 'vite';
import tailwind from '@tailwindcss/postcss';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const publicSource = fileURLToPath(new URL('../../vendor/upstream-exchange/05_Web_Front/src/', import.meta.url));
const modules = {
  intake: 'assets/js/outreach-intake.js',
  review: 'assets/js/outreach-review.js',
  info: 'assets/js/outreach-public-info.js',
  storage: 'assets/js/outreach-draft-storage.js',
  countries: 'assets/js/outreach-countries.js',
  transport: 'config/intafaced.js',
};
export default defineConfig({
  esbuild: { jsx: 'automatic' },
  plugins: process.env.INVITATION_MODULE_EVIDENCE
    ? [
        {
          name: 'invitation-module-evidence',
          generateBundle() {
            writeFileSync(process.env.INVITATION_MODULE_EVIDENCE!, JSON.stringify([...this.getModuleIds()], null, 2) + '\n');
          },
        },
      ]
    : [],
  resolve: {
    alias: Object.fromEntries(Object.entries(modules).map(([name, file]) => ['@outreach/' + name, publicSource + file])),
  },
  optimizeDeps: { include: Object.keys(modules).map((name) => '@outreach/' + name) },
  css: { postcss: { plugins: [tailwind()] } },
  define: {
    'process.env.OUTREACH_CONTACT_URL': JSON.stringify(process.env.OUTREACH_CONTACT_URL || ''),
    'process.env.OUTREACH_RETENTION_NOTICE': JSON.stringify(process.env.OUTREACH_RETENTION_NOTICE || ''),
  },
  server: {
    host: '127.0.0.1',
    port: 3201,
    proxy: { '/api': { target: process.env.INVITATION_EDGE_URL || 'http://127.0.0.1:4000', changeOrigin: false } },
  },
  build: {
    target: 'es2022',
    sourcemap: false,
    commonjsOptions: { include: [/node_modules/, /05_Web_Front\/src/], transformMixedEsModules: true },
  },
});
