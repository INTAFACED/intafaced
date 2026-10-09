import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: '.',
  testMatch: 'app.pw.mjs',
  workers: 1,
  fullyParallel: false,
  reporter: 'list',
  outputDir: '/tmp/intafaced-integrated-browser-results',
  use: { baseURL: 'http://127.0.0.1:3205', headless: true },
  webServer: {
    command: 'pnpm --filter @intafaced/customer exec vite --host 127.0.0.1 --port 3205',
    url: 'http://127.0.0.1:3205',
    cwd: new URL('../../..', import.meta.url).pathname,
    reuseExistingServer: true,
    timeout: 30000,
  },
});
