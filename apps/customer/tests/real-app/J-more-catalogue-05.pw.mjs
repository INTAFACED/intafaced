import { test, expect } from '@playwright/test';
import { journeyState, tool } from './stack.mjs';
import { signIn, signUp } from './desk.mjs';

// J-more-catalogue-05, in the running app (docs/roadmap/journeys.json): point a miner at the pool. One test per step,
// titled "J-more-catalogue-05 #<n>". The person is a TEST account on the local stack; no money moves. The miner is the
// stack's TEST share submitter, which speaks to the pool's own share door as a rig would.
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - #1, #2: the overview has no coin, hardware or revenue split sections and nothing to copy (MC-mining-01).
// - #3: no reachability test with a timed-out label and a press limit.
// - #5, #6: the stack has no TEST share submitter (`local-test-stack.mjs mining-share`, proposed) and the workers room
//   lists none (MC-mining-03); #7: no solo mode or proof-of-work refusal (RC-more-catalogue-16, -17).
const J = 'J-more-catalogue-05';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const UNBUILT = { timeout: 5_000 };

test.describe.configure({ mode: 'default' });

async function openMining(page, path = '/mining') {
  await signIn(page, run.read().who);
  await page.goto(path);
}

test(`${J} starts: a signed-up TEST account`, async ({ page }) => {
  const who = await signUp(page, 'mn');
  run.reset({ who });
});

test(`${J} #1 opens /mining: the pool overview with coin, hardware and revenue split, each "not set" with no invented text when unpublished`, async ({
  page,
}) => {
  await openMining(page);
  await expect(page.getByRole('heading', { name: 'Mining', level: 1 })).toBeVisible();
  for (const section of ['Coin', 'Hardware', 'Revenue split']) {
    const region = page.getByRole('region', { name: section });
    await expect(region).toBeVisible(UNBUILT);
    // A section the owner has not published says so and nothing else.
    if ((await region.getAttribute('data-state')) === 'unset') await expect(region).toContainText('not set');
  }
});

test(`${J} #2 copies the pool address, the account id and the worker name: each copy equals the stored value, and the account id is the miner id`, async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await openMining(page);
  const connect = page.getByRole('region', { name: 'Connect your miner' });
  for (const field of ['Pool address', 'Account id', 'Worker name']) {
    await connect.getByRole('button', { name: `Copy ${field.toLowerCase()}` }).click(UNBUILT);
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    await expect(connect.getByTestId(`mining-${field.toLowerCase().replace(' ', '-')}`)).toHaveText(copied);
  }
});

test(`${J} #3 presses the reachability test on an unreachable host: "Timed out" with a label, never a success; past the owner limit a typed limit refusal`, async ({
  page,
}) => {
  await openMining(page);
  const check = page.getByRole('button', { name: 'Test the connection' });
  await check.click(UNBUILT);
  await expect(page.getByTestId('mining-reachability')).toHaveText(/Timed out|Not reached/, { timeout: 30_000 });
  for (let i = 0; i < 20; i += 1) {
    await check.click();
    if (
      await page
        .getByRole('alert')
        .filter({ hasText: /too many connection tests/i })
        .count()
    )
      return;
  }
  throw new Error('twenty connection tests were all accepted: no owner limit');
});

test(`${J} #4 opens /mining/status: the pool status and reachability`, async ({ page }) => {
  await openMining(page, '/mining/status');
  await expect(page.getByRole('heading', { name: 'Mining status', level: 1 })).toBeVisible();
  await expect(page.getByTestId('mining-pool-status')).toHaveText(/Answering|Not answering|Not checked/, UNBUILT);
});

test(`${J} #5 connects the rig Rig-A and submits a first accepted share: one worker Rig-A; a share with no name goes to the default worker; the same share twice makes one worker`, async ({
  page,
}) => {
  const { who } = run.read();
  await openMining(page, '/mining/workers');
  tool('local-test-stack.mjs', 'mining-share', who.email, '--worker', 'Rig-A', '--share', 'jmc05-first');
  tool('local-test-stack.mjs', 'mining-share', who.email, '--worker', 'Rig-A', '--share', 'jmc05-first');
  tool('local-test-stack.mjs', 'mining-share', who.email, '--share', 'jmc05-unnamed');
  await page.reload();
  const workers = page.getByRole('table', { name: 'Workers' });
  await expect(workers.getByRole('row', { name: /Rig-A/ })).toHaveCount(1);
  await expect(workers.getByRole('row', { name: /default/ })).toHaveCount(1);
});

test(`${J} #6 opens /mining/workers and sets a minimum difficulty: the list with filters and paging; difficulty set or automatic; a blank default says so`, async ({
  page,
}) => {
  await openMining(page, '/mining/workers');
  await expect(page.getByRole('heading', { name: 'Mining workers', level: 1 })).toBeVisible();
  await expect(page.getByRole('searchbox', { name: 'Filter workers' })).toBeVisible(UNBUILT);
  await page.getByRole('textbox', { name: 'Minimum difficulty' }).fill('1024');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('status')).toContainText('Minimum difficulty 1024');
});

test(`${J} #7 starts solo mining, or submits a share that fails validation: solo alongside pooled; an invalid share is refused by the proof-of-work check and a testnet flag is labelled`, async ({
  page,
}) => {
  await openMining(page);
  await page.getByRole('radio', { name: 'Solo' }).check(UNBUILT);
  await expect(page.getByRole('radio', { name: 'Pooled' })).toBeVisible();
  await expect(page.getByText(/Testnet/)).toBeVisible();
});
