import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { founderTotp, makeContext } from '../../../../tooling/scripts/local-test-gates.mjs';
import { FOUNDER_VAULT_NAME, foundersEnrolled } from '../../../../tooling/scripts/local-test-founders.mjs';
import { localStackState } from '../../../../tooling/scripts/local-test-state.mjs';
import { deviceCodesMailedTo, OUTBOX_NAME } from '../../../../tooling/scripts/local-test-entry.mjs';
import { HOME_ASSET, HOME_DEPOSIT_AMOUNT, HOME_NOTICE_TITLE } from '../../../../tooling/scripts/local-test-home.mjs';
import { ADMIN, assertAdminUp } from './admin.mjs';
import { NOTICE_DRAIN_MINUTES } from './notices.mjs';
import { EDGE, ORIGIN as CUSTOMER, ROOT } from './stack.mjs';

// J-home-ia-11, in the running app (docs/roadmap/journeys.json): I bring up a test build and sign in as a founder (tester
// entry). Tests titled "J-home-ia-11 #<n>" prove a whole step. The journey starts from a compose up with the `tester`
// profile; the real-app run starts the same services with `pnpm local:stack`, so the steps read the compose files for the
// seed service's wiring and run the seed's own scripts, which refuse anything but a local dev or test build.
// #5 runs on the stack's LOCAL TEST hosts (local-test-stack.mjs localTestHosts: its own loopback sites, labelled TEST),
// never on an owner's hosts: no deployment is named on this stack. The deployed hosts are their own #5 test, red by name
// (BLOCKED deployed_hosts) until a deployment names the hosts.
const J = 'J-home-ia-11';
// The stack's own rule for its state folder (LOCAL_STACK_STATE, else per user, else /var/lib as root).
const STATE = localStackState();
const COMPOSE = ['docker-compose.yml', 'docker-compose.apps.yml'];
const OUTBOX = path.join(STATE, OUTBOX_NAME);
// The stack's TEST apex page, its invitation site (the join host) and the Customer server (the app host): localTestHosts.
const APEX = 'http://127.0.0.1:3260';
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

/**
 * A seed script run as the seed service runs it: { status, out }, with out holding both streams, instead of throwing on a
 * refusal. `timeout` caps the run (2 minutes by default); a killed run has no status and counts as failed.
 */
function run(script, args, env, { timeout = 120_000 } = {}) {
  const base = { ...process.env };
  delete base.APP_ENV;
  delete base.NODE_ENV;
  const res = spawnSync(process.execPath, [path.join(ROOT, script), ...args], {
    cwd: ROOT,
    env: { ...base, ...env },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout,
  });
  const out = `${res.stdout ?? ''}${res.stderr ?? ''}${res.error ? `\n${res.error.message}` : ''}`;
  return { status: res.status ?? 1, out };
}

/** The steps the seed service's command names (its compose `command` list), in order. */
const composeSteps = (block) => [...block.matchAll(/'(local-[a-z-]+\.mjs [a-z]+)'/g)].map((m) => m[1]);

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

// The seed service's own entrypoint (local-tester-seed.mjs), run with the TEST content steps its compose command names
// (apply, home, status), on a test build, with its compose environment's LOCAL_STACK_STATE and NODE_ENV. Its founder
// steps (init, enrol) are not run here: the journeys stack enrols its
// founder pair itself (local-test-stack.mjs, through the founder seed's own enrolment), and `init` refuses a machine that
// already has founder files, so #1 reads the pair back instead. The journeys stack loads the TEST content with `apply`
// alone, which makes no Home content, so every other journey starts from an empty notice board (J-home-ia-06). Here the
// notice is open for NOTICE_MINUTES rather than the tester's 30 days, inside the NOTICE_DRAIN_MINUTES that J-home-ia-06
// waits for leftover notices, so in either order in a shard it waits this one out. The seed publishes it last, after the
// deposit and its inbox row. The run may take as long as `home`'s own waits (150 s each for the credit and the row).
const NOTICE_MINUTES = String(NOTICE_DRAIN_MINUTES - 2);
const SEED_ENTRY = 'tooling/scripts/local-tester-seed.mjs';
let contentSteps;
let seedRun;
test.beforeAll(() => {
  test.setTimeout(8 * 60_000);
  const seed = seedService();
  contentSteps = seed ? composeSteps(seed.block).filter((step) => step.startsWith('local-test-seed.mjs ')) : [];
  // As the service runs it: the state folder from LOCAL_STACK_STATE and NODE_ENV development (its compose environment).
  seedRun = run(
    SEED_ENTRY,
    [...contentSteps, '--notice-minutes', NOTICE_MINUTES],
    { APP_ENV: 'test', NODE_ENV: 'development', LOCAL_STACK_STATE: STATE },
    { timeout: 7 * 60_000 },
  );
});

test(`${J} #1 the tester profile starts healthy services, and its seed service runs once and reports what it made`, async () => {
  test.setTimeout(8 * 60_000);
  // Every service the stack started answers, and Edge routes to them.
  const ready = await fetch(`${EDGE}/ready`).then((res) => res.json());
  expect(ready.ready).toBe(true);
  // Each service the stack started, one row each in its own health table, answers its health check.
  const table = run('tooling/scripts/local-test-stack.mjs', ['status'], { LOCAL_STACK_STATE: STATE });
  expect(table.status, table.out).toBe(0);
  const rows = [...table.out.matchAll(/^ {2}(\S+) +\S+ +(\d+|owned) +(.+)$/gm)].map((m) => [m[1], m[3].trim()]);
  const names = rows.map(([name]) => name);
  expect(new Set(names).size, 'one row per service').toBe(names.length);
  for (const name of ['postgres', 'nats', 'svc-ledger', 'svc-identity', 'svc-pay', 'svc-notify', 'svc-edge', 'customer'])
    expect(names, `${name} was started`).toContain(name);
  for (const [name, health] of rows) expect(health, `${name} health`).toMatch(/^ok\b/);

  // The tester profile's seed service: off unless asked, it runs the founder seed (init, then enrol) and the test-content
  // seed (apply, then home), in that order, and refuses any APP_ENV but dev or test.
  const seed = seedService();
  expect(seed, `no compose file (${COMPOSE.join(', ')}) has a seed service`).not.toBeNull();
  expect(seed.block).toMatch(/profiles:\s*\[?\s*['"]?tester['"]?/);
  // Once: it is never restarted after it exits.
  expect(seed.block).toMatch(/^ {4}restart: 'no'$/m);
  expect(seed.block).toContain(`'node',\n        '${SEED_ENTRY}',`);
  expect(composeSteps(seed.block)).toEqual([
    'local-founder-seed.mjs init',
    'local-founder-seed.mjs enrol',
    'local-test-seed.mjs apply',
    'local-test-seed.mjs home',
    'local-test-seed.mjs status',
  ]);

  // The founder steps' result on this stack: both founders have an account and a confirmed second factor.
  expect(foundersEnrolled(vault())).toBe(true);

  // The entrypoint (run above) ran each content step once, in the command's order, and ended with what it made.
  expect(seedRun.status, seedRun.out).toBe(0);
  const ran = [...seedRun.out.matchAll(/^seed: (local-[a-z-]+\.mjs [a-z]+)$/gm)].map((m) => m[1]);
  expect(ran).toEqual(['local-test-seed.mjs apply', 'local-test-seed.mjs home', 'local-test-seed.mjs status']);
  expect(seedRun.out).toMatch(/^seed: done \(3 steps\)$/m);
  const founder = vault().founders[0].handle;
  expect(seedRun.out).toContain(`home deposit: ${HOME_DEPOSIT_AMOUNT} ${HOME_ASSET} on TEST `);
  expect(seedRun.out).toContain(`home notice: ${HOME_NOTICE_TITLE} `);
  expect(seedRun.out).toContain(`home inbox: 1 deposit-credited row for ${founder}`);
  // Its closing `status` step reports the same three things.
  expect(seedRun.out).toContain(`  deposit  ${HOME_DEPOSIT_AMOUNT} ${HOME_ASSET} credited  ${founder}`);
  expect(seedRun.out).toContain(`  notice  ${HOME_NOTICE_TITLE}  published`);

  // What it made: Home's TEST deposit, TEST notice and inbox row, beside the Earn, Loans, Convert and P2P content.
  const report = seedStatus();
  expect(report.status).toBe(0);
  // Read back from the services for founder a: exactly one credited TEST deposit (status refuses on a second record for
  // the seeded transfer), the published TEST notice, and exactly one deposit-credited inbox row.
  expect(report.out).toContain(`  deposit  ${HOME_DEPOSIT_AMOUNT} ${HOME_ASSET} credited  ${founder}`);
  expect(report.out).toContain(`  notice  ${HOME_NOTICE_TITLE}  published`);
  expect(report.out).toContain(`  inbox  1 deposit-credited row  ${founder}`);

  // A second run of the same entrypoint makes nothing new: the deposit is keyed on its business key and the notice is
  // still open, so `home` skips it. status exits 0 only while the seeded transfer has exactly one deposit record (it
  // refuses on a second), and still reads one inbox row.
  const again = run(
    SEED_ENTRY,
    [...contentSteps, '--notice-minutes', NOTICE_MINUTES],
    { APP_ENV: 'test', NODE_ENV: 'development', LOCAL_STACK_STATE: STATE },
    { timeout: 7 * 60_000 },
  );
  expect(again.status, again.out).toBe(0);
  expect(again.out).toContain(`home notice: ${HOME_NOTICE_TITLE} skipped`);
  expect(again.out).toContain(`home inbox: 1 deposit-credited row for ${founder}`);
  const after = seedStatus();
  expect(after.status, after.out).toBe(0);
  expect(after.out).toContain(`  deposit  ${HOME_DEPOSIT_AMOUNT} ${HOME_ASSET} credited  ${founder}`);
  expect(after.out).toContain(`  inbox  1 deposit-credited row  ${founder}`);
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
  expect(seedRun.status, seedRun.out).toBe(0);
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
// The host check's build id: the first 16 hex of the sha256 of what the host served (host-dispatch.mjs).
const buildIdOf = (body) => createHash('sha256').update(body).digest('hex').slice(0, 16);
/** The Customer build the stack serves: a saved folder override (customer-dist), else this checkout's own build. */
function customerDist() {
  const saved = path.join(STATE, 'customer-dist.json');
  return existsSync(saved) ? JSON.parse(readFileSync(saved, 'utf8')).path : path.join(ROOT, 'apps', 'customer', 'dist');
}

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
      INTAFACED_APEX_HOST: APEX,
      INTAFACED_APP_HOST: CUSTOMER,
      INTAFACED_JOIN_HOST: INVITATION,
    });
    expect(refused.status, refused.out).toBe(2);
    expect(refused.out).toContain('host dispatch (TEST): all (not checked) host.local_test_refused');
    expect(existsSync(local)).toBe(false);
  }

  // On the stack's own sites: one host dark and two served names only the dark one; a host serving another site's build
  // is that host's wrong build, not served.
  const oneOff = [
    [{ INTAFACED_APEX_HOST: 'http://127.0.0.1:9' }, ['host.not_served', 'served', 'served']],
    [{ INTAFACED_APP_HOST: 'http://127.0.0.1:9' }, ['served', 'host.not_served', 'served']],
    [{ INTAFACED_JOIN_HOST: 'http://127.0.0.1:9' }, ['served', 'served', 'host.not_served']],
    [{ INTAFACED_APEX_HOST: INVITATION }, ['host.apex_wrong_build', 'served', 'served']],
    [{ INTAFACED_APP_HOST: INVITATION }, ['served', 'host.app_wrong_build', 'served']],
    [{ INTAFACED_JOIN_HOST: CUSTOMER }, ['served', 'served', 'host.join_wrong_build']],
  ];
  for (const [change, results] of oneOff) {
    const hosts = { INTAFACED_APEX_HOST: APEX, INTAFACED_APP_HOST: CUSTOMER, INTAFACED_JOIN_HOST: INVITATION, ...change };
    const checked = run(check, ['--local-test', '--out', local], { APP_ENV: 'test', ...hosts });
    expect(checked.status, checked.out).toBe(1);
    const got = JSON.parse(readFileSync(local, 'utf8'));
    expect(got).toMatchObject({ status: 'refused', test: true });
    expect(got.hosts.map((host) => [host.role, host.host, host.result])).toEqual([
      ['apex', hosts.INTAFACED_APEX_HOST, results[0]],
      ['app', hosts.INTAFACED_APP_HOST, results[1]],
      ['join', hosts.INTAFACED_JOIN_HOST, results[2]],
    ]);
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
    expect((await page.request.get('/host-dispatch.json')).status(), 'no receipt is published').toBe(404);
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
  const want = { apex: APEX, app: CUSTOMER, join: INVITATION };
  const served = await publishedReceipt(page);
  expect(served, 'the Customer server published no host dispatch receipt').not.toBeNull();
  expect(served).toMatchObject({ schemaVersion: 1, status: 'served', test: true });
  expect(served.hosts.map((host) => [host.role, host.host, host.result])).toEqual(
    Object.entries(want).map(([role, host]) => [role, host, 'served']),
  );
  expect(JSON.parse(readFileSync(HOST_RECEIPT, 'utf8'))).toEqual(served);
  // Each build id is the stack's own build: the apex stand-in's descriptor and the Customer descriptor as built on disk,
  // and the invitation index as served at /join, which loads the invitation build's own assets.
  const buildIds = Object.fromEntries(served.hosts.map((host) => [host.role, host.buildId]));
  expect(buildIds.apex).toBe(buildIdOf(readFileSync(path.join(STATE, 'apex-test', 'apex-deployment.json'))));
  expect(buildIds.app).toBe(buildIdOf(readFileSync(path.join(customerDist(), 'customer-deployment.json'))));
  const join = await page.request.get(`${INVITATION}/join`);
  const joinBody = await join.text();
  expect(buildIds.join).toBe(buildIdOf(joinBody));
  const builtAssets = readFileSync(path.join(ROOT, 'apps', 'invitation', 'dist', 'index.html'), 'utf8').match(/\/assets\/[^"']+/g);
  expect(builtAssets?.length, 'the invitation build references its assets').toBeGreaterThan(0);
  for (const asset of builtAssets) expect(joinBody).toContain(asset);
  expect(new Set(Object.values(buildIds)).size, 'three distinct builds').toBe(3);
  await page.goto('/help');
  await expect(page.getByTestId('host-dispatch')).toBeVisible();
  await expect(page.getByTestId('host-dispatch-test')).toHaveText('TEST');
  for (const [role, host] of Object.entries(want)) {
    const row = page.getByTestId(`host-dispatch-${role}`);
    await expect(row).toHaveAttribute('data-result', 'served');
    await expect(row).toContainText(host);
    // The row names its loopback TEST host and no other host.
    const hosts = (await row.innerText()).match(/[a-z][a-z0-9+.-]*:\/\/[^\s/]+/gi) ?? [];
    expect(hosts.length, `${role} row names its host`).toBeGreaterThan(0);
    for (const named of hosts) expect(new URL(named).hostname, `${role} row names ${named}`).toBe('127.0.0.1');
  }
});

// The one clause the stack cannot give: the deployment's own apex, app and join hosts, over HTTPS, each serving its build.
// The check runs in its deployment mode with the hosts the run is given (none on the stack), so this stays red by name
// until a deployment names the hosts.
test(`${J} #5 the deployed apex, app and join hosts are served (BLOCKED until a deployment names the hosts)`, () => {
  const out = path.join(mkdtempSync(path.join(tmpdir(), 'host-dispatch-')), 'host-dispatch.json');
  const hosts = Object.fromEntries(
    ['INTAFACED_APEX_HOST', 'INTAFACED_APP_HOST', 'INTAFACED_JOIN_HOST'].map((name) => [name, process.env[name] ?? '']),
  );
  const deployed = run('apps/customer/deployment/host-dispatch.mjs', ['--out', out], hosts);
  const receipt = existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : null;
  expect(
    deployed.status === 0 && receipt?.status === 'served' && receipt.test === undefined,
    `BLOCKED deployed_hosts: until a deployment names the hosts and serves them, the deployment check refuses:\n${deployed.out}`,
  ).toBe(true);
  expect(receipt.hosts.map((host) => [host.role, host.result])).toEqual([
    ['apex', 'served'],
    ['app', 'served'],
    ['join', 'served'],
  ]);
});

/** `docker compose` on the repo's compose files under the tester profile, as a person runs it: { status, out }. */
function compose(args, env, { timeout = 120_000 } = {}) {
  const files = COMPOSE.flatMap((name) => ['-f', name]);
  const res = spawnSync(
    'docker',
    ['compose', '-p', 'intafaced-tester-journey', '--env-file', '.env.example', ...files, '--profile', 'tester', ...args],
    { cwd: ROOT, env: { ...process.env, ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout },
  );
  const out = `${res.stdout ?? ''}${res.stderr ?? ''}${res.error ? `\n${res.error.message}` : ''}`;
  return { status: res.status ?? 1, out };
}

// The step's own start: a fresh compose up with the tester profile, from the documented example env as a test build, on a
// state directory nothing has written. The real-app run seeds the `pnpm local:stack` stack instead (#1 above), so this
// stays red by name until a fresh compose up starts and its seed service runs once and reports what it made.
test(`${J} #1 a fresh compose up with the tester profile seeds (BLOCKED compose_seed until a fresh compose up seeds)`, () => {
  test.setTimeout(30 * 60_000);
  const env = { APP_ENV: 'test', LOCAL_STACK_STATE: mkdtempSync(path.join(tmpdir(), 'compose-tester-')) };
  const config = compose(['config', '--quiet'], env);
  expect(config.status, `BLOCKED compose_seed: a fresh compose up with the tester profile refuses to start:\n${config.out}`).toBe(0);
  try {
    const up = compose(['up', '--build', '--abort-on-container-exit', '--exit-code-from', 'seed', 'seed'], env, {
      timeout: 25 * 60_000,
    });
    expect(up.status, `BLOCKED compose_seed: the tester profile's seed service did not seed a fresh compose stack:\n${up.out}`).toBe(0);
    const ran = [...up.out.matchAll(/seed: (local-[a-z-]+\.mjs [a-z]+)$/gm)].map((m) => m[1]);
    expect(ran).toEqual(composeSteps(seedService().block));
    expect(up.out).toMatch(new RegExp(`seed: done \\(${ran.length} steps\\)$`, 'm'));
  } finally {
    compose(['down', '--volumes', '--remove-orphans'], env);
  }
});
