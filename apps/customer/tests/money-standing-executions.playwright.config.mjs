import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

const baseURL = process.env.MONEY_STANDING_EXECUTIONS_BASE_URL;
const evidence = process.env.MONEY_STANDING_EXECUTIONS_EVIDENCE;
if (!baseURL || !evidence) throw new Error('Set the verified standing-executions origin and a new absolute evidence directory.');
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
  throw new Error('Standing baseline requires an isolated loopback ordinary compiled App origin.');
if (!isAbsolute(evidence)) throw new Error('Use an explicit absolute evidence path.');
if (existsSync(join(evidence, 'results.json'))) throw new Error('Preserve earlier standing evidence; use a new directory.');
export default defineConfig({
  testDir: '.',
  testMatch: 'money-standing-executions.pw.mjs',
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
    viewport: { width: 320, height: 844 },
    trace: 'off',
    video: 'off',
    screenshot: 'off',
  },
});
