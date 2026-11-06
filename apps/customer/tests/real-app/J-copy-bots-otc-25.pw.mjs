// World: book
import { createHash } from 'node:crypto';
import { test, expect } from './journey.mjs';
import { api, fund, journeyState } from './stack.mjs';
import { fundedTrader, signIn } from './desk.mjs';

// J-copy-bots-otc-25, in the running app (docs/roadmap/journeys.json): keep my RFQ private, multi-leg and safe on /otc.
// One test per step, titled "J-copy-bots-otc-25 #<n>", run in order on one verified TEST account with TEST 20000 USDT
// and the desk's TEST stake floor staked, eligible for the desk under the stack's TEST desk law
// (tooling/profiles/test-owner-values/trade.json). Every request asks the house desk from the stack's TEST provider list;
// every RFQ and quote is read back from svc-trade (rfq.get through Edge), not only from the screen.
// Bids and asks: a quote that answers a sell request is a bid (the provider bids for the coin), one that answers a buy
// request is an ask.
// #2's own maker quote needs an account that can quote as a maker (CB-otc-10 maker vetting); #5's greeks need the
// QuantLib addon linked on the stack. Each fails at that part, by name.
const J = 'J-copy-bots-otc-25';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const UNBUILT = { timeout: 5_000 };
const HOUSE = 'House desk (TEST)';

test.describe.configure({ mode: 'default' });
// An action on a part that never appears fails in 15 s, not at the test's time limit.
test.use({ actionTimeout: 15_000 });

function state(key) {
  const value = run.read()[key];
  if (!value) throw new Error(`${J}: an earlier step made no ${key}, so this step has nothing to act on`);
  return value;
}

const form = (page) => page.getByRole('region', { name: 'Request a price' });
const quoteCard = (page) => page.getByRole('region', { name: 'Quote', exact: true });
const killRegion = (page) => page.getByRole('region', { name: 'Kill quotes' });
const timerRegion = (page) => page.getByRole('region', { name: 'Dead-man timer' });
const client = () => api(state('trader'));
const codeOf = (body) => [body].flat()[0]?.error?.data?.cause?.code;

/** A decimal string as a whole number of 1e-18 units, so amounts compare exactly (never as floats). */
const units = (value) => {
  const [whole, fraction = ''] = String(value ?? '0').split('.');
  return BigInt(whole + fraction.padEnd(18, '0').slice(0, 18));
};

/** The service's own record of one quote (`rfq.get` through Edge), as the trader. */
async function rfqGet(quoteId) {
  const read = await (await client()).get(`/api/trade/trpc/rfq.get?input=${encodeURIComponent(JSON.stringify({ quoteId }))}`);
  expect(read.status, JSON.stringify(read.body).slice(0, 300)).toBe(200);
  return read.body.result.data;
}

/** A desk request through the API, from the house desk: `{ qty }` or `{ notional }` of BTC against USDT. */
async function apiQuote(size, side = 'buy', extra = {}) {
  const me = await client();
  const makers = (await me.get('/api/trade/trpc/otc.makers.list')).body.result.data.makers;
  const house = makers.find((m) => m.name === HOUSE).id;
  return me.post('/api/trade/trpc/rfq.quote', { side, baseAsset: 'BTC', quoteAsset: 'USDT', makerIds: [house], ...size, ...extra });
}

/** The desk's published terms (`otc.deskStatus`). */
async function deskStatus() {
  const read = await (await client()).get('/api/trade/trpc/otc.deskStatus');
  expect(read.status, JSON.stringify(read.body).slice(0, 300)).toBe(200);
  return read.body.result.data;
}

/**
 * Stakes `amount` TEST IFC for the account through svc-token's own stake door, funded first through the ledger. The
 * deposit ref and the stake id are business keys for this account and amount, so a retried step neither funds nor
 * stakes twice.
 */
async function stake(who, amount) {
  const me = await api(who);
  const hex = createHash('sha256').update(`${J}:stake:${who.email}:${amount}`).digest('hex');
  expect(fund(who.email, 'IFC', amount, `${J}-stake-${hex.slice(0, 16)}`).tx).toBeTruthy();
  const stakeId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  const staked = await me.post('/api/token/trpc/stake', { amount, tier: 'flex', stakeId });
  expect(staked.status, JSON.stringify(staked.body).slice(0, 300)).toBe(200);
}

async function openDesk(page) {
  await signIn(page, state('trader'));
  await page.goto('/otc');
  await expect(page.getByRole('heading', { name: 'Quote desk', level: 1 })).toBeVisible();
}

/** Picks BTC/USDT and the house desk in the request form. */
async function pickHouse(page) {
  await form(page).getByRole('combobox', { name: 'Pair' }).click();
  await page.getByRole('option', { name: 'BTC/USDT', exact: true }).click();
  await form(page).getByRole('group', { name: 'Providers' }).getByRole('checkbox', { name: HOUSE, exact: true }).check();
}

/** Presses Request price and returns the desk's answer to the single-request call (rfq.quote, not rfq.quoteStrategy). */
async function requestPrice(page) {
  const answer = page.waitForResponse((res) => /rfq\.quote(\?|$)/.test(new URL(res.url()).pathname + new URL(res.url()).search));
  await form(page).getByRole('button', { name: 'Request price' }).click();
  return [await (await answer).json()].flat()[0];
}

test(`${J} #1 sends an anonymous RFQ: the quote card reads "Counterparty hidden" and the API returns no maker id to the taker`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  const trader = await fundedTrader(page, 'jrq', '20000');
  run.reset({ trader });
  const desk = await deskStatus();
  const minStake = /(?:^| )minStake=(\S+)/.exec(desk.statusLine)?.[1];
  expect(minStake, desk.statusLine).toBeTruthy();
  await stake(trader, minStake);

  await openDesk(page);
  await pickHouse(page);
  await form(page).getByRole('switch', { name: 'Hide my identity from makers' }).check(UNBUILT);
  await form(page)
    .getByRole('textbox', { name: /^Quantity/ })
    .fill('0.1');
  const answer = await requestPrice(page);
  const quote = answer.result?.data;
  expect(quote, JSON.stringify(answer).slice(0, 300)).toBeTruthy();
  expect(quote.anonymous).toBe(true);
  // No maker id anywhere in what the taker gets: not on the quote, not on any quote the request collected.
  expect([quote.makerId ?? null, quote.counterpartyId ?? null]).toEqual([null, null]);
  for (const q of quote.quotes ?? []) expect([q.makerId ?? null, q.counterpartyId ?? null]).toEqual([null, null]);
  await expect(quoteCard(page)).toContainText('Counterparty hidden');
  await expect(quoteCard(page)).not.toContainText(HOUSE);
  // The service's own record, read back, keeps it hidden from the taker.
  const read = await rfqGet(quote.quoteId);
  expect([read.anonymous, read.makerId ?? null, read.counterpartyId ?? null]).toEqual([true, null, null]);
});

test(`${J} #2 accepts a maker quote that is their own: refused as self-trade; allowing partial execution is refused as not offered`, async ({
  page,
}) => {
  await openDesk(page);
  const partial = form(page).getByRole('checkbox', { name: 'Allow partial execution' });
  await expect(partial).toBeDisabled(UNBUILT);
  await expect(form(page)).toContainText('Partial execution isn’t offered: a quote fills whole.');

  // Asking for partial execution is refused as not offered, and binds nothing.
  const asked = await apiQuote({ qty: '0.1' });
  expect(asked.status, JSON.stringify(asked.body).slice(0, 300)).toBe(200);
  const quote = asked.body.result.data;
  const me = await client();
  const partialAccept = await me.post('/api/trade/trpc/rfq.accept', { quoteId: quote.quoteId, allowPartial: true });
  expect(codeOf(partialAccept.body), JSON.stringify(partialAccept.body).slice(0, 300)).toBe('trade.rfq_partial_not_offered');
  expect((await rfqGet(quote.quoteId)).lifecycle).toBe('open');

  // The trader quotes their own request as a maker, then tries to take that quote: refused as self-trade, nothing bound.
  const own = await me.post('/api/trade/trpc/rfq.makerQuote', { rfqId: quote.rfqId, price: '65000' });
  expect(own.status, `the trader could not quote as a maker: ${JSON.stringify(own.body).slice(0, 300)}`).toBe(200);
  const ownQuote = own.body.result.data;
  const selfAccept = await me.post('/api/trade/trpc/rfq.accept', { quoteId: ownQuote.quoteId });
  expect(codeOf(selfAccept.body), JSON.stringify(selfAccept.body).slice(0, 300)).toBe('trade.rfq_self_trade');
  expect((await rfqGet(ownQuote.quoteId)).lifecycle).not.toMatch(/bound|settled/);
});

test(`${J} #3 builds a multi-leg strategy with sixteen legs: refused over the leg cap; a notional with a quantity also set is refused`, async ({
  page,
}) => {
  await openDesk(page);
  const { maxLegs } = await deskStatus();
  expect(maxLegs, 'the desk publishes no leg cap').toBe(15);
  await form(page).getByRole('tab', { name: 'Strategy' }).click(UNBUILT);
  for (let i = 0; i < 16; i++) await form(page).getByRole('button', { name: 'Add a leg' }).click();
  await expect(form(page).getByText(`A strategy takes at most ${maxLegs} legs.`)).toBeVisible();
  await expect(form(page).getByRole('group', { name: /^Leg \d+$/ })).toHaveCount(maxLegs);
  // The desk refuses a sixteen-leg strategy itself, not only the form.
  const leg = { side: 'buy', right: 'call', strike: '65000', qty: '1' };
  const sixteen = await (
    await client()
  ).post('/api/trade/trpc/rfq.quoteStrategy', { underlying: 'BTC', quoteAsset: 'USDT', legs: Array.from({ length: 16 }, () => leg) });
  expect(codeOf(sixteen.body), JSON.stringify(sixteen.body).slice(0, 300)).toBe('trade.rfq_legs_over_cap');

  await form(page).getByRole('tab', { name: 'Single' }).click();
  await form(page)
    .getByRole('textbox', { name: /^Quantity/ })
    .fill('0.5');
  await form(page)
    .getByRole('textbox', { name: /^Notional/ })
    .fill('10000');
  await expect(form(page).getByText('Give a quantity or a notional, not both.')).toBeVisible();
  await expect(form(page).getByRole('button', { name: 'Request price' })).toBeDisabled();
  const both = await apiQuote({ qty: '0.5', notional: '10000' });
  expect(codeOf(both.body), JSON.stringify(both.body).slice(0, 300)).toBe('trade.rfq_qty_and_notional');
});

test(`${J} #4 sends a notional RFQ: a quote for the notional at the firm price`, async ({ page }) => {
  await openDesk(page);
  await pickHouse(page);
  await form(page)
    .getByRole('textbox', { name: /^Notional/ })
    .fill('10000', UNBUILT);
  const answer = await requestPrice(page);
  const quote = answer.result?.data;
  expect(quote, JSON.stringify(answer).slice(0, 300)).toBeTruthy();
  expect(quote.notional).toBe('10000');
  // The quote is for the notional: what the trader pays is exactly 10000 USDT.
  expect(units(quote.userNotional)).toBe(units('10000'));
  // At the firm price: the same price the desk quotes a quantity request at this moment, and the quantity is the notional
  // at that price, never more.
  const byQty = await apiQuote({ qty: '0.1' });
  expect(byQty.status, JSON.stringify(byQty.body).slice(0, 300)).toBe(200);
  expect(quote.quotedPrice).toBe(byQty.body.result.data.quotedPrice);
  expect((units(quote.qty) * units(quote.quotedPrice)) / 10n ** 18n <= units('10000')).toBe(true);
  await expect(quoteCard(page)).toContainText('10,000');
  const read = await rfqGet(quote.quoteId);
  expect([read.notional, read.quotedPrice]).toEqual(['10000', quote.quotedPrice]);
});

test(`${J} #5 reviews a two-leg strategy before sending: payoff chart and greeks for the leg values; a spot RFQ shows the fee included with the house spread; a blank VIP credit reads "Not set"; the probability view is refused as not built`, async ({
  page,
}) => {
  await openDesk(page);
  const { fees } = await deskStatus();
  expect(fees?.vipCredit ?? null, 'the stack leaves the VIP volume credit blank').toBeNull();
  // A spot request: the fee is included in the house spread, named in bps.
  await expect(form(page).getByTestId('fee-line')).toHaveText(`Fee: included in the house spread of ${fees.houseSpreadBps} bps`, UNBUILT);

  await form(page).getByRole('tab', { name: 'Strategy' }).click();
  await form(page).getByRole('button', { name: 'Add a leg' }).click();
  await form(page).getByRole('button', { name: 'Add a leg' }).click();
  const leg1 = form(page).getByRole('group', { name: 'Leg 1' });
  const leg2 = form(page).getByRole('group', { name: 'Leg 2' });
  await leg1.getByRole('textbox', { name: 'Strike' }).fill('65000');
  await leg1.getByRole('textbox', { name: 'Premium' }).fill('1000');
  await leg2.getByRole('radio', { name: 'Sell' }).click();
  await leg2.getByRole('textbox', { name: 'Strike' }).fill('70000');
  await leg2.getByRole('textbox', { name: 'Premium' }).fill('400');
  await form(page).getByRole('textbox', { name: 'Spot' }).fill('65000');
  await form(page).getByRole('textbox', { name: 'Volatility' }).fill('0.6');
  await form(page).getByRole('textbox', { name: 'Years to expiry' }).fill('0.25');
  await form(page).getByRole('button', { name: 'Review' }).click();
  const review = page.getByRole('dialog', { name: 'Review your strategy' });
  // The payoff for these legs: a bull call spread loses the net premium (600) below 65000 and makes 4400 above 70000.
  await expect(review.getByRole('img', { name: 'Payoff chart' })).toBeVisible();
  await expect(review.getByTestId('payoff-max-loss')).toHaveText('-600');
  await expect(review.getByTestId('payoff-max-profit')).toHaveText('4,400');
  // Greeks for each leg's values, as numbers, from the desk's greeks read.
  const greeks = review.getByRole('table', { name: 'Greeks' });
  await expect(greeks).toBeVisible();
  for (const leg of ['Leg 1', 'Leg 2']) {
    await expect(greeks.getByRole('row', { name: new RegExp(`^${leg}\\b`) })).toContainText(/Delta\s*-?\d/);
  }
  await expect(review).toContainText(/VIP credit\s*Not set/);
  await review.getByRole('button', { name: 'Probability view' }).click();
  await expect(review.getByText('The probability view isn’t built.')).toBeVisible();
  const refused = await (await client()).get('/api/trade/trpc/rfq.probability');
  expect(codeOf(refused.body), JSON.stringify(refused.body).slice(0, 300)).toBe('trade.rfq_probability_not_built');
});

test(`${J} #6 kills all bid quotes: only bids cancel and the count shows`, async ({ page }) => {
  // One bid (a sell request) and one ask (a buy request), both open.
  const bid = await apiQuote({ qty: '0.1' }, 'sell');
  const ask = await apiQuote({ qty: '0.1' }, 'buy');
  expect([bid.status, ask.status], JSON.stringify([bid.body, ask.body]).slice(0, 300)).toEqual([200, 200]);
  const bidId = bid.body.result.data.quoteId;
  const askId = ask.body.result.data.quoteId;

  await openDesk(page);
  const killed = page.waitForResponse((res) => res.url().includes('rfq.killAll'));
  await killRegion(page).getByRole('button', { name: 'Kill all bids' }).click(UNBUILT);
  const result = [await (await killed).json()].flat()[0].result.data;
  expect(result.scope).toBe('bids');
  expect(result.quoteIds).toContain(bidId);
  expect(result.quoteIds).not.toContain(askId);
  const n = result.quoteIds.length;
  await expect(killRegion(page).getByRole('status')).toHaveText(`${n} bid ${n === 1 ? 'quote' : 'quotes'} cancelled`);
  // Only bids: every quote cancelled answered a sell request, and the ask stays open.
  for (const id of result.quoteIds) {
    const q = await rfqGet(id);
    expect([q.side, q.lifecycle, q.cancelledBy]).toEqual(['sell', 'cancelled', 'kill']);
  }
  expect((await rfqGet(askId)).lifecycle).toBe('open');
});

test(`${J} #7 sets the dead-man timer to 5 seconds, then to a valid time and lets it lapse: the first is refused as out of range; the countdown ends and open quotes cancel once; zero turns it off and says so`, async ({
  page,
}) => {
  test.setTimeout(180_000);
  await openDesk(page);
  const timer = timerRegion(page);
  const seconds = timer.getByRole('textbox', { name: 'Cancel my open quotes after, seconds' });
  await seconds.fill('5', UNBUILT);
  await timer.getByRole('button', { name: 'Set' }).click();
  await expect(timer.getByText(/Choose between \d+ and \d+ seconds, or 0 to turn it off\./)).toBeVisible();
  const refused = await (await client()).post('/api/trade/trpc/rfq.cancelAllAfter', { timeOutSec: 5 });
  expect(codeOf(refused.body), JSON.stringify(refused.body).slice(0, 300)).toBe('trade.cancel_all_after_range');

  // A valid time, with one open quote to cancel.
  const open = await apiQuote({ qty: '0.1' });
  expect(open.status, JSON.stringify(open.body).slice(0, 300)).toBe(200);
  const openId = open.body.result.data.quoteId;
  await seconds.fill('15');
  await timer.getByRole('button', { name: 'Set' }).click();
  await expect(timer.getByText(/Cancels your open quotes in \d+ s/)).toBeVisible();
  await expect(timer.getByText(/Your open quotes were cancelled \(\d+\)\./)).toBeVisible({ timeout: 60_000 });
  await expect(timer.getByText(/Cancels your open quotes in \d+ s/)).toHaveCount(0);
  const cancelled = await rfqGet(openId);
  expect([cancelled.lifecycle, cancelled.cancelledBy]).toEqual(['cancelled', 'dead_man']);
  // Once: the lapsed timer does not fire again, so a quote asked after it stays open.
  const me = await client();
  const fired = (await me.get('/api/trade/trpc/rfq.cancelAllAfterStatus')).body.result.data;
  expect([fired.armed, fired.firedAt != null, fired.cancelled >= 1]).toEqual([false, true, true]);
  const after = await apiQuote({ qty: '0.1' });
  const afterId = after.body.result.data.quoteId;
  await page.waitForTimeout(5_000);
  expect((await rfqGet(afterId)).lifecycle).toBe('open');
  const again = (await me.get('/api/trade/trpc/rfq.cancelAllAfterStatus')).body.result.data;
  expect([again.firedAt, again.cancelled]).toEqual([fired.firedAt, fired.cancelled]);

  await seconds.fill('0');
  await timer.getByRole('button', { name: 'Set' }).click();
  await expect(timer.getByText('The timer is off.')).toBeVisible();
  const off = (await me.get('/api/trade/trpc/rfq.cancelAllAfterStatus')).body.result.data;
  expect(off.armed).toBe(false);
});
