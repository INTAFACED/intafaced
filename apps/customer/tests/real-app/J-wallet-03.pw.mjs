import { test, expect } from '@playwright/test';
import { ADMIN, founderSignIn } from './admin.mjs';
import { api, journeyState, tool, toUnits } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';

// J-wallet-03, in the running app (docs/roadmap/journeys.json): my deposit is held and then released. One test per step,
// titled "J-wallet-03 #<n>". The stack's chain is in memory: a TEST transfer reaches svc-pay's own chain webhook signed
// with the stack's secret (local-test-stack.mjs chain-deposit), and the TEST chain takes it back the same way, as a watcher
// reports a reorg (local-test-stack.mjs chain-reorg). Every balance is read back from the ledger through the person's own
// API. Compliance freezes and lifts a deposit address on the founder console, with the stack's two TEST founders (#4).
// Not here yet: #1-#3 (the travel-rule declaration and its review need the owner's threshold and the counterparty
// exchange).
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
  return (await page.getByTestId('deposit-address').locator('strong.numeric').innerText()).trim();
}

/** A founder's console on the customer's Money tab, with the row of `address` open. Returns that row's detail. */
async function openAddressRow(page, userId, address) {
  await page.goto(`${ADMIN}/accounts/${userId}?tab=money`, { waitUntil: 'load' });
  const list = page.getByTestId('read-money.deposit-addresses');
  await expect(list.getByRole('table')).toBeVisible({ timeout: 60_000 });
  await list.locator('tbody > tr', { hasText: address }).getByRole('button', { name: 'Open' }).click();
  return list.getByTestId('row-detail');
}

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
  const address = (await page.getByTestId('deposit-address').locator('strong.numeric').innerText()).trim();
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
