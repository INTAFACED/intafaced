import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { ROOT, api, journeyState, tool } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';
import { bodyRows, tableIn } from './tables.mjs';

// J-more-catalogue-05, in the running app (docs/roadmap/journeys.json): point a miner at the pool. One test per step,
// titled "J-more-catalogue-05 #<n>". The person is a verified TEST account on the local stack (the pool serves the
// basic tier and up); no money moves. The miner is the
// stack's TEST share submitter, which speaks to the pool's own share door as a rig would.
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT), and stay red by name:
// - #7: no solo mode or proof-of-work refusal.
const J = 'J-more-catalogue-05';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const UNBUILT = { timeout: 5_000 };
// The values the stack's pool is started with: the labelled LOCAL TEST owner values, read from their own file.
const PUBLISHED = Object.fromEntries(
  Object.entries(JSON.parse(readFileSync(path.join(ROOT, 'tooling/profiles/test-owner-values/mining-pool.json'), 'utf8')).values).map(
    ([key, { value }]) => [key, value],
  ),
);

/**
 * The pool restarted with nothing published (LOCAL_STACK_MINING_POOL_PUBLISHED=off), or back on its TEST values. "Off" is
 * written to its own state file before the restart, so a run cancelled while blank is put back by the next run's first
 * hook, and cleared only once the pool is published again.
 */
const blank = journeyState(`${J}-blank`);
function poolPublished(on) {
  const before = process.env.LOCAL_STACK_MINING_POOL_PUBLISHED;
  if (on) delete process.env.LOCAL_STACK_MINING_POOL_PUBLISHED;
  else process.env.LOCAL_STACK_MINING_POOL_PUBLISHED = 'off';
  if (!on) blank.write({ off: true });
  try {
    tool('local-test-stack.mjs', 'restart', 'mining-pool');
    if (on) blank.reset({});
  } finally {
    if (before === undefined) delete process.env.LOCAL_STACK_MINING_POOL_PUBLISHED;
    else process.env.LOCAL_STACK_MINING_POOL_PUBLISHED = before;
  }
}
const putPoolBack = () => {
  if (blank.read().off) poolPublished(true);
};
// A step that fails or times out never reaches its own end, so the hooks publish the pool again before the next step.
test.beforeAll(putPoolBack);
test.afterEach(putPoolBack);

test.describe.configure({ mode: 'default' });

/** The roster row whose name cell is exactly `name`, and its cells: name, weight, minimum difficulty, added. */
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
  // The stack's TEST host is a documentation address that never answers, and the TEST wait is 1000 ms.
  expect(PUBLISHED.MINING_PROBE_TIMEOUT_MS).toBe('1000');
  // The press limit is counted in the pool's own process, so a fresh start makes "no press used yet" true.
  tool('local-test-stack.mjs', 'restart', 'mining-pool');
  await openMining(page);
  const check = page.getByRole('button', { name: 'Test the connection' });
  const result = page.getByTestId('mining-reachability');
  const limit = Number(PUBLISHED.MINING_PROBE_LIMIT);
  for (let press = 1; press <= limit; press += 1) {
    await check.click();
    await expect(check).toBeEnabled({ timeout: 30_000 });
    await expect(result).toHaveAttribute('data-result', 'timed_out');
    await expect(result).toHaveText(/^Timed out after \d+ ms: the pool address did not answer$/);
    // The measured wait is the round trip, at least the published 1000 ms.
    expect(Number((await result.textContent()).match(/after (\d+) ms/)[1])).toBeGreaterThanOrEqual(1000);
    await expect(page.getByText('Tested from the pool’s own network, not from your rig.')).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);
  }
  // One press past the owner limit: the typed limit refusal, and the last result stays a time-out, never a success.
  await check.click();
  await expect(page.getByRole('alert')).toHaveAttribute('data-code', 'mining.probe_limit_reached');
  await expect(result).toHaveAttribute('data-result', 'timed_out');
  await expect(page.getByText(/^Reached in/)).toHaveCount(0);
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

test(`${J} #5 connects the rig Rig-A and submits a first accepted share: one worker Rig-A; a share with no name goes to the default worker; the same share twice makes one worker`, async ({
  page,
}) => {
  const { who, tag } = run.read();
  await openMining(page, '/mining/workers');
  expect(tool('local-test-stack.mjs', 'mining-share', who.email, '--worker', 'Rig-A', '--share', `jmc05-${tag}-first`)).toContain(
    'accepted TEST share',
  );
  // The same share delivered again is refused by name and keeps nothing new.
  expect(tool('local-test-stack.mjs', 'mining-share', who.email, '--worker', 'Rig-A', '--share', `jmc05-${tag}-first`)).toContain(
    'refused mining.share_duplicate',
  );
  expect(tool('local-test-stack.mjs', 'mining-share', who.email, '--share', `jmc05-${tag}-unnamed`)).toContain('worker default');
  await page.reload();
  const workers = tableIn(page, 'Your workers');
  // Two workers, each named exactly once; the refused repeat added no weight to Rig-A (one share of weight 1).
  await expect(bodyRows(workers)).toHaveCount(2);
  await expect(workerRow(workers, 'Rig-A')).toHaveCount(1);
  await expect(workerRow(workers, 'default')).toHaveCount(1);
  await expect(cellsOf(workerRow(workers, 'Rig-A')).nth(1)).toHaveText('1');
  await expect(cellsOf(workerRow(workers, 'default')).nth(1)).toHaveText('1');
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
  await expect(rigA.nth(2)).toHaveText('Automatic');
  // The stack publishes no default difficulty, and the room says so instead of showing a number.
  await expect(page.getByTestId('mining-default-difficulty')).toHaveText('The pool has no published default difficulty.');

  await page.getByRole('combobox', { name: 'Worker', exact: true }).selectOption({ label: 'Rig-A' });
  await page.getByRole('textbox', { name: 'Minimum difficulty' }).fill('1024');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Minimum difficulty' })).toHaveText('Minimum difficulty 1024 saved for Rig-A');
  await expect(rigA.nth(2)).toHaveText('1024');
  // Read back from the pool after a fresh load: the saved minimum stays.
  await page.reload();
  await page.getByRole('searchbox', { name: 'Filter workers' }).fill('rig-a');
  await expect(bodyRows(workers)).toHaveCount(1);
  await expect(rigA.nth(2)).toHaveText('1024');
  await page.getByRole('button', { name: 'Use automatic' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Rig-A' })).toHaveText('Automatic difficulty saved for Rig-A');
  await expect(rigA.nth(2)).toHaveText('Automatic');
});

test(`${J} #7 starts solo mining, or submits a share that fails validation: solo alongside pooled; an invalid share is refused by the proof-of-work check and a testnet flag is labelled`, async ({
  page,
}) => {
  await openMining(page);
  await page.getByRole('radio', { name: 'Solo' }).check(UNBUILT);
  await expect(page.getByRole('radio', { name: 'Pooled' })).toBeVisible();
  await expect(page.getByText(/Testnet/)).toBeVisible();
});
