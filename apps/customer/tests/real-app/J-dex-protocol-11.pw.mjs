// World: gates, stack
import { test, expect } from './journey.mjs';
import { createPublicClient, http, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { GATE_URL } from '../../../../tooling/scripts/local-test-chain.mjs';
import { tool } from './stack.mjs';
import { testWalletKey } from './test-wallet.mjs';
import { TOKEN_A, TOKEN_B, UNBUILT, acceptRepresentation, connectWallet, dexRun, fundOnTestChain } from './dex.mjs';

// J-dex-protocol-11, in the running app (docs/roadmap/journeys.json): buy a little every week with a recurring order.
// Independent tests (OWNER 212), written from the step's own words. One test per step, titled "J-dex-protocol-11 #<n>",
// run in order with one TEST wallet on the stack's TEST chain, holding TEST Token A, buying TEST Token B.
//
// What every step reads as true, and how a test checks it:
// - The plan is 4 rounds of 40 TEST Token A each, one every hour: 160 TEST Token A leave the wallet for the order vault
//   when it starts, and each round swaps 40 from the vault. Its output goes straight to the wallet, read on the chain
//   (TEST Token B Transfer logs to the wallet), never from the page alone.
// - Each round swaps under the session the person signed once when the plan started: no round asks the wallet for a
//   signature or a transaction.
// - The rounds' clock is the TEST chain's block time (the vault holds the interval on chain), so a step that waits for
//   the next round moves the TEST chain's clock forward through its gate (evm_increaseTime), as a person waits.
// - #3's "sent but not recorded" is made by a LOCAL TEST fault the stack offers, as `engine-drop` does for the book:
//   `local-test-gates.mjs dca-drop-record` makes the keeper send its next DCA round on the TEST chain and lose its record.
// - This journey runs on the TEST chain, so its run funds its wallet there (the same as dex.mjs ON_TEST_CHAIN does for
//   J-dex-protocol-02 and -04; the builder may move it into that set instead).
//
// Names the builder implements, under /dex/orders, tab "Recurring buy":
// - form "New recurring buy": comboboxes "Spend", "Buy", "Every"; textboxes "Amount each round", "Rounds", "Lowest price",
//   "Highest price"; switch "Earn on idle deposits"; button "Start recurring buy"; the pair's price as test id
//   "current-price" (TEST Token A per TEST Token B).
// - one article per plan holding: test id "order-hash"; test id "retry-window"; progressbar "Rounds done"; test id
//   "next-fill" with a <time datetime>; table "Rounds" whose rows start with a cell "Round <n>" and hold the round's due
//   <time datetime>, its state and, once it swapped, a link "Transaction" to /chain/tx/<hash>; list "Round log"; buttons
//   "Edit plan", "Pause plan" and "Cancel recurring buy"; a dialog "Cancel recurring buy" with "Cancel and refund".
const J = 'J-dex-protocol-11';
const base = dexRun(J);
const dex = {
  ...base,
  onChain: true,
  start(extra = {}) {
    const walletKey = testWalletKey();
    fundOnTestChain(privateKeyToAccount(walletKey).address);
    return base.run.reset({ walletKey, ...extra });
  },
  key() {
    return base.run.read().walletKey ?? this.start().walletKey;
  },
};

test.describe.configure({ mode: 'default' });

const HOUR = 3_600;
const ROUND = 40n * 10n ** BigInt(TOKEN_A.decimals);
const ROUNDS = 4n;

/** The stack's TEST chain, read through the gate the way svc-protocol reads it. */
const chain = createPublicClient({ transport: http(GATE_URL) });
const erc20Abi = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
]);
const balanceOf = (token, who) => chain.readContract({ address: token.address, abi: erc20Abi, functionName: 'balanceOf', args: [who] });
const owner = () => privateKeyToAccount(dex.key()).address;

async function rpc(method, params = []) {
  const res = await fetch(GATE_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = await res.json();
  expect(body.error, `TEST chain ${method}`).toBeUndefined();
  return body.result;
}
/** Moves the TEST chain's clock forward `seconds` and mines a block, as time passing. */
async function passTime(seconds) {
  await rpc('evm_increaseTime', [Math.ceil(seconds)]);
  await rpc('evm_mine');
}
const chainNow = async () => Number((await chain.getBlock()).timestamp);

/** TEST Token B sent to the wallet since `fromBlock`, from the chain: [{ hash, value }]. */
async function receivedB(fromBlock) {
  const logs = await chain.getLogs({
    address: TOKEN_B.address,
    event: erc20Abi[1],
    args: { to: owner() },
    fromBlock,
  });
  return logs.map((log) => ({ hash: log.transactionHash, value: log.args.value }));
}

const room = (page) => page.getByRole('main');
const form = (page) => page.getByRole('form', { name: 'New recurring buy' });
const plans = (page) =>
  room(page)
    .getByRole('article')
    .filter({ has: page.getByTestId('order-hash') });
const planOf = (page, hash) => plans(page).filter({ has: page.getByTestId('order-hash').filter({ hasText: hash }) });
const roundRow = (plan, n) =>
  plan
    .getByRole('table', { name: 'Rounds' })
    .getByRole('row')
    .filter({ has: plan.page().getByRole('cell', { name: `Round ${n}`, exact: true }) });
const dueAt = async (row) => Date.parse((await row.locator('time').first().getAttribute('datetime')) ?? '') / 1000;
const txHashOf = async (row) =>
  /\/chain\/tx\/(0x[0-9a-f]{64})$/.exec((await row.getByRole('link', { name: 'Transaction' }).getAttribute('href')) ?? '')?.[1];

async function openRecurring(page) {
  // No token answers of the wallet's own: on the TEST chain every token read goes to the node.
  const wallet = await connectWallet(page, dex);
  await page.goto('/dex/orders');
  await room(page).getByRole('tab', { name: 'Recurring buy' }).click(UNBUILT);
  await expect(form(page)).toBeVisible(UNBUILT);
  return wallet;
}

/** The plan this run made in `step` (its order hash, kept in the run's state). */
function planHash(step) {
  const hash = base.run.read()[step];
  expect(hash, `the plan made in ${step}`).toMatch(/^0x[0-9a-f]{64}$/);
  return hash;
}

/**
 * Fills the form for 4 rounds of 40 TEST Token A into TEST Token B every hour (with a price band when given), starts it
 * and goes through the wallet's prompts. Returns the new plan's order hash, after checking that the person signed a
 * session and that exactly 160 TEST Token A left the wallet for the vault.
 */
async function startPlan(page, wallet, { band } = {}) {
  const before = new Set(await plans(page).getByTestId('order-hash').allInnerTexts());
  const aBefore = await balanceOf(TOKEN_A, owner());
  await form(page).getByRole('combobox', { name: 'Spend' }).selectOption({ label: 'TEST Token A' }, UNBUILT);
  await form(page).getByRole('combobox', { name: 'Buy' }).selectOption({ label: 'TEST Token B' });
  await form(page)
    .getByRole('textbox', { name: /^Amount each round/ })
    .fill('40');
  await form(page)
    .getByRole('textbox', { name: /^Rounds/ })
    .fill('4');
  await form(page).getByRole('combobox', { name: 'Every' }).selectOption({ label: 'Hour' });
  if (band) {
    await form(page)
      .getByRole('textbox', { name: /^Lowest price/ })
      .fill(band[0]);
    await form(page)
      .getByRole('textbox', { name: /^Highest price/ })
      .fill(band[1]);
  }
  await form(page).getByRole('button', { name: 'Start recurring buy' }).click();
  // The wallet's prompts, however many the start takes (the representation once per wallet, the session, the deposit).
  const representation = page.locator('[data-panel="representation"]');
  const prompt = page.locator('[data-sheet]').getByRole('button', { name: 'Continue in wallet' });
  const fresh = plans(page).getByTestId('order-hash');
  for (let i = 0; i < 6; i++) {
    const hashes = await fresh.allInnerTexts();
    if (hashes.some((h) => !before.has(h))) break;
    await expect(representation.or(prompt).or(fresh.last()).first()).toBeVisible({ timeout: 60_000 });
    if (await representation.isVisible()) await acceptRepresentation(page);
    else if (await prompt.first().isVisible()) await prompt.first().click();
    else await page.waitForTimeout(1_000);
  }
  const made = (await plans(page).getByTestId('order-hash').allInnerTexts()).filter((h) => !before.has(h));
  expect(made, 'one new plan on the page').toHaveLength(1);
  const [hash] = made;
  expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
  // The rounds will swap under a session the person signed here.
  expect(wallet.requests.filter((r) => r.method === 'eth_signTypedData_v4').length, 'the person signed the session').toBeGreaterThan(0);
  // TEST tokens deposited to the order vault: exactly 4 x 40 TEST Token A left the wallet.
  await expect.poll(async () => aBefore - (await balanceOf(TOKEN_A, owner())), { timeout: 60_000 }).toBe(ROUNDS * ROUND);
  return hash;
}

test(`${J} starts: a connected TEST wallet holding TEST Token A, with TEST Token B to choose as the target`, async ({ page }) => {
  dex.start();
  await openRecurring(page);
  expect(await balanceOf(TOKEN_A, owner())).toBeGreaterThanOrEqual(2n * ROUNDS * ROUND);
  await expect(form(page).getByRole('combobox', { name: 'Buy' }).getByRole('option', { name: 'TEST Token B' })).toHaveCount(1);
});

test(`${J} #1 creates a 4-round recurring buy of 40 TEST every hour: round 1 fills at the start and its output lands in the wallet`, async ({
  page,
}) => {
  const wallet = await openRecurring(page);
  const fromBlock = await chain.getBlockNumber();
  const bBefore = await balanceOf(TOKEN_B, owner());
  const hash = await startPlan(page, wallet);
  base.run.write({ plan: hash });
  const plan = planOf(page, hash);
  for (const n of [1, 2, 3, 4]) await expect(roundRow(plan, n)).toHaveCount(1);
  await expect(roundRow(plan, 5)).toHaveCount(0);
  // Round 1 fills at the start: no time passes on the chain.
  await expect(roundRow(plan, 1)).toContainText('Filled', { timeout: 60_000 });
  for (const n of [2, 3, 4]) await expect(roundRow(plan, n)).toContainText('Scheduled');
  const [r1, r2] = [await dueAt(roundRow(plan, 1)), await dueAt(roundRow(plan, 2))];
  expect(r2 - r1, 'one round every hour').toBe(HOUR);
  // The output landed in the wallet itself: one TEST Token B transfer to the wallet, in round 1's own transaction.
  const got = await receivedB(fromBlock);
  expect(got, 'one TEST Token B transfer to the wallet').toHaveLength(1);
  expect(got[0].hash).toBe(await txHashOf(roundRow(plan, 1)));
  expect(got[0].value).toBeGreaterThan(0n);
  expect(await balanceOf(TOKEN_B, owner())).toBe(bBefore + got[0].value);
  base.run.write({ round1Due: r1 });
});

test(`${J} #2 sets a price band and the price is outside it: the round waits, the log says outside the band; after the retry window it moves to the next interval`, async ({
  page,
}) => {
  const wallet = await openRecurring(page);
  // A band wholly above today's price, so the price is outside it.
  const price = Number.parseFloat(
    ((await form(page).getByTestId('current-price').innerText(UNBUILT)).match(/\d[\d,]*(?:\.\d+)?/) ?? [''])[0].replaceAll(',', ''),
  );
  expect(price, 'the pair has a price').toBeGreaterThan(0);
  const band = [(price * 2).toPrecision(6), (price * 3).toPrecision(6)];
  const fromBlock = await chain.getBlockNumber();
  const hash = await startPlan(page, wallet, { band });
  base.run.write({ banded: hash });
  const plan = planOf(page, hash);
  const log = plan.getByRole('list', { name: 'Round log' });
  // The round waits, and the log says why.
  await expect(roundRow(plan, 1)).toContainText('Waiting', { timeout: 60_000 });
  await expect(
    log
      .getByRole('listitem')
      .filter({ hasText: /Round 1/ })
      .filter({ hasText: /outside (?:the|your) (?:price )?band/i }),
  ).not.toHaveCount(0);
  const due1 = await dueAt(roundRow(plan, 1));
  // The retry window the plan shows.
  const retry = /(\d+)\s*(second|minute|hour)s?/i.exec(await plan.getByTestId('retry-window').innerText());
  expect(retry, 'the plan shows its retry window').toBeTruthy();
  const windowSeconds = Number(retry[1]) * { second: 1, minute: 60, hour: HOUR }[retry[2].toLowerCase()];
  // Inside the window the round still waits.
  await passTime(due1 + windowSeconds / 2 - (await chainNow()));
  await page.waitForTimeout(15_000);
  await expect(roundRow(plan, 1)).toContainText('Waiting');
  // At the end of the window it moves to the next interval: no swap, and the next round is an hour after round 1.
  await passTime(due1 + windowSeconds + 1 - (await chainNow()));
  await expect(
    log
      .getByRole('listitem')
      .filter({ hasText: /Round 1/ })
      .filter({ hasText: /next interval/i }),
  ).not.toHaveCount(0, {
    timeout: 60_000,
  });
  await expect(roundRow(plan, 1)).not.toContainText('Waiting');
  await expect(roundRow(plan, 1)).not.toContainText('Filled');
  expect(Date.parse((await plan.getByTestId('next-fill').locator('time').getAttribute('datetime')) ?? '') / 1000).toBe(due1 + HOUR);
  expect(await receivedB(fromBlock), 'nothing swapped outside the band').toHaveLength(0);
});

test(`${J} #3 reopens the page after a round was sent but not recorded: the next tick reads the chain by the stored hash and records it; not sent twice`, async ({
  page,
}) => {
  const wallet = await openRecurring(page);
  const plan = planOf(page, planHash('plan'));
  await expect(roundRow(plan, 2)).toContainText('Scheduled');
  const asked = { requests: wallet.requests.length, sends: wallet.sends.length };
  const fromBlock = await chain.getBlockNumber();
  // The keeper sends round 2 and loses its record (LOCAL TEST fault), then round 2's time comes.
  tool('local-test-gates.mjs', 'dca-drop-record');
  await passTime((await dueAt(roundRow(plan, 2))) + 1 - (await chainNow()));
  await expect.poll(async () => (await receivedB(fromBlock)).length, { timeout: 90_000, message: 'round 2 was sent on the chain' }).toBe(1);
  await expect(roundRow(plan, 2)).not.toContainText('Filled');
  // The person reopens the page; the next tick finds round 2 on the chain by its stored hash and records it.
  await page.reload();
  const again = planOf(page, planHash('plan'));
  await expect(roundRow(again, 2)).toContainText('Filled', { timeout: 90_000 });
  const [sent] = await receivedB(fromBlock);
  expect(await txHashOf(roundRow(again, 2)), 'recorded from the transaction that was sent').toBe(sent.hash);
  await expect(
    again
      .getByRole('list', { name: 'Round log' })
      .getByRole('listitem')
      .filter({ hasText: /Round 2/ })
      .filter({ hasText: /recorded from the chain/i }),
  ).not.toHaveCount(0);
  // Not sent twice: after more ticks, still one round 2 on the chain.
  await page.waitForTimeout(20_000);
  expect(await receivedB(fromBlock), 'round 2 reached the wallet once').toHaveLength(1);
  // The round swapped under the session signed at the start: the wallet was asked for nothing.
  expect({ requests: wallet.requests.length, sends: wallet.sends.length }).toEqual(asked);
});

test(`${J} #4 opens progress after two rounds: "2 of 4", 50 percent and the next fill time`, async ({ page }) => {
  await openRecurring(page);
  const plan = planOf(page, planHash('plan'));
  const progress = plan.getByRole('progressbar', { name: 'Rounds done' });
  await expect(progress).toHaveAttribute('aria-valuenow', '50', UNBUILT);
  await expect(plan).toContainText('2 of 4');
  await expect(plan).toContainText(/\b50\s?%/);
  // The next fill is round 3, two hours after round 1.
  const next = plan.getByTestId('next-fill');
  await expect(next).toBeVisible();
  const at = Date.parse((await next.locator('time').getAttribute('datetime')) ?? '') / 1000;
  expect(at).toBe(await dueAt(roundRow(plan, 3)));
  expect(at).toBe(base.run.read().round1Due + 2 * HOUR);
});

test(`${J} #5 tries to pause or edit the plan: the refusal says a plan cannot be edited; cancel and recreate`, async ({ page }) => {
  await openRecurring(page);
  const plan = planOf(page, planHash('plan'));
  for (const action of ['Edit plan', 'Pause plan']) {
    await plan.getByRole('button', { name: action }).click(UNBUILT);
    const refusal = plan.getByRole('alert');
    await expect(refusal).toContainText(/cannot be (?:paused or )?edited/i);
    await expect(refusal).toContainText(/cancel/i);
    await expect(refusal).toContainText(/create a new one|recreate/i);
  }
  // Nothing about the plan changed.
  await expect(plan).toContainText('2 of 4');
  for (const n of [3, 4]) await expect(roundRow(plan, n)).toContainText('Scheduled');
});

test(`${J} #6 cancels with two rounds left: the refund equals the unfilled remainder exactly`, async ({ page }) => {
  await openRecurring(page);
  const plan = planOf(page, planHash('plan'));
  await expect(plan).toContainText('2 of 4', UNBUILT);
  const aBefore = await balanceOf(TOKEN_A, owner());
  await plan.getByRole('button', { name: 'Cancel recurring buy' }).click();
  await page.getByRole('dialog', { name: 'Cancel recurring buy' }).getByRole('button', { name: 'Cancel and refund' }).click();
  await page.locator('[data-sheet]').getByRole('button', { name: 'Continue in wallet' }).click();
  // The unfilled remainder is the two rounds left: 2 x 40 TEST Token A, back in the wallet to the unit.
  const remainder = 2n * ROUND;
  await expect.poll(async () => (await balanceOf(TOKEN_A, owner())) - aBefore, { timeout: 60_000 }).toBe(remainder);
  await expect(plan.getByRole('status')).toContainText(/Cancelled/);
  await expect(plan.getByRole('status')).toContainText(/\b80 TEST Token A\b/);
  for (const n of [3, 4]) await expect(roundRow(plan, n)).not.toContainText('Scheduled');
  // Nothing more leaves the vault for this plan: an hour later the wallet holds exactly the same.
  await passTime(HOUR + 1);
  await page.waitForTimeout(15_000);
  expect(await balanceOf(TOKEN_A, owner())).toBe(aBefore + remainder);
});

test(`${J} #7 turns on idle-deposit yield before the lending contract is published: the toggle is disabled and names the owner decision and the contract blocker`, async ({
  page,
}) => {
  await openRecurring(page);
  const toggle = form(page).getByRole('switch', { name: 'Earn on idle deposits' });
  await expect(toggle).toBeDisabled(UNBUILT);
  await toggle.click({ force: true });
  await expect(toggle).not.toBeChecked();
  await expect(toggle).toHaveAccessibleDescription(/owner\.decision/);
  await expect(toggle).toHaveAccessibleDescription(/lending contract/i);
});
