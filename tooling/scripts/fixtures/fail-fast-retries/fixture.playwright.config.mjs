// The real reporter (apps/customer/tests/real-app/fail-fast-retries.mjs) on fixture journeys, retries 1 as on main.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export default {
  testDir: here,
  testMatch: '*.pw.mjs',
  workers: 1,
  fullyParallel: false,
  retries: 1,
  reporter: [
    [path.join(here, '../../../../apps/customer/tests/real-app/fail-fast-retries.mjs'), { baseline: path.join(here, 'baseline.json') }],
    ['json', { outputFile: process.env.FIXTURE_REPORT }],
  ],
  outputDir: process.env.FIXTURE_OUT,
};
