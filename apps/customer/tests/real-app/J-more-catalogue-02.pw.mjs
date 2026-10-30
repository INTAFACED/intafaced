import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { api, fund, journeyState, toUnits, tool } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';
import { tableIn, bodyRows } from './tables.mjs';
import { testStrategyListing } from './market-listing.mjs';

// J-more-catalogue-02, in the running app (docs/roadmap/journeys.json): find a strategy in the Market and buy it. One test
// per step, titled "J-more-catalogue-02 #<n>". The buyer is a TEST account on the local stack, verified and funded with
// TEST USDT through the real ledger. The listing is a TEST strategy listing this run publishes through the product's own
// doors (market-listing.mjs: a TEST seller stakes, applies, is approved by the stack's TEST operators, and lists). The
// purchase is held, then released or refunded once; the steps read the buyer's ledger
// balance to check each moves once.
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - #1: /market has no listing-type switch and no four entry points to the copy, bot and signal rooms (MC-market-01).
// - #3: no listings of other kinds and no placement label (RC-more-catalogue-18 to -20).
// - #7: no reviews (MC-market-01).
const J = 'J-more-catalogue-02';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const UNBUILT = { timeout: 5_000 };

test.describe.configure({ mode: 'default' });

const usdt = async (who) => (await (await api(who)).balances()).USDT ?? { free: '0', used: '0' };

/** The buyer's purchases of this run's listing, newest first, as svc-market stores them (`myPurchases`). */
async function purchasesOf(who) {
  const { listingId } = run.read();
  const client = await api(who);
  const mine = await client.get(`/api/market/trpc/myPurchases?input=${encodeURIComponent(JSON.stringify({ limit: 50 }))}`);
  expect(mine.status, JSON.stringify(mine.body).slice(0, 300)).toBe(200);
  return mine.body.result.data.filter((row) => row.listingId === listingId);
}

async function openMarket(page) {
  await signIn(page, run.read().who);
  await page.goto('/market');
  await expect(page.getByRole('heading', { name: 'Market', level: 1 })).toBeVisible();
}

async function openListing(page) {
  await openMarket(page);
  const card = page.getByRole('article').filter({ hasText: run.read().title });
  await expect(card).toBeVisible(UNBUILT);
  await card.getByRole('button', { name: /View/ }).click();
  return page.getByRole('dialog');
}

test(`${J} starts: a verified TEST account with 100 USDT, and an approved TEST seller's TEST strategy listing`, async ({ page }) => {
  test.setTimeout(240_000);
  const title = `TEST strategy with a refund window ${Date.now().toString(36)}`;
  const { seller, listing } = await testStrategyListing(page, { title });
  expect(listing).toMatchObject({ title, offerType: 'subscription', status: 'active' });
  const who = await signUp(page, 'mk');
  await verify(page, who);
  expect(fund(who.email, 'USDT', '100').tx).toBeTruthy();
  run.reset({ who, seller, title, listingId: listing.id });
});

test(`${J} #1 opens /market: listings with terms, a listing-type switch and four entry points to their own rooms, ordered by registration, price or title, never by returns`, async ({
  page,
}) => {
  await openMarket(page);
  const types = page.getByRole('radiogroup', { name: 'Listing type' });
  await expect(types.getByRole('radio', { name: 'Access listing' })).toBeVisible(UNBUILT);
  await expect(types.getByRole('radio', { name: 'Strategy subscription' })).toBeVisible();
  const doors = page.getByRole('navigation', { name: 'More in the Market' });
  for (const door of ['Spot copy trading', 'Futures copy trading', 'Bot marketplace', 'Signal marketplace']) {
    await expect(doors.getByRole('link', { name: new RegExp(door) })).toBeVisible();
  }
  const sort = page.getByRole('combobox', { name: 'Sort by' });
  const options = await sort.getByRole('option').allInnerTexts();
  expect(options).toEqual(expect.arrayContaining(['Newest', 'Price', 'Title']));
  expect(options.join(' ')).not.toMatch(/return|profit|performance/i);
});

test(`${J} #2 opens a listing by id: the seller profile, review summary and performance with its stated basis; an unknown id is a typed not-found`, async ({
  page,
}) => {
  const listing = await openListing(page);
  await expect(listing.getByRole('region', { name: 'Seller' })).toBeVisible();
  await expect(listing.getByRole('region', { name: 'Reviews' })).toBeVisible();
  await expect(listing.getByRole('region', { name: 'Performance' })).toContainText(/Basis:/);
  await page.goto('/market/listing/00000000-0000-4000-8000-000000000000');
  await expect(page.getByRole('main')).toContainText('No listing has this id.');
});

test(`${J} #3 browses vendor listings of other kinds (signals, data, indicators) and sees premium placement: the category taxonomy and lifecycle for every kind, and placement labelled`, async ({
  page,
}) => {
  await openMarket(page);
  const kinds = page.getByRole('combobox', { name: 'Category' });
  await expect(kinds).toBeVisible(UNBUILT);
  for (const kind of ['Signals', 'Data', 'Indicators']) await expect(kinds.getByRole('option', { name: kind })).toBeAttached();
  const placed = page.getByRole('article').filter({ has: page.getByText('Promoted placement') });
  for (const card of await placed.all()) await expect(card.getByText('Promoted placement')).toBeVisible();
});

test(`${J} #4 presses Buy on the strategy: the charge into the held account once, the record shows held, and the seller sees nothing yet`, async ({
  page,
}) => {
  const { who, seller, title } = run.read();
  const before = await usdt(who);
  const sellerBefore = await usdt(seller);
  const listing = await openListing(page);
  const price = /([\d.]+) USDT/.exec((await listing.getByRole('group', { name: 'Price' }).textContent()) ?? '')?.[1];
  expect(price).toBeTruthy();
  await listing.getByRole('button', { name: 'Buy' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Confirm purchase' }).click();
  // The page also carries the stack's own TEST banner as a status, so the outcome is read where the buyer is: the listing.
  await expect(listing.getByRole('status')).toContainText('Held until the refund window ends');
  expect(toUnits((await usdt(who)).free)).toBe(toUnits(before.free) - toUnits(price));
  // The record, read back from the service, is held with its refund window; the seller's balance has not moved.
  const [bought, ...more] = await purchasesOf(who);
  expect(more).toHaveLength(0);
  expect(bought).toMatchObject({ status: 'held', flow: 'hold', outcome: null, outcomeTxId: null, refundRequestedAt: null });
  expect(toUnits(bought.price)).toBe(toUnits(price));
  expect(Date.parse(bought.refundWindowEndsAt)).toBeGreaterThan(Date.now());
  expect(await usdt(seller)).toEqual(sellerBefore);
  await page.goto('/market/purchases');
  await expect(tableIn(page, 'Your purchases').getByRole('row', { name: new RegExp(title) })).toContainText(
    'Held until the refund window ends',
  );
  run.write({ price, purchaseId: bought.id });
});

test(`${J} #5 presses Buy again, or loses the reply: one purchase, and the screen re-reads the stored state`, async ({ page }) => {
  const { who, price } = run.read();
  expect(price, 'a purchase from #4').toBeTruthy();
  const before = await usdt(who);
  const listing = await openListing(page);
  await expect(listing.getByRole('button', { name: 'Buy' })).toBeDisabled();
  await expect(listing).toContainText('You own this. Held until the refund window ends.');
  await page.goto('/market/purchases');
  await expect(tableIn(page, 'Your purchases').getByRole('row', { name: new RegExp(run.read().title) })).toHaveCount(1);
  expect(await usdt(who)).toEqual(before);
});

/**
 * Market restarted with the owner's refund policy blank, or back on the stack's TEST policy
 * (tooling/profiles/test-owner-values/market.json). The stack sets the policy by default, so #6 sets up "undecided" itself.
 */
function marketRefundPolicy(on) {
  const before = process.env.LOCAL_STACK_MARKET_REFUND_POLICY;
  if (on) delete process.env.LOCAL_STACK_MARKET_REFUND_POLICY;
  else process.env.LOCAL_STACK_MARKET_REFUND_POLICY = 'off';
  try {
    tool('local-test-stack.mjs', 'restart', 'market');
  } finally {
    if (before === undefined) delete process.env.LOCAL_STACK_MARKET_REFUND_POLICY;
    else process.env.LOCAL_STACK_MARKET_REFUND_POLICY = before;
  }
}

/** The ledger's own record of a business key (svc-ledger's lookup door, read by the stack's TEST founder). */
let operator;
async function booked(key) {
  const gates = await import('../../../../tooling/scripts/local-test-gates.mjs');
  operator ??= await gates.makeContext({ log: () => undefined, shareSessions: true });
  return gates.ledgerTrace(operator, key);
}

const sumOf = (postings) => postings.reduce((total, e) => total + toUnits(e.amount), 0n);

/** The hold under `market:hold:<id>`, booked once: the price from the buyer's available into an empty pot. */
async function heldOnce(purchaseId, price) {
  const hold = await booked(`market:hold:${purchaseId}`);
  expect(hold).toMatchObject({ found: true, module: 'market', reason: 'market.purchase.held' });
  expect(hold.postings).toHaveLength(2);
  const from = hold.postings.find((e) => e.side === 'source');
  const pot = hold.postings.find((e) => e.side === 'destination');
  expect(from).toMatchObject({ assetId: 'USDT', direction: 'credit' });
  expect(pot).toMatchObject({ assetId: 'USDT', direction: 'debit' });
  expect([toUnits(from.amount), toUnits(pot.amount), toUnits(pot.balanceBefore), toUnits(pot.balanceAfter)]).toEqual([
    toUnits(price),
    toUnits(price),
    0n,
    toUnits(price),
  ]);
  return { txId: hold.txId, pot: pot.accountId };
}

/** The pot emptied by one outcome: its only source leg takes the whole price out of `pot`, leaving it at zero. */
function emptiesPot(trace, pot, price) {
  const out = trace.postings.filter((e) => e.side === 'source');
  expect(out.map((e) => [e.accountId, toUnits(e.amount), toUnits(e.balanceAfter)])).toEqual([[pot, toUnits(price), 0n]]);
}

/** A refused market call: its typed code, exactly, from the service's error body. */
const refusedWith = (reply) => [reply.status, reply.body?.error?.message ?? reply.body?.error?.json?.message];

test(`${J} #6 requests a refund inside the window: the amount returns once; with the refund policy undecided the refund shows its named blocker`, async ({
  page,
  browser,
}) => {
  const { who, seller, title, price, purchaseId } = run.read();
  expect(purchaseId, 'a purchase from #4').toBeTruthy();
  test.setTimeout(420_000);
  // The buyer holds a real USDT row (never the zero fallback), with the price held in `used`; a new seller has none yet.
  expect((await (await api(who)).balances()).USDT, "the buyer's USDT balance row").toBeDefined();
  const before = await usdt(who);
  const sellerBefore = await usdt(seller);
  expect(toUnits(before.used)).toBeGreaterThanOrEqual(toUnits(price));
  await signIn(page, who);
  const row = tableIn(page, 'Your purchases').getByRole('row', { name: new RegExp(title) });
  // The refund policy undecided (blank): the refund shows its named blocker, moves nothing, and the purchase stays held.
  marketRefundPolicy(false);
  try {
    const programme = await (await api(who)).get('/api/market/trpc/commerceProgramme');
    expect(programme.body?.result?.data, JSON.stringify(programme.body).slice(0, 300)).toMatchObject({ refundPolicy: null });
    await page.goto('/market/purchases');
    const blocker = row.getByRole('note').filter({ hasText: 'The refund policy is not set' });
    await expect(blocker).toBeVisible();
    await expect(blocker).toHaveAttribute('data-code', 'owner.decision');
    await expect(blocker).toContainText('owner.decision');
    await row.getByRole('button', { name: 'Ask for a refund' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Request refund' }).click();
    await expect(
      page.getByRole('main').getByTestId('failure').filter({ hasText: 'The refund policy is not set. No refund can be asked for or made' }),
    ).toBeVisible();
    // The service's own answer to the buyer's request and to the seller's refund: the typed code, exactly.
    expect(refusedWith(await (await api(who)).post('/api/market/trpc/requestRefund', { purchaseId }))).toEqual([412, 'owner.decision']);
    expect(refusedWith(await (await api(seller)).post('/api/market/trpc/refund', { purchaseId }))).toEqual([412, 'owner.decision']);
    // The seller, who makes the refund, sees the same named blocker in their Refund requests, and no request to act on.
    const sellerBlank = await (await browser.newContext()).newPage();
    await signIn(sellerBlank, seller);
    await sellerBlank.goto('/market/mine');
    const requests = sellerBlank
      .getByRole('main')
      .locator('section')
      .filter({ has: sellerBlank.getByRole('heading', { name: 'Refund requests', level: 2 }) });
    const sellerBlocker = requests.getByRole('note').filter({ hasText: 'The refund policy is not set' });
    await expect(sellerBlocker).toBeVisible();
    await expect(sellerBlocker).toHaveAttribute('data-code', 'owner.decision');
    await expect(sellerBlocker).toContainText('owner.decision');
    await expect(requests.getByRole('row', { name: new RegExp(title) })).toHaveCount(0);
    await sellerBlank.context().close();
    // Re-read: still held, never asked, no outcome; neither balance moved.
    const [unchanged] = await purchasesOf(who);
    expect(unchanged).toMatchObject({ id: purchaseId, status: 'held', refundRequestedAt: null, outcome: null, outcomeTxId: null });
    expect(await usdt(who)).toEqual(before);
    expect(await usdt(seller)).toEqual(sellerBefore);
  } finally {
    marketRefundPolicy(true);
  }
  // The policy set again (the stack's TEST value, read back), and the buyer asks inside the window. Asking moves nothing.
  const restored = await (await api(who)).get('/api/market/trpc/commerceProgramme');
  expect(restored.body?.result?.data, JSON.stringify(restored.body).slice(0, 300)).toMatchObject({ refundPolicy: 'seller_full' });
  const [open] = await purchasesOf(who);
  expect(open).toMatchObject({ id: purchaseId, status: 'held' });
  expect(Date.parse(open.refundWindowEndsAt)).toBeGreaterThan(Date.now());
  await page.goto('/market/purchases');
  await expect(row.getByRole('button', { name: 'Ask for a refund' })).toBeEnabled();
  await expect(row.getByRole('note').filter({ hasText: 'The refund policy is not set' })).toHaveCount(0);
  await row.getByRole('button', { name: 'Ask for a refund' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Request refund' }).click();
  await expect(page.getByRole('main').getByRole('status').filter({ hasText: 'Refund requested.' })).toBeVisible();
  await expect(row).toContainText('Held · refund requested');
  await expect(row.getByRole('button', { name: 'Ask for a refund' })).toBeDisabled();
  expect(await usdt(who)).toEqual(before);
  // The seller decides in their own workspace and refunds: the whole price returns to the buyer once.
  const sellerPage = await (await browser.newContext()).newPage();
  await signIn(sellerPage, seller);
  await sellerPage.goto('/market/mine');
  const asked = tableIn(sellerPage, 'Refund requests').getByRole('row', { name: new RegExp(title) });
  await asked.getByRole('button', { name: 'Refund' }).click();
  await sellerPage.getByRole('dialog').getByRole('button', { name: 'Refund the buyer' }).click();
  await expect(sellerPage.getByRole('main').getByRole('status').filter({ hasText: 'Refunded.' })).toBeVisible();
  await expect(asked).toHaveCount(0);
  // The whole price comes back: out of the held `used` and into `free`.
  const refunded = await usdt(who);
  expect(toUnits(refunded.free)).toBe(toUnits(before.free) + toUnits(price));
  expect(toUnits(refunded.used)).toBe(toUnits(before.used) - toUnits(price));
  expect(await usdt(seller)).toEqual(sellerBefore);
  // Once: the seller's retry answers with the stored refund and moves nothing again.
  const retry = await (await api(seller)).post('/api/market/trpc/refund', { purchaseId });
  expect(retry.body?.result?.data, JSON.stringify(retry.body).slice(0, 300)).toMatchObject({ id: purchaseId, status: 'refunded' });
  const [stored] = await purchasesOf(who);
  expect(stored).toMatchObject({ id: purchaseId, status: 'refunded', outcome: 'refund' });
  expect(stored.outcomeTxId).toBeTruthy();
  // And the buyer cannot ask again: the purchase is no longer held.
  expect(refusedWith(await (await api(who)).post('/api/market/trpc/requestRefund', { purchaseId }))).toEqual([
    409,
    'market.refund_not_held',
  ]);
  const [still] = await purchasesOf(who);
  expect(still).toMatchObject({ id: purchaseId, status: 'refunded', outcome: 'refund', outcomeTxId: stored.outcomeTxId });
  expect(await usdt(who)).toEqual(refunded);
  expect(await usdt(seller)).toEqual(sellerBefore);
  await page.reload();
  await expect(row).toContainText('Refunded');
  await expect(row.getByRole('link', { name: 'Receipt' })).toHaveCount(0);
  // Or the window ends. Two more purchases, held in the same seconds: the buyer's companion is left alone and released by
  // the sweep once its window ends; a second TEST buyer's racer (one held purchase per buyer and listing) gets the
  // seller's refund sent every 150 ms across its window's end, racing the sweep. Each gets exactly one outcome, read back
  // from the ledger by its business key, and the companion's release shows the sweep really ran past both windows' end.
  const { listingId } = run.read();
  const otherPage = await (await browser.newContext()).newPage();
  const other = await signUp(otherPage, 'mkr');
  await verify(otherPage, other);
  expect(fund(other.email, 'USDT', '100').tx).toBeTruthy();
  await otherPage.context().close();
  const otherStart = await usdt(other);
  const buyerStart = await usdt(who);
  const sellerStart = await usdt(seller);
  await page.goto('/market');
  await page.getByRole('article').filter({ hasText: title }).getByRole('button', { name: /^Buy/ }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Confirm purchase' }).click();
  await expect(page.getByRole('main').getByRole('status').filter({ hasText: 'Held until the refund window ends' })).toBeVisible();
  const [second] = await purchasesOf(who);
  expect(second).toMatchObject({ status: 'held', flow: 'hold', outcome: null });
  expect(second.id).not.toBe(purchaseId);
  const bought = await (await api(other)).post('/api/market/trpc/purchase', { listingId, purchaseId: randomUUID() });
  expect(bought.status, JSON.stringify(bought.body).slice(0, 300)).toBe(200);
  const racer = bought.body.result.data;
  expect(racer).toMatchObject({ status: 'held', flow: 'hold', outcome: null });
  const companionPot = (await heldOnce(second.id, price)).pot;
  const racePot = (await heldOnce(racer.id, price)).pot;
  const ends = Date.parse(racer.refundWindowEndsAt);
  const companionEnds = Date.parse(second.refundWindowEndsAt);
  expect(Math.abs(companionEnds - ends)).toBeLessThan(10_000);
  expect(Date.now(), 'the race starts before the window ends').toBeLessThan(ends - 1_000);
  const sellerAsker = await api(seller);
  const asks = [];
  for (let at = ends - 1_000; at <= ends + 1_000; at += 150) {
    await new Promise((r) => setTimeout(r, Math.max(0, at - Date.now())));
    const sentAt = Date.now();
    asks.push(sellerAsker.post('/api/market/trpc/refund', { purchaseId: racer.id }).then((answer) => ({ ...answer, sentAt })));
  }
  const answers = await Promise.all(asks);
  // Every answer is the stored refund or the typed too-late refusal; every ask sent well inside the window refunded.
  for (const answer of answers) {
    if (answer.status === 200) expect(answer.body.result.data).toMatchObject({ id: racer.id, status: 'refunded', outcome: 'refund' });
    else expect(refusedWith(answer)).toEqual([409, 'market.refund_not_held']);
  }
  const inside = answers.filter((answer) => answer.sentAt < ends - 500);
  expect(inside.length).toBeGreaterThan(0);
  expect(inside.map((answer) => answer.status)).toEqual(inside.map(() => 200));
  // The sweep's run past the window's end is seen, not assumed: it released the companion, once, out of its pot, and
  // only after its window ended.
  await expect
    .poll(async () => (await purchasesOf(who)).find((p) => p.id === second.id)?.status, { timeout: 200_000, intervals: [2_000] })
    .toBe('released');
  const released = (await purchasesOf(who)).find((p) => p.id === second.id);
  const release = await booked(`market:release:${second.id}`);
  expect(release).toMatchObject({ found: true, module: 'market', reason: 'market.purchase.released' });
  expect(released).toMatchObject({ status: 'released', outcome: 'release', outcomeTxId: release.txId });
  expect(toUnits(released.price)).toBe(toUnits(price));
  expect(Date.parse(released.outcomeAt)).toBeGreaterThanOrEqual(companionEnds);
  emptiesPot(release, companionPot, released.price);
  const net = toUnits(released.price) - (toUnits(released.price) * BigInt(released.commissionBps)) / 10_000n;
  const legs = release.postings.filter((e) => e.side === 'destination').map((e) => toUnits(e.amount));
  expect(legs.sort()).toEqual([toUnits(released.price) - net, net].filter((amount) => amount > 0n).sort());
  expect(await booked(`market:refund:${second.id}:1`)).toMatchObject({ found: false });
  // The racer: refunded once, and the same sweep run left it unreleased.
  const refund = await booked(`market:refund:${racer.id}:1`);
  expect(refund).toMatchObject({ found: true, module: 'market', reason: 'market.purchase.refunded' });
  emptiesPot(refund, racePot, price);
  expect(await booked(`market:release:${racer.id}`)).toMatchObject({ found: false });
  const raced = (await purchasesOf(other)).find((p) => p.id === racer.id);
  expect(raced).toMatchObject({ status: 'refunded', outcome: 'refund', outcomeTxId: refund.txId });
  // The seller's real balance row gains the companion's net, once; the second buyer has the racer's price back, and the
  // buyer's companion price has left for good.
  expect((await sellerAsker.balances()).USDT, "the seller's USDT balance row").toBeDefined();
  const sellerAfter = await usdt(seller);
  expect(toUnits(sellerAfter.free)).toBe(toUnits(sellerStart.free) + net);
  const buyerAfter = await usdt(who);
  expect(toUnits(buyerAfter.free)).toBe(toUnits(buyerStart.free) - toUnits(price));
  expect(toUnits(buyerAfter.used)).toBe(toUnits(buyerStart.used));
  const otherAfter = await usdt(other);
  expect([toUnits(otherAfter.free), toUnits(otherAfter.used)]).toEqual([toUnits(otherStart.free), toUnits(otherStart.used)]);
  // Once: two more sweeps (5 s each on the stack) post nothing again, and neither record changes.
  await page.waitForTimeout(12_000);
  expect(await usdt(seller)).toEqual(sellerAfter);
  expect(await usdt(who)).toEqual(buyerAfter);
  expect(await usdt(other)).toEqual(otherAfter);
  const settled = [...(await purchasesOf(who)), ...(await purchasesOf(other))];
  expect(settled.find((p) => p.id === second.id)).toMatchObject({ status: 'released', outcomeTxId: release.txId });
  expect(settled.find((p) => p.id === racer.id)).toMatchObject({ status: 'refunded', outcomeTxId: refund.txId });
  expect(await booked(`market:release:${racer.id}`)).toMatchObject({ found: false });
  expect(await booked(`market:refund:${second.id}:1`)).toMatchObject({ found: false });
  // Reconciliation over every purchase of this run's listing by both buyers, from the ledger by key: each pot pays out exactly what it
  // held, through one outcome; both outcomes occur, so the totals can't agree by being zero.
  let held = 0n;
  let paidOut = 0n;
  const kinds = new Set();
  for (const p of settled) {
    const hold = await booked(`market:hold:${p.id}`);
    expect(hold.found, `purchase ${p.id} was held`).toBe(true);
    const back = await booked(`market:refund:${p.id}:1`);
    const on = await booked(`market:release:${p.id}`);
    expect([back.found, on.found].filter(Boolean), `purchase ${p.id} has exactly one outcome`).toHaveLength(1);
    const into = sumOf(hold.postings.filter((e) => e.side === 'destination'));
    const outOf = sumOf((back.found ? back : on).postings.filter((e) => e.side === 'destination'));
    expect(outOf, `purchase ${p.id} pays out what it held`).toBe(into);
    kinds.add(back.found ? 'refund' : 'release');
    held += into;
    paidOut += outOf;
  }
  expect([...kinds].sort()).toEqual(['refund', 'release']);
  expect(held).toBeGreaterThan(0n);
  expect(paidOut).toBe(held);
  await page.goto('/market/purchases');
  await expect(bodyRows(tableIn(page, 'Your purchases')).filter({ hasText: 'Released to the seller' })).toHaveCount(1);
  run.write({ releasedId: second.id });
});

test(`${J} #7 writes a review after a settled purchase: one review stored, a second refused as already reviewed, and a visitor with no purchase refused`, async ({
  page,
}) => {
  const listing = await openListing(page);
  await listing.getByRole('button', { name: 'Write a review' }).click(UNBUILT);
  const form = page.getByRole('form', { name: 'Your review' });
  await form.getByRole('textbox', { name: 'Review' }).fill('TEST review');
  await form.getByRole('button', { name: 'Post review' }).click();
  await expect(page.getByRole('status')).toContainText('Review posted');
  await listing.getByRole('button', { name: 'Write a review' }).click();
  await expect(page.getByRole('alert')).toContainText('You have already reviewed this listing.');
});

test(`${J} #8 opens /market/purchases: price, window and status for each; a pending settlement is not shown as a receipt`, async ({
  page,
}) => {
  const { who, title, releasedId } = run.read();
  expect(releasedId, 'the purchase #6 let its window end on').toBeTruthy();
  await signIn(page, who);
  // A held purchase (money not yet with the seller) next to a released one: only the released one is a receipt.
  await page.goto('/market');
  const card = page.getByRole('article').filter({ hasText: title });
  await card.getByRole('button', { name: /^Buy/ }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Confirm purchase' }).click();
  await expect(page.getByRole('main').getByRole('status').filter({ hasText: 'Held until the refund window ends' })).toBeVisible();
  const [held] = await purchasesOf(who);
  expect(held.status).toBe('held');
  await page.goto('/market/purchases');
  const table = tableIn(page, 'Your purchases');
  await expect(table).toBeVisible(UNBUILT);
  for (const column of ['Price', 'Refund window', 'Status']) await expect(table.getByRole('columnheader', { name: column })).toBeVisible();
  const rows = bodyRows(table);
  await expect(rows).toHaveCount(
    (await (await api(who)).get(`/api/market/trpc/myPurchases?input=${encodeURIComponent('{"limit":50}')}`)).body.result.data.length,
  );
  const heldRow = rows.filter({ hasText: 'Held until the refund window ends' });
  await expect(heldRow).toHaveCount(1);
  await expect(heldRow).toContainText(/\d/);
  await expect(heldRow.getByRole('link', { name: 'Receipt' })).toHaveCount(0);
  // The purchase #6 let its window end was released to the seller: that one is a receipt.
  expect((await purchasesOf(who)).find((row) => row.id === releasedId)?.status).toBe('released');
  const released = rows.filter({ hasText: 'Released to the seller' });
  await expect(released).toHaveCount(1);
  await expect(released.getByRole('link', { name: 'Receipt' })).toHaveCount(1);
});
