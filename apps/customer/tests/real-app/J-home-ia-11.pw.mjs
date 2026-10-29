import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { founderTotp, makeContext } from '../../../../tooling/scripts/local-test-gates.mjs';
import { FOUNDER_VAULT_NAME } from '../../../../tooling/scripts/local-test-founders.mjs';
import { localStackState } from '../../../../tooling/scripts/local-test-state.mjs';
import { deviceCodesMailedTo, OUTBOX_NAME } from '../../../../tooling/scripts/local-test-entry.mjs';
import { HOME_ASSET, HOME_DEPOSIT_AMOUNT, HOME_NOTICE_TITLE } from '../../../../tooling/scripts/local-test-home.mjs';
import { ADMIN, assertAdminUp } from './admin.mjs';
import { EDGE, ORIGIN as CUSTOMER, ROOT } from './stack.mjs';

// J-home-ia-11, in the running app (docs/roadmap/journeys.json): I bring up a test build and sign in as a founder (tester
// entry). Tests titled "J-home-ia-11 #<n>" prove a whole step. The journey starts from a compose up with the `tester`
// profile; the real-app run starts the same services with `pnpm local:stack`, so the steps read the compose files for the
// seed service's wiring and run the seed's own scripts, which refuse anything but a local dev or test build.
// #5 runs on the stack's LOCAL TEST hosts (local-test-stack.mjs localTestHosts: its own loopback sites, labelled TEST),
// never on an owner's hosts: no deployment is named on this stack.
const J = 'J-home-ia-11';
// The stack's own rule for its state folder (LOCAL_STACK_STATE, else per user, else /var/lib as root).
const STATE = localStackState();
const COMPOSE = ['docker-compose.yml', 'docker-compose.apps.yml'];
const OUTBOX = path.join(STATE, OUTBOX_NAME);
// The stack's invitation site, which stands in for the apex and is the join host on this stack (localTestHosts).
const INVITATION = 'http://127.0.0.1:3220';

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

/** The documented tester step (tooling/scripts/local-test-entry.mjs) for founder a: the one value it prints after `label`. */
function entry(cmd, label) {
  const done = run('tooling/scripts/local-test-entry.mjs', [cmd, 'a'], { LOCAL_TEST: '1' });
  expect(done.status, done.out).toBe(0);
  const value = new RegExp(`${label}: (\\d{6})`).exec(done.out)?.[1];
  expect(value, done.out).toBeTruthy();
  return value;
}

/** How many device codes identity has mailed to `email` in the stack's LOCAL-TEST outbox. */
const deviceMails = (email) => deviceCodesMailedTo(existsSync(OUTBOX) ? readFileSync(OUTBOX, 'utf8') : '', email).length;

/** What the test-content seed says it has made on this stack. */
const seedStatus = () => run('tooling/scripts/local-test-seed.mjs', ['status', '--state', STATE], { LOCAL_TEST: '1' });

/** The founder vault on this stack (founders.json): the founders' sign-in details, which no page may show. */
function vault() {
  return JSON.parse(readFileSync(path.join(STATE, FOUNDER_VAULT_NAME), 'utf8'));
}

// The seed service's Home step, run as it runs it. The journeys stack loads the TEST content with `apply` alone, which
// makes no Home content, so every other journey starts from an empty notice board (J-home-ia-06). Here the notice is open
// for 5 minutes rather than the tester's 30 days: J-home-ia-06 waits up to 7 minutes for leftover notices to close, so in
// either order in a shard it waits this one out. The seed publishes it last, after the deposit and its inbox row.
const NOTICE_MINUTES = '5';
let homeSeed;
test.beforeAll(() => {
  test.setTimeout(3 * 60_000);
  homeSeed = run('tooling/scripts/local-test-seed.mjs', ['home', '--notice-minutes', NOTICE_MINUTES, '--state', STATE], {
    LOCAL_TEST: '1',
  });
});

test(`${J} #1 the tester profile starts healthy services, and its seed service runs once and reports what it made`, async () => {
  // Every service the stack started answers, and Edge routes to them.
  const ready = await fetch(`${EDGE}/ready`).then((res) => res.json());
  expect(ready.ready).toBe(true);

  // The tester profile's seed service: off unless asked, it runs the founder seed (init, then enrol) and the test-content
  // seed (apply, then home), in that order, and refuses any APP_ENV but dev or test.
  const seed = seedService();
  expect(seed, `no compose file (${COMPOSE.join(', ')}) has a seed service`).not.toBeNull();
  expect(seed.block).toMatch(/profiles:\s*\[?\s*['"]?tester['"]?/);
  // Once: it is never restarted after it exits.
  expect(seed.block).toMatch(/^ {4}restart: 'no'$/m);
  const order = [
    'local-founder-seed.mjs init',
    'local-founder-seed.mjs enrol',
    'local-test-seed.mjs apply',
    'local-test-seed.mjs home',
  ].map((step) => seed.block.indexOf(step));
  expect(
    order.every((at) => at >= 0),
    `the seed service runs ${order}`,
  ).toBe(true);
  expect([...order].sort((a, b) => a - b)).toEqual(order);

  // Its Home step (run above as the service runs it) says what it made: the TEST deposit, notice and inbox row.
  expect(homeSeed.status, homeSeed.out).toBe(0);
  const founder = vault().founders[0].handle;
  expect(homeSeed.out).toContain(`home deposit: ${HOME_DEPOSIT_AMOUNT} ${HOME_ASSET} on TEST `);
  expect(homeSeed.out).toContain(`home notice: ${HOME_NOTICE_TITLE} `);
  expect(homeSeed.out).toContain(`home inbox: 1 deposit-credited row for ${founder}`);

  // What it made: Home's TEST deposit, TEST notice and inbox row, beside the Earn, Loans, Convert and P2P content.
  const report = seedStatus();
  expect(report.status).toBe(0);
  // Read back from the services for founder a: exactly one credited TEST deposit (status refuses on a second record for
  // the seeded transfer), the published TEST notice, and exactly one deposit-credited inbox row.
  expect(report.out).toContain(`  deposit  ${HOME_DEPOSIT_AMOUNT} ${HOME_ASSET} credited  ${founder}`);
  expect(report.out).toContain(`  notice  ${HOME_NOTICE_TITLE}  published`);
  expect(report.out).toContain(`  inbox  1 deposit-credited row  ${founder}`);
});

test(`${J} #2 the documented sign-in steps get the founder in with founder scopes, and the founder console opens`, async ({ page }) => {
  // The sign-in page of a non-live build says how a tester gets in: where the founder vault file is and how to print a
  // one-time code. It never shows a password, a second-factor secret or a code.
  await page.goto('/login');
  const panel = page.getByRole('region', { name: 'Tester build' });
  await expect(panel).toBeVisible();
  await expect(panel).toContainText(FOUNDER_VAULT_NAME);
  await expect(panel).toContainText(/one-time code/i);
  const text = await panel.innerText();
  for (const founder of vault().founders) {
    for (const secret of [founder.password, founder.totpSecret].filter(Boolean)) expect(text).not.toContain(secret);
  }

  // Following those steps in a browser identity has never seen, with no cookie or device put in by the test: the founder
  // signs in to the console with password and a one-time code, identity asks for this browser to be authorised and mails a
  // device code to the founder's address, and the founder enters it.
  // (The run's customer-app device cookie, scoped to the customer's identity path, never reaches the console.)
  test.setTimeout(180_000);
  await assertAdminUp();
  expect(await page.context().cookies(new URL('/', ADMIN).href)).toEqual([]);
  const founder = vault().founders[0];
  await page.goto(`${ADMIN}/login`);
  await page.getByLabel('Email or handle').fill(founder.handle);
  await page.getByLabel('Password').fill(founder.password);
  await page.getByLabel('Authenticator or recovery code').fill(entry('code', 'one-time code'));
  const mailed = deviceMails(founder.email);
  await page.locator('button[type=submit]').click();
  await expect(page.getByRole('heading', { name: 'Authorise this browser' })).toBeVisible({ timeout: 20_000 });
  // This sign-in's own code, never an older one still in the outbox.
  await expect.poll(() => deviceMails(founder.email), { timeout: 15_000 }).toBeGreaterThan(mailed);
  await page.getByLabel('Device code from the email').fill(entry('device', 'device code for \\S+'));
  await page.getByRole('button', { name: 'Approve this browser' }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 30_000 });
  await expect(page.getByRole('main')).toBeVisible();

  // Founder scopes: the console reads the founder directory with this session, a door svc-ops opens only to a founder
  // session's ops scopes, and its session bar names this founder by the directory's own name.
  const owners = await page.request.get(`${ADMIN}/api/crm?view=owners`);
  expect(owners.status()).toBe(200);
  const name = (await owners.json()).owners.find((owner) => owner.userId === founder.userId)?.displayName;
  expect(name).toMatch(/^(Nitro|Phantom)$/);
  await expect(page.locator(`.adm-session > span[title="${founder.userId}"]`)).toHaveText(name);
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

  // What the seed made for founder a, read back from the services (status writes nothing).
  expect(homeSeed.status, homeSeed.out).toBe(0);
  const status = seedStatus();
  expect(status.status, status.out).toBe(0);
  const made = /^ {2}deposit {2}(\S+) (\S+) credited {2}(\S+)$/m.exec(status.out);
  expect(made, `the seed reports no credited Home deposit:\n${status.out}`).not.toBeNull();
  const [, amount, asset, holder] = made;
  expect(holder).toBe(founder.handle);
  const notice = /^ {2}notice {2}(.+) {2}published$/m.exec(status.out)?.[1];
  expect(notice, `the seed reports no published Home notice:\n${status.out}`).toBeTruthy();
  // The deposit is founder a's only holding, a stablecoin Home counts as cash at its dollar amount, so the total is exactly
  // that figure, not zero, and says it is TEST money.
  const [whole, fraction = ''] = amount.split('.');
  const dollars = `$${whole}.${`${fraction}00`.slice(0, 2)}`;
  const total = page.getByTestId('home-total').first();
  await expect(total.getByRole('img', { name: dollars, exact: true })).toBeVisible();
  await expect(total.getByTestId('home-total-test')).toHaveText('TEST');
  // The deposit itself is on Home, once.
  await expect(page.getByTestId('home-activity__row').filter({ hasText: `+${amount} ${asset}` })).toHaveCount(1);
  // One TEST notice, the one the seed published (drafted by one founder and published by the other).
  await expect(page.getByTestId('home-notice').filter({ hasText: notice })).toHaveCount(1);
  expect(notice).toContain('TEST');
  // One inbox row for that deposit, filed by the real deposit-credit consumer, and it says TEST beside the amount.
  await page.goto('/notifications');
  const row = page.getByTestId('nf-row').filter({ hasText: `${amount} ${asset}` });
  await expect(row).toHaveCount(1);
  await expect(row.getByTestId('nf-test')).toHaveText('TEST');
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
    // So does its Home step, which the seed service runs after apply.
    const home = run('tooling/scripts/local-test-seed.mjs', ['home', '--state', STATE], { LOCAL_TEST: '1', APP_ENV: appEnv });
    expect(home.status, home.out).toBe(2);
    expect(home.out).toContain(`APP_ENV is "${appEnv}"`);
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

/** `pnpm local:stack restart customer`, with `env` on top; the stack re-runs its LOCAL TEST host check as it starts. */
const restartCustomer = (env = {}) =>
  run('tooling/scripts/local-test-stack.mjs', ['restart', 'customer'], { LOCAL_STACK_HOSTS: '', ...env });
const HOST_RECEIPT = path.join(STATE, 'host-dispatch.json');

/** The receipt the Customer server publishes at /host-dispatch.json, or null when it answers with anything but JSON. */
async function publishedReceipt(page) {
  const published = await page.request.get('/host-dispatch.json');
  const isReceipt = published.ok() && (published.headers()['content-type'] ?? '').includes('application/json');
  return isReceipt ? await published.json() : null;
}

test(`${J} #5 the apex, app and join hosts are checked: a receipt of three served hosts, or a typed refusal naming the host`, async ({
  page,
}) => {
  test.setTimeout(6 * 60_000);
  const check = 'apps/customer/deployment/host-dispatch.mjs';
  const out = path.join(mkdtempSync(path.join(tmpdir(), 'host-dispatch-')), 'host-dispatch.json');

  // The deployment check: a blank host setting is refused by name and nothing is fetched.
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

  // Its LOCAL TEST mode refuses anything but a dev or test APP_ENV, and writes nothing.
  const local = path.join(mkdtempSync(path.join(tmpdir(), 'host-dispatch-')), 'host-dispatch.json');
  for (const appEnv of ['staging', 'production']) {
    const refused = run(check, ['--local-test', '--out', local], {
      APP_ENV: appEnv,
      INTAFACED_APEX_HOST: INVITATION,
      INTAFACED_APP_HOST: CUSTOMER,
      INTAFACED_JOIN_HOST: INVITATION,
    });
    expect(refused.status, refused.out).toBe(2);
    expect(refused.out).toContain('host dispatch (TEST): all (not checked) host.local_test_refused');
    expect(existsSync(local)).toBe(false);
  }

  // The blank case on the stack: restarted with its TEST hosts unset, the check names each host's typed refusal, the
  // receipt is gone, and the Help room shows no host as served. The finally puts the TEST hosts back.
  let restored;
  try {
    const unset = restartCustomer({ LOCAL_STACK_HOSTS: 'off' });
    expect(unset.status, unset.out).toBe(0);
    for (const role of ['apex', 'app', 'join'])
      expect(unset.out).toContain(`host dispatch (TEST): ${role} (not checked) host.${role}_unset`);
    expect(unset.out).toContain('host dispatch (TEST): no receipt written');
    expect(existsSync(HOST_RECEIPT)).toBe(false);
    expect(await publishedReceipt(page)).toBeNull();
    await page.goto('/help');
    await expect(page.getByTestId('host-dispatch')).toBeVisible();
    for (const role of ['apex', 'app', 'join'])
      await expect(page.getByTestId(`host-dispatch-${role}`)).toHaveAttribute('data-result', 'host.receipt_missing');
    await expect(page.getByTestId('host-dispatch-test')).toHaveCount(0);
  } finally {
    restored = restartCustomer();
  }
  // Asserted after the finally, so a failure above is the one reported.
  expect(restored.status, restored.out).toBe(0);
  expect(restored.out).toContain('host dispatch (TEST): receipt ');

  // The pass: a TEST receipt in which the apex, app and join hosts are each served, read back from what the Customer
  // server publishes and from the Help room, row by row, with its TEST label.
  const want = { apex: INVITATION, app: CUSTOMER, join: INVITATION };
  const served = await publishedReceipt(page);
  expect(served, 'the Customer server published no host dispatch receipt').not.toBeNull();
  expect(served).toMatchObject({ schemaVersion: 1, status: 'served', test: true });
  expect(served.hosts.map((host) => [host.role, host.host, host.result])).toEqual(
    Object.entries(want).map(([role, host]) => [role, host, 'served']),
  );
  expect(JSON.parse(readFileSync(HOST_RECEIPT, 'utf8'))).toEqual(served);
  await page.goto('/help');
  await expect(page.getByTestId('host-dispatch')).toBeVisible();
  await expect(page.getByTestId('host-dispatch-test')).toHaveText('TEST');
  for (const [role, host] of Object.entries(want)) {
    const row = page.getByTestId(`host-dispatch-${role}`);
    await expect(row).toHaveAttribute('data-result', 'served');
    await expect(row).toContainText(host);
  }
});
