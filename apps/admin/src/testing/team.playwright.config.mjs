import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  testDir: '.',
  testMatch: 'team.browser.pw.mjs',
  outputDir: '/Users/Nitro/Desktop/intafaced-interface-overview/named-look/build/team-test-results',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  use: { baseURL: 'http://127.0.0.1:3215', browserName: 'chromium' },
  webServer: {
    command: 'pnpm --filter @intafaced/admin exec next start --port 3215 --hostname 127.0.0.1',
    cwd: fileURLToPath(new URL('../../../..', import.meta.url)),
    url: 'http://127.0.0.1:3215',
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      NEXT_TELEMETRY_DISABLED: '1',
      ADMIN_BFF_SHARED_SECRET: '',
      ADMIN_OPERATOR_TOKEN: '',
      ADMIN_TREASURY_TOKEN: '',
      EDGE_URL: '',
    },
  },
});
