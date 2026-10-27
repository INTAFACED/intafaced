import { test, expect } from '@playwright/test';
import { api, journeyState, tool, toUnits } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';
import { draftNotice, publishNotice } from './notices.mjs';
import { TEST_UNSUPPORTED_DEPOSIT } from '../../../../tooling/scripts/local-test-gates.mjs';

// J-wallet-02, in the running app (docs/roadmap/journeys.json): I deposit crypto and watch it arrive.
// One test per step, titled "J-wallet-02 #<n>", run in order on one verified TEST account. The stack publishes TEST
// deposit terms for USDT and USDC on TEST Ethereum and TEST Base (minimum 10, 6 confirmations; local-test-gates.mjs
// deposit-terms), its chain is in memory, and a TEST transfer reaches svc-pay's own chain webhook signed with the stack's
// secret (local-test-stack.mjs chain-deposit), as the chain watcher would deliver it. Every credit is read back from the
// ledger through the customer's own API.
// #2 reads the TEST unsupported-case list the stack publishes for USDC on TEST Ethereum (TEST_UNSUPPORTED_DEPOSIT), the
// switched-off network (the stack keeps TEST USDC on TEST Base off), an unpublished asset and an unverified person.
// #7 reads the inbox: svc-pay announces the credit (intafaced.pay.deposit_credit.posted) and svc-notify files it once.
// #4 makes labelled extra addresses up to the stack's TEST cap of 3 open (BANK_DEPOSIT_ADDRESS_CAP), lets them expire with
// the LOCAL TEST tool (local-test-stack.mjs expire-deposit-addresses) and sends to an expired one: held for release.
// #8 has the founders publish a TEST funding incident for USDT on TEST Ethereum (four-eyes, as the notice desk does) and
// moves it on a stage: Deposit shows it, with its stage and dates, on that pair only. It closes the incident at the end.
// #1 restarts the bank with no custody port (LOCAL_STACK_BANK_DEPOSIT_CUSTODY=off, as a deployment with custody unset runs),
// reads the whole room and its refusal, and restarts it connected again before #3, whatever happened (an afterEach hook
// covers a step that times out).
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

/**
 * The bank restarted with no deposit custody port, or back on the stack's svc-pay. "Off" is written to its own state file
 * before the restart, so a run cancelled while custody is off is put back by the next run's first hook, and cleared only
 * once the bank is connected again.
 */
const custody = journeyState(`${J}-custody`);
function bankDepositCustody(on) {
  const before = process.env.LOCAL_STACK_BANK_DEPOSIT_CUSTODY;
  if (on) delete process.env.LOCAL_STACK_BANK_DEPOSIT_CUSTODY;
  else process.env.LOCAL_STACK_BANK_DEPOSIT_CUSTODY = 'off';
  if (!on) custody.write({ off: true });
  try {
    tool('local-test-stack.mjs', 'restart', 'bank');
    if (on) custody.reset({});
  } finally {
    if (before === undefined) delete process.env.LOCAL_STACK_BANK_DEPOSIT_CUSTODY;
    else process.env.LOCAL_STACK_BANK_DEPOSIT_CUSTODY = before;
  }
}
const putCustodyBack = () => {
  if (custody.read().off) bankDepositCustody(true);
};
// A step that fails or times out never reaches its own end, so the hooks put custody back before the next step, and a run
// that was cancelled with custody off is put back before this one starts.
test.beforeAll(putCustodyBack);
test.afterEach(putCustodyBack);

test(`${J} #1 opens Deposit with custody unset: the whole room, every control, and a typed refusal naming the blocker`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  const who = await signUp(page, 'w2u');
  await verify(page, who);
  bankDepositCustody(false);
  // The bank's own answer names the blocker on the room's catalogue, incoming and records reads.
  const client = await api(who);
  const reads = { 'deposits.assets': undefined, 'deposits.pending': undefined, 'deposits.list': { offset: 0, limit: 20 } };
  for (const [route, input] of Object.entries(reads)) {
    const query = input === undefined ? '' : `?input=${encodeURIComponent(JSON.stringify(input))}`;
    const { status, body } = await client.get(`/api/bank/trpc/${route}${query}`);
    expect(status, route).toBe(412);
    expect(JSON.stringify(body), route).toContain('bank.deposit_custody_unset');
  }

  await openDeposit(page, who);
  // The room is there with every control: asset, network, address, terms, incoming and records. Nothing says "coming soon".
  // With no custody there is no deposit catalogue, so the asset chooser lists only the coins the app knows of.
  await expect(assetPicker(page)).toBeVisible();
  await expect(assetPicker(page).locator('option:not([value=""])')).not.toHaveCount(0);
  // The network chooser's reason is part of its name while it has nothing to offer.
  const network = page.getByRole('combobox', { name: /^Network/ });
  await expect(network).toBeVisible();
  await expect(network).toBeDisabled();
  await expect(network.locator('option')).toHaveText(['No networks available']);
  await expect(page.getByText('The list of networks for an asset needs crypto custody, which isn’t connected.')).toBeVisible();
  await expect(page.getByText('Deposit addresses are not available', { exact: true })).toBeVisible();
  await expect(
    page.getByText(
      'Crypto custody isn’t connected, so no deposit address is issued. Please do not send anything to an address from elsewhere.',
    ),
  ).toBeVisible();
  await expect(page.getByTestId('deposit-address')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Show my deposit address' })).toHaveCount(0);
  for (const fact of ['Minimum deposit', 'Confirmations needed', 'Time to arrive'])
    await expect(page.getByText(fact, { exact: true })).toBeVisible();
  await expect(page.getByText('Not published', { exact: true })).toHaveCount(3);
  await expect(page.getByRole('heading', { name: 'On its way' })).toBeVisible();
  await expect(page.getByText('Incoming deposits cannot be shown because crypto custody isn’t connected.')).toBeVisible();
  await expect(records(page)).toBeVisible();
  await expect(page.getByText('Deposit records cannot be shown because crypto custody isn’t connected.')).toBeVisible();
  await expect(page.getByText(/coming soon/i)).toHaveCount(0);
  bankDepositCustody(true);
  // Connected again, the same person's catalogue answers, so #3 starts from a connected stack.
  const { status } = await (await api(who)).get('/api/bank/trpc/deposits.assets');
  expect(status).toBe(200);
});

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
  const address = (await issued.locator('strong[data-testid="numeric"]').innerText()).trim();
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
  await expect(page.getByTestId('deposit-address').locator('strong[data-testid="numeric"]')).toHaveText(address);
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
  const notice = page.getByTestId('nf-row').filter({ hasText: 'Deposit credited' });
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

test(`${J} #4 creates another address and labels it: a list with labels and expiry, the cap refused with the cap shown, and a deposit to an expired address held for release`, async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const { account: who } = state();
  const usdt = await ledger(who);
  const before = await usdt();
  async function showAddresses(signedIn = false) {
    if (signedIn) {
      // Already signed in: back to the room, as a person would, rather than a second sign-in.
      await page.goto('/uc/recharge');
      await page.mouse.move(0, 600);
    } else await openDeposit(page, who);
    await assetPicker(page).selectOption(ASSET);
    await page.getByRole('combobox', { name: 'Network', exact: true }).selectOption({ label: NETWORK });
    await page.getByRole('checkbox', { name: `I will send only ${ASSET} on ${NETWORK}.` }).check();
    await page.getByRole('button', { name: 'Show my deposit address' }).click();
    return page.getByTestId('deposit-addresses');
  }
  const row = (list, n) => list.locator(`li[data-address-index="${n}"]`);

  let list = await showAddresses();
  await expect(list.getByRole('heading', { name: `Your addresses on ${NETWORK}` })).toBeVisible();
  await expect(row(list, 0)).toContainText('First address');
  await expect(row(list, 0)).toContainText('Does not expire');
  await expect(list.getByTestId('deposit-addresses-cap')).toContainText('Open addresses here: 1 of 3');
  await expect(list.getByTestId('deposit-addresses-cap')).toContainText('A new address lasts 30 days.');

  // Two more, the first with a name: each gets its own address and an expiry 30 days out.
  await list.getByLabel('Name for the new address (optional)').fill('Savings');
  await list.getByRole('button', { name: 'Add another address' }).click();
  await expect(list).toContainText('Address 1 is ready.');
  await expect(row(list, 1)).toContainText('Savings');
  await expect(row(list, 1)).toContainText('30 days left');
  await list.getByRole('button', { name: 'Add another address' }).click();
  await expect(list).toContainText('Address 2 is ready.');
  await expect(row(list, 2)).toContainText('Address 2');
  await expect(list.getByTestId('deposit-addresses-cap')).toContainText('Open addresses here: 3 of 3');
  const extra = (await row(list, 1).getByTestId('numeric').innerText()).trim();
  expect(extra).not.toBe(state().address);
  expect((await row(list, 2).getByTestId('numeric').innerText()).trim()).not.toBe(extra);

  // A fourth open address is past the TEST cap of 3: refused, with the cap named, and nothing is made.
  await list.getByRole('button', { name: 'Add another address' }).click();
  await expect(list.getByRole('alert')).toHaveText(
    'You already hold 3 open addresses here, the most allowed. One frees up when an address expires.',
  );
  await expect(list.locator('li[data-address-index]')).toHaveCount(3);

  // Name the second one.
  await row(list, 2).getByRole('button', { name: 'Rename' }).click();
  await row(list, 2).getByLabel('Name for Address 2').fill('Exchange payouts');
  await row(list, 2).getByRole('button', { name: 'Save name' }).click();
  await expect(row(list, 2).locator('strong')).toHaveText('Exchange payouts');

  // Both extra addresses expire (LOCAL TEST tool, in custody and in the list); they stay listed, and their places free up.
  const out = tool('local-test-stack.mjs', 'expire-deposit-addresses', who.email);
  expect(out).toContain('2 extra deposit address(es)');
  list = await showAddresses(true);
  await expect(row(list, 1)).toHaveAttribute('data-state', 'expired');
  await expect(row(list, 1)).toContainText('Money sent to it now is held for release.');
  await expect(row(list, 2)).toContainText('Exchange payouts');
  await expect(list.getByTestId('deposit-addresses-cap')).toContainText('Open addresses here: 1 of 3');

  // TEST 50 USDT sent to the expired address: recorded as held for release with its reason, and nothing is credited.
  const tx = chainDeposit(extra, '50', 6, `jw02-${who.handle}-expired-r${testInfo.retry}`);
  await page.reload();
  await expect(recordRow(page, tx).locator('[data-status]')).toHaveAttribute('data-status', 'held_for_release');
  await expect(recordRow(page, tx)).toContainText('Held for release');
  await expect(recordRow(page, tx)).toContainText('The funds are safe and wait for support to release them to you.');
  expect(await usdt()).toBe(before);
});

test(`${J} #8 a funding incident on this asset and network shows on Deposit with its stage and dates, and on no other pair`, async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const { account: who } = state();
  // Unique per attempt, so a retry drafts a new incident rather than replaying the last one's keys.
  const key = `${J}-8-${process.env.JOURNEY_RUN_ID ?? 'local'}-${Date.now()}-r${testInfo.retry}`;
  const title = `TEST ${ASSET} deposits delayed ${key}`;
  // A short window: if this run stops part way, the incident closes on its own within minutes.
  const entry = (n, fields) => draftNotice({ kind: 'incident', title, minutes: 5, key: `${key}-${n}`, ...fields });
  const incident = await publishNotice(
    await entry('root', {
      body: 'TEST deposits are slow to arrive; we are looking into it.',
      asset: ASSET,
      network: 'ethereum',
      phase: 'investigating',
    }),
    `${key}-root`,
  );
  expect(incident.asset).toBe(ASSET);
  expect(incident.network).toBe('ethereum');
  await publishNotice(
    await entry('update', { body: 'TEST cause found: a stuck TEST node. A fix is going out.', parentId: incident.id, phase: 'identified' }),
    `${key}-update`,
  );

  const network = page.getByRole('combobox', { name: 'Network', exact: true });
  const card = page.getByTestId(`funding-incident-${incident.id}`);
  // The banner says where its read stands, so "not shown" is checked against an answer, not a read still running. Another
  // run's notice may be open on a pair, so the answer is `none` or `open`, and this incident's own card is what must be absent.
  const answered = () => expect(page.getByTestId('funding-notices')).toHaveAttribute('data-state', /^(none|open)$/);
  await openDeposit(page, who);
  await assetPicker(page).selectOption(ASSET);
  await network.selectOption({ label: NETWORK });
  // Shown as soon as the pair is chosen, before any address is asked for.
  await expect(card).toHaveAttribute('role', 'alert');
  await expect(card).toContainText(`Incident on ${ASSET} on ${NETWORK}`);
  await expect(card.getByRole('heading', { name: title })).toBeVisible();
  await expect(card.getByTestId('funding-incident-stage')).toHaveText('Stage: Cause identified');
  await expect(card.getByTestId('funding-incident-dates')).toContainText(/^Started .+ · Last update .+$/);
  await expect(card).toContainText('TEST cause found: a stuck TEST node. A fix is going out.');

  // The same coin on another network, and another coin on this network: not shown.
  await network.selectOption({ label: 'TEST Base' });
  await expect(page.getByRole('checkbox', { name: `I will send only ${ASSET} on TEST Base.` })).toBeVisible();
  await answered();
  await expect(card).toHaveCount(0);
  await assetPicker(page).selectOption('USDC');
  await network.selectOption({ label: NETWORK });
  await expect(page.getByRole('checkbox', { name: `I will send only USDC on ${NETWORK}.` })).toBeVisible();
  await answered();
  await expect(card).toHaveCount(0);

  // Resolved, it leaves the deposit room.
  await publishNotice(
    await entry('resolved', {
      body: 'TEST deposits are arriving normally again.',
      parentId: incident.id,
      phase: 'resolved',
      resolves: true,
    }),
    `${key}-resolved`,
  );
  await page.reload();
  await page.mouse.move(0, 600);
  await assetPicker(page).selectOption(ASSET);
  await network.selectOption({ label: NETWORK });
  await expect(page.getByRole('checkbox', { name: `I will send only ${ASSET} on ${NETWORK}.` })).toBeVisible();
  await answered();
  await expect(card).toHaveCount(0);
});

test(`${J} #2 chooses asset and network: an unsupported-case list shows with its checkbox before any address; a switched-off network shows the owner's banner and no address; an unpublished asset says so; an unverified person is sent to Verification`, async ({
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
  // The other network of the same coin is untouched, and the owner published what it will not credit there: the list shows,
  // as written, with its checkbox, before any address.
  await network.selectOption({ label: 'TEST Ethereum' });
  await expect(page.getByTestId('deposit-halted')).toHaveCount(0);
  const notes = page.getByTestId('deposit-notes');
  await expect(notes.getByRole('heading', { name: 'Not supported on this network' })).toBeVisible();
  for (const item of TEST_UNSUPPORTED_DEPOSIT.cases) await expect(notes.getByRole('listitem').filter({ hasText: item })).toBeVisible();
  const ack = page.getByRole('checkbox', { name: 'I will send only USDC on TEST Ethereum. I have read the notes above.' });
  await expect(ack).not.toBeChecked();
  await expect(page.getByRole('button', { name: 'Show my deposit address' })).toBeDisabled();
  await expect(page.getByTestId('deposit-address')).toHaveCount(0);
  await ack.check();
  await expect(page.getByRole('button', { name: 'Show my deposit address' })).toBeEnabled();

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
