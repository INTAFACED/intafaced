import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
const baseURL = process.env.RAIL_RECORDS_BASE_URL;
const evidence = process.env.RAIL_RECORDS_EVIDENCE;
if (!baseURL || !evidence) throw new Error('Supply a verified compiled loopback origin and new absolute evidence directory.');
const origin = new URL(baseURL);
if (
  origin.protocol !== 'http:' ||
  !['127.0.0.1', 'localhost'].includes(origin.hostname) ||
  origin.username ||
  origin.password ||
  origin.pathname !== '/' ||
  origin.search ||
  origin.hash
)
  throw new Error('Use the ordinary compiled App on loopback.');
if (!isAbsolute(evidence) || existsSync(join(evidence, 'results.json')))
  throw new Error('Preserve previous evidence; supply a new absolute directory.');
export default defineConfig({
  testDir: '.',
  testMatch: 'money-rail-records.pw.mjs',
  workers: 1,
  retries: 0,
  timeout: 120000,
  expect: { timeout: 7000 },
  reporter: [['list'], ['json', { outputFile: join(evidence, 'results.json') }]],
  outputDir: join(evidence, 'browser-results'),
  use: { baseURL, headless: true, timezoneId: 'UTC', viewport: { width: 320, height: 844 }, trace: 'off', video: 'off', screenshot: 'off' },
});
