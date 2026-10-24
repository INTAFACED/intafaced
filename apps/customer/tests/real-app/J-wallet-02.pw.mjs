import { test, expect } from '@playwright/test';
import { api, journeyState, tool, toUnits } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';

// J-wallet-02, in the running app (docs/roadmap/journeys.json): I deposit crypto and watch it arrive.
// One test per step, titled "J-wallet-02 #<n>", run in order on one verified TEST account. The stack publishes TEST
// deposit terms for USDT and USDC on TEST Ethereum and TEST Base (minimum 10, 6 confirmations; local-test-gates.mjs
// deposit-terms), its chain is in memory, and a TEST transfer reaches svc-pay's own chain webhook signed with the stack's
// secret (local-test-stack.mjs chain-deposit), as the chain watcher would deliver it. Every credit is read back from the
// ledger through the customer's own API.
// "part of #2" covers the switched-off network (the stack keeps TEST USDC on TEST Base off), the unverified person and an
// unpublished asset; it counts as #2 once the unsupported-case lists are published too.
// #7 reads the inbox: svc-pay announces the credit (intafaced.pay.deposit_credit.posted) and svc-notify files it once.
// Not here yet: #1 (custody unset, while this stack has it connected), #2's unsupported-case lists, #4 (labelled extra
// addresses) and #8 (funding incident banners).
const J = 'J-wallet-02';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const ASSET = 'USDT';
const NETWORK = 'TEST Ethereum';

test.describe.configure({ mode: 'default' });

function state() {
  const now = run.read();
  if (!now.account || !now.address) throw new Error(`${J} #3 made no account or address, so this step has no one to act as`);
  return now;
}

/**
 * One TEST chain delivery of `amount` to `address`, `confirmations` deep, as transfer `label` (the same label to the same
 * address is the same transfer). Returns the transaction hash the tool printed, as the records table shows it.
 */
function chainDeposit(address, amount, confirmations, label) {
  const out = tool('local-test-stack.mjs', 'chain-deposit', address, ASSET, amount, String(confirmations), '--tx', label);
  expect(out).toContain('"received":true');
  const tx = /^\s*tx\s+(0x[0-9a-f]{64}):\d+/m.exec(out)?.[1];
  expect(tx, out).toBeTruthy();
  return tx;
}

/** The ledger's available USDT for `who`, through one signed-in client of their own. */
async function ledger(who) {
  const client = await api(who);
  return async () => toUnits((await client.balances())[ASSET]?.free ?? '0');
}

async function openDeposit(page, who) {
  await signIn(page, who);
  await page.goto('/uc/recharge');
  // A pointer left on the top bar keeps its hover menu open over the page; move it off, as a person would.
  await page.mouse.move(0, 600);
}

// The asset chooser (its hint is part of its name); the records filter below is also called Asset.
const assetPicker = (page) => page.getByRole('combobox', { name: /^Asset Coins you hold/ });
const records = (page) => page.locator('section', { has: page.getByRole('heading', { name: 'Deposit records' }) });
const recordRow = (page, tx) => records(page).locator('tbody tr', { hasText: tx });

test(`${J} #3 with custody connected, reads the address: no address until a network is chosen, then the address, its QR and the published terms`, async ({
  page,
}) => {
  test.setTimeout(120_000);
  run.reset({});
  const who = await signUp(page, 'w2');
  await verify(page, who);
  run.write({ account: who });
  await openDeposit(page, who);

  await assetPicker(page).selectOption(ASSET);
  const network = page.getByRole('combobox', { name: 'Network', exact: true });
  await expect(network.locator('option', { hasText: NETWORK })).toHaveCount(1);
  // No address, and nothing to confirm, before a network is chosen.
  await expect(page.getByText('Choose an asset and a network, then confirm below to see your address.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Show my deposit address' })).toHaveCount(0);
  await expect(page.getByTestId('deposit-address')).toHaveCount(0);

  await network.selectOption({ label: NETWORK });
  const show = page.getByRole('button', { name: 'Show my deposit address' });
  await expect(show).toBeDisabled();
  await page.getByRole('checkbox', { name: `I will send only ${ASSET} on ${NETWORK}.` }).check();
  await show.click();

  const issued = page.getByTestId('deposit-address');
  await expect(issued).toContainText(`Send only ${ASSET} on ${NETWORK} to this address.`);
  const address = (await issued.locator('strong.numeric').innerText()).trim();
  expect(address.length).toBeGreaterThan(8);
  await expect(issued.getByRole('button', { name: /copy/i })).toBeVisible();
  await expect(issued.getByTestId('pay-qr').getByRole('img')).toBeVisible();
  // TEST Ethereum needs no memo, so none is asked for.
  await expect(issued.getByText('Memo or tag (required)')).toHaveCount(0);
  await expect(page.getByText(`10 ${ASSET}`, { exact: true })).toBeVisible();
  await expect(page.getByText('About 15 minutes', { exact: true })).toBeVisible();
  run.write({ address });

  // Asked again, the same address comes back: one per asset and network, never a new one per visit.
  await page.reload();
  await page.mouse.move(0, 600);
  await assetPicker(page).selectOption(ASSET);
  await page.getByRole('combobox', { name: 'Network', exact: true }).selectOption({ label: NETWORK });
  await page.getByRole('checkbox', { name: `I will send only ${ASSET} on ${NETWORK}.` }).check();
  await page.getByRole('button', { name: 'Show my deposit address' }).click();
  await expect(page.getByTestId('deposit-address').locator('strong.numeric')).toHaveText(address);
});

test(`${J} #5 sends TEST 100 ${ASSET} on the TEST chain: detected, then confirming with a count, then credited; below the minimum nothing posts`, async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const { account: who, address } = state();
  // A retry is a new transfer, so it starts from detected again; #6 repeats the one this attempt credits.
  const label = `jw02-${who.handle}-100-r${testInfo.retry}`;
  const usdt = await ledger(who);
  const before = await usdt();
  await openDeposit(page, who);

  const tx = chainDeposit(address, '100', 0, label);
  await page.reload();
  const pending = page.locator('section', { has: page.getByRole('heading', { name: 'On its way' }) });
  await expect(recordRow(page, tx).locator('[data-status]')).toHaveAttribute('data-status', 'detected');
  await expect(pending).toContainText('0 of 6 confirmations');
  expect(await usdt()).toBe(before);

  chainDeposit(address, '100', 3, label);
  await page.reload();
  await expect(recordRow(page, tx).locator('[data-status]')).toHaveAttribute('data-status', 'confirming');
  await expect(recordRow(page, tx)).toContainText('3 of 6 confirmations');
  await expect(pending).toContainText('3 of 6 confirmations');
  expect(await usdt()).toBe(before);

  chainDeposit(address, '100', 6, label);
  await page.reload();
  await expect(recordRow(page, tx).locator('[data-status]')).toHaveAttribute('data-status', 'credited');
  await expect(pending).toContainText('Nothing is on its way.');
  expect(await usdt()).toBe(before + toUnits('100'));
  // Each attempt that credits is one more deposit, so one more inbox notice in #7.
  run.write({ credits: (run.read().credits ?? 0) + 1 });

  // Under the published minimum of 10: recorded as below minimum, with the reason, and nothing posts.
  const small = chainDeposit(address, '5', 6, `jw02-${who.handle}-5-r${testInfo.retry}`);
  await page.reload();
  await expect(recordRow(page, small).locator('[data-status]')).toHaveAttribute('data-status', 'below_minimum');
  expect(await usdt()).toBe(before + toUnits('100'));
  run.write({ credited: String(before + toUnits('100')), label, tx });
});

test(`${J} #6 the chain event is delivered three times: one row, one credit, and the balance equals the ledger`, async ({ page }) => {
  const { account: who, address, credited, label, tx } = state();
  if (!credited) throw new Error(`${J} #5 credited nothing, so there is no event to deliver again`);
  for (let i = 0; i < 3; i += 1) expect(chainDeposit(address, '100', 6, label)).toBe(tx);
  const usdt = await ledger(who);
  expect(String(await usdt())).toBe(credited);

  await openDeposit(page, who);
  await expect(recordRow(page, tx)).toHaveCount(1);
  await expect(recordRow(page, tx).locator('[data-status]')).toHaveAttribute('data-status', 'credited');
  // Your deposits (the ledger's own history, for the chosen asset) shows the credit once.
  await assetPicker(page).selectOption(ASSET);
  const history = page.locator('section', { has: page.getByRole('heading', { name: 'Your deposits' }) });
  await expect(history.locator('tbody tr')).toHaveCount(1);
  await expect(history.locator('tbody tr')).toContainText(`100 ${ASSET}`);
});

test(`${J} #7 the credit lands in the inbox once, however often the chain delivered it, and opens its deposit room`, async ({ page }) => {
  test.setTimeout(180_000);
  const { account: who, credited, credits } = state();
  if (!credited || !credits) throw new Error(`${J} #5 credited nothing, so there is no notice to read`);
  await signIn(page, who);
  const notice = page.locator('.nf-row', { hasText: 'Deposit credited' });
  // The notice is filed from the bus after the credit; read the inbox again until it is there. A credit whose
  // announcement missed the first pass goes out on svc-pay's next one (every 60 s), so wait longer than that.
  await expect(async () => {
    await page.goto('/notifications');
    await expect(notice).toHaveCount(credits, { timeout: 2_000 });
  }).toPass({ timeout: 150_000 });
  await expect(notice.first()).toContainText(`100 ${ASSET} is in your available balance.`);
  await notice.first().click();
  await expect(page).toHaveURL(/\/uc\/recharge\?asset=USDT&network=ethereum$/);
  await expect(assetPicker(page)).toHaveValue(ASSET);
});

test(`${J}, part of #2 a switched-off network shows the owner's banner and no address; an unverified person is sent to Verification; an unpublished asset says so`, async ({
  page,
}) => {
  test.setTimeout(120_000);
  const { account: who } = state();
  await openDeposit(page, who);
  await assetPicker(page).selectOption('USDC');
  const network = page.getByRole('combobox', { name: 'Network', exact: true });
  await network.selectOption({ label: 'TEST Base (switched off)' });
  const banner = page.getByTestId('deposit-halted');
  await expect(banner).toHaveAttribute('role', 'alert');
  await expect(banner).toContainText('Deposits of USDC on TEST Base are switched off');
  await expect(banner).toContainText('TEST: switched off on this test stack so the notice can be seen.');
  // Money already on its way to an address the person kept is not lost: svc-pay credits it once the pair is back on.
  await expect(banner).toContainText('it waits, and is credited after deposits are switched back on.');
  await expect(page.getByRole('button', { name: 'Show my deposit address' })).toHaveCount(0);
  await expect(page.getByTestId('deposit-address')).toHaveCount(0);
  // Asked directly, the bank issues nothing for it either.
  const client = await api(who);
  const asked = await client.post('/api/bank/trpc/deposits.address', { assetId: 'USDC', networkId: 'base' });
  expect(asked.status).toBe(412);
  expect(asked.body?.error?.data?.cause?.code ?? asked.body?.error?.data?.intafacedCode).toBe('bank.deposit_network_halted');
  // The other network of the same coin is untouched.
  await network.selectOption({ label: 'TEST Ethereum' });
  await expect(page.getByTestId('deposit-halted')).toHaveCount(0);
  await expect(page.getByRole('checkbox', { name: 'I will send only USDC on TEST Ethereum.' })).toBeVisible();

  // An asset custody does not publish, asked for by link: nothing is chosen and the page says why.
  await page.goto('/uc/recharge?asset=BTC');
  await expect(page.locator('[data-code="bank.deposit_asset_unpublished"]')).toContainText(
    'BTC is not an asset custody publishes for deposits, so nothing was chosen.',
  );

  // A person who has not finished verification: the room is whole, and its address panel sends them to Verification.
  await page.context().clearCookies();
  await signUp(page, 'w2u');
  await page.goto('/uc/recharge');
  await page.mouse.move(0, 600);
  const verify = page.getByTestId('deposit-verify');
  await expect(verify).toContainText('Verify your identity first');
  await expect(page.getByText('Crypto deposits open once your identity is verified.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Show my deposit address' })).toHaveCount(0);
  await verify.getByRole('link', { name: 'Verify now' }).click();
  await expect(page).toHaveURL(/\/verification$/);
});
