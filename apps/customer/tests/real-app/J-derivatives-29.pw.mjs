// World: book, restart
import { randomBytes } from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';
import { test, expect } from './journey.mjs';
import { fromUnits, journeyState, toUnits } from './stack.mjs';
import { pictureFromTop, signUp, verify } from './desk.mjs';
import { personDoor } from './person-door.mjs';
import { testWalletKey } from './test-wallet.mjs';
import {
  continueInWallet,
  openVenueDesk,
  openVenuePage,
  otherTraderKey,
  otherTraderRun,
  sameDecimal,
  testDeposit,
  testVenue,
  venueAccount,
  venueForThisFile,
  venueInfo,
  venueRecord,
} from './venue.mjs';
import { doorCalls, ledgerView } from './venue-door.mjs';
import { ownSpotMarket } from './own-market.mjs';

// J-derivatives-29, in the running app (docs/roadmap/journeys.json): my venue account's mode decides whether my spot and
// perps money is one balance or two. One test per step, titled "J-derivatives-29 #<n>", run in order on one TEST person,
// on this file's own TEST venue (`venueForThisFile`). The venue holds the balances; the mode is the venue's setting on
// the person's own account, read from the venue and changed only by their signed venue action; our ledger posts nothing.
//
// TEST setup in the journey's start (the "starts:" test): a verified TEST person with a TEST browser wallet whose venue
// account the TEST venue holds in standard mode (`/test/account-mode`, the simulator's TEST control), TEST 500 USDC
// in its perps balance and none in spot. The person buys on a TEST spot market of this file's own (ownSpotMarket), whose
// TEST coin stands in for the steps' TEST BTC, as J-cex-spot-08 does: a step that prices off a book owns that book
// (garden/no-shared-market-on-book). A TEST other trader rests its only ask, TEST 0.05 at TEST 20,000, so TEST 0.01
// costs 200 USDC. #7, #9, #10 and #11 use the simulator's TEST switches: a mode switch the venue refuses, the day's
// action count near and at the mode's limit, and the mode not reported. Every figure is compared with the venue's own
// record (`/account-mode`, `/balances`, `/fills`).
const J = 'J-derivatives-29';
const ASK = '20000';
const ASK_SIZE = '0.05';
const MAKER = 'jd29-maker';
const START_USDC = '500';
const BUY = '0.01';
const LIMIT = 50_000;
const REFUSAL = 'TEST: the venue takes no account mode change right now';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);

test.describe.configure({ mode: 'default' });
venueForThisFile(test);

const { state, door } = personDoor(J, run, test);

// ── the TEST venue's own record ──

const modeOf = async (owner) => (await venueRecord(owner, '/account-mode')).value;
const usdc = (rows) => rows?.find((b) => b.asset === 'USDC') ?? { free: '0', locked: '0', total: '0' };
const coin = (rows, base) => rows?.find((b) => b.asset === base) ?? { free: '0', locked: '0', total: '0' };
/** The simulator's TEST control for the account's mode, its day's action count and its two switches. */
async function setMode(owner, set) {
  const { status, body } = await testVenue('/test/account-mode', { account: await venueAccount(owner), ...set });
  expect(status, JSON.stringify(body)).toBe(200);
  expect(body.label).toBe('TEST');
  // The control answers the venue's own read of the mode after the change.
  return body.value;
}
/** The file's own TEST spot market: its symbol, its TEST coin (standing in for TEST BTC) and its desk. */
const market = () => {
  const { symbol, base } = state();
  if (!symbol) throw new Error(`${J} starts made no TEST market of its own, so this step has nowhere to buy`);
  return { symbol, base, desk: `/trade/spot/${symbol}` };
};
/** The page's next `n` reads of the account mode (it polls them): the window a resend or a retry would fall in. */
async function nextModeReads(page, n) {
  for (let i = 0; i < n; i++)
    await page.waitForResponse((r) => new URL(r.url()).pathname === '/api/v1/venue/account-mode', { timeout: 30_000 });
}
const signatures = (wallet) => wallet.requests.filter((r) => r.method === 'eth_signTypedData_v4').length;
const ledgerOf = async () => ledgerView(state().who);

// ── the room ──

const openAccount = async (page) => openVenuePage(page, state().who, '/trade/account', state().walletKey);
const panel = (page) => page.getByTestId('account-mode');
const modeLine = (page) => page.getByTestId('account-mode-line');
const cell = (page, table, asset, name) =>
  panel(page).getByTestId(`mode-${table}`).locator(`tr[data-asset="${asset}"] [data-cell="${name}"]`);

/** The spot or perps table equals the venue's own record, row for row, every figure exact. */
async function tablesEqualVenue(page, owner) {
  const venue = await modeOf(owner);
  for (const table of ['spot', 'perps']) {
    const rows = venue[table];
    await expect(panel(page).getByTestId(`mode-${table}`).locator('tr[data-asset]')).toHaveCount(rows.length, { timeout: 20_000 });
    for (const row of rows)
      for (const name of ['free', 'locked', 'total'])
        await expect
          .poll(async () => sameDecimal(await cell(page, table, row.asset, name).getAttribute('data-value'), row[name]))
          .toBe(true);
  }
}

/** A buy ticket of `amount` of the TEST coin at `price` on the desk, typed; returns the form and the venue's preview answer. */
async function typeBuy(page, price, amount) {
  await page.locator('[role=tab]', { hasText: /^Limit$/ }).click();
  const form = page.locator('form[data-testid="dk-form"][data-side="buy"]');
  await form.getByRole('textbox', { name: 'Price', exact: true }).fill(price);
  const answer = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/v1/venue/preview' && r.request().method() === 'POST');
  await form.getByRole('textbox', { name: 'Amount', exact: true }).fill(amount);
  const preview = await answer;
  expect(preview.status()).toBe(200);
  return { form, lock: (await preview.json()).value.lock };
}

test(`${J} starts: signed in, verified, a TEST wallet whose venue account the TEST venue holds in standard mode with TEST 500 USDC in perps and none in spot`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  const who = await signUp(page, 'jd29');
  await verify(page, who);
  const walletKey = testWalletKey();
  const owner = privateKeyToAccount(walletKey).address.toLowerCase();
  run.reset({ who, walletKey });
  // TEST: the venue holds the account in standard mode, then the TEST deposit lands in its perps balance.
  expect((await setMode(owner, { mode: 'standard' })).mode).toBe('standard');
  expect(await testDeposit(owner, 'USDC', START_USDC, `84532:0x${randomBytes(32).toString('hex')}:0`)).toBe(true);
  const venue = await modeOf(owner);
  expect(venue.mode).toBe('standard');
  expect(sameDecimal(usdc(venue.perps).total, START_USDC)).toBe(true);
  expect(venue.spot).toEqual([]);
  // TEST: a spot market of this file's own, and a TEST other trader's one ask on it, 0.05 at 20,000.
  const { symbol, base } = await ownSpotMarket(J, 'JDM', 'A');
  const maker = otherTraderKey(`${MAKER}-${base}`).address.toLowerCase();
  expect(await testDeposit(maker, base, '1', `84532:0x${randomBytes(32).toString('hex')}:0`)).toBe(true);
  const rest = await otherTraderRun(`${MAKER}-${base}`, {
    kind: 'place_order',
    symbol,
    side: 'sell',
    type: 'limit',
    amount: ASK_SIZE,
    price: ASK,
    timeInForce: 'GTC',
    reduceOnly: false,
    clientOrderKey: `order:${maker}:${base.toLowerCase()}:ask`,
    builderFee: null,
  });
  expect(rest).toMatchObject({ definite: true, accepted: true });
  run.write({ symbol, base, ledger: await ledgerView(who) });
});

test(`${J} #1 opens /trade/account: the account mode as the venue reports it, standard, with what it means; each balance as the venue reports it with an as-of time; a mode the venue doesn't report reads "not known"`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  const { owner } = state();
  await openAccount(page);
  const { displayName } = await venueInfo();
  await expect(modeLine(page)).toHaveText('Account mode: standard', { timeout: 30_000 });
  await expect(modeLine(page)).toHaveAttribute('data-value', (await modeOf(owner)).mode);
  await expect(page.getByTestId('account-mode-meaning')).toHaveText(
    'Standard keeps separate spot and perps balances: a spot buy pays from spot, and USDC moves between them only by your own signed transfer.',
  );
  await expect(panel(page)).toContainText(`From ${displayName}`);
  // Each balance as the venue reports it: perps 500 USDC, spot nothing; with the venue's as-of time.
  await tablesEqualVenue(page, owner);
  await expect(panel(page).getByTestId('mode-spot')).toContainText('Nothing here.');
  const asOf = await panel(page).locator('[data-as-of]').first().getAttribute('data-as-of');
  expect(Number.isNaN(Date.parse(asOf ?? ''))).toBe(false);

  // While the venue does not report the mode, it reads "not known", never a guess.
  await setMode(owner, { unreported: true });
  try {
    expect((await modeOf(owner)).mode).toBeNull();
    await expect(modeLine(page)).toHaveText('Account mode: not known', { timeout: 30_000 });
    await expect(panel(page)).not.toContainText('Account mode: standard');
  } finally {
    await setMode(owner, { unreported: false });
  }
  await expect(modeLine(page)).toHaveText('Account mode: standard', { timeout: 30_000 });
  expect(await ledgerOf()).toEqual(state().ledger);
});

test(`${J} #2 in standard mode, with all the USDC in perps, opens a spot buy of TEST 0.01 BTC: spot holds too little USDC, and one signed move of the amount needed from perps to spot is offered; nothing is bought until it lands`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  const { owner, who, walletKey } = state();
  const wallet = await openVenueDesk(page, who, market().desk, walletKey);
  const calls = doorCalls(page);
  const asked = signatures(wallet);
  const before = await modeOf(owner);
  const { form, lock } = await typeBuy(page, ASK, BUY);
  expect(lock.asset).toBe('USDC');
  const offer = form.getByTestId('spot-short');
  await expect(offer).toHaveAttribute('data-state', 'offer', { timeout: 20_000 });
  // The amount needed is what the buy locks less what spot holds free, both the venue's figures.
  const needed = fromUnits(toUnits(lock.amount) - toUnits(usdc(before.spot).free));
  await expect.poll(async () => sameDecimal((await offer.getAttribute('data-needed')) ?? '-1', needed)).toBe(true);
  await expect(offer).toContainText(`Spot holds ${usdc(before.spot).free} USDC, too little for this buy’s ${lock.amount} USDC.`);
  await expect(offer).toContainText('Nothing is bought until it lands.');
  await expect(offer.getByTestId('spot-short-move')).toHaveText(`Sign the move of ${await offer.getAttribute('data-needed')} USDC`);
  // Nothing is bought: the buy can't be reviewed, nothing was prepared or signed, and the venue holds none of the coin for them.
  await expect(page.getByRole('button', { name: `Buy ${market().base}`, exact: true })).toBeDisabled();
  await page.getByRole('button', { name: `Buy ${market().base}`, exact: true }).click({ force: true });
  expect(calls.of('prepare')).toHaveLength(0);
  expect(signatures(wallet)).toBe(asked);
  expect(await modeOf(owner)).toMatchObject({ spot: before.spot, perps: before.perps });
  expect((await venueRecord(owner, '/fills', { since: new Date(0).toISOString() })).value).toEqual([]);
});

/**
 * #3's page, kept open for #4: the same move is sent again from the page that sent it, as the person would press it
 * there. #4 alone has no page to send it from, and says so.
 */
let movePage = null;
let moveWallet = null;

test(`${J} #3 signs the move: the venue moves the USDC once; perps falls and spot rises by the venue's figures`, async ({ browser }) => {
  test.setTimeout(240_000);
  const { owner, who, walletKey } = state();
  const page = await browser.newPage();
  movePage = page;
  const wallet = await openVenueDesk(page, who, market().desk, walletKey);
  moveWallet = wallet;
  const calls = doorCalls(page);
  const before = await modeOf(owner);
  const { form } = await typeBuy(page, ASK, BUY);
  const offer = form.getByTestId('spot-short');
  await expect(offer).toHaveAttribute('data-state', 'offer', { timeout: 20_000 });
  const needed = await offer.getAttribute('data-needed');
  const asked = signatures(wallet);
  await offer.getByTestId('spot-short-move').click();
  await continueInWallet(page);
  await expect(offer).toHaveAttribute('data-state', 'landed', { timeout: 20_000 });
  // One signature, one prepare and one submit: one signed venue transfer of exactly the amount needed.
  expect(signatures(wallet)).toBe(asked + 1);
  expect(calls.of('prepare')).toHaveLength(1);
  expect(calls.of('submit')).toHaveLength(1);
  const intent = calls.of('prepare')[0].body.intent;
  expect(intent).toMatchObject({ kind: 'spot_perps_transfer', direction: 'perps_to_spot', asset: 'USDC' });
  expect(sameDecimal(intent.amount, needed)).toBe(true);
  // The venue's figures: perps down by the amount, spot up by it, once.
  const after = await modeOf(owner);
  expect(toUnits(usdc(before.perps).free) - toUnits(usdc(after.perps).free)).toBe(toUnits(needed));
  expect(toUnits(usdc(after.spot).free) - toUnits(usdc(before.spot).free)).toBe(toUnits(needed));
  expect(after.actions.usedToday).toBe(before.actions.usedToday + 1);
  await expect(offer.getByTestId('spot-short-landed')).toHaveText(
    `Moved: perps ${usdc(before.perps).free} → ${usdc(after.perps).free} USDC, spot ${usdc(before.spot).free} → ${usdc(after.spot).free} USDC, as ${(await venueInfo()).displayName} reports them.`,
  );
  // Nothing was bought by the move; the buy can be reviewed now that spot covers it.
  expect(sameDecimal(coin(after.spot, market().base).total, '0')).toBe(true);
  await expect(page.getByRole('button', { name: `Buy ${market().base}`, exact: true })).toBeEnabled({ timeout: 20_000 });
  run.write({ moved: { needed, after } });
  expect(await ledgerOf()).toEqual(state().ledger);
});

test(`${J} #4 sends the same move again: nothing moves; the first move's result is shown`, async () => {
  test.setTimeout(180_000);
  const { owner, moved } = state();
  const page = movePage;
  if (!page || page.isClosed()) throw new Error(`${J} #3 left no page that sent the move, so this step has nothing to send again`);
  try {
    const calls = doorCalls(page);
    const asked = signatures(moveWallet);
    const before = await modeOf(owner);
    expect(before).toEqual(moved.after);
    const offer = page.locator('form[data-testid="dk-form"][data-side="buy"]').getByTestId('spot-short');
    await expect(offer).toHaveAttribute('data-state', 'landed');
    const firstResult = await offer.getByTestId('spot-short-landed').innerText();
    await offer.getByTestId('spot-short-again-send').click();
    await expect(offer.getByTestId('spot-short-again')).toHaveText('Already sent: nothing more moved. This is the first move’s result.', {
      timeout: 20_000,
    });
    // The first move's result stays shown, word for word.
    await expect(offer.getByTestId('spot-short-landed')).toHaveText(firstResult);
    // The door answered the stored move: one prepare under #3's key, no new signature, nothing submitted.
    expect(calls.of('prepare')).toHaveLength(1);
    expect(calls.of('submit')).toHaveLength(0);
    expect(signatures(moveWallet)).toBe(asked);
    // Nothing moved at the venue, and the venue received no new action.
    await nextModeReads(page, 2);
    expect(await modeOf(owner)).toEqual(before);
  } finally {
    await page.close();
    movePage = null;
    moveWallet = null;
  }
});

test(`${J} #5 signs the buy: it fills from spot, by the venue's figures`, async ({ page }) => {
  test.setTimeout(240_000);
  const { owner, who, walletKey } = state();
  const wallet = await openVenueDesk(page, who, market().desk, walletKey);
  const before = await modeOf(owner);
  const since = new Date(Date.now() - 1_000).toISOString();
  await typeBuy(page, ASK, BUY);
  await page.getByRole('button', { name: `Buy ${market().base}`, exact: true }).click();
  const asked = signatures(wallet);
  await page.getByRole('button', { name: 'Confirm buy', exact: true }).click();
  await continueInWallet(page);
  await expect(page.getByTestId('venue-bottom').getByTestId('venue-outcome')).toContainText('Filled on the venue.', { timeout: 20_000 });
  expect(signatures(wallet)).toBe(asked + 1);
  // The venue's own fills and figures: spot USDC down by the cost, spot coin up by 0.01 less the fee the venue took in it;
  // perps untouched.
  const fills = (await venueRecord(owner, '/fills', { since })).value.filter((f) => f.symbol === market().symbol);
  expect(fills.reduce((n, f) => n + toUnits(f.amount), 0n)).toBe(toUnits(BUY));
  const cost = fills.reduce((n, f) => n + (toUnits(f.amount) * toUnits(f.price)) / toUnits('1'), 0n);
  const feeIn = (asset) =>
    fills.filter((f) => f.feeAsset === asset).reduce((n, f) => n + toUnits(f.venueFee) + toUnits(f.builderFee ?? '0'), 0n);
  const after = await modeOf(owner);
  expect(toUnits(usdc(before.spot).total) - toUnits(usdc(after.spot).total)).toBe(cost + feeIn('USDC'));
  expect(toUnits(coin(after.spot, market().base).total) - toUnits(coin(before.spot, market().base).total)).toBe(
    toUnits(BUY) - feeIn(market().base),
  );
  expect(after.perps).toEqual(before.perps);
  // The trading account's spot table shows the venue's figures.
  await page.goto('/trade/account');
  await expect(modeLine(page)).toHaveText('Account mode: standard', { timeout: 30_000 });
  await tablesEqualVenue(page, owner);
  expect(await ledgerOf()).toEqual(state().ledger);
});

test(`${J} #6 asks to move more USDC from spot to perps than spot holds: refused naming the venue's spot figure; nothing signed`, async ({
  page,
}) => {
  test.setTimeout(180_000);
  const { owner } = state();
  const wallet = await openAccount(page);
  const calls = doorCalls(page);
  const asked = signatures(wallet);
  const before = await modeOf(owner);
  const spotFree = usdc(before.spot).free;
  const more = fromUnits(toUnits(spotFree) + toUnits('1'));
  await expect(modeLine(page)).toHaveText('Account mode: standard', { timeout: 30_000 });
  const move = page.getByTestId('mode-move');
  await move.getByTestId('mode-move-direction').selectOption('spot_to_perps');
  await move.getByTestId('mode-move-amount').fill(more);
  await move.getByTestId('mode-move-review').click();
  await expect(move.getByTestId('mode-move-refused')).toHaveText(
    `${(await venueInfo()).displayName} reports ${spotFree} USDC free in spot; ${more} is more than that. Nothing was signed.`,
  );
  await expect(move.getByTestId('mode-move-sign')).toHaveCount(0);
  expect(calls.of('prepare')).toHaveLength(0);
  expect(signatures(wallet)).toBe(asked);
  expect(await modeOf(owner)).toEqual(before);
});

test(`${J} #7 asks to switch the account to unified mode while the venue refuses the switch, and signs: the venue's reason is shown and the mode reads standard, unchanged`, async ({
  page,
}) => {
  test.setTimeout(180_000);
  const { owner } = state();
  const wallet = await openAccount(page);
  const calls = doorCalls(page);
  await expect(modeLine(page)).toHaveText('Account mode: standard', { timeout: 30_000 });
  // TEST: the venue refuses the next mode switch, in its own words.
  await setMode(owner, { refuseSwitch: REFUSAL });
  try {
    const before = await modeOf(owner);
    const asked = signatures(wallet);
    const sw = page.getByTestId('mode-switch');
    await sw.getByTestId('mode-switch-unified').click();
    await expect(sw.getByTestId('mode-switch-review')).toContainText('switch this account');
    await sw.getByTestId('mode-switch-sign').click();
    await continueInWallet(page);
    const result = sw.getByTestId('mode-switch-result');
    await expect(result).toHaveText(
      `${(await venueInfo()).displayName} refused the switch: ${REFUSAL}. The account stays in standard mode.`,
      {
        timeout: 20_000,
      },
    );
    await expect(result).toHaveAttribute('data-accepted', 'false');
    // The person's own signature, once; the venue refused it, and the mode is unchanged.
    expect(signatures(wallet)).toBe(asked + 1);
    expect(calls.of('submit')).toHaveLength(1);
    expect(calls.of('prepare')[0].body.intent).toMatchObject({ kind: 'set_account_mode', mode: 'unified' });
    const after = await modeOf(owner);
    expect(after.mode).toBe('standard');
    expect({ spot: after.spot, perps: after.perps }).toEqual({ spot: before.spot, perps: before.perps });
    await expect(modeLine(page)).toHaveText('Account mode: standard');
  } finally {
    await setMode(owner, { refuseSwitch: null });
  }
});

test(`${J} #8 switches the account to unified mode and signs: one signed venue action; the account then reads unified, with one USDC balance used by spot and perps, from the venue`, async ({
  page,
  stepPicture,
}) => {
  test.setTimeout(180_000);
  const { owner } = state();
  const wallet = await openAccount(page);
  const calls = doorCalls(page);
  const before = await modeOf(owner);
  await expect(modeLine(page)).toHaveText('Account mode: standard', { timeout: 30_000 });
  const asked = signatures(wallet);
  const sw = page.getByTestId('mode-switch');
  await sw.getByTestId('mode-switch-unified').click();
  await sw.getByTestId('mode-switch-sign').click();
  await continueInWallet(page);
  await expect(sw.getByTestId('mode-switch-result')).toHaveText(
    `${(await venueInfo()).displayName} now holds this account in unified mode.`,
    {
      timeout: 20_000,
    },
  );
  expect(signatures(wallet)).toBe(asked + 1);
  expect(calls.of('prepare')).toHaveLength(1);
  expect(calls.of('submit')).toHaveLength(1);
  // From the venue: unified, no spot or perps apart, one USDC balance that is what spot and perps held together.
  const after = await modeOf(owner);
  expect(after).toMatchObject({ mode: 'unified', spot: null, perps: null, actions: { dailyLimit: LIMIT } });
  const one = usdc((await venueRecord(owner, '/balances')).value);
  expect(toUnits(one.total)).toBe(toUnits(usdc(before.spot).total) + toUnits(usdc(before.perps).total));
  await expect(modeLine(page)).toHaveText('Account mode: unified', { timeout: 30_000 });
  await expect(page.getByTestId('account-mode-meaning')).toHaveText(
    'Unified holds one balance for each asset, used by spot and perps alike.',
  );
  const oneBalance = page.getByTestId('mode-one-balance');
  await expect
    .poll(async () => sameDecimal((await oneBalance.getAttribute('data-value')) || '-1', one.total), { timeout: 20_000 })
    .toBe(true);
  await expect(oneBalance).toContainText('One USDC balance, used by spot and perps');
  await expect(panel(page).getByTestId('mode-spot')).toHaveCount(0);
  expect(await ledgerOf()).toEqual(state().ledger);
  await pictureFromTop(page, stepPicture);
});

test(`${J} #9 in unified mode, with the venue reporting the day's actions near the mode's limit, opens the order ticket: a warning names the venue's daily action limit, what it reports used today, and that standard mode has no such limit`, async ({
  page,
}) => {
  test.setTimeout(180_000);
  const { owner, who, walletKey } = state();
  // TEST: the venue reports 49,990 of the day's 50,000 actions used.
  await setMode(owner, { actionsToday: 49_990 });
  const reported = (await modeOf(owner)).actions;
  expect(reported).toEqual({ usedToday: 49_990, dailyLimit: LIMIT });
  await openVenueDesk(page, who, market().desk, walletKey);
  const warning = page.getByTestId('action-limit-warning');
  await expect(warning).toHaveText(
    `${(await venueInfo()).displayName} allows 50,000 actions a day in unified mode and reports 49,990 used today. Past the limit it takes no more orders until the day resets. Standard mode has no such limit.`,
    { timeout: 30_000 },
  );
  await expect(warning).toHaveAttribute('data-used', String(reported.usedToday));
  await expect(warning).toHaveAttribute('data-limit', String(reported.dailyLimit));
});

test(`${J} #10 with the venue refusing orders for the daily action limit, signs an order: the venue's reason is shown and the order is sent once, never retried`, async ({
  page,
}) => {
  test.setTimeout(180_000);
  const { owner, who, walletKey } = state();
  // TEST: every one of the day's 50,000 actions used: the venue refuses the next order for the limit.
  await setMode(owner, { actionsToday: LIMIT });
  const wallet = await openVenueDesk(page, who, market().desk, walletKey);
  const calls = doorCalls(page);
  const open = (await venueRecord(owner, '/open-orders')).value;
  // A small TEST limit buy under the one ask, so it would rest if the venue took it.
  const price = '16000';
  await typeBuy(page, price, '0.001');
  await page.getByRole('button', { name: `Buy ${market().base}`, exact: true }).click();
  const asked = signatures(wallet);
  await page.getByRole('button', { name: 'Confirm buy', exact: true }).click();
  await continueInWallet(page);
  const outcome = page.getByTestId('venue-bottom').getByTestId('venue-outcome');
  await expect(outcome).toContainText(
    'The venue refused it: the account has used its 50,000 actions for today in unified mode; the venue takes no more orders until the day resets (standard mode has no such limit)',
    { timeout: 20_000 },
  );
  // Sent once: one signature, one submit, and the venue counted exactly one more action; never retried after.
  expect(signatures(wallet)).toBe(asked + 1);
  expect(calls.of('submit')).toHaveLength(1);
  expect((await modeOf(owner)).actions.usedToday).toBe(LIMIT + 1);
  // Never retried: through the page's next three reads of the account mode, no second submit and no second action.
  await nextModeReads(page, 3);
  expect(calls.of('submit')).toHaveLength(1);
  expect((await modeOf(owner)).actions.usedToday).toBe(LIMIT + 1);
  expect((await venueRecord(owner, '/open-orders')).value).toEqual(open);
  // TEST: the day resets for the steps after this one.
  await setMode(owner, { actionsToday: 0 });
});

test(`${J} #11 opens /trade/account while the venue does not report the mode: "Account mode: not known" with the venue named; a spot buy from perps money, a move between spot and perps and a mode switch are each refused naming the unknown mode; nothing is signed or sent`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  const { owner } = state();
  const { displayName } = await venueInfo();
  await setMode(owner, { unreported: true });
  try {
    expect((await modeOf(owner)).mode).toBeNull();
    const wallet = await openAccount(page);
    const calls = doorCalls(page);
    const asked = signatures(wallet);
    const balancesBefore = (await venueRecord(owner, '/balances')).value;
    await expect(modeLine(page)).toHaveText('Account mode: not known', { timeout: 30_000 });
    await expect(page.getByTestId('account-mode-meaning')).toContainText(
      `${displayName} doesn’t report which mode it holds this account in`,
    );
    // A move between spot and perps: refused naming the unknown mode.
    const move = page.getByTestId('mode-move');
    await move.getByTestId('mode-move-amount').fill('1');
    await move.getByTestId('mode-move-review').click();
    await expect(move.getByTestId('mode-move-refused')).toHaveText(
      `Account mode not known at ${displayName}, so a move between spot and perps is refused. Nothing was signed.`,
    );
    // A mode switch: refused naming the unknown mode.
    const sw = page.getByTestId('mode-switch');
    await sw.getByTestId('mode-switch-standard').click();
    await expect(sw.getByTestId('mode-switch-refused')).toHaveText(
      `Account mode not known at ${displayName}, so a mode switch is refused. Nothing was signed.`,
    );
    // A spot buy from perps money: refused on the ticket, naming the unknown mode.
    await page.goto(market().desk);
    await expect(page.getByTestId('venue-header')).toBeVisible({ timeout: 30_000 });
    const { form } = await typeBuy(page, ASK, '1');
    const offer = form.getByTestId('spot-short');
    await expect(offer).toHaveAttribute('data-state', 'mode-unknown', { timeout: 20_000 });
    await expect(offer).toHaveText(
      `Account mode not known at ${displayName}, so this buy can’t be paid from perps money. Nothing is signed or sent.`,
    );
    await expect(offer.getByTestId('spot-short-move')).toHaveCount(0);
    // Nothing signed or sent from the page.
    expect(calls.of('prepare')).toHaveLength(0);
    expect(calls.of('submit')).toHaveLength(0);
    expect(signatures(wallet)).toBe(asked);
    // Our door refuses both mode actions itself too, naming the unknown mode, before anything is signed.
    const d = await door();
    for (const intent of [
      {
        kind: 'spot_perps_transfer',
        direction: 'perps_to_spot',
        asset: 'USDC',
        amount: '1',
        moveKey: `class-move:${owner}:to-spot:${J}-11`,
      },
      { kind: 'set_account_mode', mode: 'standard', changeKey: `account-mode:${owner}:standard:${J}-11` },
    ]) {
      const prep = await d.post('/api/v1/venue/prepare', {
        venueId: (await venueInfo()).id,
        owner,
        signer: { role: 'owner', address: owner },
        intent,
      });
      expect(prep.status, JSON.stringify(prep.body).slice(0, 300)).toBe(409);
      expect(prep.body.intafacedCode).toBe('trade.venue_account_mode_unknown');
      expect(JSON.stringify(prep.body)).toContain('not known');
    }
    expect((await venueRecord(owner, '/balances')).value).toEqual(balancesBefore);
    expect(await ledgerOf()).toEqual(state().ledger);
  } finally {
    await setMode(owner, { unreported: false });
  }
});
