import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { ROOT, api, journeyState, tool } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';
import { bodyRows, tableIn } from './tables.mjs';

// J-more-catalogue-05, in the running app (docs/roadmap/journeys.json): point a miner at the pool. One test per step,
// titled "J-more-catalogue-05 #<n>". The person is a verified TEST account on the local stack (the pool serves the
// basic tier and up); no money moves. The miner is the
// stack's TEST rig, which dials the pool's miner door at the address the room shows and submits a nonce found for the
// pool's own job with the TEST testnet parameters (the pool's reference check, never the token's live proof of work).
const J = 'J-more-catalogue-05';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
// The values the stack's pool is started with: the labelled LOCAL TEST owner values, read from their own file.
const PUBLISHED = Object.fromEntries(
  Object.entries(JSON.parse(readFileSync(path.join(ROOT, 'tooling/profiles/test-owner-values/mining-pool.json'), 'utf8')).values).map(
    ([key, { value }]) => [key, value],
  ),
);

/**
 * The pool restarted with stack-only flags (LOCAL_STACK_MINING_POOL_PUBLISHED=off for nothing published,
 * LOCAL_STACK_MINING_POOL_POW=off for blank proof-of-work parameters, LOCAL_STACK_MINING_POOL_PROBE_TARGET for a local
 * listener the test starts), or back on its TEST values with none. "Changed" is written to its own state file before the
 * restart, so a run cancelled mid-step is put back by the next run's first hook, and cleared only once the pool is back.
 */
const POOL_FLAGS = ['LOCAL_STACK_MINING_POOL_PUBLISHED', 'LOCAL_STACK_MINING_POOL_POW', 'LOCAL_STACK_MINING_POOL_PROBE_TARGET'];
const changed = journeyState(`${J}-blank`);
function restartPool(flags = {}) {
  const before = Object.fromEntries(POOL_FLAGS.map((key) => [key, process.env[key]]));
  const plain = Object.keys(flags).length === 0;
  for (const key of POOL_FLAGS) delete process.env[key];
  Object.assign(process.env, flags);
  if (!plain) changed.write({ off: true });
  try {
    tool('local-test-stack.mjs', 'restart', 'mining-pool');
    if (plain) changed.reset({});
  } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
const poolPublished = (on) => restartPool(on ? {} : { LOCAL_STACK_MINING_POOL_PUBLISHED: 'off' });
const putPoolBack = () => {
  if (changed.read().off) restartPool();
};
// A step that fails or times out never reaches its own end, so the hooks put the pool back before the next step.
test.beforeAll(putPoolBack);
test.afterEach(putPoolBack);

/**
 * A local address that takes no connection: a child process listens with a backlog of one and then blocks its only
 * thread, so it never accepts; filler connections fill the kernel's queue, and the next connection's handshake is never
 * answered. Checked here before use: a connect of our own must time out, not connect and not be refused.
 */
async function silentListener() {
  const child = spawn(
    process.execPath,
    [
      '-e',
      `const s = require('node:net').createServer();
       s.listen({ host: '127.0.0.1', port: 0, backlog: 1 }, () => {
         process.stdout.write(s.address().port + '\\n');
         setTimeout(() => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0), 50);
       });`,
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  const port = await new Promise((resolve, reject) => {
    child.stdout.once('data', (chunk) => resolve(Number(String(chunk).trim())));
    child.once('exit', (code) => reject(new Error(`silent listener exited ${code}`)));
  });
  await new Promise((resolve) => setTimeout(resolve, 200));
  const fillers = Array.from({ length: 8 }, () => net.connect({ host: '127.0.0.1', port }).on('error', () => {}));
  await new Promise((resolve) => setTimeout(resolve, 300));
  const close = () => {
    for (const socket of fillers) socket.destroy();
    child.kill('SIGKILL');
  };
  const own = await new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.setTimeout(500);
    const done = (kind) => {
      socket.destroy();
      resolve(kind);
    };
    socket.once('connect', () => done('connected'));
    socket.once('timeout', () => done('timed out'));
    socket.once('error', (err) => done(err.code));
  });
  if (own !== 'timed out') close();
  expect(own, 'the silent listener takes no connection').toBe('timed out');
  return { port, close };
}

/** A local port nothing listens on: bound by the system, then released, so a connect to it is refused. */
async function closedPort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen({ host: '127.0.0.1', port: 0 }, resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test.describe.configure({ mode: 'default' });

/** The roster row whose name cell is exactly `name`, and its cells: name, mode, weight, minimum difficulty, added. */
const workerRow = (table, name) => table.getByRole('row').filter({ has: table.page().getByRole('cell', { name, exact: true }) });
const cellsOf = (row) => row.getByRole('cell');

async function openMining(page, path = '/mining') {
  await signIn(page, run.read().who);
  await page.goto(path);
}

test(`${J} starts: a signed-up TEST account`, async ({ page }) => {
  const who = await signUp(page, 'mn');
  await verify(page, who);
  // Share ids are global to the pool, so each run labels its TEST shares with its own tag.
  run.reset({ who, tag: Date.now().toString(36) });
});

test(`${J} #1 opens /mining: the pool overview with coin, hardware and revenue split, each "not set" with no invented text when unpublished`, async ({
  page,
}) => {
  const sections = [
    ['Coin', 'MINING_OVERVIEW_COIN'],
    ['Hardware', 'MINING_OVERVIEW_HARDWARE'],
    ['Revenue split', 'MINING_OVERVIEW_REVENUE_SPLIT'],
  ];
  await openMining(page);
  await expect(page.getByRole('heading', { name: 'Mining', level: 1 })).toBeVisible();
  // Published: each section shows the stored TEST text exactly.
  for (const [section, key] of sections) {
    const region = page.getByRole('region', { name: section, exact: true });
    await expect(region).toHaveAttribute('data-state', 'set');
    await expect(region.getByRole('paragraph')).toHaveText(PUBLISHED[key]);
  }
  // Unpublished: the pool restarted with every owner value blank; each section says "Not set" and nothing else.
  poolPublished(false);
  try {
    await page.reload();
    for (const [section] of sections) {
      const region = page.getByRole('region', { name: section, exact: true });
      await expect(region).toHaveAttribute('data-state', 'unset');
      await expect(region.getByRole('paragraph')).toHaveText('Not set');
      await expect(region.getByRole('paragraph')).toHaveCount(1);
    }
    await expect(page.getByText('Published overview')).toHaveCount(0);
    await expect(page.getByText(PUBLISHED.MINING_OVERVIEW_WHAT)).toHaveCount(0);
  } finally {
    poolPublished(true);
  }
});

test(`${J} #2 copies the pool address, the account id and the worker name: each copy equals the stored value, and the account id is the miner id`, async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await openMining(page);
  const connect = page.getByRole('region', { name: 'Connect your miner' });
  // The worker name is the pool's published pattern filled with the rig's name, so the rig is named first.
  await connect.getByLabel('Your rig name').fill('Rig-A');
  const copy = async (field) => {
    await connect.getByRole('button', { name: `Copy ${field}` }).click();
    return page.evaluate(() => navigator.clipboard.readText());
  };
  // Each copy is compared with the value the pool was started with, not with the page's own text.
  expect(await copy('pool address')).toBe(`${PUBLISHED.MINING_POOL_HOST}:${PUBLISHED.MINING_POOL_PORT}`);
  // The account id a rig sends is the signed-in account's own id, which the pool counts shares under.
  expect(await copy('account id')).toBe((await api(run.read().who)).userId);
  expect(await copy('worker name')).toBe(PUBLISHED.MINING_WORKER_NAME_PATTERN.replace('{worker}', 'Rig-A'));

  // A blank host: the typed refusal by its code, and nothing to copy.
  poolPublished(false);
  try {
    await page.reload();
    const unset = connect.getByTestId('mining-connection-unset');
    await expect(unset).toHaveAttribute('data-code', 'mining.connection_unset');
    await expect(unset).toHaveAttribute('role', 'alert');
    await expect(connect.getByRole('button', { name: /^Copy / })).toHaveCount(0);
  } finally {
    poolPublished(true);
  }
});

test(`${J} #3 presses the reachability test on an unreachable host: "Timed out" with a label, never a success; past the owner limit a typed limit refusal`, async ({
  page,
}) => {
  test.setTimeout(180_000);
  // The TEST wait is 1000 ms and the TEST limit 3 presses; the press limit is counted in the pool's own process, and each
  // restart below starts it at no press used.
  expect(PUBLISHED.MINING_PROBE_TIMEOUT_MS).toBe('1000');
  const limit = Number(PUBLISHED.MINING_PROBE_LIMIT);
  expect(limit).toBe(3);
  const check = page.getByRole('button', { name: 'Test the connection' });
  const result = page.getByTestId('mining-reachability');
  const pressed = async () => {
    await check.click();
    await expect(check).toBeEnabled({ timeout: 30_000 });
  };

  // An address that never answers the handshake: "Timed out" with the measured wait, never a success.
  const silent = await silentListener();
  try {
    restartPool({ LOCAL_STACK_MINING_POOL_PROBE_TARGET: `127.0.0.1:${silent.port}` });
    await openMining(page);
    await expect(result).toHaveAttribute('data-result', 'none');
    await pressed();
    await expect(result).toHaveAttribute('data-result', 'timed_out');
    await expect(result).toHaveText(/^Timed out after \d+ ms: the pool address did not answer$/);
    // The measured wait is the round trip, at least the published 1000 ms.
    expect(Number((await result.textContent()).match(/after (\d+) ms/)[1])).toBeGreaterThanOrEqual(1000);
    await expect(page.getByText('Tested from the pool’s own network, not from your rig.')).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(page.getByText(/^Reached in/)).toHaveCount(0);
  } finally {
    silent.close();
  }

  // A port nothing listens on: "Not reached", a different label from a time-out, and never a success; then one press
  // past the owner limit is the typed limit refusal and the last result stays as it was.
  try {
    restartPool({ LOCAL_STACK_MINING_POOL_PROBE_TARGET: `127.0.0.1:${await closedPort()}` });
    await page.reload();
    await expect(result).toHaveAttribute('data-result', 'none');
    for (let press = 1; press <= limit; press += 1) {
      await pressed();
      await expect(result).toHaveAttribute('data-result', 'refused');
      await expect(result).toHaveText('Not reached: the pool address did not accept the connection');
      await expect(page.getByRole('alert')).toHaveCount(0);
    }
    await check.click();
    await expect(page.getByRole('alert')).toHaveAttribute('data-code', 'mining.probe_limit_reached');
    await expect(result).toHaveAttribute('data-result', 'refused');
    await expect(result).toHaveText('Not reached: the pool address did not accept the connection');
    await expect(page.getByText(/^Reached in/)).toHaveCount(0);
  } finally {
    restartPool();
  }
});

test(`${J} #4 opens /mining/status: the pool status and reachability`, async ({ page }) => {
  await openMining(page, '/mining/status');
  await expect(page.getByRole('heading', { name: 'Mining status', level: 1 })).toBeVisible();
  // The stack's pool is up, so the one expected state is answering.
  await expect(page.getByTestId('mining-pool-status')).toHaveAttribute('data-state', 'answering');
  await expect(page.getByTestId('mining-pool-status')).toHaveText('Answering');
  // The reachability control is on the status tab, with its result line.
  const reach = page.getByRole('region', { name: 'Reachability' });
  await expect(reach.getByRole('button', { name: 'Test the connection' })).toBeEnabled();
  await expect(reach.getByTestId('mining-reachability')).toHaveAttribute('data-result', 'none');
  await expect(reach.getByTestId('mining-reachability')).toHaveText('No test run');
});

/** This account's workers as the pool itself answers `workers.mine`, never the page's own text: [name, weight] pairs. */
async function poolRoster(who) {
  const client = await api(who);
  const res = await client.get(`/api/mining/trpc/workers.mine?input=${encodeURIComponent(JSON.stringify({ windowMinutes: 60 }))}`);
  expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
  return res.body.result.data.workers.map((worker) => [worker.name, worker.hashrate]).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

test(`${J} #5 connects the rig Rig-A and submits a first accepted share: one worker Rig-A; a share with no name goes to the default worker; the same share twice makes one worker`, async ({
  page,
  context,
}) => {
  const { who, tag } = run.read();
  // Before any share the account has no worker, in the room and in the pool's own read.
  await openMining(page, '/mining/workers');
  await expect(page.getByText('You have no workers yet', { exact: true })).toBeVisible();
  await expect(tableIn(page, 'Your workers')).toHaveCount(0);
  expect(await poolRoster(who)).toEqual([]);

  // The rig is set up from what the room copies: the pool address, the account id and the worker name for Rig-A.
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/mining');
  const connect = page.getByRole('region', { name: 'Connect your miner' });
  await connect.getByLabel('Your rig name').fill('Rig-A');
  const copy = async (field) => {
    await connect.getByRole('button', { name: `Copy ${field}` }).click();
    return page.evaluate(() => navigator.clipboard.readText());
  };
  const pool = await copy('pool address');
  const login = `${await copy('account id')}.${await copy('worker name')}`;
  const rig = (...args) => tool('local-test-stack.mjs', 'mining-share', who.email, '--pool', pool, ...args);

  // The rig connects to that address and its first share is accepted: exactly one worker, Rig-A, at weight 1.
  expect(rig('--login', login, '--share', `jmc05-${tag}-first`)).toMatch(
    new RegExp(
      `^accepted TEST share LOCAL-TEST-jmc05-${tag}-first for miner \\S+, login ${login.replaceAll('.', '\\.')}, .* through the miner door at ${pool.replaceAll('.', '\\.')} `,
    ),
  );
  expect(await poolRoster(who)).toEqual([['Rig-A', '1']]);
  await page.goto('/mining/workers');
  const workers = tableIn(page, 'Your workers');
  await expect(bodyRows(workers)).toHaveCount(1);
  await expect(cellsOf(workerRow(workers, 'Rig-A')).nth(2)).toHaveText('1');

  // The same share sent again is refused by name and keeps nothing: still one worker, weight unchanged.
  expect(rig('--login', login, '--share', `jmc05-${tag}-first`)).toMatch(/^refused mining\.share_duplicate: /);
  expect(await poolRoster(who)).toEqual([['Rig-A', '1']]);

  // A share sent with the account id alone, no worker name, goes to the worker named default.
  const account = login.slice(0, login.indexOf('.'));
  expect(rig('--login', account, '--share', `jmc05-${tag}-unnamed`)).toMatch(/^accepted TEST share /);
  expect(await poolRoster(who)).toEqual([
    ['Rig-A', '1'],
    ['default', '1'],
  ]);
  await page.reload();
  await expect(bodyRows(workers)).toHaveCount(2);
  await expect(workerRow(workers, 'Rig-A')).toHaveCount(1);
  await expect(workerRow(workers, 'default')).toHaveCount(1);
  await expect(cellsOf(workerRow(workers, 'Rig-A')).nth(2)).toHaveText('1');
  await expect(cellsOf(workerRow(workers, 'default')).nth(2)).toHaveText('1');
});

test(`${J} #6 opens /mining/workers and sets a minimum difficulty: the list with filters and paging; difficulty set or automatic; a blank default says so`, async ({
  page,
}) => {
  test.setTimeout(180_000);
  const { who, tag } = run.read();
  // Twenty more rigs, so the roster runs past one page of twenty.
  for (let n = 1; n <= 20; n += 1) {
    const rig = `Rig-${String(n).padStart(2, '0')}`;
    expect(tool('local-test-stack.mjs', 'mining-share', who.email, '--worker', rig, '--share', `jmc05-${tag}-${rig}`)).toContain(
      'accepted TEST share',
    );
  }
  await openMining(page, '/mining/workers');
  await expect(page.getByRole('heading', { name: 'Mining workers', level: 1 })).toBeVisible();
  const workers = tableIn(page, 'Your workers');
  await expect(bodyRows(workers)).toHaveCount(20);
  const names = async () => bodyRows(workers).evaluateAll((rows) => rows.map((row) => row.querySelector('td').textContent));
  const first = await names();
  await page.getByRole('button', { name: 'Next page' }).click();
  await expect(bodyRows(workers)).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'Next page' })).toHaveCount(0);
  // Across both pages every worker this person's shares made appears exactly once.
  const rigs = Array.from({ length: 20 }, (_, n) => `Rig-${String(n + 1).padStart(2, '0')}`);
  expect([...first, ...(await names())].sort()).toEqual(['Rig-A', 'default', ...rigs].sort());
  await page.getByRole('button', { name: 'First page' }).click();
  await expect(bodyRows(workers)).toHaveCount(20);

  await page.getByRole('searchbox', { name: 'Filter workers' }).fill('rig-a');
  await expect(bodyRows(workers)).toHaveCount(1);
  const rigA = cellsOf(workerRow(workers, 'Rig-A'));
  await expect(rigA.nth(3)).toHaveText('Automatic');
  // The stack publishes no default difficulty, and the room says so instead of showing a number.
  await expect(page.getByTestId('mining-default-difficulty')).toHaveText('The pool has no published default difficulty.');

  await page.getByRole('combobox', { name: 'Worker', exact: true }).selectOption({ label: 'Rig-A' });
  await page.getByRole('textbox', { name: 'Minimum difficulty' }).fill('1024');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Minimum difficulty' })).toHaveText('Minimum difficulty 1024 saved for Rig-A');
  await expect(rigA.nth(3)).toHaveText('1024');
  // Read back from the pool after a fresh load: the saved minimum stays.
  await page.reload();
  await page.getByRole('searchbox', { name: 'Filter workers' }).fill('rig-a');
  await expect(bodyRows(workers)).toHaveCount(1);
  await expect(rigA.nth(3)).toHaveText('1024');
  await page.getByRole('button', { name: 'Use automatic' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Rig-A' })).toHaveText('Automatic difficulty saved for Rig-A');
  // Read back from the pool after a fresh load: the minimum is cleared, in the room and in the pool's own read.
  await page.reload();
  await page.getByRole('searchbox', { name: 'Filter workers' }).fill('rig-a');
  await expect(bodyRows(workers)).toHaveCount(1);
  await expect(rigA.nth(3)).toHaveText('Automatic');
  const client = await api(who);
  const res = await client.get(
    `/api/mining/trpc/workers.mine?input=${encodeURIComponent(JSON.stringify({ windowMinutes: 60, name: 'Rig-A' }))}`,
  );
  expect(res.body.result.data.workers.map((worker) => [worker.name, worker.minDifficulty])).toEqual([['Rig-A', null]]);
});

/**
 * This account's pooled weight in the open window that holds its work, as the rewards room shows it ("Your weight"). The
 * rig's shares all fall in the miner door's one current window, so exactly one open window holds this account's work
 * (others the stack holds are other accounts' and weigh 0 here).
 */
async function pooledWeight(page) {
  await page.goto('/mining/rewards');
  const open = tableIn(page, 'Open windows');
  await expect(bodyRows(open).first()).toBeVisible();
  const mine = (await bodyRows(open).evaluateAll((rows) => rows.map((row) => row.querySelectorAll('td')[1].textContent.trim()))).filter(
    (weight) => !/^0(\.0+)?$/.test(weight),
  );
  expect(mine).toHaveLength(1);
  return mine[0];
}

const share = (...args) => tool('local-test-stack.mjs', 'mining-share', run.read().who.email, ...args);

test(`${J} #7 starts solo mining, or submits a share that fails validation: solo alongside pooled; an invalid share is refused by the proof-of-work check and a testnet flag is labelled`, async ({
  page,
}) => {
  test.setTimeout(180_000);
  // Share ids are global to the pool; each attempt of this step labels its own.
  const tag = `${run.read().tag}-${Date.now().toString(36)}`;
  // A valid share: the submitter finds a nonce that meets the TEST target for this window, account and rig, and sends no
  // weight; the pool accepts it. Rig-A then has a share in the open window.
  expect(share('--worker', 'Rig-A', '--share', `jmc05-${tag}-pow-valid`)).toMatch(
    /^accepted TEST share LOCAL-TEST-jmc05-\S+-pow-valid for miner \S+, worker Rig-A, TEST testnet proof of work, valid nonce [0-9a-f]+ /,
  );
  await signIn(page, run.read().who);
  const before = await pooledWeight(page);

  await page.goto('/mining/workers');
  const workers = tableIn(page, 'Your workers');
  await expect(page.getByRole('heading', { name: 'Pooled or solo', level: 2 })).toBeVisible();
  const setMode = async (rig, mode) => {
    await page.getByRole('textbox', { name: 'Rig name', exact: true }).fill(rig);
    await page.getByRole('group', { name: 'Mode for this rig' }).getByRole('radio', { name: mode, exact: true }).check();
    await page.getByRole('button', { name: 'Save mode' }).click();
  };
  // The testnet flag is labelled: the pool's own published TEST parameters, read back exactly.
  const pow = page.getByTestId('mining-pow');
  await expect(pow).toHaveAttribute('data-testnet', 'true');
  await expect(pow).toHaveText(
    `TEST testnet proof of work: ${PUBLISHED.MINING_POW_DIMENSION}×${PUBLISHED.MINING_POW_DIMENSION} matrix multiplication, at least ${PUBLISHED.MINING_POW_TARGET_BITS} leading zero bits. Testnet shares earn no credit.`,
  );
  expect(PUBLISHED.MINING_POW_TESTNET).toBe('true');
  await expect(
    page.getByText('This is the pool’s reference check of each share. It is not the token’s live proof of work, and it is not audited.'),
  ).toBeVisible();

  // Solo alongside pooled: Rig-S is saved solo and read back from the pool; Rig-A stays pooled.
  await setMode('Rig-S', 'Solo');
  await expect(page.getByTestId('mining-mode-status')).toHaveText('Solo saved for Rig-S');
  await page.reload();
  const filter = page.getByRole('searchbox', { name: 'Filter workers' });
  await filter.fill('rig-s');
  await expect(bodyRows(workers)).toHaveCount(1);
  await expect(cellsOf(workerRow(workers, 'Rig-S')).nth(1)).toHaveText('Solo');
  await filter.fill('rig-a');
  await expect(bodyRows(workers)).toHaveCount(1);
  await expect(cellsOf(workerRow(workers, 'Rig-A')).nth(1)).toHaveText('Pooled');
  const rigAWeight = (await cellsOf(workerRow(workers, 'Rig-A')).nth(2).textContent()).trim();

  // Rig-A has a share in the open window, so a mode change is refused by its code and the stored mode stays pooled.
  await setMode('Rig-A', 'Solo');
  const refused = page.getByTestId('mining-mode-refused');
  await expect(refused).toHaveAttribute('data-code', 'mining.mode_change_in_window');
  await expect(refused).toHaveText('Mode not changed: this rig has shares in a window that is still open.');
  await page.reload();
  await page.getByRole('searchbox', { name: 'Filter workers' }).fill('rig-a');
  await expect(bodyRows(workers)).toHaveCount(1);
  await expect(cellsOf(workerRow(workers, 'Rig-A')).nth(1)).toHaveText('Pooled');

  // A solo share is stored on Rig-S and stays out of the pooled split: this account's pooled weight does not move.
  expect(share('--worker', 'Rig-S', '--share', `jmc05-${tag}-solo`)).toContain('accepted TEST share');
  expect(await pooledWeight(page)).toBe(before);
  await page.goto('/mining/workers');
  await page.getByRole('searchbox', { name: 'Filter workers' }).fill('rig-s');
  await expect(bodyRows(workers)).toHaveCount(1);
  await expect(cellsOf(workerRow(workers, 'Rig-S')).nth(2)).toHaveText('1');

  // An invalid share (a nonce whose work misses the target) is refused by the proof-of-work check by its code, and no
  // weight moves anywhere.
  expect(share('--worker', 'Rig-A', '--share', `jmc05-${tag}-pow-invalid`, '--invalid-pow')).toMatch(
    /^refused mining\.pow_invalid: TEST share LOCAL-TEST-jmc05-\S+-pow-invalid \(TEST testnet proof of work, invalid nonce [0-9a-f]+\); nothing was kept/,
  );
  expect(await pooledWeight(page)).toBe(before);
  await page.goto('/mining/workers');
  await page.getByRole('searchbox', { name: 'Filter workers' }).fill('rig-a');
  await expect(bodyRows(workers)).toHaveCount(1);
  await expect(cellsOf(workerRow(workers, 'Rig-A')).nth(2)).toHaveText(rigAWeight);

  // A second valid pooled share does move the pooled weight, by exactly its one unit, so the two checks above are not
  // reading a weight that never moves.
  expect(share('--worker', 'Rig-A', '--share', `jmc05-${tag}-pow-valid-2`)).toContain('accepted TEST share');
  expect(BigInt(await pooledWeight(page))).toBe(BigInt(before) + 1n);

  // Solo credit is the service's own typed refusal.
  await page.goto('/mining/workers');
  const solo = page.getByTestId('mining-solo-credit');
  await expect(solo).toHaveAttribute('data-code', 'mining.emission_unpublished');
  await expect(solo).toHaveText('Solo credit is refused: the pool has no published reward source.');
});

test(`${J} #7 with no published proof-of-work parameters: the room says so by its code and the pool refuses work it cannot check`, async ({
  page,
}) => {
  // Share ids are global to the pool; each attempt of this step labels its own.
  const tag = `${run.read().tag}-${Date.now().toString(36)}`;
  try {
    restartPool({ LOCAL_STACK_MINING_POOL_POW: 'off' });
    await openMining(page, '/mining/workers');
    const unset = page.getByTestId('mining-pow-unset');
    await expect(unset).toHaveAttribute('data-code', 'mining.pow_spec_unset');
    await expect(unset).toHaveText('The pool has no published proof-of-work parameters, so it checks no work.');
    await expect(page.getByTestId('mining-pow')).toHaveCount(0);
    await expect(page.getByText(/testnet/i)).toHaveCount(0);
    expect(share('--worker', 'Rig-A', '--share', `jmc05-${tag}-pow-blank`)).toMatch(/^refused mining\.pow_spec_unset: /);
  } finally {
    restartPool();
  }
  // Published again: the TEST testnet label is back.
  await page.reload();
  await expect(page.getByTestId('mining-pow')).toHaveAttribute('data-testnet', 'true');
});
