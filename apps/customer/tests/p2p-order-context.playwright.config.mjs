import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
const baseURL = process.env.P2P_ORDER_BASE_URL,
  evidence = process.env.P2P_ORDER_EVIDENCE;
if (!baseURL || !evidence || !isAbsolute(evidence)) throw Error('Supply compiled loopback App and a new absolute evidence directory.');
const url = new URL(baseURL);
if (
  url.protocol !== 'http:' ||
  !['127.0.0.1', 'localhost'].includes(url.hostname) ||
  url.username ||
  url.password ||
  url.pathname !== '/' ||
  url.search ||
  url.hash ||
  existsSync(join(evidence, 'results.json'))
)
  throw Error('Preserve prior evidence; use ordinary loopback App.');
export default defineConfig({
  testDir: '.',
  testMatch: 'p2p-order-context.pw.mjs',
  workers: 1,
  retries: 0,
  timeout: 30000,
  expect: { timeout: 5000 },
  reporter: [['list'], ['json', { outputFile: join(evidence, 'results.json') }]],
  outputDir: join(evidence, 'browser-results'),
  use: { baseURL, headless: true, viewport: { width: 390, height: 844 }, timezoneId: 'UTC', trace: 'off', video: 'off', screenshot: 'off' },
});
