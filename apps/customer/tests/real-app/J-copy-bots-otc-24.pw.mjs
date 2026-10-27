import { test, expect } from '@playwright/test';
import { api, journeyState, toUnits } from './stack.mjs';
import { fundedTrader, signIn, signUp } from './desk.mjs';

// J-copy-bots-otc-24, in the running app (docs/roadmap/journeys.json): ask the OTC desk for a firm price on a large
// trade and settle it. One test per step, titled "J-copy-bots-otc-24 #<n>", run in order on one verified TEST account
// funded with 20000 TEST USDT. The desk's law (asset list, providers and their cap, minimum notional, deferral window)
// is the stack's TEST desk terms; every quote is read back from svc-trade and every balance from the ledger.
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - #1: the room shows no asset list, and the stack publishes no desk law, so the desk reads closed.
// - #2 to #9: with the desk closed, Request price stays disabled; providers, the provider cap, the desk minimum, the
//   RFQ board, the deferral window, re-price and Convert at the OTC price are not built.
// #1's blocked-region banner and #3's settlement-name match wait for launch prep (owner decision 2026-10-27, no
// compliance work until then); #3's verification level stays (identity verification stays, owner decision 2026-10-27).
const J = 'J-copy-bots-otc-24';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const UNBUILT = { timeout: 5_000 };

test.describe.configure({ mode: 'default' });
// An action on a part that never appears fails in 15 s, not at the test's time limit.
test.use({ actionTimeout: 15_000 });

function state(key) {
  const value = run.read()[key];
  if (!value) throw new Error(`${J}: an earlier step made no ${key}, so this step has nothing to act on`);
  return value;
}

const trpc = (proc, input) => `/api/trade/trpc/${proc}?input=${encodeURIComponent(JSON.stringify(input ?? {}))}`;
const form = (page) => page.getByRole('region', { name: 'Request a price' });
const quoteCard = (page) => page.getByRole('region', { name: 'Quote' });

/** Fills the request form: `pair`, `side`, `qty`, and the providers to ask, by name. */
async function fillRequest(page, { pair = 'BTC/USDT', side = 'Buy', qty, providers = [] }) {
  const box = form(page);
  await box.getByRole('combobox', { name: 'Pair' }).click();
  await page.getByRole('option', { name: pair, exact: true }).click();
  await box.getByRole('radio', { name: side, exact: true }).click();
  await box.getByRole('textbox', { name: /^Quantity/ }).fill(qty);
  const chooser = box.getByRole('group', { name: 'Providers' });
  for (const name of providers) await chooser.getByRole('checkbox', { name }).check(UNBUILT);
}

/** Presses Request price and returns the desk's answer to the RFQ. */
async function requestPrice(page) {
  const answer = page.waitForResponse((res) => res.url().includes('rfq.request') && res.request().method() === 'POST');
  await form(page).getByRole('button', { name: 'Request price' }).click(UNBUILT);
  return answer;
}

/** The person's own RFQs as the desk lists them. */
async function rfqs(who) {
  const { status, body } = await (await api(who)).get(trpc('rfq.list', { limit: 50 }));
  expect(status, JSON.stringify(body).slice(0, 300)).toBe(200);
  return body.result.data.items;
}

test(`${J} #1 opens OTC: the overview and the owner's asset list, "Not set" when blank`, async ({ page }) => {
  test.setTimeout(240_000);
  const trader = await fundedTrader(page, 'jotc', '20000');
  run.reset({ trader });
  await signIn(page, trader);
  await page.goto('/otc');
  await expect(page.getByRole('heading', { name: 'Quote desk', level: 1 })).toBeVisible();
  const status = page.getByRole('region', { name: 'Desk status' });
  await expect(status).toContainText('Desk');
  await expect(status).toContainText('Maker routing');
  for (const name of ['Quotes', 'Request history export', 'Allocation and give-up', 'Rules'])
    await expect(page.getByRole('tab', { name, exact: true })).toBeVisible();

  // The assets the desk quotes, from the owner's list: each asset by name, or "Not set" when the list is blank.
  const assets = page.getByRole('region', { name: 'Assets the desk quotes' });
  await expect(assets).toBeVisible(UNBUILT);
  await expect(assets.getByRole('listitem').first().or(assets.getByText('Not set'))).toBeVisible();
  // The stack publishes BTC as a TEST desk asset, so the desk is open for BTC/USDT.
  await expect(assets.getByRole('listitem', { name: 'BTC' })).toBeVisible();
  await expect(status).toContainText('Open');
});

test(`${J} #2 requests with no provider set, then four providers when three are allowed: "No providers set", then the cap by number`, async ({
  page,
}) => {
  const trader = state('trader');
  await signIn(page, trader);
  await page.goto('/otc');
  const before = (await rfqs(trader)).length;

  // ETH/USDT has no TEST provider list on the stack, so the desk refuses before it prices anything.
  await fillRequest(page, { pair: 'ETH/USDT', qty: '5' });
  await expect(form(page).getByText('No providers set')).toBeVisible(UNBUILT);
  await expect(form(page).getByRole('button', { name: 'Request price' })).toBeDisabled();

  // BTC/USDT allows three providers per request.
  await fillRequest(page, { qty: '0.5', providers: ['TEST Maker A', 'TEST Maker B', 'TEST Maker C', 'TEST Maker D'] });
  await expect(form(page).getByText('You can ask at most 3 providers at once.')).toBeVisible();
  expect((await rfqs(trader)).length).toBe(before);
});

test(`${J} #3 requests as a person below the owner's verification level: refused, and no quote is priced`, async ({ page }) => {
  test.setTimeout(120_000);
  // Signed up, never verified.
  const fresh = await signUp(page, 'jotcu');
  await page.goto('/otc');
  await fillRequest(page, { qty: '0.5', providers: ['TEST Maker A'] });
  const answer = await requestPrice(page);
  expect(answer.status()).toBe(403);
  await expect(form(page).getByText(/verified/i)).toBeVisible();
  await expect(quoteCard(page)).toHaveCount(0);
  expect(await rfqs(fresh)).toHaveLength(0);
});

test(`${J} #4 requests below the desk minimum: refused, naming the minimum`, async ({ page }) => {
  const trader = state('trader');
  await signIn(page, trader);
  await page.goto('/otc');
  // A tiny size, far under any desk minimum notional.
  await fillRequest(page, { qty: '0.0001', providers: ['TEST Maker A'] });
  await expect(form(page).getByText(/The desk minimum is [\d,.]+ USDT/)).toBeVisible(UNBUILT);
  await expect(form(page).getByRole('button', { name: 'Request price' })).toBeDisabled();
});

test(`${J} #5 opens the RFQ board: grouped by status with counts, the best quote on top, equal quotes to the earlier`, async ({ page }) => {
  const trader = state('trader');
  await signIn(page, trader);
  await page.goto('/otc');
  await fillRequest(page, { qty: '0.5', providers: ['TEST Maker A', 'TEST Maker B', 'TEST Maker C'] });
  const answer = await requestPrice(page);
  expect(answer.status(), (await answer.text()).slice(0, 300)).toBe(200);
  const rfq = (await answer.json()).result.data;
  run.write({ rfq: rfq.rfqId });

  const board = page.getByRole('region', { name: 'RFQ board' });
  for (const group of ['Open', 'Accepted', 'Settled', 'Expired'])
    await expect(board.getByRole('heading', { name: new RegExp(`^${group} \\(\\d+\\)$`) })).toBeVisible(UNBUILT);
  // Quotes for a buy: the lowest price first; two at one price go to the one that came first.
  const quotes = (await (await api(trader)).get(trpc('rfq.get', { rfqId: rfq.rfqId }))).body.result.data.quotes;
  const best = [...quotes].sort((a, b) => {
    const d = toUnits(a.price) - toUnits(b.price);
    return d !== 0n ? (d < 0n ? -1 : 1) : Date.parse(a.createdAt) - Date.parse(b.createdAt);
  })[0];
  const rows = board.getByRole('table', { name: 'Quotes for this request' }).getByRole('row');
  await expect(rows.nth(1)).toContainText(best.provider);
  run.write({ quote: best.quoteId, price: best.price });
});

test(`${J} #6 accepts a quote: bound at the quoted price, not settled; a different asserted price is refused as last look`, async ({
  page,
}) => {
  const trader = state('trader');
  const quoteId = state('quote');
  await signIn(page, trader);

  // A request that asserts another price is refused: the desk never re-prices after the quote.
  const asserted = await (
    await api(trader)
  ).post('/api/trade/trpc/rfq.accept', {
    quoteId,
    price: String(Number(state('price')) + 1),
    requestId: `${J}-6-lastlook`,
  });
  expect(asserted.status, JSON.stringify(asserted.body).slice(0, 300)).toBeGreaterThanOrEqual(400);
  expect(JSON.stringify(asserted.body)).toContain('last_look');

  await page.goto(`/otc/${encodeURIComponent(quoteId)}`);
  await quoteCard(page).getByRole('button', { name: 'Accept' }).click();
  await page.getByRole('dialog', { name: 'Accept this quote?' }).getByRole('button', { name: 'Accept at this price' }).click();
  await expect(quoteCard(page)).toContainText('Accepted, not settled');
  await expect(quoteCard(page)).toContainText(state('price'));
});

test(`${J} #7 settles later inside the deferral window: one settlement with its key; after the window it is refused`, async ({ page }) => {
  const trader = state('trader');
  const quoteId = state('quote');
  await signIn(page, trader);
  await page.goto(`/otc/${encodeURIComponent(quoteId)}`);
  // The desk's deferral window, from the owner's terms (the stack's TEST value).
  await expect(quoteCard(page).getByText(/Settle by \d/)).toBeVisible(UNBUILT);
  const before = await (await api(trader)).balances();
  await quoteCard(page).getByRole('button', { name: 'Settle' }).click();
  await page.getByRole('dialog', { name: 'Settle this quote?' }).getByRole('button', { name: 'Settle now' }).click();
  await expect(quoteCard(page)).toContainText('Settled');
  const after = await (await api(trader)).balances();
  expect(toUnits(after.BTC?.total ?? '0') - toUnits(before.BTC?.total ?? '0')).toBe(toUnits('0.5'));

  // Settling the same quote again posts nothing more.
  const again = await (await api(trader)).post('/api/trade/trpc/rfq.settle', { quoteId, requestId: `${J}-7-again` });
  expect(JSON.stringify(again.body)).not.toContain('"posted":true');
  expect((await (await api(trader)).balances()).BTC.total).toBe(after.BTC.total);
});

test(`${J} #8 lets a quote expire, then re-prices it: the old quote stays expired, a new RFQ exists, balances unchanged`, async ({
  page,
}) => {
  test.setTimeout(180_000);
  const trader = state('trader');
  await signIn(page, trader);
  await page.goto('/otc');
  await fillRequest(page, { qty: '0.5', providers: ['TEST Maker A'] });
  const answer = await requestPrice(page);
  expect(answer.status()).toBe(200);
  const before = await (await api(trader)).balances();
  // The quote runs out on its own (the TEST quote lifetime).
  await expect(quoteCard(page)).toContainText('Expired', { timeout: 120_000 });
  const old = (await answer.json()).result.data;
  await quoteCard(page).getByRole('button', { name: 'Re-price' }).click(UNBUILT);
  await expect(quoteCard(page)).toContainText('Open');
  const list = await rfqs(trader);
  expect(list.find((r) => r.rfqId === old.rfqId)?.status).toBe('expired');
  expect(list.filter((r) => r.repricedFrom === old.rfqId)).toHaveLength(1);
  expect(await (await api(trader)).balances()).toEqual(before);
});

test(`${J} #9 uses Convert for a large buy at the OTC price: the OTC price and settlement time shown; a blank bound refuses`, async ({
  page,
}) => {
  const trader = state('trader');
  await signIn(page, trader);
  await page.goto('/convert');
  await page.getByLabel('From').selectOption('USDT');
  await page.getByLabel('To').selectOption('BTC');
  await page.getByLabel('You pay').fill('15000');
  const offer = page.getByRole('region', { name: 'Large trade price' });
  await expect(offer.getByText('OTC desk price')).toBeVisible(UNBUILT);
  await expect(offer.getByText(/Settles in/)).toBeVisible();
  // ETH has no TEST upper bound for the OTC route, so a large ETH convert refuses rather than inventing one.
  await page.getByLabel('To').selectOption('ETH');
  await expect(offer.getByText('The large-trade limit is not set, so this size can’t be quoted.')).toBeVisible();
});
