import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { founderTotp, makeContext } from '../../../../tooling/scripts/local-test-gates.mjs';
import { FOUNDER_VAULT_NAME } from '../../../../tooling/scripts/local-test-founders.mjs';
import { localStackState } from '../../../../tooling/scripts/local-test-state.mjs';
import { HOME_ASSET, HOME_DEPOSIT_AMOUNT, HOME_NOTICE_TITLE } from '../../../../tooling/scripts/local-test-home.mjs';
import { ADMIN, founderSignIn } from './admin.mjs';
import { EDGE, ROOT } from './stack.mjs';

// J-home-ia-11, in the running app (docs/roadmap/journeys.json): I bring up a test build and sign in as a founder (tester
// entry). Tests titled "J-home-ia-11 #<n>" prove a whole step. The journey starts from a compose up with the `tester`
// profile; the real-app run starts the same services with `pnpm local:stack`, so the steps read the compose files for the
// seed service's wiring and run the seed's own scripts, which refuse anything but a local dev or test build.
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - #2: the sign-in page of a non-live build has no "Tester build" panel saying where the founder vault is.
// - #3: the seed gives founder a's Home a TEST deposit, notice and inbox row, but Home does not label them TEST.
// - #5: no deployment receipt with three served hosts exists on this stack (no apex, app or join host is named), so the
//   step fails by name, BLOCKED hosts_unset, after the Help room's rows are matched to what the build published.
const J = 'J-home-ia-11';
const UNBUILT = { timeout: 5_000 };
// The stack's own rule for its state folder (LOCAL_STACK_STATE, else per user, else /var/lib as root).
const STATE = localStackState();
const COMPOSE = ['docker-compose.yml', 'docker-compose.apps.yml'];

test.describe.configure({ mode: 'default' });

/** The `seed` service's block in the compose files, as text (no YAML parser in the tree), or null when there is none. */
function seedService() {
  for (const name of COMPOSE) {
    const file = path.join(ROOT, name);
    if (!existsSync(file)) continue;
    const match = /^ {2}seed:\n((?: {4}.*\n|\s*\n)+)/m.exec(readFileSync(file, 'utf8'));
    if (match) return { file: name, block: match[1] };
  }
  return null;
}

/** A seed script run as the seed service runs it; returns { status, out } instead of throwing on a refusal. */
function run(script, args, env) {
  const base = { ...process.env };
  delete base.APP_ENV;
  delete base.NODE_ENV;
  try {
    const out = execFileSync(process.execPath, [path.join(ROOT, script), ...args], {
      cwd: ROOT,
      env: { ...base, ...env },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120_000,
    });
    return { status: 0, out };
  } catch (error) {
    return { status: error.status ?? 1, out: `${error.stdout ?? ''}${error.stderr ?? ''}` };
  }
}

/** What the test-content seed says it has made on this stack. */
const seedStatus = () => run('tooling/scripts/local-test-seed.mjs', ['status', '--state', STATE], { LOCAL_TEST: '1' });

/** The founder vault on this stack (founders.json): the founders' sign-in details, which no page may show. */
function vault() {
  return JSON.parse(readFileSync(path.join(STATE, FOUNDER_VAULT_NAME), 'utf8'));
}

test(`${J} #1 the tester profile starts healthy services, and its seed service runs once and reports what it made`, async () => {
  // Every service the stack started answers, and Edge routes to them.
  const ready = await fetch(`${EDGE}/ready`).then((res) => res.json());
  expect(ready.ready).toBe(true);

  // The tester profile's seed service: off unless asked, it runs the founder seed (init, then enrol) and the test-content
  // seed (apply), in that order, and refuses any APP_ENV but dev or test.
  const seed = seedService();
  expect(seed, `no compose file (${COMPOSE.join(', ')}) has a seed service`).not.toBeNull();
  expect(seed.block).toMatch(/profiles:\s*\[?\s*['"]?tester['"]?/);
  // Once: it is never restarted after it exits.
  expect(seed.block).toMatch(/^ {4}restart: 'no'$/m);
  const order = ['local-founder-seed.mjs init', 'local-founder-seed.mjs enrol', 'local-test-seed.mjs apply'].map((step) =>
    seed.block.indexOf(step),
  );
  expect(
    order.every((at) => at >= 0),
    `the seed service runs ${order}`,
  ).toBe(true);
  expect([...order].sort((a, b) => a - b)).toEqual(order);

  // What it made: Home's TEST deposit, TEST notice and inbox row, beside the Earn, Loans, Convert and P2P content.
  const report = seedStatus();
  expect(report.status).toBe(0);
  // Read back from the services for founder a: exactly one credited TEST deposit (status refuses on a second record for
  // the seeded transfer), the published TEST notice, and exactly one deposit-credited inbox row.
  const founder = vault().founders[0].handle;
  expect(report.out).toContain(`  deposit  ${HOME_DEPOSIT_AMOUNT} ${HOME_ASSET} credited  ${founder}`);
  expect(report.out).toContain(`  notice  ${HOME_NOTICE_TITLE}  published`);
  expect(report.out).toContain(`  inbox  1 deposit-credited row  ${founder}`);
});

test(`${J} #2 the documented sign-in steps get the founder in with founder scopes, and the founder console opens`, async ({ page }) => {
  // The sign-in page of a non-live build says how a tester gets in: where the founder vault file is and how to print a
  // one-time code. It never shows a password, a second-factor secret or a code.
  await page.goto('/login');
  const panel = page.getByRole('region', { name: 'Tester build' });
  await expect(panel).toBeVisible(UNBUILT);
  await expect(panel).toContainText(FOUNDER_VAULT_NAME);
  await expect(panel).toContainText(/one-time code/i);
  const text = await panel.innerText();
  for (const founder of vault().founders) {
    for (const secret of [founder.password, founder.totpSecret].filter(Boolean)) expect(text).not.toContain(secret);
  }

  // Following those steps: the founder signs in to the console with password and code, and it opens on a founder page.
  await founderSignIn(page, 'a');
  await expect(page).toHaveURL(new RegExp(`^${ADMIN}/(?!login)`));
  await expect(page.getByRole('main')).toBeVisible();
});

test(`${J} #3 the founder's Home shows a TEST deposit in the total, a TEST notice and one inbox row, each labelled TEST`, async ({
  page,
}) => {
  const ctx = await makeContext({ log: () => {} });
  const founder = vault().founders[0];
  await page.goto('/login?redirect=%2Fhome');
  await page.fill('input[name=identifier]', founder.handle ?? founder.email);
  await page.fill('input[name=password]', founder.password);
  await page.fill('input[name=totp]', await founderTotp(ctx, 'a', founder.totpSecret));
  await page.getByRole('button', { name: /^sign in$/i }).click();
  await expect(page).toHaveURL(/\/home$/);

  // The total holds the seeded deposit and says it is TEST money.
  await expect(page.getByTestId('home-total').first()).toContainText('TEST', UNBUILT);
  // One TEST notice, drafted by one founder and published by the other.
  await expect(page.getByTestId('home-notice').filter({ hasText: 'TEST' })).toHaveCount(1, UNBUILT);
  // One inbox row, filed by the real deposit-credit consumer.
  await page.goto('/notifications');
  await expect(page.getByTestId('nf-row').filter({ hasText: 'TEST' })).toHaveCount(1, UNBUILT);
});

test(`${J} #4 the same image started as staging or production: the seed service exits with an error and creates nothing`, async () => {
  const secrets = path.join(ROOT, '.env.founder-secrets.local');
  const secretsBefore = existsSync(secrets) ? statSync(secrets).mtimeMs : null;
  const contentBefore = seedStatus().out.replace(/^as of .*$/m, '');

  for (const appEnv of ['staging', 'production']) {
    // The founder seed refuses before reading or writing anything.
    const founders = run('tooling/scripts/local-founder-seed.mjs', ['init'], { INTAFACED_LOCAL_FOUNDER: '1', APP_ENV: appEnv });
    expect(founders.status, founders.out).not.toBe(0);
    expect(founders.out).toContain(`APP_ENV is "${appEnv}"`);
    // The test-content seed refuses before any database or ledger call.
    const content = run('tooling/scripts/local-test-seed.mjs', ['apply', '--state', STATE], { LOCAL_TEST: '1', APP_ENV: appEnv });
    expect(content.status, content.out).not.toBe(0);
    expect(content.out).toContain(`APP_ENV is "${appEnv}"`);
  }
  expect(existsSync(secrets) ? statSync(secrets).mtimeMs : null).toBe(secretsBefore);
  expect(seedStatus().out.replace(/^as of .*$/m, '')).toBe(contentBefore);

  // The seed service itself refuses to start: its entrypoint, run with that APP_ENV, exits non-zero.
  const seed = seedService();
  expect(seed, `no compose file (${COMPOSE.join(', ')}) has a seed service`).not.toBeNull();
  const entry = /tooling\/scripts\/[\w.-]+\.mjs/.exec(seed.block)?.[0];
  expect(entry, 'the seed service names no script').toBeTruthy();
  for (const appEnv of ['staging', 'production']) {
    const started = run(entry, [], { APP_ENV: appEnv });
    expect(started.status, started.out).toBe(2);
    expect(started.out).toContain(`refusing: APP_ENV is "${appEnv}"`);
  }
  expect(seedStatus().out.replace(/^as of .*$/m, '')).toBe(contentBefore);
});

test(`${J} #5 the apex, app and join hosts are checked: a receipt of three served hosts, or a typed refusal naming the host`, async ({
  page,
}) => {
  const check = 'apps/customer/deployment/host-dispatch.mjs';
  const out = path.join(mkdtempSync(path.join(tmpdir(), 'host-dispatch-')), 'host-dispatch.json');

  // A blank host setting is refused by name and nothing is fetched.
  const blank = run(check, ['--out', out], { INTAFACED_APEX_HOST: '', INTAFACED_APP_HOST: '', INTAFACED_JOIN_HOST: '' });
  expect(blank.status).toBe(1);
  for (const role of ['apex', 'app', 'join']) expect(blank.out).toContain(`host.${role}_unset`);
  expect(JSON.parse(readFileSync(out, 'utf8'))).toMatchObject({ status: 'refused' });

  // A host that does not answer is "not served", naming it, never a pass.
  const dark = run(check, ['--out', out], {
    INTAFACED_APEX_HOST: 'https://127.0.0.1:9',
    INTAFACED_APP_HOST: 'https://127.0.0.1:9',
    INTAFACED_JOIN_HOST: 'https://127.0.0.1:9',
  });
  expect(dark.status).toBe(1);
  const receipt = JSON.parse(readFileSync(out, 'utf8'));
  expect(receipt.status).toBe('refused');
  expect(receipt.hosts.map((host) => [host.role, host.host, host.result])).toEqual([
    ['apex', 'https://127.0.0.1:9', 'host.not_served'],
    ['app', 'https://127.0.0.1:9', 'host.not_served'],
    ['join', 'https://127.0.0.1:9', 'host.not_served'],
  ]);

  // The Help room shows each host exactly as the receipt the build published says: its host and its one result. With no
  // receipt published (a static host answers the unknown path with the app's index, not JSON), every row is
  // host.receipt_missing, never served.
  const published = await page.request.get('/host-dispatch.json');
  const isReceipt = published.ok() && (published.headers()['content-type'] ?? '').includes('application/json');
  const served = isReceipt ? await published.json() : null;
  await page.goto('/help');
  await expect(page.getByTestId('host-dispatch')).toBeVisible();
  for (const role of ['apex', 'app', 'join']) {
    const row = page.getByTestId(`host-dispatch-${role}`);
    const want = served ? (served.hosts.find((host) => host.role === role) ?? {}) : { host: null, result: 'host.receipt_missing' };
    const result = want.result ?? served?.hosts.find((host) => host.role === 'all')?.result ?? 'host.not_checked';
    await expect(row).toHaveAttribute('data-result', result);
    if (want.host) await expect(row).toContainText(want.host);
  }

  // The step's pass: a receipt in which the apex, app and join hosts are each served. Until a deployment names them,
  // this fails by name.
  expect(
    served?.status === 'served' &&
      ['apex', 'app', 'join'].every((role) => served.hosts.some((h) => h.role === role && h.result === 'served')),
    `BLOCKED hosts_unset: the build published ${served ? `a ${served.status} receipt` : 'no host dispatch receipt'}, not one with the apex, app and join hosts served`,
  ).toBe(true);
  for (const role of ['apex', 'app', 'join'])
    await expect(page.getByTestId(`host-dispatch-${role}`)).toHaveAttribute('data-result', 'served');
});
