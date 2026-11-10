// World: book, gates, restart, stack
import { randomBytes } from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';
import { test, expect } from './journey.mjs';
import { api, journeyState, restartWithSetting, toUnits, fromUnits } from './stack.mjs';
import { signUp, verify } from './desk.mjs';
import { testWalletKey } from './test-wallet.mjs';
import { ADMIN, founderSignIn } from './admin.mjs';
import { continueInWallet, openVenueDesk, sameDecimal, TEST_VENUE, TEST_VENUE_B, testVenueAt, venueForThisFile } from './venue.mjs';

// J-derivatives-28, "My order goes to the best venue I can sign for", in the running app against the stack's two TEST
// venue simulators (LOCAL_STACK_USER_VENUE=two: the first venue with its 1 BTC a level TEST ladder, and a second TEST venue
// with 5 BTC a level), the same BTC-PERP perpetual listed on both. One test per step, titled "J-derivatives-28 #<n>".
// #7 is Later (OWNER 226: our own book as one more venue) and is not here. #8 (the builder-fee approval before the first
// order on a venue) runs before #3, since the first routed order on a venue is the one that asks for it. Every figure is
// TEST. The door is on, with both venues, for this file only.
const J = 'J-derivatives-28';
const DESK = '/trade/futures';
const SYMBOL = 'BTC-PERP';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
/** TEST margin in each venue account: enough for every TEST order here at 10x. */
const FUNDS = '50000';
const LEVERAGE = '10';

test.describe.configure({ mode: 'default' });
venueForThisFile(test, 'two');

// ── the two TEST venues, read directly (what the desk must equal) ──

const venues = { a: TEST_VENUE, b: TEST_VENUE_B };
async function at(base, path, body) {
  const { status, body: out } = await testVenueAt(base, path, body);
  expect(status, JSON.stringify(out).slice(0, 300)).toBe(200);
  return out;
}
const info = async (base) => {
  const v = await at(base, '/venue');
  expect(v.label).toBe('TEST');
  return { id: v.venue.id, displayName: v.venue.displayName, base };
};
const both = async () => ({ a: await info(venues.a), b: await info(venues.b) });
const account = (venue, owner) => ({ venueId: venue.id, owner: owner.toLowerCase(), subAccount: null });
const book = async (venue) => (await at(venue.base, '/book', { symbol: SYMBOL, depth: 5 })).value;
const deposit = (venue, owner, asset, amount) =>
  at(venue.base, '/test/deposit', {
    account: account(venue, owner),
    asset,
    amount,
    depositRef: `84532:0x${randomBytes(32).toString('hex')}:0`,
  });
const byClientId = async (venue, owner, id) =>
  (await at(venue.base, '/order-by-client-id', { account: account(venue, owner), venueClientOrderId: id })).value;
const fillsOf = async (venue, owner, since) => (await at(venue.base, '/fills', { account: account(venue, owner), since })).value;
const filled = (fills, id) => fromUnits(fills.filter((f) => f.venueClientOrderId === id).reduce((t, f) => t + toUnits(f.amount), 0n));
const switchDown = (venue, venueDown) => at(venue.base, '/test/switches', { venueDown });
const byId = async (id) => {
  const v = await both();
  return id === v.a.id ? v.a : v.b;
};
const plain = (text) => text.replace(/,/g, '').trim();

function state() {
  const s = run.read();
  if (!s.account || !s.walletKey) throw new Error(`${J} #1 made no account and wallet, so this step has no one to act as`);
  return s;
}

const desk = async (page) => {
  const s = state();
  const wallet = await openVenueDesk(page, s.account, DESK, s.walletKey);
  await expect(page.getByTestId('venue-routes')).toBeVisible({ timeout: 30_000 });
  return { ...s, wallet, owner: wallet.address };
};
const strip = (page) => page.getByTestId('venue-routes');
const row = (page, venue) => strip(page).locator(`tr[data-venue="${venue.id}"]`);
const line = (sheet, name) => sheet.locator(`[data-line="${name}"]`);

/** Both venue accounts funded and leverage set on each through our door (setup for the steps after #2). */
async function ready(s) {
  const v = await both();
  const owner = privateKeyToAccount(s.walletKey).address.toLowerCase();
  const client = await api(s.account);
  const key = privateKeyToAccount(s.walletKey);
  for (const venue of [v.a, v.b]) {
    const balances = (await at(venue.base, '/balances', { account: account(venue, owner) })).value;
    if (!balances.some((b) => b.asset === 'USDC' && toUnits(b.total) > 0n)) await deposit(venue, owner, 'USDC', FUNDS);
    const lev = await client.get(`/api/v1/venue/leverage?owner=${owner}&symbol=${SYMBOL}&venueId=${venue.id}`);
    expect(lev.status, JSON.stringify(lev.body).slice(0, 300)).toBe(200);
    if (lev.body.value) continue;
    const intent = { kind: 'update_leverage', symbol: SYMBOL, leverageBps: Number(LEVERAGE) * 10_000, marginMode: 'isolated' };
    const prep = await client.post('/api/v1/venue/prepare', {
      venueId: venue.id,
      owner,
      signer: { role: 'owner', address: owner },
      intent,
      actionKey: `leverage:${owner}:${SYMBOL}:isolated:${LEVERAGE}:setup-${venue.id}`,
    });
    expect(prep.status, JSON.stringify(prep.body).slice(0, 300)).toBe(200);
    const t = prep.body.prepared.typedData;
    const signature = await key.signTypedData({ domain: t.domain, types: t.types, primaryType: t.primaryType, message: t.message });
    const sent = await client.post('/api/v1/venue/submit', {
      actionKey: prep.body.actionKey,
      signature: { digest: prep.body.prepared.digest, signature, signedBy: owner },
    });
    expect(sent.body.outcome).toMatchObject({ definite: true, accepted: true });
  }
  return { ...v, owner, client };
}

/** An order the first venue's shown depth can't fill at its shown price: its best ask's size and half a BTC more. */
async function sizeFor(a) {
  const ask = (await book(a)).asks[0];
  expect(ask, 'the first TEST venue shows an ask').toBeTruthy();
  return { ask, size: fromUnits(toUnits(ask.amount) + toUnits('0.5')), worst: fromUnits(toUnits(ask.price) + toUnits('200')) };
}

/** The ticket filled for a market long and Review pressed; returns the routed review. */
async function reviewLong(page, { size, worst }) {
  const ticket = page.getByTestId('venue-ticket');
  await ticket.getByRole('button', { name: 'Long', exact: true }).click();
  await ticket.getByRole('button', { name: 'Market', exact: true }).click();
  await ticket.getByRole('textbox', { name: 'Size (BTC)' }).fill(size);
  await ticket.getByRole('textbox', { name: 'Worst price (slippage limit)' }).fill(worst);
  await ticket.getByRole('combobox', { name: 'Margin asset' }).selectOption('USDC');
  await ticket.getByRole('button', { name: 'Review long' }).click();
  const sheet = page.getByTestId('venue-route-review');
  await expect(sheet).toBeVisible();
  return sheet;
}
const closeReview = (sheet) => sheet.getByRole('button', { name: 'Close', exact: true }).click();

/** The prepare our door answered for the next order: its venue and the venue client order id it holds. */
const nextPrepare = (page) =>
  page.waitForResponse(
    (r) =>
      r.request().method() === 'POST' &&
      r.url().endsWith('/api/v1/venue/prepare') &&
      r.ok() &&
      r.request().postDataJSON()?.intent?.kind === 'place_order',
  );

test(`${J} #1 opens the ticket for a market two venues list: each venue with its price, depth and fee read from the venue, and whether the person can sign there; a venue without an account shows "connect to use"`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  const account = await signUp(page, 'vroute');
  await verify(page, account);
  run.reset({ account, walletKey: testWalletKey(), startedAt: new Date(Date.now() - 60_000).toISOString() });
  const v = await both();
  expect(v.a.id).not.toBe(v.b.id);
  const owner = privateKeyToAccount(state().walletKey).address.toLowerCase();
  // The journey's start: a TEST account on the first venue only.
  await deposit(v.a, owner, 'USDC', FUNDS);
  await desk(page);

  const client = await api(account);
  const status = (await client.get('/api/v1/venue/status')).body;
  expect(status.routes).toBe(true);
  expect(status.builder?.feeBps, 'the stack publishes a TEST builder fee').toBeTruthy();
  for (const venue of [v.a, v.b]) {
    const r = row(page, venue);
    await expect(r.locator('[data-cell="venue"]')).toContainText(venue.displayName);
    await expect(r.getByTestId('venue-test')).toHaveText('TEST');
    await expect(r.locator('[data-cell="state"]')).toHaveText('Up');
    const market = (await at(venue.base, '/markets', {})).value.find((m) => m.symbol === SYMBOL);
    const fee = (k) => (market[k].known ? `${market[k].value} bps` : 'Not known');
    await expect.poll(async () => plain(await r.locator('[data-fee="maker"]').innerText())).toBe(`Maker ${fee('makerFeeBps')}`);
    await expect.poll(async () => plain(await r.locator('[data-fee="taker"]').innerText())).toBe(`Taker ${fee('takerFeeBps')}`);
    await expect.poll(async () => plain(await r.locator('[data-cell="builder-fee"]').innerText())).toBe(`${status.builder.feeBps} bps`);
    // The venue's own book: its best bid and ask with their sizes, and the depth it shows over five levels.
    await expect
      .poll(
        async () => {
          const b = await book(venue);
          const level = (l) => (l ? `${l.price} × ${l.amount}` : 'None');
          const sum = (ls) => fromUnits(ls.reduce((t, l) => t + toUnits(l.amount), 0n));
          const shown = {
            bid: plain(await r.locator('[data-cell="bid"]').innerText()),
            ask: plain(await r.locator('[data-cell="ask"]').innerText()),
            depth: plain(await r.locator('[data-cell="depth"]').innerText()),
          };
          return (
            sameLevel(shown.bid, level(b.bids[0])) &&
            sameLevel(shown.ask, level(b.asks[0])) &&
            shown.depth.startsWith('Bids') &&
            sameDecimal(shown.depth.split(' ')[1], sum(b.bids)) &&
            sameDecimal(shown.depth.split(' ')[4], sum(b.asks))
          );
        },
        { timeout: 15_000 },
      )
      .toBe(true);
  }
  await expect(row(page, v.a)).toHaveAttribute('data-account', 'signable');
  await expect(row(page, v.a).locator('[data-cell="account"]')).toContainText('You can sign here');
  await expect(row(page, v.b)).toHaveAttribute('data-account', 'connect');
  await expect(row(page, v.b).locator('[data-cell="account"]')).toContainText('Connect to use');
  await expect(row(page, v.b).getByRole('link', { name: 'Fund an account on this venue from your wallet' })).toBeVisible();
});

/** "60010 × 1" against the venue's level, decimals compared exactly. */
function sameLevel(shown, venue) {
  if (venue === 'None') return shown === 'None';
  const [p, a] = shown.split(' × ');
  const [vp, va] = venue.split(' × ');
  return Boolean(p && a) && sameDecimal(p, vp) && sameDecimal(a, va);
}

test(`${J} #2 enters an order the first venue's shown depth can't fill at the shown price: the routing preview names the venue chosen, its expected fill and fee, and why; a fee the venue doesn't publish reads "not known"`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  const { wallet, owner } = await desk(page);
  const v = await both();
  // The person opens an account on the second venue: it becomes one they can sign for.
  await deposit(v.b, owner, 'USDC', FUNDS);
  await expect(row(page, v.b)).toHaveAttribute('data-account', 'signable', { timeout: 15_000 });
  // Leverage on each venue, one signature each: the first venue's margin step, then "set here" on the second.
  const margin = page.getByTestId('venue-margin');
  await margin.locator('[data-mode="isolated"] input').check();
  await margin.getByRole('textbox', { name: 'Leverage (times)' }).fill(LEVERAGE);
  await margin.getByRole('button', { name: 'Sign this leverage setting' }).click();
  await continueInWallet(page);
  await expect(margin.getByTestId('venue-leverage-current')).toContainText(`${LEVERAGE}x`, { timeout: 15_000 });
  await row(page, v.b)
    .getByRole('button', { name: `Sign ${LEVERAGE}x isolated on this venue` })
    .click();
  await continueInWallet(page);
  await expect(row(page, v.b).getByTestId('venue-route-leverage')).toContainText(`leverage here ${LEVERAGE}x isolated`, {
    timeout: 15_000,
  });
  const signed = wallet.requests.length;

  const { ask, size, worst } = await sizeFor(v.a);
  const bAsk = (await book(v.b)).asks[0];
  expect(toUnits(bAsk.amount) >= toUnits(size), 'the second TEST venue shows depth for the whole order').toBe(true);
  const sheet = await reviewLong(page, { size, worst });
  await expect(line(sheet, 'route-venue')).toHaveAttribute('data-venue', v.b.id);
  await expect(line(sheet, 'route-venue')).toHaveText(v.b.displayName);
  // The expected fill: all of it now, at the second venue's best ask.
  await expect.poll(async () => plain(await line(sheet, 'route-fill').innerText())).toMatch(/^[\d.]+ of [\d.]+ at an average [\d.]+$/);
  const [fills, , of, , , , avg] = plain(await line(sheet, 'route-fill').innerText()).split(' ');
  expect(sameDecimal(fills, size) && sameDecimal(of, size)).toBe(true);
  expect(sameDecimal(avg, bAsk.price)).toBe(true);
  await expect(line(sheet, 'venue-fee')).toContainText('USDC');
  await expect(line(sheet, 'builder-fee')).toContainText('USDC');
  // Why: the first venue's shown depth fills only its best ask's size at its shown price; the chosen one costs less.
  const why = line(sheet, 'route-why');
  await expect(why).toContainText(`${v.a.displayName}'s shown depth fills`);
  await expect(why).toContainText(`at its shown price`);
  expect(sameDecimal(plain(await why.innerText()).match(/shown depth fills ([\d.]+) of/)[1], ask.amount)).toBe(true);
  await expect(why).toContainText(`${v.b.displayName} fills all of it at the lowest total cost`);
  await expect(sheet.getByTestId('venue-route-others').locator(`li[data-venue="${v.a.id}"]`)).toContainText(v.a.displayName);
  await closeReview(sheet);

  // The chosen venue stops publishing its fee: the preview says "not known" and that the cost counts known fees only.
  await at(v.b.base, '/test/market-fees', { symbol: SYMBOL, makerFeeBps: null, takerFeeBps: null });
  try {
    const again = await reviewLong(page, { size, worst });
    await expect(line(again, 'route-venue')).toHaveAttribute('data-venue', v.b.id);
    await expect(line(again, 'venue-fee')).toHaveText('Not known');
    await expect(line(again, 'route-total')).toContainText('counting known fees only');
    await expect(line(again, 'route-why')).toContainText('This venue does not publish its fee');
    await expect(row(page, v.b).locator('[data-fee="taker"]')).toHaveText('Taker Not known');
    await closeReview(again);
  } finally {
    const market = (await at(v.a.base, '/markets', {})).value.find((m) => m.symbol === SYMBOL);
    await at(v.b.base, '/test/market-fees', {
      symbol: SYMBOL,
      makerFeeBps: market.makerFeeBps.value,
      takerFeeBps: market.takerFeeBps.value,
    });
  }
  // A preview sends nothing and asks the wallet for nothing.
  expect(wallet.requests).toHaveLength(signed);
  expect((await at(v.b.base, '/open-orders', { account: account(v.b, owner) })).value).toEqual([]);
});

test(`${J} #8 confirms an order on a venue where they never approved our builder fee: one approval from their own wallet naming the venue and at most the published fee, then the order; declining sends nothing; an agent key can't sign it; a blank fee refuses and asks for nothing`, async ({
  page,
}) => {
  test.setTimeout(600_000);
  const s = state();
  const { owner, client } = await ready(s);
  const v = await both();
  const builder = (await client.get('/api/v1/venue/status')).body.builder;
  expect((await at(v.b.base, '/builder-fee-approval', { account: account(v.b, owner), builder: builder.address })).value).toBe('0');

  // An agent key can't sign the approval: the venue refuses it before anything is signed.
  const agent = await client.post('/api/v1/venue/prepare', {
    venueId: v.b.id,
    owner,
    signer: { role: 'agent', address: `0x${randomBytes(20).toString('hex')}` },
    intent: { kind: 'approve_builder_fee', builder: builder.address, maxFeeBps: builder.feeBps },
    actionKey: `builder-approval:${owner}:${v.b.id}:agent-try`,
  });
  expect(agent.status, JSON.stringify(agent.body).slice(0, 300)).toBe(422);
  expect(agent.body.refusal?.code).toBe('agent_not_permitted');

  // A blank builder fee: no venue can take the order, the refusal names the blocker, and the wallet is asked nothing.
  const savedVenue = process.env.LOCAL_STACK_USER_VENUE;
  process.env.LOCAL_STACK_USER_VENUE = 'two';
  try {
    restartWithSetting('trade', 'LOCAL_STACK_USER_VENUE_BUILDER_FEE', 'off');
    const blank = await desk(page);
    await expect(row(page, v.b).locator('[data-cell="builder-fee"]')).toContainText('Not published', { timeout: 15_000 });
    const sheet = await reviewLong(page, await sizeFor(v.a));
    const none = sheet.getByTestId('venue-route-none');
    await expect(none).toContainText('No venue you can sign for is up and takes this order');
    for (const venue of [v.a, v.b])
      await expect(none.locator(`li[data-venue="${venue.id}"][data-code="builder_fee_not_published"]`)).toContainText(
        'our builder fee is not published',
      );
    await expect(sheet.getByRole('button', { name: 'Open long' })).toHaveCount(0);
    expect(blank.wallet.requests).toHaveLength(0);
  } finally {
    restartWithSetting('trade', 'LOCAL_STACK_USER_VENUE_BUILDER_FEE', null);
    if (savedVenue === undefined) delete process.env.LOCAL_STACK_USER_VENUE;
    else process.env.LOCAL_STACK_USER_VENUE = savedVenue;
  }

  const { wallet } = await desk(page);
  const order = await sizeFor(v.a);
  const sheet = await reviewLong(page, order);
  await expect(line(sheet, 'route-venue')).toHaveAttribute('data-venue', v.b.id);
  // Declining sends no order and says why.
  await sheet.getByRole('button', { name: 'Open long' }).click();
  const approval = sheet.getByTestId('venue-route-approval');
  await expect(approval).toBeVisible();
  await expect(line(approval, 'approval-words')).toContainText(`signs one approval that lets ${v.b.displayName} charge our builder fee`);
  await expect(line(approval, 'approval-words')).toContainText(`at most ${builder.feeBps} bps of each order`);
  await expect(line(approval, 'approval-words')).toContainText('You sign it once for this venue');
  await approval.getByRole('button', { name: 'Decline' }).click();
  await expect(sheet.getByTestId('venue-route-declined')).toHaveText(
    `No order was sent: our builder fee on ${v.b.displayName} was not approved, and every order there carries it.`,
  );
  expect(wallet.requests).toHaveLength(0);
  expect((await at(v.b.base, '/open-orders', { account: account(v.b, owner) })).value).toEqual([]);
  expect(await fillsOf(v.b, owner, s.startedAt)).toEqual([]);

  // Approving: one approval signature from the owner wallet, then the order is signed and sent.
  const prepared = nextPrepare(page);
  await sheet.getByRole('button', { name: 'Open long' }).click();
  await approval.getByRole('button', { name: 'Approve in wallet' }).click();
  await continueInWallet(page);
  await continueInWallet(page);
  const p = (await (await prepared).json()).prepared;
  await expect(sheet.getByTestId('venue-route-filled')).toBeVisible({ timeout: 20_000 });
  expect(wallet.requests).toHaveLength(2);
  expect((await at(v.b.base, '/builder-fee-approval', { account: account(v.b, owner), builder: builder.address })).value).toBe(
    builder.feeBps,
  );
  expect(p.venueId).toBe(v.b.id);
  const placed = await byClientId(v.b, owner, p.venueClientOrderId);
  expect(placed.status).toBe('filled');
  await expect(sheet.getByTestId('venue-route-filled')).toHaveText(
    `Sent to ${v.b.displayName}. The venue’s order id: ${placed.venueOrderId}.`,
  );
  expect(sameDecimal(filled(await fillsOf(v.b, owner, s.startedAt), p.venueClientOrderId), order.size)).toBe(true);
  run.write({ lastVenueId: v.b.id });
});

test(`${J} #3 confirms and signs: one signed order sent once to the chosen venue; the fill shows with the venue's order id`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  const s = state();
  await ready(s);
  const { wallet, owner } = await desk(page);
  const v = await both();
  const submits = [];
  page.on('request', (r) => r.method() === 'POST' && r.url().endsWith('/api/v1/venue/submit') && submits.push(r.postDataJSON()));
  const order = await sizeFor(v.a);
  const sheet = await reviewLong(page, order);
  const chosenId = await line(sheet, 'route-venue').getAttribute('data-venue');
  const chosen = await byId(chosenId);
  const other = chosen.id === v.a.id ? v.b : v.a;
  const before = wallet.requests.length;
  const prepared = nextPrepare(page);
  await sheet.getByRole('button', { name: 'Open long' }).click();
  await continueInWallet(page);
  const p = (await (await prepared).json()).prepared;
  await expect(sheet.getByTestId('venue-route-filled')).toBeVisible({ timeout: 20_000 });
  expect(wallet.requests).toHaveLength(before + 1);
  expect(submits).toHaveLength(1);
  expect(p.venueId).toBe(chosen.id);
  const placed = await byClientId(chosen, owner, p.venueClientOrderId);
  expect(placed.status).toBe('filled');
  await expect(sheet.getByTestId('venue-route-filled')).toHaveText(
    `Sent to ${chosen.displayName}. The venue’s order id: ${placed.venueOrderId}.`,
  );
  expect(sameDecimal(filled(await fillsOf(chosen, owner, s.startedAt), p.venueClientOrderId), order.size)).toBe(true);
  // Sent once, to that venue only.
  expect(await byClientId(other, owner, p.venueClientOrderId)).toBeNull();
  run.write({ lastVenueId: chosen.id });
});

test(`${J} #5 retries after a network error: the same client order id is sent and the venue never holds a second order`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  const s = state();
  await ready(s);
  const { wallet, owner } = await desk(page);
  const v = await both();
  const submits = [];
  page.on('request', (r) => r.method() === 'POST' && r.url().endsWith('/api/v1/venue/submit') && submits.push(r.postDataJSON()));
  // The first submit reaches our door and the venue, and its answer is lost on the way back: a network error.
  let cut = false;
  await page.route('**/api/v1/venue/submit', async (route) => {
    if (cut) return route.continue();
    cut = true;
    await route.fetch();
    await route.abort('failed');
  });
  const order = await sizeFor(v.a);
  const sheet = await reviewLong(page, order);
  const chosen = await byId(await line(sheet, 'route-venue').getAttribute('data-venue'));
  const before = wallet.requests.length;
  const prepared = nextPrepare(page);
  await sheet.getByRole('button', { name: 'Open long' }).click();
  await continueInWallet(page);
  const p = (await (await prepared).json()).prepared;
  const again = sheet.getByRole('button', { name: 'Send the same order again' });
  await expect(again).toBeVisible({ timeout: 20_000 });
  await again.click();
  await expect(sheet.getByTestId('venue-route-filled')).toBeVisible({ timeout: 20_000 });
  // The same signed order under the same key, so the same client order id; the wallet was asked once.
  expect(submits).toHaveLength(2);
  expect(submits[1].actionKey).toBe(submits[0].actionKey);
  expect(submits[1].signature).toEqual(submits[0].signature);
  expect(wallet.requests).toHaveLength(before + 1);
  // The venue holds one order under that client id, filled once.
  const placed = await byClientId(chosen, owner, p.venueClientOrderId);
  expect(placed.status).toBe('filled');
  expect(sameDecimal(filled(await fillsOf(chosen, owner, s.startedAt), p.venueClientOrderId), order.size)).toBe(true);
  expect(sameDecimal(placed.filled, order.size)).toBe(true);
  await page.unroute('**/api/v1/venue/submit');
  run.write({ lastVenueId: chosen.id });
});

test(`${J} #4 the chosen venue goes down before the next order: it is marked down, and the preview offers only venues that are up, or no order and the reason`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  const s = state();
  await ready(s);
  const { wallet } = await desk(page);
  const v = await both();
  const downVenue = await byId(s.lastVenueId ?? v.b.id);
  const upVenue = downVenue.id === v.a.id ? v.b : v.a;
  const order = await sizeFor(v.a);
  await switchDown(downVenue, true);
  try {
    await expect(row(page, downVenue)).toHaveAttribute('data-state', 'down', { timeout: 15_000 });
    await expect(row(page, downVenue).locator('[data-cell="state"]')).toContainText('Down since');
    await expect(row(page, downVenue).locator('[data-cell="state"]')).toContainText('is down');
    await expect(row(page, upVenue)).toHaveAttribute('data-state', 'up');
    const sheet = await reviewLong(page, order);
    await expect(line(sheet, 'route-venue')).toHaveAttribute('data-venue', upVenue.id);
    await expect(sheet.getByTestId('venue-route-others').locator(`li[data-venue="${downVenue.id}"][data-code="venue_down"]`)).toBeVisible();
    await closeReview(sheet);

    // Both down: no order is offered, and the reason names each.
    await switchDown(upVenue, true);
    await expect(row(page, upVenue)).toHaveAttribute('data-state', 'down', { timeout: 15_000 });
    const none = await reviewLong(page, order);
    await expect(none.getByTestId('venue-route-none')).toContainText('No venue you can sign for is up and takes this order');
    for (const venue of [downVenue, upVenue])
      await expect(none.getByTestId('venue-route-none').locator(`li[data-venue="${venue.id}"][data-code="venue_down"]`)).toBeVisible();
    await expect(none.getByRole('button', { name: 'Open long' })).toHaveCount(0);
    await closeReview(none);
  } finally {
    await switchDown(upVenue, false);
    await switchDown(downVenue, false);
  }
  // Back up: the next read marks both up again.
  await expect(row(page, downVenue)).toHaveAttribute('data-state', 'up', { timeout: 15_000 });
  await expect(row(page, upVenue)).toHaveAttribute('data-state', 'up');
  expect(wallet.requests).toHaveLength(0);
});

test(`${J} #6 an operator opens the routing view: our users' routed volume and builder fees by venue, and house exposure "none: routed"`, async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const s = state();
  const v = await both();
  const owner = privateKeyToAccount(s.walletKey).address.toLowerCase();
  const to = new Date(Date.now() + 60_000).toISOString();
  const page = await (await browser.newContext()).newPage();
  try {
    await founderSignIn(page);
    await page.goto(`${ADMIN}/trade-ops/routing?from=${encodeURIComponent(s.startedAt)}&to=${encodeURIComponent(to)}`);
    const table = page.getByTestId('routing-table');
    await expect(table).toBeVisible({ timeout: 30_000 });
    let ours = { fills: 0, volume: 0n, fees: 0n };
    for (const venue of [v.a, v.b]) {
      // This file's own routed orders on the venue, from the venue's fills (every order here went through our door).
      const fills = (await fillsOf(venue, owner, s.startedAt)).filter((f) => f.symbol === SYMBOL && f.venueClientOrderId);
      const volume = fills.reduce((t, f) => t + (toUnits(f.price) * toUnits(f.amount)) / 10n ** 18n, 0n);
      const fees = fills.reduce((t, f) => t + toUnits(f.builderFee), 0n);
      const r = table.locator(`tr[data-venue="${venue.id}"]`);
      await expect(r.locator('[data-cell="exposure"]')).toHaveText('none: routed');
      await expect(r).toHaveAttribute('data-state', 'up');
      const shownVolume = toUnits(
        plain(await r.locator('[data-cell="volume"]').innerText())
          .replace(/ USDC$/, '')
          .replace(/^none$/, '0'),
      );
      const shownFees = toUnits(
        plain(await r.locator('[data-cell="builder-fees"]').innerText())
          .replace(/ USDC$/, '')
          .replace(/^none$/, '0'),
      );
      if (venue.id === v.b.id) {
        // Only this file routes to the second TEST venue: its row is exactly this file's fills.
        expect(fromUnits(shownVolume)).toBe(fromUnits(volume));
        expect(fromUnits(shownFees)).toBe(fromUnits(fees));
        expect(Number(await r.locator('[data-cell="fills"]').innerText())).toBe(fills.length);
        expect(fees > 0n, 'our builder fee was charged on the routed fills').toBe(true);
      } else {
        // The first venue also carries other journeys' routed orders in the period: at least this file's.
        expect(shownVolume >= volume).toBe(true);
        expect(shownFees >= fees).toBe(true);
      }
      ours = { fills: ours.fills + fills.length, volume: ours.volume + volume, fees: ours.fees + fees };
    }
    expect(ours.fills > 0).toBe(true);
    await expect(table.locator('tr[data-row="total"] [data-cell="exposure"]')).toHaveText('none: routed');
  } finally {
    await page.context().close();
  }
});
