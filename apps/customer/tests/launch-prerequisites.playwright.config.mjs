import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
const baseURL = process.env.LAUNCH_PREREQUISITES_BASE_URL,
  evidence = process.env.LAUNCH_PREREQUISITES_EVIDENCE;
if (!baseURL || !evidence || !isAbsolute(evidence)) throw Error('Supply compiled loopback App and new absolute evidence path.');
const url = new URL(baseURL);
if (
  url.protocol !== 'http:' ||
  !['localhost', '127.0.0.1'].includes(url.hostname) ||
  url.username ||
  url.password ||
  url.pathname !== '/' ||
  url.search ||
  url.hash ||
  existsSync(join(evidence, 'results.json'))
)
  throw Error('Preserve previous evidence; use ordinary loopback App.');
export default defineConfig({
  testDir: '.',
  testMatch: 'launch-prerequisites.pw.mjs',
  workers: 1,
  retries: 0,
  timeout: 45000,
  expect: { timeout: 5000 },
  reporter: [['list'], ['json', { outputFile: join(evidence, 'results.json') }]],
  outputDir: join(evidence, 'browser-results'),
  use: { baseURL, headless: true, viewport: { width: 390, height: 844 }, timezoneId: 'UTC', trace: 'off', video: 'off', screenshot: 'off' },
});
