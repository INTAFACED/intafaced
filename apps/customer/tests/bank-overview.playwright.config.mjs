import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

const baseURL = process.env.BANK_OVERVIEW_BASE_URL;
const evidence = process.env.BANK_OVERVIEW_EVIDENCE;
if (!baseURL || !evidence) throw new Error('Set the verified Bank candidate origin and a new absolute evidence directory.');
const origin = new URL(baseURL);
if (origin.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(origin.hostname) || origin.username || origin.password)
  throw new Error('Bank native acceptance requires an isolated loopback compiled App.');
if (!isAbsolute(evidence)) throw new Error('Bank evidence must use an explicit absolute path.');
if (existsSync(join(evidence, 'results.json'))) throw new Error('Preserve previous Bank results; use a new evidence directory.');

export default defineConfig({
  testDir: '.',
  testMatch: 'bank-overview.pw.mjs',
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
    viewport: { width: 1440, height: 976 },
    trace: 'off',
    video: 'off',
    screenshot: 'off',
  },
});
