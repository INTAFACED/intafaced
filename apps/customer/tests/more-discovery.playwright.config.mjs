import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const baseURL = process.env.MORE_DISCOVERY_BASE_URL;
const evidence = process.env.MORE_DISCOVERY_EVIDENCE;
if (!baseURL || !evidence)
  throw new Error('Set MORE_DISCOVERY_BASE_URL and MORE_DISCOVERY_EVIDENCE for the verified compiled More candidate.');
const origin = new URL(baseURL);
if (origin.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(origin.hostname))
  throw new Error('More acceptance requires an isolated local compiled stage.');
if (existsSync(join(evidence, 'results.json'))) throw new Error('Use a new evidence directory; preserve prior raw results.');

export default defineConfig({
  testDir: '.',
  testMatch: 'more-discovery.pw.mjs',
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
