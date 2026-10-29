import { test, expect } from '@playwright/test';
import { api, journeyState, toUnits, tool } from './stack.mjs';
import { fundedTrader, signIn } from './desk.mjs';

// J-more-catalogue-12, in the running app (docs/roadmap/journeys.json): subscribe to a launch and get my allocation or
// my money back. One test per step, titled "J-more-catalogue-12 #<n>", run in order on one verified TEST account with
// TEST 500 USDT. The launch events (an open subscription with a cap, a lottery with no draw source, one to cancel) are
// the stack's TEST launch seed (`local-test-world.mjs launch-events`), and settlement is its TEST clock
// (`local-test-world.mjs launch-settle`). Every hold, allocation and refund is read back from the ledger.
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - every step: there is no launch event service, Subscribe button or My launches list (/uc/innovation/myorders), and
//   the stack has no launch seed or settle clock.
const J = 'J-more-catalogue-12';
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

const held = async (who) => toUnits((await (await api(who)).balances()).USDT?.used ?? '0');
const free = async (who) => toUnits((await (await api(who)).balances()).USDT?.free ?? '0');

async function subscribe(page, eventId, amount) {
  await page.goto(`/launch/${encodeURIComponent(eventId)}`);
  await page.getByRole('button', { name: 'Subscribe' }).click(UNBUILT);
  const sheet = page.getByRole('dialog', { name: 'Subscribe to this launch' });
  await sheet.getByLabel('Commit (USDT)').fill(amount);
  await sheet.getByRole('button', { name: 'Commit' }).click();
  return sheet;
}

test(`${J} #1 presses Subscribe and commits TEST 100: one hold; My launches shows it`, async ({ page }) => {
  test.setTimeout(240_000);
  const buyer = await fundedTrader(page, 'jls', '500');
  const seeded = JSON.parse(tool('local-test-world.mjs', 'launch-events', '--open', '--lottery', '--cancellable'));
  run.reset({ buyer, ...seeded });
  await signIn(page, buyer);
  const before = await held(buyer);
  await subscribe(page, seeded.openId, '100');
  expect((await held(buyer)) - before).toBe(toUnits('100'));
  await page.goto('/uc/innovation/myorders');
  await expect(page.getByRole('row', { name: new RegExp(seeded.openId) })).toContainText('100');
});

test(`${J} #2 sends the same request twice, or loses the reply: one hold`, async () => {
  const buyer = state('buyer');
  const body = { eventId: state('openId'), amount: '50', requestId: `launch:commit:${state('openId')}:${buyer.email}:2` };
  const before = await held(buyer);
  await (await api(buyer)).post('/api/launch/trpc/launch.commit', body);
  await (await api(buyer)).post('/api/launch/trpc/launch.commit', body);
  expect((await held(buyer)) - before).toBe(toUnits('50'));
});

test(`${J} #3 subscribes to a lottery launch with no draw source recorded: the refusal naming the owner decision`, async ({ page }) => {
  await signIn(page, state('buyer'));
  const sheet = await subscribe(page, state('lotteryId'), '10');
  await expect(sheet.getByText(/draw source .*owner/i)).toBeVisible();
});

test(`${J} #4 the event settles: allocation paid once, the unused commit returned once; the hold equals the two`, async () => {
  const buyer = state('buyer');
  const freeBefore = await free(buyer);
  const settled = JSON.parse(tool('local-test-world.mjs', 'launch-settle', state('openId')));
  const mine = settled.rows.find((r) => r.account === buyer.email);
  expect(toUnits(mine.paid) + toUnits(mine.returned)).toBe(toUnits(mine.held));
  expect((await free(buyer)) - freeBefore).toBe(toUnits(mine.returned));
  tool('local-test-world.mjs', 'launch-settle', state('openId'));
  expect((await free(buyer)) - freeBefore).toBe(toUnits(mine.returned));
});

test(`${J} #5 an event is cancelled: every commit returned in full`, async ({ page }) => {
  const buyer = state('buyer');
  await signIn(page, buyer);
  await subscribe(page, state('cancellableId'), '20');
  const freeBefore = await free(buyer);
  tool('local-test-world.mjs', 'launch-cancel', state('cancellableId'));
  expect((await free(buyer)) - freeBefore).toBe(toUnits('20'));
});
