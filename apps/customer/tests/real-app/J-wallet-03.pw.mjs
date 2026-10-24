import { test, expect } from '@playwright/test';
import { api, journeyState, tool, toUnits } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';

// J-wallet-03, in the running app (docs/roadmap/journeys.json): my deposit is held and then released. One test per step,
// titled "J-wallet-03 #<n>". The stack's chain is in memory: a TEST transfer reaches svc-pay's own chain webhook signed
// with the stack's secret (local-test-stack.mjs chain-deposit), and the TEST chain takes it back the same way, as a watcher
// reports a reorg (local-test-stack.mjs chain-reorg). Every balance is read back from the ledger through the person's own
// API.
// Not here yet: #1-#3 (the travel-rule declaration and its review need the owner's threshold and the counterparty
// exchange) and #4 (freezing a deposit address).
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
