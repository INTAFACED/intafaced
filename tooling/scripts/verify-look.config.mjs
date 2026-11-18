// `pnpm local:stack verify look <path>` (verify-app.mjs): the journeys' own Playwright config, harness and TEST browser,
// pointed at the one look spec beside this file instead of the journey files. Nothing else differs, so a page looked at
// here is the page a journey step sees.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import base from '../../apps/customer/tests/real-app/real-app.playwright.config.mjs';

const JOURNEYS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../apps/customer/tests/real-app');
// The journeys config names its own reporter files relative to its folder; Playwright reads them relative to this one.
const reporter = base.reporter.map(([name, opts]) => [name.startsWith('./') ? path.join(JOURNEYS, name) : name, opts]);

export default { ...base, reporter, testDir: '.', testMatch: 'verify-look.pw.mjs', retries: 0 };
