import { test, expect } from '@playwright/test';
import { ADMIN, founderSignIn } from './admin.mjs';
import { api, journeyState, tool, toUnits } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';

// J-wallet-03, in the running app (docs/roadmap/journeys.json): my deposit is held and then released. One test per step,
// titled "J-wallet-03 #<n>". The stack's chain is in memory: a TEST transfer reaches svc-pay's own chain webhook signed
// with the stack's secret (local-test-stack.mjs chain-deposit), and the TEST chain takes it back the same way, as a watcher
// reports a reorg (local-test-stack.mjs chain-reorg). Every balance is read back from the ledger through the person's own
// API. Compliance freezes and lifts a deposit address on the founder console, with the stack's two TEST founders (#4).
// #1-#3 use the stack's TEST inbound travel rule (local-test-gates.mjs TEST_DEPOSIT_TRAVEL_RULE: 1000 or more is held for the
// sender's name and address) and its TEST 60-second wait on the sending platform. The stack publishes a rule for every TEST
// coin, so the blank-rule refusal of #1 (no rule: not credited, reason travel_rule_unset) is proven in svc-pay's
// travel-rule.db.test.ts, not here: unsetting a coin's rule would stop every other journey's deposits on a shared stack.
const J = 'J-wallet-03';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const ASSET = 'USDT';
const NETWORK = 'TEST Ethereum';

test.describe.configure({ mode: 'default' });

/** One TEST chain delivery of `amount`, `confirmations` deep, as transfer `label` to `address`. Returns its transaction hash. */
function chainDeposit(address, amount, confirmations, label) {
  const out = tool('local-test-stack.mjs', 'chain-deposit', address, ASSET, amount, String(confirmations), '--tx', label);
  expect(out).toContain('"received":true');
  const tx = /^\s*tx\s+(0x[0-9a-f]{64}):\d+/m.exec(out)?.[1];
  expect(tx, out).toBeTruthy();
  return tx;
}

/** The TEST chain takes transfer `label` to `address` back, as a watcher reports a reorg. */
function chainReorg(address, label) {
  const out = tool('local-test-stack.mjs', 'chain-reorg', address, '--tx', label);
  expect(out).toContain('TEST chain reorg delivered');
  return out;
}

/** The person's own clients: the ledger's available USDT, and their bank API. */
async function clients(who) {
  const client = await api(who);
  return {
    usdt: async () => toUnits((await client.balances())[ASSET]?.free ?? '0'),
    async bank(procedure, input) {
      const { status, body } = await client.post(`/api/bank/trpc/${procedure}`, input);
      expect(status, JSON.stringify(body).slice(0, 300)).toBe(200);
      return body.result.data;
    },
    async spaces() {
      const { status, body } = await client.get(`/api/bank/trpc/spaces.list?input=${encodeURIComponent(JSON.stringify({ limit: 50 }))}`);
      expect(status).toBe(200);
      return body.result.data;
    },
  };
}

const assetPicker = (page) => page.getByRole('combobox', { name: /^Asset Coins you hold/ });
const records = (page) => page.locator('section', { has: page.getByRole('heading', { name: 'Deposit records' }) });
const recordRow = (page, tx) => records(page).locator('tbody tr', { hasText: tx });

async function openDeposit(page) {
  await page.goto('/uc/recharge');
  // A pointer left on the top bar keeps its hover menu open over the page; move it off, as a person would.
  await page.mouse.move(0, 600);
}

/** The person opens Deposit for TEST USDT on TEST Ethereum and reads their address. */
async function showAddress(page) {
  await openDeposit(page);
  await assetPicker(page).selectOption(ASSET);
  await page.getByRole('combobox', { name: 'Network', exact: true }).selectOption({ label: NETWORK });
  await page.getByRole('checkbox', { name: `I will send only ${ASSET} on ${NETWORK}.` }).check();
  await page.getByRole('button', { name: 'Show my deposit address' }).click();
  return (await page.getByTestId('deposit-address').locator('strong[data-testid="numeric"]').innerText()).trim();
}

/** A founder's console on the customer's Money tab, with the row of `address` open. Returns that row's detail. */
async function openAddressRow(page, userId, address) {
  await page.goto(`${ADMIN}/accounts/${userId}?tab=money`, { waitUntil: 'load' });
  const list = page.getByTestId('read-money.deposit-addresses');
  await expect(list.getByRole('table')).toBeVisible({ timeout: 60_000 });
  await list.locator('tbody > tr', { hasText: address }).getByRole('button', { name: 'Open' }).click();
  return list.getByTestId('row-detail');
}

const LARGE = '2500';
const travelRule = (page, tx) =>
  records(page)
    .locator('tbody tr', { has: page.getByTestId('deposit-travel-rule') })
    .filter({
      has: page.locator(`xpath=preceding-sibling::tr[1][contains(., "${tx}")]`),
    });

/** A new verified person with a TEST 2500 USDT deposit at full depth, held for the travel rule. */
async function heldDeposit(page, prefix, testInfo) {
  const who = await signUp(page, prefix);
  await verify(page, who);
  await signIn(page, who);
  const address = await showAddress(page);
  const mine = await clients(who);
  const { userId } = await api(who);
  const label = `${prefix}-${who.handle}-${LARGE}-r${testInfo.retry}`;
  const tx = chainDeposit(address, LARGE, 6, label);
  await page.reload();
  await expect(recordRow(page, tx).locator('[data-status]')).toHaveAttribute('data-status', 'held_travel_rule');
  return { who, address, mine, userId, label, tx };
}

/** The person declares where the deposit came from: an exchange, with the sender's name and address. */
async function declare(page, tx) {
  const panel = travelRule(page, tx).getByTestId('deposit-travel-rule');
  const form = panel.getByTestId('deposit-travel-rule-form');
  await form.getByRole('radio', { name: 'An exchange or other crypto platform' }).check();
  await form.getByLabel('Sender’s full name').fill('TEST Sender Person');
  await form.getByLabel('Sender’s address').fill('1 TEST Street, Testville');
  await form.getByRole('button', { name: 'Send declaration' }).click();
  await expect(panel).toHaveAttribute('data-state', 'under_review', { timeout: 30_000 });
  return panel;
}

/** A founder's console on the customer's Money tab, with their one travel-rule hold open. Returns that row's detail. */
async function openTravelRuleRow(page, userId) {
  await page.goto(`${ADMIN}/accounts/${userId}?tab=money`, { waitUntil: 'load' });
  const list = page.getByTestId('read-money.deposit-travel-rule');
  await expect(list.getByRole('table')).toBeVisible({ timeout: 60_000 });
  await list.locator('tbody > tr', { hasText: ASSET }).first().getByRole('button', { name: 'Open' }).click();
  return list.getByTestId('row-detail');
}

test(`${J} #1 a large inbound deposit is held for the travel rule with the declaration form, and is not credited`, async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const { mine, tx, address, label } = await heldDeposit(page, 'w3t', testInfo);
  const row = recordRow(page, tx);
  await expect(row).toContainText('Held: travel rule');
  await expect(row).toContainText('Deposits this large need a short declaration about where they came from');
  const panel = travelRule(page, tx).getByTestId('deposit-travel-rule');
  await expect(panel).toHaveAttribute('data-state', 'awaiting_declaration');
  await expect(panel).toContainText('This deposit of 2,500 USDT is at or above the 1,000 USDT limit');
  const form = panel.getByTestId('deposit-travel-rule-form');
  await expect(form.getByLabel('Sender’s full name')).toBeVisible();
  await expect(form.getByLabel('Sender’s address')).toBeVisible();
  // A half-filled declaration is not sent.
  await form.getByLabel('Sender’s full name').fill('TEST Sender Person');
  await form.getByRole('button', { name: 'Send declaration' }).click();
  await expect(form.getByRole('alert')).toContainText('Fill in every field before sending.');
  await expect(panel).toHaveAttribute('data-state', 'awaiting_declaration');
  // Deeper on the chain, it is still held and nothing is credited.
  chainDeposit(address, LARGE, 12, label);
  await page.reload();
  await expect(recordRow(page, tx).locator('[data-status]')).toHaveAttribute('data-status', 'held_travel_rule');
  expect(await mine.usdt()).toBe(0n);
});

test(`${J} #2 the person declares it, it is under review; after compliance releases it, one credit and the balance moves once`, async ({
  page,
  browser,
}, testInfo) => {
  test.setTimeout(300_000);
  const { mine, tx, address, label, userId, who } = await heldDeposit(page, 'w3r', testInfo);
  await declare(page, tx);
  await expect(travelRule(page, tx)).toContainText('Declared. Compliance is reviewing it');
  await page.reload();
  await expect(recordRow(page, tx)).toContainText('We have your declaration and compliance is reviewing it');
  expect(await mine.usdt()).toBe(0n);

  const a = await (await browser.newContext()).newPage();
  try {
    await founderSignIn(a, 'a');
    const detail = await openTravelRuleRow(a, userId);
    await expect(detail).toContainText('under_review');
    // The declared values are sealed in svc-pay: the console never shows them.
    await expect(detail).not.toContainText('TEST Sender Person');
    const review = detail.getByTestId('deposit-travel-rule-review');
    await review.getByLabel(/^Why/).fill(`LOCAL TEST declaration checked for ${who.handle}`);
    await review.getByRole('button', { name: 'Release and credit once' }).click();
    await expect(detail.getByTestId('deposit-travel-rule-reply')).toContainText('credited it once', { timeout: 60_000 });
  } finally {
    await a.context().close();
  }
  expect(await mine.usdt()).toBe(toUnits(LARGE));
  await page.reload();
  await expect(recordRow(page, tx).locator('[data-status]')).toHaveAttribute('data-status', 'credited');
  // Seen again deeper on the chain, nothing more moves.
  chainDeposit(address, LARGE, 12, label);
  expect(await mine.usdt()).toBe(toUnits(LARGE));
});

test(`${J} #3 a wait on the sending platform runs past its deadline: still held, never released on its own`, async ({
  page,
  browser,
}, testInfo) => {
  test.setTimeout(300_000);
  const { mine, tx, address, label, userId, who } = await heldDeposit(page, 'w3c', testInfo);
  await declare(page, tx);
  const a = await (await browser.newContext()).newPage();
  try {
    await founderSignIn(a, 'a');
    const detail = await openTravelRuleRow(a, userId);
    const review = detail.getByTestId('deposit-travel-rule-review');
    await review.getByLabel(/^Why/).fill(`LOCAL TEST asked the sending platform about ${who.handle}`);
    await review.getByRole('button', { name: 'Wait on the sending platform' }).click();
    await expect(detail.getByTestId('deposit-travel-rule-reply')).toContainText('waiting on the sending platform until', {
      timeout: 60_000,
    });
  } finally {
    await a.context().close();
  }
  await page.reload();
  const panel = travelRule(page, tx).getByTestId('deposit-travel-rule');
  await expect(panel).toHaveAttribute('data-state', 'counterparty_pending');
  await expect(panel).toContainText('Compliance is waiting for the sending platform until');
  await expect(recordRow(page, tx)).toContainText('Compliance is waiting for the sending platform to confirm the transfer');

  // The TEST wait is 60 seconds; svc-pay records it ran out within half a minute after. The deposit stays held.
  await expect(async () => {
    await page.reload();
    await expect(travelRule(page, tx).getByTestId('deposit-travel-rule')).toHaveAttribute('data-state', 'blocking_time_expired', {
      timeout: 5_000,
    });
  }).toPass({ timeout: 180_000, intervals: [10_000] });
  await expect(recordRow(page, tx).locator('[data-status]')).toHaveAttribute('data-status', 'held_travel_rule');
  await expect(recordRow(page, tx)).toContainText('The sending platform did not answer in time. The deposit stays held');
  await expect(travelRule(page, tx)).toContainText('The wait for the sending platform has ended');
  chainDeposit(address, LARGE, 12, label);
  await page.reload();
  await expect(recordRow(page, tx).locator('[data-status]')).toHaveAttribute('data-status', 'held_travel_rule');
  expect(await mine.usdt()).toBe(0n);
});

test(`${J} #4 compliance freezes the deposit address: the confirming deposit shows on hold and is not credited; after a second person unfreezes it, one credit`, async ({
  page,
  browser,
}, testInfo) => {
  test.setTimeout(300_000);
  const who = await signUp(page, 'w3f');
  await verify(page, who);
  await signIn(page, who);
  const address = await showAddress(page);
  const mine = await clients(who);
  const { userId } = await api(who);
  const label = `jw03f-${who.handle}-30-r${testInfo.retry}`;

  // TEST 30 USDT is on its way: 2 of 6 confirmations.
  const tx = chainDeposit(address, '30', 2, label);
  await page.reload();
  await expect(recordRow(page, tx).locator('[data-status]')).toHaveAttribute('data-status', 'confirming');

  // Founder A freezes the address with a reason: the deposit goes on hold at once.
  const a = await (await browser.newContext()).newPage();
  const b = await (await browser.newContext()).newPage();
  const founderA = await founderSignIn(a, 'a');
  const founderB = await founderSignIn(b, 'b');
  try {
    let detail = await openAddressRow(a, userId, address);
    const freeze = detail.getByTestId('deposit-address-freeze');
    await freeze.getByLabel(/^Why/).fill(`LOCAL TEST compliance review of the source ${who.handle}`);
    await freeze.getByRole('button', { name: 'Freeze this address' }).click();
    await expect(detail.getByTestId('deposit-address-freeze-reply')).toContainText(
      '1 deposit on the way to it is on hold and not credited',
      {
        timeout: 60_000,
      },
    );

    // The chain reaches full depth: still on hold, in words, and nothing is credited.
    chainDeposit(address, '30', 6, label);
    await page.reload();
    await expect(recordRow(page, tx).locator('[data-status]')).toHaveAttribute('data-status', 'on_hold');
    await expect(recordRow(page, tx)).toContainText('On hold');
    await expect(recordRow(page, tx)).toContainText('This deposit address is on hold for a compliance review');
    expect(await mine.usdt()).toBe(0n);

    // Founder A asks to lift it. Alone, A cannot approve, and a run before anyone approved changes nothing.
    detail = await openAddressRow(a, userId, address);
    await expect(detail).toContainText('Deposits on hold');
    const deskA = detail.getByTestId('control-desk');
    const phrase = `UNFREEZE ADDRESS ${address.slice(0, 10)}`;
    await deskA.getByLabel(/^Why/).fill(`LOCAL TEST source cleared by compliance ${who.handle}`);
    await deskA.getByLabel(/to confirm$/).fill(phrase);
    await deskA.getByRole('button', { name: 'Ask a second founder to approve lifting the freeze' }).click();
    await expect(deskA.getByTestId('packet-made')).toBeVisible({ timeout: 60_000 });
    const packet = (await deskA.getByLabel('Request packet').inputValue()).trim();
    await deskA.getByLabel(/to approve or run it$/).fill(phrase);
    await expect(deskA.getByRole('button', { name: 'Approve this request' })).toBeDisabled();
    await deskA.getByRole('button', { name: 'Run the approved request' }).click();
    await expect(deskA.getByTestId('step-reply')).toHaveAttribute('data-tone', /danger|warn/, { timeout: 60_000 });
    expect(await mine.usdt()).toBe(0n);

    // Founder B, on their own console, reads the same request and approves it.
    const detailB = await openAddressRow(b, userId, address);
    const deskB = detailB.getByTestId('control-desk');
    await deskB.getByLabel('Request packet').fill(packet);
    await expect(deskB.getByTestId('packet-summary')).toContainText(`Lift the compliance freeze on deposit address ${address}`);
    await deskB.getByLabel(/to approve or run it$/).fill(phrase);
    await deskB.getByRole('button', { name: 'Approve this request' }).click();
    await expect(deskB.getByTestId('step-reply')).toContainText('Approved.', { timeout: 60_000 });

    // A runs it: the held deposit is credited once, and the balance moves by 30 once.
    await deskA.getByLabel(/to approve or run it$/).fill(phrase);
    await deskA.getByRole('button', { name: 'Run the approved request' }).click();
    await expect(deskA.getByTestId('step-reply')).toContainText('1 held deposit was credited once', { timeout: 60_000 });
    expect(await mine.usdt()).toBe(toUnits('30'));
    await page.reload();
    await expect(recordRow(page, tx).locator('[data-status]')).toHaveAttribute('data-status', 'credited');

    // The history names who froze, who lifted and who approved; the spent approval lifts nothing again.
    await a.goto(`${ADMIN}/accounts/${userId}?tab=money`, { waitUntil: 'load' });
    const history = a.getByTestId('read-money.deposit-freezes').locator('tbody > tr', { hasText: address });
    await expect(history).toHaveCount(1, { timeout: 60_000 });
    await expect(history).toContainText(founderA.userId.slice(0, 8));
    await expect(history).toContainText(founderB.userId.slice(0, 8));
    chainDeposit(address, '30', 9, label);
    expect(await mine.usdt()).toBe(toUnits('30'));
  } finally {
    await a.context().close();
    await b.context().close();
  }
});

test(`${J} #5 a credited deposit the chain takes back is reversed once and the balance drops by the amount once; if it was already spent, it is sent to review and the balance never goes below zero`, async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const who = await signUp(page, 'w3');
  await verify(page, who);
  run.write({ account: who });
  await signIn(page, who);
  await openDeposit(page);
  await assetPicker(page).selectOption(ASSET);
  await page.getByRole('combobox', { name: 'Network', exact: true }).selectOption({ label: NETWORK });
  await page.getByRole('checkbox', { name: `I will send only ${ASSET} on ${NETWORK}.` }).check();
  await page.getByRole('button', { name: 'Show my deposit address' }).click();
  const address = (await page.getByTestId('deposit-address').locator('strong[data-testid="numeric"]').innerText()).trim();
  const mine = await clients(who);
  expect(await mine.usdt()).toBe(0n);

  // TEST 100 USDT credits at its published depth.
  const first = `jw03-${who.handle}-100-r${testInfo.retry}`;
  const tx = chainDeposit(address, '100', 6, first);
  await page.reload();
  await expect(recordRow(page, tx).locator('[data-status]')).toHaveAttribute('data-status', 'credited');
  expect(await mine.usdt()).toBe(toUnits('100'));

  // The chain rewrites the block: reversed with the reason in words, and the balance drops by exactly 100. Reported again,
  // nothing more moves.
  chainReorg(address, first);
  await page.reload();
  await expect(recordRow(page, tx).locator('[data-status]')).toHaveAttribute('data-status', 'reversed');
  await expect(recordRow(page, tx)).toContainText('Reversed');
  await expect(recordRow(page, tx)).toContainText('The network rewrote the block this deposit was in');
  expect(await mine.usdt()).toBe(0n);
  chainReorg(address, first);
  expect(await mine.usdt()).toBe(0n);

  // TEST 50 credits, then 40 of it moves into a space of the person's own, so the main balance holds 10.
  const second = `jw03-${who.handle}-50-r${testInfo.retry}`;
  const spentTx = chainDeposit(address, '50', 6, second);
  expect(await mine.usdt()).toBe(toUnits('50'));
  await mine.bank('spaces.create', { assetId: ASSET, name: `Spent TEST ${testInfo.retry}` });
  const spaces = await mine.spaces();
  const main = spaces.find((s) => s.kind === 'primary' && s.assetId === ASSET);
  const space = spaces.find((s) => s.kind === 'named' && s.name === `Spent TEST ${testInfo.retry}`);
  await mine.bank('transfers.create', { transferId: `jw03-spend-${space.id}`, fromSpaceId: main.id, toSpaceId: space.id, amount: '40' });
  expect(await mine.usdt()).toBe(toUnits('10'));

  // The chain takes the 50 back: the 10 left cannot cover it, so nothing moves and the deposit goes to review, in words.
  chainReorg(address, second);
  await page.reload();
  await expect(recordRow(page, spentTx).locator('[data-status]')).toHaveAttribute('data-status', 'needs_review');
  await expect(recordRow(page, spentTx)).toContainText('the funds are already spent, so support is reviewing it');
  expect(await mine.usdt()).toBe(toUnits('10'));
  // The first reversal is untouched.
  await expect(recordRow(page, tx).locator('[data-status]')).toHaveAttribute('data-status', 'reversed');
});
