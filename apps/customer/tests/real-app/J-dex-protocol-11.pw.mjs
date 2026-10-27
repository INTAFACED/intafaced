import { test, expect } from '@playwright/test';
import { UNBUILT, connectWallet, dexRun } from './dex.mjs';

// J-dex-protocol-11, in the running app (docs/roadmap/journeys.json): buy a little every week with a recurring order.
// One test per step, titled "J-dex-protocol-11 #<n>", run in order with one TEST wallet holding TEST token A and a chosen
// target token. TEST tokens sit in the order vault; each round swaps under the person's signed session; nothing posts to
// the ledger. While the keeper is absent the room shows rail.crypto; the idle-deposit yield toggle waits on the owner's
// decision and the lending contract.
// Every step is written; none is built yet, so each fails at its first missing part, quickly (UNBUILT):
// - there is no Recurring buy room under /dex (D-limit-dca-05, -06); svc-dex's DCA keeper exists but does not run on the
//   stack, and the stack has no TEST chain for a round to fill on.
const J = 'J-dex-protocol-11';
const dex = dexRun(J);
const TOKEN_A = { address: '0x00000000000000000000000000000000000a11ce', name: 'TEST Token A', version: '1', decimals: 6, nonce: 0 };

test.describe.configure({ mode: 'default' });

const plan = (page) => page.getByRole('region', { name: 'Recurring buy' });
const rounds = (page) => plan(page).getByRole('table', { name: 'Rounds' });

async function openRecurring(page) {
  const wallet = await connectWallet(page, dex, { tokens: [TOKEN_A] });
  await page.goto('/dex/recurring');
  await expect(page.getByRole('main').getByRole('heading', { name: 'Recurring buy', level: 1 })).toBeVisible(UNBUILT);
  return wallet;
}

test(`${J} starts: a TEST wallet with TEST token A and a target token chosen`, async ({ page }) => {
  dex.start();
  await openRecurring(page);
});

test(`${J} #1 creates a 4-round recurring buy of 40 TEST every hour: round 1 fills at the start and the output lands in the wallet`, async ({
  page,
}) => {
  await openRecurring(page);
  const form = page.getByRole('form', { name: 'New recurring buy' });
  await form.getByRole('combobox', { name: 'Spend' }).selectOption({ label: 'TEST Token A' }, UNBUILT);
  await form.getByRole('combobox', { name: 'Buy' }).selectOption({ label: 'TEST Token B' });
  await form.getByRole('textbox', { name: /^Total to spend/ }).fill('40');
  await form.getByRole('textbox', { name: /^Rounds/ }).fill('4');
  await form.getByRole('combobox', { name: 'Every' }).selectOption({ label: 'Hour' });
  await form.getByRole('button', { name: 'Start recurring buy' }).click();
  await expect(rounds(page).getByRole('row').nth(1)).toContainText('Filled');
  await expect(plan(page).getByTestId('received-to-wallet')).toHaveText(/^Received [\d.]+ TEST Token B in your wallet$/);
});

test(`${J} #2 sets a price band and the price is outside it: the round waits with the reason; after the retry window it moves to the next interval`, async ({
  page,
}) => {
  await openRecurring(page);
  await plan(page)
    .getByRole('textbox', { name: /^Lowest price/ })
    .fill('0.01', UNBUILT);
  await plan(page)
    .getByRole('textbox', { name: /^Highest price/ })
    .fill('0.02');
  await plan(page).getByRole('button', { name: 'Save band' }).click();
  const log = plan(page).getByRole('list', { name: 'Round log' });
  await expect(log).toContainText('Waiting: the price is outside your band');
  await expect(log).toContainText('Moved to the next interval after the retry window');
});

test(`${J} #3 reopens the page after a round was sent but not recorded: the next tick reads the chain by the stored hash; not sent twice`, async ({
  page,
}) => {
  await openRecurring(page);
  const sent = rounds(page).getByRole('row').filter({ hasText: 'Sent' });
  await expect(sent).toHaveCount(1, UNBUILT);
  await page.reload();
  await expect(sent).toContainText('Recorded from its transaction');
  await expect(
    rounds(page)
      .getByRole('row')
      .filter({ hasText: /Round 2/ }),
  ).toHaveCount(1);
});

test(`${J} #4 opens progress after two rounds: "2 of 4", 50 percent and the next fill time`, async ({ page }) => {
  await openRecurring(page);
  const progress = plan(page).getByRole('progressbar', { name: 'Rounds done' });
  await expect(progress).toHaveAttribute('aria-valuenow', '50', UNBUILT);
  await expect(plan(page)).toContainText('2 of 4');
  await expect(plan(page).getByTestId('next-fill')).toHaveText(/^Next round at \d{2}:\d{2}/);
});

test(`${J} #5 tries to pause or edit the plan: the refusal says a plan cannot be edited; cancel and recreate`, async ({ page }) => {
  await openRecurring(page);
  await plan(page).getByRole('button', { name: 'Edit' }).click(UNBUILT);
  await expect(plan(page).getByRole('alert')).toHaveText('A recurring buy cannot be paused or edited. Cancel it and create a new one.');
  await expect(plan(page).getByRole('button', { name: 'Pause' })).toHaveCount(0);
});

test(`${J} #6 cancels with two rounds left: the refund equals the unfilled remainder exactly`, async ({ page }) => {
  await openRecurring(page);
  await plan(page).getByRole('button', { name: 'Cancel recurring buy' }).click(UNBUILT);
  await page.getByRole('dialog', { name: 'Cancel recurring buy' }).getByRole('button', { name: 'Cancel and refund' }).click();
  await expect(plan(page).getByRole('status')).toHaveText('Cancelled. 20 TEST Token A returned to your wallet.');
});

test(`${J} #7 turns on idle-deposit yield before the lending contract is published: the toggle is off and names the owner decision and the contract`, async ({
  page,
}) => {
  await openRecurring(page);
  const toggle = plan(page).getByRole('switch', { name: 'Earn on idle deposits' });
  await expect(toggle).toBeDisabled(UNBUILT);
  await expect(plan(page).getByRole('note').filter({ hasText: 'owner.decision' })).toContainText('lending contract');
});
