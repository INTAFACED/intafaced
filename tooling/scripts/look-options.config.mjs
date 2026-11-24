// The look options' pictures (intafaced #9188): the journeys' own Playwright config, harness and TEST browser, pointed
// at look-options.pw.mjs beside this file, exactly as verify-look.config.mjs does for one page.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import base from '../../apps/customer/tests/real-app/real-app.playwright.config.mjs';

const JOURNEYS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../apps/customer/tests/real-app');
const reporter = base.reporter.map(([name, opts]) => [name.startsWith('./') ? path.join(JOURNEYS, name) : name, opts]);

export default { ...base, reporter, testDir: '.', testMatch: 'look-options.pw.mjs', retries: 0, timeout: 20 * 60_000 };
