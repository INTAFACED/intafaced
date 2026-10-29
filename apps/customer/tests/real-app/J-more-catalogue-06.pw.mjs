import { test, expect } from '@playwright/test';
import { api, journeyState, tool } from './stack.mjs';
import { fundedTrader, signIn } from './desk.mjs';

// J-more-catalogue-06, in the running app (docs/roadmap/journeys.json): watch my fleet and get told when a worker goes
// quiet. One test per step, titled "J-more-catalogue-06 #<n>", run in order on one verified TEST miner. Shares come from
// the stack's TEST miner (`local-test-world.mjs mining-share`), and the quiet interval is the stack's TEST pool terms;
// every worker, sample and state change is read back from svc-mining-pool.
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - #1: the Mining room reads no hashrate.
// - #2 to #6: no stack tool submits TEST shares, and the room has no hashrate pair, delay line, worker status, quiet
//   flag, notification switch or maintenance mode.
const J = 'J-more-catalogue-06';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const UNBUILT = { timeout: 5_000 };

test.describe.configure({ mode: 'default' });
// An action on a part that never appears fails in 15 s, not at the test's time limit.
test.use({ actionTimeout: 15_000 });

function state(key) {
  const value = run.read()[key];
  if (!value) throw new Error(`${J}: an earlier step made no ${key}, so this step has nothing to act on`);
  return value;
}

const trpc = (proc, input) => `/api/mining-pool/trpc/${proc}?input=${encodeURIComponent(JSON.stringify(input ?? {}))}`;
const read = async (who, proc, input) => (await (await api(who)).get(trpc(proc, input))).body?.result?.data;
const share = (miner, worker, ...rest) => tool('local-test-world.mjs', 'mining-share', miner.email, worker, ...rest);

test(`${J} #1 opens /mining with no shares: both hashrates read "no shares in the window" and the chart is empty`, async ({ page }) => {
  test.setTimeout(240_000);
  const miner = await fundedTrader(page, 'jmf', '1');
  run.reset({ miner });
  await signIn(page, miner);
  await page.goto('/mining');
  const rates = page.getByRole('region', { name: 'Hashrate' });
  await expect(rates).toContainText(/Nominal\s*No shares in the window/, UNBUILT);
  await expect(rates).toContainText(/Effective\s*No shares in the window/);
  await expect(rates.getByRole('img', { name: /Hashrate chart, no data/ })).toBeVisible();
});

test(`${J} #2 opens /mining/shares with shares in: nominal and effective hashrate, a delay line, power and temperature not reported`, async ({
  page,
}) => {
  const miner = state('miner');
  for (const worker of ['Rig-A', 'Rig-B', 'Rig-C']) share(miner, worker);
  share(miner, 'Rig-A', '--invalid');
  await signIn(page, miner);
  await page.goto('/mining/shares');
  const rates = page.getByRole('region', { name: 'Hashrate' });
  const stored = await read(miner, 'hashrate');
  await expect(rates).toContainText(new RegExp(`Nominal\\s*${stored.nominal}`), UNBUILT);
  await expect(rates).toContainText(new RegExp(`Effective\\s*${stored.effective}`));
  await expect(rates).toContainText(/Newest sample \d+ (seconds|minutes?) old/);
  await expect(rates).toContainText(/Power\s*Not reported by the pool/);
  await expect(rates).toContainText(/Temperature\s*Not reported by the pool/);
});

test(`${J} #3 opens a worker: hashing and connectivity status; online when a share was recent`, async ({ page }) => {
  const miner = state('miner');
  share(miner, 'Rig-A');
  await signIn(page, miner);
  await page.goto('/mining/workers');
  await page.getByRole('row', { name: /Rig-A/ }).getByRole('link', { name: 'Rig-A' }).click(UNBUILT);
  await expect(page.getByRole('region', { name: 'Worker' })).toContainText(/Online/);
});

test(`${J} #4 a worker stops sending shares: offline after the quiet interval with one state-change row; a blank alert limit "not set"`, async ({
  page,
}) => {
  const miner = state('miner');
  tool('local-test-world.mjs', 'mining-quiet', miner.email, 'Rig-B');
  tool('local-test-world.mjs', 'mining-quiet', miner.email, 'Rig-B');
  const changes = await read(miner, 'workers.stateChanges', { worker: 'Rig-B' });
  expect(changes.filter((c) => c.to === 'offline')).toHaveLength(1);
  await signIn(page, miner);
  await page.goto('/mining/workers');
  await expect(page.getByRole('row', { name: /Rig-B/ })).toContainText('Offline', UNBUILT);
  await expect(page.getByText(/Alert limit\s*Not set/)).toBeVisible();
});

test(`${J} #5 turns on notifications with no mail provider: the email notice shows and nothing is sent`, async ({ page }) => {
  await signIn(page, state('miner'));
  await page.goto('/mining/workers');
  await page.getByRole('switch', { name: 'Tell me when a worker goes quiet' }).check(UNBUILT);
  await expect(page.getByText(/Email isn’t connected/)).toBeVisible();
});

test(`${J} #6 puts three workers in maintenance: one row per worker; no alert, and the badge says maintenance`, async ({ page }) => {
  const miner = state('miner');
  await signIn(page, miner);
  await page.goto('/mining/workers');
  for (const worker of ['Rig-A', 'Rig-B', 'Rig-C'])
    await page
      .getByRole('row', { name: new RegExp(worker) })
      .getByRole('checkbox')
      .check(UNBUILT);
  await page.getByRole('button', { name: 'Put in maintenance' }).click();
  await page.getByRole('button', { name: 'Put in maintenance' }).click();
  for (const worker of ['Rig-A', 'Rig-B', 'Rig-C'])
    await expect(page.getByRole('row', { name: new RegExp(worker) })).toContainText('Maintenance');
  expect(await read(miner, 'workers.maintenance')).toHaveLength(3);
});
