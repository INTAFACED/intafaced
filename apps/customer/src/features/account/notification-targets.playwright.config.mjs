import { defineConfig } from '@playwright/test';
process.env.PLAYWRIGHT_NO_COPY_PROMPT = '1';
const dist = process.env.NOTIFICATION_TARGETS_DIST ?? '/tmp/intafaced-notification-targets-dist';
export default defineConfig({
  testDir: '.',
  testMatch: 'notification-targets.pw.mjs',
  workers: 1,
  reporter: 'list',
  outputDir: process.env.NOTIFICATION_TARGETS_ARTIFACT
    ? process.env.NOTIFICATION_TARGETS_ARTIFACT + '/browser-results'
    : '/tmp/intafaced-targets-results',
  use: { baseURL: 'http://127.0.0.1:3224', headless: true },
  webServer: {
    // Build this actual App snapshot with vite build --outDir before running.
    command:
      'pnpm --filter @intafaced/customer exec vite preview --outDir ' + JSON.stringify(dist) + ' --host 127.0.0.1 --port 3224 --strictPort',
    url: 'http://127.0.0.1:3224',
    cwd: new URL('../../../../..', import.meta.url).pathname,
    reuseExistingServer: false,
    timeout: 30000,
  },
});
