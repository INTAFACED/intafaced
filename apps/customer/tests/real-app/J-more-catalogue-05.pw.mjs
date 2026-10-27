import { test, expect } from '@playwright/test';
import { api, journeyState, tool } from './stack.mjs';
import { fundedTrader, signIn } from './desk.mjs';

// J-more-catalogue-05, in the running app (docs/roadmap/journeys.json): point my miner at the pool. One test per step,
// titled "J-more-catalogue-05 #<n>", run in order on one verified TEST account. The pool overview and its connection
// settings are the stack's TEST pool terms (svc-mining-pool's overview, connection, probe limit and timeout); the miner is
// the stack's TEST miner, which submits shares to svc-mining-pool for a worker name as a rig would.
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - #1: the Mining room shows the pool reading only; it reads none of the service's overview (coin, hardware, revenue
//   split), and the stack publishes no TEST overview.
// - #2, #3: the room shows no connection details, Copy buttons or reachability test (svc-mining-pool's connection and
//   probe reads exist, the room doesn't call them).
// - #4: Pool status shows no reachability line.
// - #5: no stack tool submits a TEST share for a worker (`local-test-world.mjs mining-share`), and customers can't
//   register a worker ("The pool doesn’t let customers register a worker.").
// - #6: no worker filters, paging or minimum difficulty; #7: no solo mode, and no testnet label.
const J = 'J-more-catalogue-05';
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
const section = (page, name) => page.getByRole('group', { name: 'Mining sections' }).getByRole('button', { name, exact: true });

/** What the pool publishes for this person, read through their own session. */
async function read(who, proc) {
  const { status, body } = await (await api(who)).get(trpc(proc));
  return { status, data: body?.result?.data, body };
}

test(`${J} #1 opens /mining: the pool overview with coin, hardware and revenue split, each "not set" when unpublished`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  const miner = await fundedTrader(page, 'jmn', '1');
  run.reset({ miner });
  await signIn(page, miner);
  await page.goto('/mining');
  await expect(page.getByRole('heading', { name: 'Mining', level: 1 })).toBeVisible();
  const overview = page.getByRole('region', { name: 'Pool overview' });
  await expect(overview).toBeVisible(UNBUILT);
  const published = await read(miner, 'overview');
  for (const [name, key] of [
    ['Coin', 'coin'],
    ['Hardware', 'hardware'],
    ['Revenue split', 'revenueSplit'],
  ]) {
    // The owner's words, or "Not set": nothing is written in their place.
    const shown = published.data?.[key] ?? 'Not set';
    await expect(overview).toContainText(new RegExp(`${name}\\s*${shown.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  }
});

test(`${J} #2 copies the pool address, account id and worker name: the copied text equals the stored values`, async ({ page, context }) => {
  const miner = state('miner');
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await signIn(page, miner);
  await page.goto('/mining');
  const connect = page.getByRole('region', { name: 'Connect your miner' });
  const conn = await read(miner, 'connection');
  expect(conn.status, JSON.stringify(conn.body).slice(0, 300)).toBe(200);
  const copied = async (name) => {
    await connect.getByRole('button', { name }).click(UNBUILT);
    return page.evaluate(() => navigator.clipboard.readText());
  };
  expect(await copied('Copy pool address')).toBe(`stratum+tcp://${conn.data.host}:${conn.data.port}`);
  // The account id is the person's own miner id.
  expect(await copied('Copy account id')).toBe(conn.data.minerId);
  expect(await copied('Copy worker name')).toBe(`${conn.data.minerId}.Rig-A`);
  run.write({ minerId: conn.data.minerId });
});

test(`${J} #3 tests reachability of an unreachable host: "Timed out", never a success; past the limit, the typed limit refusal`, async ({
  page,
}) => {
  const miner = state('miner');
  await signIn(page, miner);
  await page.goto('/mining');
  const probe = page.getByRole('region', { name: 'Reachability' });
  // The stack's TEST pool host answers nothing on its stratum port, so the probe times out.
  await probe.getByRole('button', { name: 'Test reachability' }).click(UNBUILT);
  await expect(probe.getByRole('status')).toHaveText(/Timed out/);
  await expect(probe).not.toContainText(/Reachable|Connected/);
  // Pressing on until the owner's probe limit: the refusal names the limit.
  for (let i = 0; i < 20 && !(await probe.getByText(/You can test again/).count()); i++)
    await probe.getByRole('button', { name: 'Test reachability' }).click();
  await expect(probe.getByText(/You can test again/)).toBeVisible();
});

test(`${J} #4 opens /mining/status: the pool status and its reachability`, async ({ page }) => {
  await signIn(page, state('miner'));
  await page.goto('/mining/status');
  await expect(page.getByRole('heading', { name: 'Mining status', level: 1 })).toBeVisible();
  await expect(section(page, 'Pool status')).toHaveAttribute('aria-pressed', 'true');
  const status = page.getByRole('region', { name: 'Pool status' });
  await expect(status.getByText(/Pool process\s*(Responding|Not responding)/)).toBeVisible(UNBUILT);
  await expect(status.getByText(/Reachability\s*(Reachable|Timed out|Not set)/)).toBeVisible();
});

test(`${J} #5 connects Rig-A and submits a first accepted share: one worker Rig-A; a nameless share goes to default; a repeat makes no second`, async ({
  page,
}) => {
  const miner = state('miner');
  const minerId = state('minerId');
  // The stack's TEST miner submits as a rig would: one share for Rig-A, the same share again, and one with no name.
  tool('local-test-world.mjs', 'mining-share', '--miner', minerId, '--worker', 'Rig-A', '--share', `${J}-1`);
  tool('local-test-world.mjs', 'mining-share', '--miner', minerId, '--worker', 'Rig-A', '--share', `${J}-1`);
  tool('local-test-world.mjs', 'mining-share', '--miner', minerId, '--share', `${J}-2`);
  await signIn(page, miner);
  await page.goto('/mining/workers');
  const workers = page.getByRole('table', { name: 'Your workers' });
  await expect(workers.getByRole('row', { name: /^Rig-A/ })).toHaveCount(1);
  await expect(workers.getByRole('row', { name: /^default/ })).toHaveCount(1);
});

test(`${J} #6 opens /mining/workers and sets a minimum difficulty: filters and paging; set or automatic; a blank default says so`, async ({
  page,
}) => {
  await signIn(page, state('miner'));
  await page.goto('/mining/workers');
  await expect(page.getByRole('heading', { name: 'Mining workers', level: 1 })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Share weight window' })).toBeVisible();
  await expect(page.getByRole('searchbox', { name: 'Find a worker' })).toBeVisible(UNBUILT);
  await expect(page.getByRole('navigation', { name: 'Pages' })).toBeVisible();
  const row = page.getByRole('table', { name: 'Your workers' }).getByRole('row', { name: /^Rig-A/ });
  await row.getByRole('button', { name: 'Minimum difficulty' }).click();
  const sheet = page.getByRole('dialog', { name: 'Minimum difficulty for Rig-A' });
  // The pool's default, or the words for one the owner hasn't set.
  await expect(sheet.getByText(/Pool default: (\d+|not set)/)).toBeVisible();
  await sheet.getByLabel('Minimum difficulty').fill('4096');
  await sheet.getByRole('button', { name: 'Save' }).click();
  await expect(row).toContainText('4096');
  await row.getByRole('button', { name: 'Minimum difficulty' }).click();
  await sheet.getByRole('radio', { name: 'Automatic' }).check();
  await sheet.getByRole('button', { name: 'Save' }).click();
  await expect(row).toContainText('Automatic');
});

test(`${J} #7 starts solo mode, or submits an invalid share: solo beside pooled; the bad share refused by the proof-of-work check; testnet labelled`, async ({
  page,
}) => {
  const miner = state('miner');
  await signIn(page, miner);
  await page.goto('/mining');
  const mode = page.getByRole('radiogroup', { name: 'Mining mode' });
  await expect(mode.getByRole('radio', { name: 'Pooled' })).toBeVisible(UNBUILT);
  await mode.getByRole('radio', { name: 'Solo' }).check();
  await expect(page.getByText('Solo mining is on for this account. Pooled workers keep running.')).toBeVisible();
  await expect(page.getByText('TEST network')).toBeVisible();
  const out = tool(
    'local-test-world.mjs',
    'mining-share',
    '--miner',
    state('minerId'),
    '--worker',
    'Rig-A',
    '--share',
    `${J}-bad`,
    '--invalid',
  );
  expect(out).toContain('mining.share_pow_invalid');
});
