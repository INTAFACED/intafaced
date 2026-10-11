import { defineConfig } from '@playwright/test';
// No raw DOM snapshot, trace, video or request-body artifact can contain an authenticator secret.
// Tests retain masked captures and redacted text/boolean observations for meaningful failures.
process.env.PLAYWRIGHT_NO_COPY_PROMPT = '1';
export default defineConfig({
  testDir: '.',
  testMatch: 'security-journey.pw.mjs',
  workers: 1,
  retries: 0,
  timeout: 45000,
  expect: { timeout: 6500 },
  reporter: [['list'], ['json', { outputFile: process.env.SECURITY_EVIDENCE + '/results.json' }]],
  outputDir: process.env.SECURITY_EVIDENCE + '/browser-results',
  use: {
    baseURL: process.env.SECURITY_BASE_URL || 'http://localhost:3234',
    viewport: { width: 1440, height: 1000 },
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
});
