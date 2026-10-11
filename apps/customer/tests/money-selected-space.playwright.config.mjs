import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
const baseURL = process.env.MONEY_SELECTED_SPACE_BASE_URL;
const evidence = process.env.MONEY_SELECTED_SPACE_EVIDENCE;
if (!baseURL || !evidence) throw new Error('Set the verified selected-space origin and a new absolute evidence directory.');
const origin = new URL(baseURL);
if (origin.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(origin.hostname) || origin.username || origin.password)
  throw new Error('Selected-space acceptance requires an isolated loopback compiled ordinary App.');
if (!isAbsolute(evidence)) throw new Error('Selected-space evidence must use an explicit absolute path.');
if (existsSync(join(evidence, 'results.json'))) throw new Error('Preserve previous selected-space results; use a new evidence directory.');
export default defineConfig({
  testDir: '.',
  testMatch: 'money-selected-space.pw.mjs',
  workers: 1,
  retries: 0,
  timeout: 90000,
  expect: { timeout: 7000 },
  reporter: [['list'], ['json', { outputFile: join(evidence, 'results.json') }]],
  outputDir: join(evidence, 'browser-results'),
  use: {
    baseURL,
    headless: true,
    timezoneId: 'UTC',
    viewport: { width: 1440, height: 1000 },
    trace: 'off',
    video: 'off',
    screenshot: 'off',
  },
});
