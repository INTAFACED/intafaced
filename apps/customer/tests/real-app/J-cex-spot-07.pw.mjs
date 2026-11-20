// World: book, gates, restart, stack
import { createHash, randomBytes } from 'node:crypto';
import { createWalletClient, encodeFunctionData, http, parseAbi, parseUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { test, expect } from './journey.mjs';
import { api, journeyState, restartWithSetting, toUnits } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';
import { CHAIN_ID, connectWhenAsked, fundOnTestChain, testChain } from './dex.mjs';
import { installTestWallet, testWalletKey } from './test-wallet.mjs';
import { setPartner } from './partner.mjs';
import { ownSpotMarket } from './own-market.mjs';
import {
  continueInWallet,
  openVenueDesk,
  otherTraderKey,
  otherTraderRun,
  testVenue,
  venueAccount,
  venueForThisFile,
  venueInfo,
  venueRecord,
} from './venue.mjs';

// J-cex-spot-07 on the launch model (OWNER 226; docs/roadmap/journeys.json; project-state operation-zero/modules/cex-spot/
// acceptance/journeys.md): a pro trader arms the dead-man switch, which is the venue's own scheduled cancel, lets it fire,
// keeps it alive and turns it off; downloads a statement of the venue account's orders, trades and money movements; and
// reads their money history from the wallet, the venue and the partner. One test per step, titled "J-cex-spot-07 #<n>",
// run in order on one TEST account.
//
// INTAFACED holds none of this person's money: with svc-trade's user-venue door on for this file (venueForThisFile), every
// order, lock, schedule and movement is read from the place that holds it, never from the page: the stack's TEST venue
// simulator (packages/venue-sim) for the venue account, the TEST chain's indexer for the wallet, and the TEST partner bank's
// record. The ledger is read before and after to show it posts nothing. The stack publishes the TEST dead-man timeouts 10,
// 30, 60 and 120 seconds (TRADE_CANCEL_ALL_AFTER_TIMEOUTS_SEC); the first TEST venue takes a scheduled cancel at least 5
// seconds ahead (FIRST_TEST_VENUE_SCHEDULED_CANCEL_MIN_LEAD_MS). Every figure is TEST.
const J = 'J-cex-spot-07';
const PUBLISHED = [10, 30, 60, 120];
/** TEST USD the wallet sends to the venue's deposit address: the venue account's only funding. */
const DEPOSIT = '60';
/**
 * Every order of this file is on a TEST market of its own (ownSpotMarket), whose book only this file trades: a resting
 * buy there meets nothing but a sell this file puts there (garden/no-shared-market-on-book). TEST amounts and prices.
 */
const AMOUNT = '1';
const REST_PRICES = ['10', '9'];
const TRADE_PRICE = '12';
const PARTNER_BANK = 'TEST partner bank';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);

test.describe.configure({ mode: 'default' });
venueForThisFile(test);

const desk = (s) => `/trade/spot/${s.market.symbol}`;

function state() {
  const s = run.read();
  if (!s.account || !s.walletKey) throw new Error(`${J} #1 made no account and wallet, so this step has no one to act as`);
  return { ...s, owner: privateKeyToAccount(s.walletKey).address.toLowerCase() };
}

// ── the venue's own records ──

const venueOpen = async (owner) => (await venueRecord(owner, '/open-orders')).value;
const venueOrder = async (owner, venueClientOrderId) => (await venueRecord(owner, '/order-by-client-id', { venueClientOrderId })).value;
const schedule = async (owner) => (await venueRecord(owner, '/scheduled-cancel')).value;
const usdcLocked = async (owner) => toUnits((await venueRecord(owner, '/balances')).value.find((b) => b.asset === 'USDC')?.locked ?? '0');

/** Our ledger's view of this account: nothing in this journey posts to it. */
const ledgerView = async (who) => (await api(who)).balances();

// ── orders placed through INTAFACED: svc-trade's door prepares, the person's own wallet key signs, the door sends ──

async function throughUs(s, intent, actionKey) {
  const session = await api(s.account);
  const key = privateKeyToAccount(s.walletKey);
  // A market listed a moment ago may not be in our door's market list yet: it re-reads the venue's list on a miss, at
  // most every few seconds (user-venue-door.ts MARKET_MISS_REREAD_MS), so only the prepare, which signs and sends
  // nothing, is asked again until it answers.
  let prepared;
  await expect(async () => {
    prepared = await session.post('/api/v1/venue/prepare', {
      owner: s.owner,
      signer: { role: 'owner', address: s.owner },
      intent,
      ...(actionKey ? { actionKey } : {}),
    });
    expect(prepared.status, JSON.stringify(prepared.body).slice(0, 400)).toBe(200);
  }).toPass({ timeout: 30_000, intervals: [2_000] });
  const t = prepared.body.prepared.typedData;
  const signature = await key.signTypedData({ domain: t.domain, types: t.types, primaryType: t.primaryType, message: t.message });
  const sent = await session.post('/api/v1/venue/submit', {
    actionKey: prepared.body.actionKey,
    signature: { digest: prepared.body.prepared.digest, signature, signedBy: s.owner },
  });
  expect(sent.status, JSON.stringify(sent.body).slice(0, 400)).toBe(200);
  expect(sent.body.outcome, JSON.stringify(sent.body).slice(0, 400)).toMatchObject({ definite: true, accepted: true });
  return sent.body.outcome;
}

const buy = (s, tag, price, timeInForce = 'GTC') => ({
  kind: 'place_order',
  symbol: s.market.symbol,
  side: 'buy',
  type: 'limit',
  amount: AMOUNT,
  price,
  timeInForce,
  reduceOnly: false,
  clientOrderKey: `order:${s.owner}:js7${tag}${randomBytes(3).toString('hex')}`,
  builderFee: null,
});

/** A TEST buy resting on the venue, placed through INTAFACED; returns its client id on the venue. */
async function restThroughUs(s, tag, price = REST_PRICES[0]) {
  const outcome = await throughUs(s, buy(s, tag, price));
  expect(outcome.order).toMatchObject({ status: 'open' });
  return outcome.order.venueClientOrderId;
}

/** Another TEST customer's resting order on `symbol`, signed and sent on the TEST venue directly by their own key. */
async function otherRests(name, symbol, side, price, asset, funds) {
  const owner = otherTraderKey(name).address.toLowerCase();
  const funded = await testVenue('/test/deposit', {
    account: await venueAccount(owner),
    asset,
    amount: funds,
    depositRef: `seed:${name}:${asset}`,
  });
  expect(funded.status, JSON.stringify(funded.body)).toBe(200);
  const answer = await otherTraderRun(name, {
    kind: 'place_order',
    symbol,
    side,
    type: 'limit',
    amount: AMOUNT,
    price,
    timeInForce: 'GTC',
    reduceOnly: false,
    clientOrderKey: `order:${owner}:js7-other-${randomBytes(4).toString('hex')}`,
    builderFee: null,
  });
  expect(answer, JSON.stringify(answer).slice(0, 300)).toMatchObject({ accepted: true, order: { status: 'open' } });
  return { owner, id: answer.order.venueClientOrderId };
}

// ── the desk ──

const signatures = (wallet) => wallet.requests.filter((r) => r.method === 'eth_signTypedData_v4').length;
const switchButton = (page) => page.getByTestId('venue-dead-man');
const dialog = (page) => page.getByRole('alertdialog').filter({ hasText: 'Auto-cancel if you go quiet' });
const ARMED = /^On, on the venue’s own scheduled cancel\. Unless refreshed, your open orders are cancelled at (\d\d:\d\d:\d\d)\.$/;

async function openSwitch(page) {
  await expect(switchButton(page)).toHaveText(/^Auto-cancel(: off| at \d\d:\d\d:\d\d)$/, { timeout: 30_000 });
  await switchButton(page).click();
  await expect(dialog(page)).toBeVisible();
  return dialog(page);
}

/** A time as the desk writes it, in this browser's own zone (desk time.ts `clockSeconds`). */
const clock = (page, iso) =>
  page.evaluate(
    (at) =>
      new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(Date.parse(at)),
    iso,
  );

/** Arms (or refreshes) the switch with `seconds` from the open dialog, signs it, and returns the venue's own time. */
async function armFromDesk(page, box, seconds, owner) {
  await box.getByRole('radio', { name: `${seconds} seconds` }).check();
  const before = (await schedule(owner)).cancelsAt;
  const button = box.getByRole('button', { name: /^(Turn on|Refresh now)$/ });
  await button.click();
  await continueInWallet(page);
  const note = box.getByText(ARMED);
  await expect.poll(async () => (await schedule(owner)).cancelsAt, { timeout: 15_000 }).not.toBe(before);
  const at = (await schedule(owner)).cancelsAt;
  expect(at).not.toBeNull();
  await expect(note).toHaveText(ARMED, { timeout: 15_000 });
  // The time shown is the venue's own record of when it cancels. On a refresh the dialog still reads "On" with the old time
  // until the desk has read the venue back after its own submit, so wait for this arm's time, not for any time.
  const shown = await clock(page, at);
  await expect.poll(async () => (await note.innerText()).match(ARMED)?.[1], { timeout: 15_000 }).toBe(shown);
  return at;
}

/**
 * TEST setup, not a step (the Starts line), made at the start of #1, never in a beforeAll (a worker that restarts after a
 * failed step would run a beforeAll again and replace the account later steps act as): a verified account; this run's TEST
 * wallet, given TEST USD on the TEST chain, which it sends to the venue's deposit address (the venue credits it after its
 * confirmations); two TEST buys resting on the venue, placed through INTAFACED; and the person's bank money at the TEST
 * partner bank with TEST USDT paid in, so every place that holds their money has a movement for #6.
 */
async function startsLine(browser) {
  const page = await browser.newPage();
  try {
    const who = await signUp(page, 'js7v');
    await verify(page, who);
    const walletKey = testWalletKey();
    const key = privateKeyToAccount(walletKey);
    const owner = key.address.toLowerCase();
    run.reset({ account: who, walletKey });
    const session = await api(who);
    const ledgerStart = await session.balances();

    // Wallet → venue: TEST USD minted into the wallet, then sent from it to the venue's deposit address.
    expect(testChain().chain, 'the stack runs its TEST chain').toBe('running');
    fundOnTestChain(owner, 'venue');
    const door = await session.get('/api/v1/venue/status');
    expect(door.status, JSON.stringify(door.body)).toBe(200);
    const deposit = door.body.deposit;
    expect(deposit, 'the TEST venue publishes where a wallet deposits').toMatchObject({ chainId: CHAIN_ID, asset: 'USDC' });
    const wallet = createWalletClient({
      account: key,
      transport: http(testChain().gateUrl),
      chain: {
        id: CHAIN_ID,
        name: 'TEST',
        nativeCurrency: { name: 'TEST ETH', symbol: 'ETH', decimals: 18 },
        rpcUrls: { default: { http: [testChain().gateUrl] } },
      },
    });
    const txHash = await wallet.sendTransaction({
      to: deposit.token,
      data: encodeFunctionData({
        abi: parseAbi(['function transfer(address to, uint256 amount) returns (bool)']),
        functionName: 'transfer',
        args: [deposit.address, parseUnits(DEPOSIT, deposit.tokenDecimals)],
      }),
    });
    await expect
      .poll(
        async () => (await venueRecord(owner, '/deposits')).value.find((d) => d.txHash.toLowerCase() === txHash.toLowerCase())?.status,
        {
          timeout: 120_000,
        },
      )
      .toBe('credited');

    // Partner: the person's bank money at the TEST partner bank, with TEST USDT paid in there.
    await setPartner(who, { custody: 'off' });
    const tag = `${process.env.JOURNEY_RUN_ID ?? 'local'}${session.userId}`.replace(/[^A-Za-z0-9-]/g, '').slice(-40);
    const funded = await session.post('/api/bank/trpc/testPartner.fund', { fundId: `js7v-${tag}`, assetId: 'USDT', amount: '25' });
    expect(funded.status, JSON.stringify(funded.body)).toBe(200);
    expect(funded.body.result.data).toMatchObject({ label: PARTNER_BANK, assetId: 'USDT' });

    // The file's own TEST market, listed by two operators, its book empty.
    const market = await ownSpotMarket(J, 'JSS', 'A');
    const s = { account: who, walletKey, owner, market };
    const orders = [await restThroughUs(s, 'a', REST_PRICES[0]), await restThroughUs(s, 'b', REST_PRICES[1])];
    run.write({ ledgerStart, txHash: txHash.toLowerCase(), orders, market });
  } finally {
    await page.close();
  }
}

test(`${J} #1 arms the switch with a timeout the owner has published: armed on the venue's own scheduled cancel, with the trigger time shown; "not offered by this venue" where it has none`, async ({
  page,
  browser,
}) => {
  test.setTimeout(600_000);
  await startsLine(browser);
  const s = state();
  for (const id of s.orders) expect(await venueOrder(s.owner, id)).toMatchObject({ status: 'open' });
  await openVenueDesk(page, s.account, desk(s), s.walletKey);
  await expect(switchButton(page)).toHaveText('Auto-cancel: off', { timeout: 30_000 });
  expect((await schedule(s.owner)).cancelsAt).toBeNull();
  const box = await openSwitch(page);
  // Only the published timeouts are offered, and Other.
  await expect(box.getByRole('radio')).toHaveCount(PUBLISHED.length + 1);
  for (const sec of PUBLISHED) await expect(box.getByRole('radio', { name: `${sec} seconds` })).toBeVisible();
  const signed = Date.now();
  const at = await armFromDesk(page, box, 120, s.owner);
  // The venue's own record: it cancels about 120 seconds from when it was armed.
  const lead = Date.parse(at) - signed;
  expect(lead).toBeGreaterThan(110_000);
  expect(lead).toBeLessThan(130_000);
  // The desk's own button says when the venue cancels.
  await box.getByRole('button', { name: 'Close' }).click();
  await expect(switchButton(page)).toHaveText(`Auto-cancel at ${await clock(page, at)}`);
  // Off again, so nothing fires during the next steps: timeout 0 removes the venue's schedule.
  const again = await openSwitch(page);
  await again.getByRole('button', { name: 'Turn off' }).click();
  await continueInWallet(page);
  await expect(again.getByText('Off. Nothing will be cancelled.')).toBeVisible({ timeout: 15_000 });
  expect((await schedule(s.owner)).cancelsAt).toBeNull();
  await again.getByRole('button', { name: 'Close' }).click();

  // Where the venue has none: the same running TEST venue declares no scheduled cancel, and svc-trade restarted so its
  // door reads the venue afresh. The desk says "not offered by this venue" and offers nothing to sign.
  await testVenue('/test/switches', { scheduledCancelMinLeadMs: null });
  restartWithSetting('trade', 'LOCAL_STACK_USER_VENUE', 'on');
  const other = await browser.newPage();
  try {
    expect((await testVenue('/venue')).body.venue.scheduledCancel).toBeUndefined();
    const plain = await openVenueDesk(other, s.account, desk(s), s.walletKey);
    const { displayName } = await venueInfo();
    await expect(switchButton(other)).toHaveText('Auto-cancel: not offered by this venue', { timeout: 30_000 });
    await switchButton(other).click();
    const none = dialog(other);
    await expect(none.getByTestId('venue-dead-man-not-offered')).toHaveText(
      `Not offered by this venue: ${displayName} has no scheduled cancel, so auto-cancel can’t be turned on here.`,
    );
    await expect(none.getByRole('button', { name: /^(Turn on|Refresh now|Turn off)$/ })).toHaveCount(0);
    await expect(none.getByRole('radio')).toHaveCount(0);
    expect(signatures(plain)).toBe(0);
    // The door refuses it too, before anything is prepared.
    const refused = await (
      await api(s.account)
    ).post('/api/v1/venue/prepare', {
      owner: s.owner,
      signer: { role: 'owner', address: s.owner },
      intent: { kind: 'schedule_cancel', timeoutSec: 10, time: null },
      actionKey: `schedule-cancel:${s.owner}:none${randomBytes(3).toString('hex')}`,
    });
    expect(refused.status).toBe(422);
    expect(refused.body).toMatchObject({ intafacedCode: 'trade.venue.not_offered' });
  } finally {
    await other.close();
    await testVenue('/test/switches', { scheduledCancelMinLeadMs: 5_000 });
    restartWithSetting('trade', 'LOCAL_STACK_USER_VENUE', 'on');
  }
  expect((await testVenue('/venue')).body.venue.scheduledCancel).toEqual({ minLeadMs: 5_000 });
  expect(await ledgerView(s.account)).toEqual(s.ledgerStart);
});

test(`${J} #2 arms it with an unpublished timeout: refused with a typed reason, before the wallet is asked, nothing armed`, async ({
  page,
}) => {
  test.setTimeout(180_000);
  const s = state();
  const wallet = await openVenueDesk(page, s.account, desk(s), s.walletKey);
  const box = await openSwitch(page);
  await box.getByRole('radio', { name: 'Other' }).check();
  await box.getByRole('textbox', { name: 'Seconds', exact: true }).fill('7');
  const asked = signatures(wallet);
  const answer = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/v1/venue/prepare' && r.request().method() === 'POST');
  await box.getByRole('button', { name: 'Turn on' }).click();
  const res = await answer;
  expect(res.status()).toBe(400);
  expect((await res.json()).intafacedCode).toBe('trade.cancel_all_after_rejected');
  await expect(box.getByRole('alert')).toHaveText('That time isn’t offered. Choose one of: 10, 30, 60, 120 seconds.');
  // Refused before the wallet: no sheet, no signature, and the venue holds no schedule.
  await expect(page.getByRole('dialog', { name: 'Check before you sign' })).toHaveCount(0);
  expect(signatures(wallet)).toBe(asked);
  expect((await schedule(s.owner)).cancelsAt).toBeNull();
  await expect(switchButton(page)).toHaveText('Auto-cancel: off');
});

test(`${J} #3 stops talking past the deadline: every resting venue order placed through INTAFACED is cancelled once, its lock ended; another customer's orders untouched`, async ({
  page,
}) => {
  test.setTimeout(180_000);
  const s = state();
  const mine = s.orders;
  for (const id of mine) expect(await venueOrder(s.owner, id)).toMatchObject({ status: 'open' });
  expect(await usdcLocked(s.owner)).toBeGreaterThan(0n);
  const theirs = await otherRests(
    `${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}-${s.owner.slice(2, 10)}`,
    s.market.symbol,
    'buy',
    '8',
    'USDC',
    '1000',
  );

  await openVenueDesk(page, s.account, desk(s), s.walletKey);
  for (const id of mine)
    await expect(page.getByTestId('venue-open-orders').locator(`tr[data-client-order-id="${id}"]`)).toHaveCount(1, { timeout: 30_000 });
  const box = await openSwitch(page);
  const at = await armFromDesk(page, box, 10, s.owner);
  await box.getByRole('button', { name: 'Close' }).click();

  // Nobody refreshes it: at its time the venue itself cancels every open order of the account, once.
  await expect.poll(async () => (await venueOpen(s.owner)).length, { timeout: 30_000, intervals: [500] }).toBe(0);
  for (const id of mine) {
    const o = await venueOrder(s.owner, id);
    expect(o).toMatchObject({ status: 'canceled', cancelReason: 'scheduled_cancel' });
    expect(toUnits(o.locked)).toBe(0n);
  }
  expect(await usdcLocked(s.owner)).toBe(0n);
  const fired = await schedule(s.owner);
  expect(fired.cancelsAt).toBeNull();
  expect(fired.lastFired.canceled).toBe(mine.length);
  expect(Date.parse(fired.lastFired.firedAt)).toBeGreaterThanOrEqual(Date.parse(at));
  // The desk says so: the switch is off and the orders are gone from Open orders.
  await expect(switchButton(page)).toHaveText('Auto-cancel: off', { timeout: 15_000 });
  for (const id of mine)
    await expect(page.getByTestId('venue-open-orders').locator(`tr[data-client-order-id="${id}"]`)).toHaveCount(0, { timeout: 15_000 });
  // Another customer's resting order is still there, its lock kept.
  const still = await venueOrder(theirs.owner, theirs.id);
  expect(still).toMatchObject({ status: 'open' });
  expect(toUnits(still.locked)).toBeGreaterThan(0n);
  expect(await ledgerView(s.account)).toEqual(s.ledgerStart);
});

test(`${J} #4 keeps refreshing, then disarms with timeout 0: nothing cancelled while refreshed; after disarming the orders stay past the old deadline`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  const s = state();
  const order = await restThroughUs(s, 'kept');
  await openVenueDesk(page, s.account, desk(s), s.walletKey);
  const box = await openSwitch(page);
  const first = await armFromDesk(page, box, 10, s.owner);

  // The person keeps refreshing: each press, signed, moves the venue's time on before it is reached.
  let last = first;
  for (let i = 0; i < 2; i += 1) {
    await page.waitForTimeout(Math.max(0, Date.parse(last) - Date.now() - 4_000));
    const next = await armFromDesk(page, box, 10, s.owner);
    expect(Date.parse(next)).toBeGreaterThan(Date.parse(last));
    last = next;
  }
  // Past the first time and the second, with the order still resting.
  expect(Date.now()).toBeGreaterThan(Date.parse(first));
  expect(await venueOrder(s.owner, order)).toMatchObject({ status: 'open' });
  expect((await schedule(s.owner)).lastFired?.canceled).toBe(2); // only #3's firing

  // Off: timeout 0, signed. Past the time it had, the order is still open.
  const off = page.waitForRequest(
    (r) =>
      new URL(r.url()).pathname === '/api/v1/venue/prepare' &&
      r.method() === 'POST' &&
      r.postDataJSON()?.intent?.kind === 'schedule_cancel',
  );
  await box.getByRole('button', { name: 'Turn off' }).click();
  expect((await off).postDataJSON().intent).toEqual({ kind: 'schedule_cancel', timeoutSec: 0, time: null });
  await continueInWallet(page);
  await expect(box.getByText('Off. Nothing will be cancelled.')).toBeVisible({ timeout: 15_000 });
  expect((await schedule(s.owner)).cancelsAt).toBeNull();
  await page.waitForTimeout(Math.max(0, Date.parse(last) - Date.now() + 3_000));
  expect(await venueOrder(s.owner, order)).toMatchObject({ status: 'open' });
  expect((await venueOpen(s.owner)).map((o) => o.venueClientOrderId)).toEqual([order]);
  expect((await schedule(s.owner)).lastFired?.canceled).toBe(2);
  await box.getByRole('button', { name: 'Close' }).click();
  await expect(switchButton(page)).toHaveText('Auto-cancel: off');
  expect(await ledgerView(s.account)).toEqual(s.ledgerStart);
});

const parseCsv = (text) => {
  const [head, ...rows] = text.trimEnd().split('\n');
  const columns = head.split(',');
  return rows.map((row) => Object.fromEntries(row.split(',').map((v, i) => [columns[i], v])));
};

test(`${J} #5 requests a statement export of orders, trades and money movements for a date range: a job created once for that request and finished; the file lists exactly the rows of the range`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  const s = state();
  // A trade of the account's own: another TEST customer rests a sell on the file's market, and the person's TEST buy at
  // its price, placed through INTAFACED, fills against it at once.
  await otherRests(
    `${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}-maker-${s.owner.slice(2, 10)}`,
    s.market.symbol,
    'sell',
    TRADE_PRICE,
    s.market.base,
    '5',
  );
  const bought = await throughUs(s, buy(s, 'take', TRADE_PRICE, 'IOC'));
  expect(bought.order).toMatchObject({ status: 'filled' });
  // A statement that ends today ends at the last whole minute that has been over for a minute: wait until that end is
  // past the trade, so it is inside the range.
  const placedAt = Date.now();
  const settledEnd = () => Math.floor((Date.now() - 60_000) / 60_000) * 60_000;
  await expect.poll(settledEnd, { timeout: 130_000, intervals: [1000] }).toBeGreaterThan(placedAt);

  await openVenueDesk(page, s.account, desk(s), s.walletKey);
  await page.getByRole('button', { name: 'Statement…' }).click();
  const box = page.getByRole('alertdialog').filter({ hasText: 'Download a statement' });
  const { displayName } = await venueInfo();
  await expect(box).toContainText(`as ${displayName} records them. Nothing moves.`);
  const today = new Date(placedAt).toISOString().slice(0, 10);
  await box.getByLabel('From').fill(today);
  await box.getByLabel('To (included)').fill(today);
  const asks = [];
  page.on('response', (r) => {
    if (new URL(r.url()).pathname === '/api/v1/venue/statements' && r.request().method() === 'POST') asks.push(r);
  });
  await box.getByRole('button', { name: 'Make statement' }).click();
  const ready = box.getByText(/^Ready: \d+ orders, \d+ trades and \d+ money movements\. Statement [0-9a-f-]{36}\.$/);
  await expect(ready).toBeVisible({ timeout: 30_000 });
  // Asking again from the same dialog is the same job, not a second file.
  await box.getByRole('button', { name: 'Make statement' }).click();
  await expect.poll(() => asks.length).toBe(2);
  const [first, second] = await Promise.all(asks.map((r) => r.json()));
  expect(second.id).toBe(first.id);
  expect(second.sha256).toBe(first.sha256);
  const job = first;
  expect(job).toMatchObject({ status: 'finished', from: `${today}T00:00:00.000Z`, owner: s.owner });

  // The file the desk saves is the one the job fingerprinted.
  const download = page.waitForEvent('download');
  await box.getByRole('button', { name: 'Download' }).click();
  const saved = await download;
  expect(saved.suggestedFilename()).toBe(`statement-${today}-${today}.csv`);
  const text = await new Promise((resolve, reject) => {
    saved.createReadStream().then((stream) => {
      const parts = [];
      stream.on('data', (chunk) => parts.push(chunk));
      stream.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
      stream.on('error', reject);
    }, reject);
  });
  expect(createHash('sha256').update(text, 'utf8').digest('hex')).toBe(job.sha256);
  await expect(box.getByText(`Saved statement-${today}-${today}.csv.`)).toBeVisible();

  // Exactly the range's rows, as the venue records them: every order placed, trade filled and credit or withdrawal in
  // [from, to), each from the venue, and nothing else.
  const from = Date.parse(job.from);
  const to = Date.parse(job.to);
  const inRange = (iso) => Date.parse(iso) >= from && Date.parse(iso) < to;
  const rows = parseCsv(text);
  expect(rows.every((r) => r.source === displayName)).toBe(true);
  const ids = (...records) =>
    rows
      .filter((r) => records.includes(r.record))
      .map((r) => r.id)
      .sort();
  const orders = (await venueRecord(s.owner, '/order-history')).value
    .filter((r) => inRange(r.placedAt))
    .map((r) => r.order.venueClientOrderId ?? r.order.venueOrderId)
    .sort();
  const trades = (await venueRecord(s.owner, '/fills', { since: new Date(from).toISOString() })).value
    .filter((f) => inRange(f.filledAt))
    .map((f) => f.fillId)
    .sort();
  const credits = (await venueRecord(s.owner, '/arrivals')).value
    .filter((x) => inRange(x.arrivedAt))
    .map((x) => x.arrivalId)
    .sort();
  expect(ids('order')).toEqual(orders);
  expect(ids('trade')).toEqual(trades);
  expect(ids('deposit', 'transfer_in', 'withdrawal')).toEqual(credits); // no withdrawal was signed
  expect(ids('order')).toContain(bought.order.venueClientOrderId);
  expect(ids('trade').length).toBeGreaterThan(0);
  expect(job.rows).toEqual({ orders: orders.length, trades: trades.length, movements: credits.length });
  await expect(ready).toHaveText(
    `Ready: ${orders.length} orders, ${trades.length} trades and ${credits.length} money movements. Statement ${job.id}.`,
  );
  // An export moves nothing.
  expect(await ledgerView(s.account)).toEqual(s.ledgerStart);
});

/** The wallet's own record: its token transfers as the TEST chain's indexer has them. */
async function walletRecord(who, owner) {
  const session = await api(who);
  const input = encodeURIComponent(JSON.stringify({ chainId: CHAIN_ID, address: owner }));
  const res = await session.get(`/api/indexer/trpc/explorer.address.txs?input=${input}`);
  expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
  return res.body.result.data;
}

/** The partner's own record of its moves for this person: the bank's lines that carry the partner's name. */
async function partnerRecord(who) {
  const session = await api(who);
  const input = encodeURIComponent(JSON.stringify({ limit: 200 }));
  const res = await session.get(`/api/bank/trpc/activity.list?input=${input}`);
  expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
  return res.body.result.data.items.filter((item) => item.heldAt);
}

test(`${J} #6 opens history: every wallet, venue and partner movement with its source reference; nothing labelled as an INTAFACED balance`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  const s = state();

  // Each source's own record of what moved, by its own reference.
  const chain = await walletRecord(s.account, s.owner);
  const walletRefs = chain.rows.flatMap((row) => row.transfers.filter((t) => t.direction !== 'self').map(() => row.hash.toLowerCase()));
  expect(walletRefs, 'the wallet received its TEST USD and sent the deposit').toContain(s.txHash);
  const fills = (await venueRecord(s.owner, '/fills', { since: new Date(0).toISOString() })).value;
  const deposits = (await venueRecord(s.owner, '/deposits')).value;
  expect(fills.length).toBeGreaterThan(0);
  expect(deposits.map((d) => d.txHash.toLowerCase())).toEqual([s.txHash]);
  const partner = await partnerRecord(s.account);
  expect(partner.length).toBeGreaterThan(0);
  for (const line of partner) expect(line.heldAt.label).toBe(PARTNER_BANK);
  const expected = [
    ...walletRefs.map((ref) => ({ source: 'wallet', ref })),
    ...fills.map((f) => ({ source: 'venue', ref: f.fillId })),
    ...deposits.map((d) => ({ source: 'venue', ref: d.txHash.toLowerCase() })),
    ...partner.map((p) => ({ source: 'partner', ref: p.txId })),
  ];

  await installTestWallet(page, { chainId: CHAIN_ID, privateKey: s.walletKey, rpcUrl: testChain().gateUrl });
  await signIn(page, s.account);
  await page.goto('/money/activity');
  const list = page.getByTestId('activity-by-source');
  await expect(list).toBeVisible({ timeout: 30_000 });
  await connectWhenAsked(page, page.getByTestId('venue-wallet-address'));

  // Every movement each source reports, one row each, and nothing else: no line of our own ledger.
  const rows = list.getByTestId('money-act');
  await expect(rows).toHaveCount(expected.length, { timeout: 30_000 });
  for (const { source, ref } of expected) {
    const row = list.locator(`[data-testid="money-act"][data-source="${source}"][data-ref="${ref}"]`);
    await expect(row).toHaveCount(expected.filter((e) => e.source === source && e.ref === ref).length);
    // Its source, and the source's own reference, in words the person reads.
    for (const r of await row.all()) {
      await expect(r.getByTestId('money-act__source')).toBeVisible();
      await expect(r.getByTestId('money-act__ref')).toHaveText(`Reference ${ref}`);
    }
  }
  const sources = await rows.evaluateAll((trs) => [...new Set(trs.map((tr) => tr.getAttribute('data-source')))].sort());
  expect(sources).toEqual(['partner', 'venue', 'wallet']);
  // Nothing on the page is labelled as a balance INTAFACED holds: the money is the wallet's, the venue's and the partner's.
  await expect(page.getByText(/INTAFACED balance|balance (at|with|on) INTAFACED|held by INTAFACED/i)).toHaveCount(0);
  for (const label of await list.getByTestId('money-act__source').allInnerTexts()) expect(label).not.toMatch(/INTAFACED/i);
  expect(await ledgerView(s.account)).toEqual(s.ledgerStart);
});
