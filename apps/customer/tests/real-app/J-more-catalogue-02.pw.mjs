import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { api, fund, journeyState, tool, toUnits } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';
import { testStrategyListing } from './market-listing.mjs';
import { ledgerAccounts, ledgerTrace, makeContext } from '../../../../tooling/scripts/local-test-gates.mjs';

// J-more-catalogue-02, in the running app (docs/roadmap/journeys.json): find a strategy in the Market and buy it. One test
// per step, titled "J-more-catalogue-02 #<n>", run in order. No real value moves: the buyer and the seller are TEST
// accounts on the local stack, funded with TEST assets through the real ledger.
// The start is built through the product's own doors, never injected (market-listing.mjs): a TEST seller stakes, applies,
// is approved by the stack's two TEST operators and publishes a strategy subscription at 10 TEST USDT, titled for this run.
// The stack runs svc-market with the TEST commission and a TEST one-hour refund window
// (tooling/profiles/test-owner-values/market.json), so a purchase is held in the buyer's own pot until the window ends.
// Step 6's "refund policy undecided" restarts market with the window unset (LOCAL_STACK_MARKET_REFUND_POLICY=off), reads
// the refusal, then restarts it with the TEST window, in a try/finally. Its "lets the window end" restarts market with a
// TEST 20-second window (LOCAL_STACK_MARKET_REFUND_POLICY=short) the same way, so the release job is seen paying out.
// Money is read from svc-ledger itself, by business key (`local-test-gates.mjs` ledgerTrace, the operator lookup door):
// `market:hold:<purchase>`, `market:release:<purchase>` and `market:refund:<purchase>:1`.
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - #1: /market has no listing-type switch and no four entry points to the copy, bot and signal rooms (MC-market-01).
// - #2: no listing page by id with seller profile, review summary and performance (MC-market-01).
// - #3: no listings of other kinds and no placement label (RC-more-catalogue-18 to -20).
// - #7: no review after a released purchase (MC-market-02).
const J = 'J-more-catalogue-02';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const UNBUILT = { timeout: 5_000 };
const PRICE = '10';
const PERIOD_SECONDS = 2_592_000;

test.describe.configure({ mode: 'default' });

const data = (res) => res.body?.result?.data;
const causeOf = (body) => body?.error?.data?.cause;
const trpcInput = (input) => `?input=${encodeURIComponent(JSON.stringify(input))}`;
const usdt = async (who) => (await (await api(who)).balances()).USDT ?? { free: '0', used: '0', total: '0' };

async function ok(res) {
  expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
  return data(res);
}

/** My purchases as svc-market keeps them: the inventory every screen read is checked against. */
async function myPurchases(who) {
  return ok(await (await api(who)).get(`/api/market/trpc/myPurchases${trpcInput({ limit: 50 })}`));
}

async function catalogue(who) {
  return ok(await (await api(who)).get(`/api/market/trpc/listings${trpcInput({ limit: 50 })}`));
}

async function openMarket(page, who) {
  await signIn(page, who);
  await page.goto('/market');
  await expect(page.getByRole('heading', { name: 'Market', level: 1 })).toBeVisible();
}

const card = (page, title) => page.getByRole('article').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
const purchasesRoom = (page) => page.getByRole('region', { name: 'Your purchases' }).last();
const purchaseRow = (page, id) => purchasesRoom(page).getByRole('article', { name: `Purchase ${id}`, exact: true });

async function openPurchases(page, who) {
  await signIn(page, who);
  await page.goto('/market/purchases');
  await expect(purchasesRoom(page)).toBeVisible();
}

/**
 * Market restarted with a refund policy, as the token lane's restarts do (J-more-catalogue-09): 'test' is the TEST hour,
 * 'off' leaves the window blank, 'short' holds a new purchase for a TEST 20 seconds.
 */
function refundPolicy(mode) {
  const before = process.env.LOCAL_STACK_MARKET_REFUND_POLICY;
  if (mode === 'test') delete process.env.LOCAL_STACK_MARKET_REFUND_POLICY;
  else process.env.LOCAL_STACK_MARKET_REFUND_POLICY = mode;
  try {
    tool('local-test-stack.mjs', 'restart', 'market');
  } finally {
    if (before === undefined) delete process.env.LOCAL_STACK_MARKET_REFUND_POLICY;
    else process.env.LOCAL_STACK_MARKET_REFUND_POLICY = before;
  }
}

let operator;
/** svc-ledger's own record of a business key, read through the operator lookup door. A read: nothing posts. */
async function booked(key) {
  operator ??= await makeContext({ log: () => undefined, shareSessions: true });
  return ledgerTrace(operator, key);
}

/** The house's market fee account for USDT, from svc-ledger. */
async function houseFees() {
  operator ??= await makeContext({ log: () => undefined, shareSessions: true });
  const [account] = (await ledgerAccounts(operator, 'house:fees:market')).filter((a) => a.assetId === 'USDT' && a.kind === 'available');
  expect(account, 'the house market fee account').toBeTruthy();
  return account;
}

/** The ledger's hold of one purchase: the buyer's available USDT down by the price, into the purchase's own pot, once. */
async function heldOnce(purchaseId, price) {
  const hold = await booked(`market:hold:${purchaseId}`);
  expect(hold).toMatchObject({ found: true, module: 'market', reason: 'market.purchase.held' });
  expect(hold.postings).toHaveLength(2);
  const from = hold.postings.find((e) => e.side === 'source');
  const pot = hold.postings.find((e) => e.side === 'destination');
  expect(from).toMatchObject({ assetId: 'USDT', direction: 'credit', amount: price });
  expect(pot).toMatchObject({ assetId: 'USDT', direction: 'debit', amount: price, balanceBefore: '0', balanceAfter: price });
  return { tx: hold.txId, pot: pot.accountId, buyerAccount: from.accountId };
}

/** The listing's price as svc-market publishes it in the catalogue. */
async function priceOf(who, listingId) {
  const [listing] = (await catalogue(who)).filter((l) => l.id === listingId);
  expect(listing, 'the stack listing in the catalogue').toBeTruthy();
  return listing.price;
}

/** The house commission rate svc-market publishes (the stack's labelled TEST value), in basis points. */
async function commissionBps(who) {
  const programme = await ok(await (await api(who)).get('/api/market/trpc/commerceProgramme'));
  expect(programme).toMatchObject({ commissionConfigured: true });
  return BigInt(programme.commissionBps);
}

/** The commission and seller net of a release of `price` at `bps`, floored as the release recipe floors it. */
function split(price, bps) {
  const commission = (toUnits(price) * bps) / 10_000n;
  return { commission, net: toUnits(price) - commission };
}

/** A decimal as a literal in a RegExp. */
const literal = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** One purchase of `listingId` pressed through the page; returns svc-market's answer. */
async function buyOnPage(page, who, title) {
  await openMarket(page, who);
  const listing = card(page, title);
  await listing.getByRole('button', { name: `Buy ${title}` }).click();
  const bought = page.waitForResponse((r) => new URL(r.url()).pathname.endsWith('/api/market/trpc/purchase'));
  await page.getByRole('dialog').getByRole('button', { name: 'Confirm purchase' }).click();
  const answer = await bought;
  expect(answer.status()).toBe(200);
  return (await answer.json()).result.data;
}

/** svc-market's record of one of my purchases, re-read. */
async function purchaseOf(who, purchaseId) {
  const rows = (await myPurchases(who)).filter((p) => p.id === purchaseId);
  expect(rows).toHaveLength(1);
  return rows[0];
}

/** The status a buyer reads for a purchase, from svc-market's own record. */
const statusOf = (p) =>
  ({ held: 'Held', refunded: 'Refunded', released: 'Released' })[p.hold?.state] ??
  { settled: 'Settled', pending: 'Pending', rejected: 'Rejected' }[p.status];
/** The heading an inspected purchase shows: only a released or direct sale is a settlement receipt. */
const receiptOf = (p) =>
  ({ held: 'Held until the refund window ends', refunded: 'Refunded', released: 'Settlement recorded' })[p.hold?.state] ??
  { settled: 'Settlement recorded', pending: 'Settlement not confirmed', rejected: 'Purchase rejected' }[p.status];

test(`${J} starts: a verified TEST account with 100 USDT, and an approved TEST seller's TEST strategy listing with a refund window`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  const title = `TEST strategy with a refund window ${Date.now().toString(36)}`;
  const { seller, listing } = await testStrategyListing(page, { title, price: PRICE, periodSeconds: PERIOD_SECONDS });
  expect(listing).toMatchObject({ title, offerType: 'subscription', status: 'active' });
  const who = await signUp(page, 'mk');
  await verify(page, who);
  expect(fund(who.email, 'USDT', '100').tx).toBeTruthy();
  expect((await catalogue(who)).filter((l) => l.id === listing.id)).toEqual([
    expect.objectContaining({ title, price: PRICE, assetId: 'USDT', status: 'active' }),
  ]);
  run.reset({ who, seller, title, listingId: listing.id });
});

test(`${J} #1 opens /market: listings with terms, a listing-type switch and four entry points to their own rooms, ordered by registration, price or title, never by returns`, async ({
  page,
}) => {
  await openMarket(page, run.read().who);
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
  const { who, listingId } = run.read();
  await signIn(page, who);
  await page.goto(`/market/listing/${listingId}`);
  const listing = page.getByRole('main');
  await expect(listing.getByRole('region', { name: 'Seller' })).toBeVisible(UNBUILT);
  await expect(listing.getByRole('region', { name: 'Reviews' })).toBeVisible();
  await expect(listing.getByRole('region', { name: 'Performance' })).toContainText(/Basis:/);
  await page.goto('/market/listing/00000000-0000-4000-8000-000000000000');
  await expect(page.getByRole('main')).toContainText('No listing has this id.');
});

test(`${J} #3 browses vendor listings of other kinds (signals, data, indicators) and sees premium placement: the category taxonomy and lifecycle for every kind, and placement labelled`, async ({
  page,
}) => {
  await openMarket(page, run.read().who);
  const kinds = page.getByRole('combobox', { name: 'Category' });
  await expect(kinds).toBeVisible(UNBUILT);
  for (const kind of ['Signals', 'Data', 'Indicators']) await expect(kinds.getByRole('option', { name: kind })).toBeAttached();
  await expect(page.getByText('Promoted placement').first()).toBeVisible();
});

test(`${J} #4 presses Buy on the strategy: the charge into the held account once, the record shows held, and the seller sees nothing yet`, async ({
  page,
}) => {
  const { who, seller, title, listingId } = run.read();
  const price = await priceOf(who, listingId);
  const before = await usdt(who);
  const sellerBefore = await usdt(seller);
  const feesBefore = await houseFees();
  await openMarket(page, who);
  await expect(card(page, title).getByRole('group', { name: 'Price' })).toHaveText(price);
  const purchase = await buyOnPage(page, who, title);
  await expect(page.getByRole('status').filter({ hasText: 'Held until the refund window ends.' })).toBeVisible();
  // Charged once, into the held account: svc-ledger booked one hold under market:hold:<purchase>, the buyer's available
  // USDT out by the price and into the purchase's own pot, which held nothing before.
  const hold = await heldOnce(purchase.id, price);
  const after = await usdt(who);
  expect(toUnits(after.free)).toBe(toUnits(before.free) - toUnits(price));
  // Still the buyer's: the price sits in their held funds, not spent, so the total is unchanged.
  expect(toUnits(after.used)).toBe(toUnits(before.used) + toUnits(price));
  expect(toUnits(after.total)).toBe(toUnits(before.total));
  // The record shows held: one purchase of this listing, one hold of exactly the price, its window one TEST hour.
  const mine = (await myPurchases(who)).filter((p) => p.listingId === listingId);
  expect(mine).toEqual([expect.objectContaining({ id: purchase.id, status: 'settled', price, refundWindowSeconds: 3600 })]);
  expect(mine[0].ledgerTxId).toBe(hold.tx);
  expect(mine[0].hold).toMatchObject({ state: 'held', heldAmount: price, refundTxId: null, releaseTxId: null });
  expect(Date.parse(mine[0].hold.windowEndsAt) - Date.parse(mine[0].hold.heldAt)).toBe(3_600_000);
  // The seller sees nothing yet: no release is booked, their USDT is unchanged, and the house took no commission.
  expect(await booked(`market:release:${purchase.id}`)).toMatchObject({ found: false });
  expect(await usdt(seller)).toEqual(sellerBefore);
  expect((await houseFees()).balance).toBe(feesBefore.balance);
  await page.goto('/market/purchases');
  await expect(purchaseRow(page, purchase.id)).toContainText(/Status\s*Held/);
  run.write({ purchaseId: purchase.id, pot: hold.pot });
});

test(`${J} #5 presses Buy again, or loses the reply: one purchase, and the screen re-reads the stored state`, async ({ page }) => {
  test.setTimeout(240_000);
  const { who, title, listingId, purchaseId } = run.read();
  expect(purchaseId, 'a purchase from #4').toBeTruthy();
  const price = await priceOf(who, listingId);
  const before = await usdt(who);
  // Buy again: the page offers no second Buy while the first is held, and a second purchase sent anyway is refused by
  // name. Nothing more is charged and the record still holds one purchase.
  await openMarket(page, who);
  const listing = card(page, title);
  await expect(listing.getByRole('button', { name: `Buy ${title}` })).toBeDisabled();
  await expect(listing).toContainText('You own this. Held until the refund window ends.');
  const client = await api(who);
  const first = await purchaseOf(who, purchaseId);
  const second = await client.post('/api/market/trpc/purchase', { listingId, purchaseId: randomUUID() });
  expect(second.status).toBe(409);
  expect(causeOf(second.body)?.code).toBe('market.purchase_already_held');
  expect(await purchaseOf(who, purchaseId)).toEqual(first);
  // The same purchase sent again under its own id is the same purchase: the stored record comes back, nothing more posts.
  const replay = await ok(await client.post('/api/market/trpc/purchase', { listingId, purchaseId }));
  expect(replay).toEqual(first);
  expect((await myPurchases(who)).filter((p) => p.listingId === listingId).map((p) => p.id)).toEqual([purchaseId]);
  expect(await usdt(who)).toEqual(before);
  await heldOnce(purchaseId, price);

  // Loses the reply: a second TEST buyer presses Buy, the purchase reaches svc-market and the ledger, and the page never
  // sees the answer. The screen says the outcome is not confirmed; after a reload it re-reads the stored purchase by its
  // original id, and the hold is found by its key, booked once.
  const late = await signUp(page, 'mkl');
  await verify(page, late);
  expect(fund(late.email, 'USDT', '100').tx).toBeTruthy();
  const lateBefore = await usdt(late);
  await openMarket(page, late);
  // Every purchase the page sends, for the whole of this part: the lost one, and none from the re-check.
  const purchasesSent = [];
  const watch = (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/api/market/trpc/purchase'))
      purchasesSent.push(request.postDataJSON().purchaseId);
  };
  page.on('request', watch);
  let sent;
  await page.route(
    (url) => url.pathname.endsWith('/api/market/trpc/purchase'),
    async (route) => {
      sent = route.request().postDataJSON().purchaseId;
      await route.fetch();
      await route.abort('connectionreset');
    },
  );
  await card(page, title)
    .getByRole('button', { name: `Buy ${title}` })
    .click();
  await page.getByRole('dialog').getByRole('button', { name: 'Confirm purchase' }).click();
  await expect(page.getByText('Outcome not confirmed', { exact: true })).toBeVisible();
  await page.unrouteAll({ behavior: 'wait' });
  expect(sent).toBeTruthy();
  await heldOnce(sent, price);
  // The page keeps the lost purchase's original id, and the re-check looks that id up in svc-market's record.
  const lateId = (await api(late)).userId;
  expect(
    await page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? 'null')?.reference, `intafaced:more:pending:${lateId}:market`),
  ).toBe(sent);
  await page.reload();
  const reread = page.waitForResponse((r) => new URL(r.url()).pathname.endsWith('/api/market/trpc/myPurchases') && r.status() === 200);
  await page.getByRole('button', { name: 'Check original outcome' }).click();
  expect(((await (await reread).json()).result.data ?? []).map((p) => p.id)).toContain(sent);
  await expect(page.getByText('Original outcome verified')).toBeVisible();
  await expect(card(page, title)).toContainText('You own this. Held until the refund window ends.');
  await expect(card(page, title).getByRole('button', { name: `Buy ${title}` })).toBeDisabled();
  page.off('request', watch);
  expect(purchasesSent).toEqual([sent]);
  const lateMine = (await myPurchases(late)).filter((p) => p.listingId === listingId);
  expect(lateMine).toEqual([
    expect.objectContaining({ id: sent, status: 'settled', price, hold: expect.objectContaining({ state: 'held' }) }),
  ]);
  expect(toUnits((await usdt(late)).free)).toBe(toUnits(lateBefore.free) - toUnits(price));
  // The screen re-reads the stored state: one row for each purchase, held.
  await page.goto('/market/purchases');
  await expect(purchasesRoom(page).getByRole('article')).toHaveCount(1);
  await expect(purchaseRow(page, sent)).toContainText(/Status\s*Held/);
  await openPurchases(page, who);
  await expect(purchaseRow(page, purchaseId)).toHaveCount(1);
  await expect(purchaseRow(page, purchaseId)).toContainText(/Status\s*Held/);
});

test(`${J} #6 requests a refund inside the window, or lets the window end: the refund returns the amount once, or the release posts once to the seller; with the refund policy undecided the refund shows its named blocker`, async ({
  page,
}) => {
  test.setTimeout(720_000);
  const { who, seller, title, listingId, purchaseId, pot } = run.read();
  expect(purchaseId, 'a purchase from #4').toBeTruthy();
  const price = await priceOf(who, listingId);
  const { commission, net } = split(price, await commissionBps(who));
  const house = (await houseFees()).accountId;
  const sellerAtStart = await usdt(seller);
  const houseAtStart = (await houseFees()).balance;
  const releasedHere = [];
  const sellerBefore = await usdt(seller);
  const before = await usdt(who);
  // The refund policy undecided: market restarts with the window unset, and the ask is refused by name. Nothing moves and
  // the purchase is re-read unchanged. A window is back afterwards.
  const heldRecord = await purchaseOf(who, purchaseId);
  let released;
  let raced;
  try {
    try {
      refundPolicy('off');
      await openPurchases(page, who);
      await purchaseRow(page, purchaseId).getByRole('button', { name: 'Ask for a refund' }).click();
      const asked = page.waitForResponse((r) => r.url().includes('/api/market/trpc/refundPurchase'));
      await page.getByRole('dialog').getByRole('button', { name: 'Refund', exact: true }).click();
      const refused = await asked;
      expect(refused.status()).toBe(412);
      expect(causeOf(await refused.json())?.code).toBe('market.refund_policy_unset');
      await expect(page.getByRole('status').getByRole('heading', { name: 'The refund policy is not decided', exact: true })).toBeVisible();
      expect(await purchaseOf(who, purchaseId)).toEqual(heldRecord);
      expect(heldRecord.hold).toMatchObject({ state: 'held', refundRequestedAt: null });
      expect(await booked(`market:refund:${purchaseId}:1`)).toMatchObject({ found: false });
      expect(await usdt(who)).toEqual(before);
    } finally {
      // Back with a window: the TEST 20 seconds, for the release below. #4's purchase keeps the hour it was held with.
      refundPolicy('short');
    }

    // Inside the window: the whole amount returns once, out of the purchase's own pot under
    // market:refund:<purchase>:1, emptying it.
    await openPurchases(page, who);
    await purchaseRow(page, purchaseId).getByRole('button', { name: 'Ask for a refund' }).click();
    const asked = page.waitForResponse((r) => r.url().includes('/api/market/trpc/refundPurchase'));
    await page.getByRole('dialog').getByRole('button', { name: 'Refund', exact: true }).click();
    expect((await asked).status()).toBe(200);
    await expect(page.getByRole('status').filter({ hasText: 'Refunded: the whole amount is back in your account.' })).toBeVisible();
    expect(toUnits((await usdt(who)).free)).toBe(toUnits(before.free) + toUnits(price));
    const refund = await booked(`market:refund:${purchaseId}:1`);
    expect(refund).toMatchObject({ found: true, module: 'market' });
    expect(refund.postings).toHaveLength(2);
    expect(refund.postings.find((e) => e.side === 'source')).toMatchObject({ accountId: pot, amount: price, balanceAfter: '0' });
    expect(refund.postings.find((e) => e.side === 'destination')).toMatchObject({ direction: 'debit', amount: price });
    const refunded = await purchaseOf(who, purchaseId);
    expect(refunded.hold).toMatchObject({ state: 'refunded', refundTxId: refund.txId, releaseTxId: null });
    await expect(purchaseRow(page, purchaseId)).toContainText(/Status\s*Refunded/);
    await expect(purchaseRow(page, purchaseId).getByRole('button', { name: 'Ask for a refund' })).toHaveCount(0);
    // Once: asking again returns the same refund and moves nothing more. The seller was never paid.
    const retry = await ok(await (await api(who)).post('/api/market/trpc/refundPurchase', { purchaseId }));
    expect(retry.hold).toMatchObject({ state: 'refunded', refundTxId: refund.txId });
    expect(toUnits((await usdt(who)).free)).toBe(toUnits(before.free) + toUnits(price));
    expect(await usdt(seller)).toEqual(sellerBefore);
    expect(await booked(`market:release:${purchaseId}`)).toMatchObject({ found: false });

    // Lets the window end: market runs with the TEST 20-second window. A purchase pressed through the page is held, its
    // window ends with no ask, and the release job pays the seller net and the house its commission, once, under
    // market:release:<purchase>, out of the purchase's own pot. Then a refund is refused by name and nothing moves.
    // Then a refund ask racing the window's end and the release job gives exactly one outcome.
    const feesBefore = (await houseFees()).balance;
    const sellerBeforeRelease = await usdt(seller);
    const bought = await buyOnPage(page, who, title);
    expect(bought.hold).toMatchObject({ state: 'held' });
    expect(Date.parse(bought.hold.windowEndsAt) - Date.parse(bought.hold.heldAt)).toBe(20_000);
    const hold = await heldOnce(bought.id, price);
    await expect.poll(async () => (await purchaseOf(who, bought.id)).hold.state, { timeout: 120_000, intervals: [2_000] }).toBe('released');
    const release = await booked(`market:release:${bought.id}`);
    expect(release).toMatchObject({ found: true, module: 'market' });
    expect(release.postings).toHaveLength(3);
    const out = release.postings.filter((e) => e.side === 'source');
    expect(out).toEqual([expect.objectContaining({ accountId: hold.pot, direction: 'credit', amount: price, balanceAfter: '0' })]);
    const toHouse = release.postings.filter((e) => e.side === 'destination' && e.accountId === house);
    const toSeller = release.postings.filter((e) => e.side === 'destination' && e.accountId !== house);
    expect(toHouse.map((e) => toUnits(e.amount))).toEqual([commission]);
    expect(toSeller.map((e) => toUnits(e.amount))).toEqual([net]);
    expect(toUnits((await usdt(seller)).free)).toBe(toUnits(sellerBeforeRelease.free) + net);
    expect(toUnits((await houseFees()).balance)).toBe(toUnits(feesBefore) + commission);
    releasedHere.push(release);
    released = await purchaseOf(who, bought.id);
    expect(released.hold).toMatchObject({ state: 'released', releaseTxId: release.txId, refundTxId: null });
    expect(await booked(`market:refund:${bought.id}:1`)).toMatchObject({ found: false });
    // After the release a refund is refused by name, and the record is re-read unchanged.
    const late = await (await api(who)).post('/api/market/trpc/refundPurchase', { purchaseId: bought.id });
    expect(late.status).toBe(412);
    expect(causeOf(late.body)?.code).toBe('market.refund_window_closed');
    expect(await purchaseOf(who, bought.id)).toEqual(released);
    await openPurchases(page, who);
    await expect(purchaseRow(page, bought.id)).toContainText(/Status\s*Released/);
    await expect(purchaseRow(page, bought.id).getByRole('button', { name: 'Ask for a refund' })).toHaveCount(0);

    // Release and refund racing: refund asks are sent every 150 ms from a second before the window ends to a second
    // after, while the release job runs. Each ask either books the refund or is refused as closed by name. An ask that
    // reached svc-market inside the window wins: the refund books, and once a release-job run has passed the window's
    // end the release is still refused (never booked) and the pot paid out once, to the buyer.
    // A second TEST buyer's purchase, held in the same seconds, asks only after its window ends: the release job must
    // release it, which shows the job ran past both windows' end, and its refund asks are refused by name.
    const other = await signUp(page, 'mkr');
    await verify(page, other);
    expect(fund(other.email, 'USDT', '100').tx).toBeTruthy();
    const otherAsker = await api(other);
    const sellerBeforeRace = await usdt(seller);
    const asker = await api(who);
    const racer = await ok(await asker.post('/api/market/trpc/purchase', { listingId, purchaseId: randomUUID() }));
    const companion = await ok(await otherAsker.post('/api/market/trpc/purchase', { listingId, purchaseId: randomUUID() }));
    const buyerBeforeRace = await usdt(who);
    const racePot = (await heldOnce(racer.id, price)).pot;
    const companionPot = (await heldOnce(companion.id, price)).pot;
    const ends = Date.parse(racer.hold.windowEndsAt);
    const companionEnds = Date.parse(companion.hold.windowEndsAt);
    expect(companionEnds - ends).toBeLessThan(5_000);
    expect(Date.now(), 'the race starts before the window ends').toBeLessThan(ends - 1_000);
    const asks = [];
    for (let at = ends - 1_000; at <= ends + 1_000; at += 150) {
      await new Promise((r) => setTimeout(r, Math.max(0, at - Date.now())));
      const sentAt = Date.now();
      asks.push(asker.post('/api/market/trpc/refundPurchase', { purchaseId: racer.id }).then((a) => ({ ...a, sentAt })));
    }
    const answers = await Promise.all(asks);
    // The companion asks a second after its window ends, and again after the job has released it: refused both times.
    await new Promise((r) => setTimeout(r, Math.max(0, companionEnds + 1_000 - Date.now())));
    const tooLate = await otherAsker.post('/api/market/trpc/refundPurchase', { purchaseId: companion.id });
    expect([tooLate.status, causeOf(tooLate.body)?.code]).toEqual([412, 'market.refund_window_closed']);
    for (const a of answers) {
      if (a.status === 200) expect(data(a)?.hold?.state).toBe('refunded');
      else expect([a.status, causeOf(a.body)?.code]).toEqual([412, 'market.refund_window_closed']);
    }
    // Sent at least half a second inside the window: these reached svc-market before it ended, so they book the refund.
    const inside = answers.filter((a) => a.sentAt < ends - 500);
    expect(inside.length).toBeGreaterThan(0);
    expect(inside.map((a) => a.status)).toEqual(inside.map(() => 200));
    test.info().annotations.push({
      type: 'race',
      description: `${answers.filter((a) => a.status === 200).length} of ${answers.length} asks answered refunded; ${inside.length} sent inside the window`,
    });
    // The release job's run past the window's end is seen, not assumed: it released the companion, once, out of its pot.
    await expect
      .poll(async () => (await purchaseOf(other, companion.id)).hold.state, { timeout: 120_000, intervals: [2_000] })
      .toBe('released');
    const companionRelease = await booked(`market:release:${companion.id}`);
    expect(companionRelease).toMatchObject({ found: true, module: 'market' });
    expect(companionRelease.postings.filter((e) => e.side === 'source')).toEqual([
      expect.objectContaining({ accountId: companionPot, amount: price, balanceAfter: '0' }),
    ]);
    releasedHere.push(companionRelease);
    expect(await booked(`market:refund:${companion.id}:1`)).toMatchObject({ found: false });
    const afterRelease = await otherAsker.post('/api/market/trpc/refundPurchase', { purchaseId: companion.id });
    expect([afterRelease.status, causeOf(afterRelease.body)?.code]).toEqual([412, 'market.refund_window_closed']);
    // Then release is refused for the refunded purchase: the same job run left it unreleased.
    const raceRefund = await booked(`market:refund:${racer.id}:1`);
    expect(raceRefund).toMatchObject({ found: true, module: 'market' });
    expect(await booked(`market:release:${racer.id}`)).toMatchObject({ found: false });
    raced = await purchaseOf(who, racer.id);
    expect(raced.hold).toMatchObject({ state: 'refunded', refundTxId: raceRefund.txId, releaseTxId: null });
    expect(raceRefund.postings.filter((e) => e.side === 'source')).toEqual([
      expect.objectContaining({ accountId: racePot, amount: price, balanceAfter: '0' }),
    ]);
    expect(toUnits((await usdt(who)).free)).toBe(toUnits(buyerBeforeRace.free) + toUnits(price));
    expect(toUnits((await usdt(seller)).free)).toBe(toUnits(sellerBeforeRace.free) + net);
  } finally {
    refundPolicy('test');
  }

  // Still once, after the restart: the refunded purchase never released, and the released one paid once.
  expect(await booked(`market:release:${purchaseId}`)).toMatchObject({ found: false });
  expect((await purchaseOf(who, released.id)).hold).toMatchObject({ state: 'released', releaseTxId: released.hold.releaseTxId });

  // Held = seller + commission + refund, to the exact decimal, for every purchase this buyer made, read from the ledger
  // by key; the scope holds a refund and a release, so either side can be non-zero.
  let held = 0n;
  let paid = 0n;
  const kinds = new Set();
  for (const p of await myPurchases(who)) {
    const h = await booked(`market:hold:${p.id}`);
    expect(h.found).toBe(true);
    const r = await booked(`market:refund:${p.id}:1`);
    const rel = await booked(`market:release:${p.id}`);
    const inOne = toUnits(h.postings.find((e) => e.side === 'destination').amount);
    const outOne =
      (r.found ? toUnits(r.postings.find((e) => e.side === 'destination').amount) : 0n) +
      (rel.found ? rel.postings.filter((e) => e.side === 'destination').reduce((sum, e) => sum + toUnits(e.amount), 0n) : 0n);
    expect(outOne, `purchase ${p.id} pays out what it held`).toBe(inOne);
    if (r.found) kinds.add('refund');
    if (rel.found) kinds.add('release');
    held += inOne;
    paid += outOne;
  }
  expect([...kinds].sort()).toEqual(['refund', 'release']);
  expect(paid).toBe(held);
  // The seller and the house, re-read now, rose by exactly the release legs this step booked (no refund reached them).
  const legs = (to) => releasedHere.flatMap((r) => r.postings.filter((e) => e.side === 'destination' && to(e.accountId)));
  const sum = (es) => es.reduce((t, e) => t + toUnits(e.amount), 0n);
  expect(releasedHere).toHaveLength(2);
  expect(toUnits((await usdt(seller)).free) - toUnits(sellerAtStart.free)).toBe(sum(legs((a) => a !== house)));
  expect(toUnits((await houseFees()).balance) - toUnits(houseAtStart)).toBe(sum(legs((a) => a === house)));
  run.write({ releasedId: released.id, racedId: raced.id });
});

test(`${J} #7 writes a review after a settled purchase: one review stored, a second refused as already reviewed, and a visitor with no purchase refused`, async ({
  page,
}) => {
  const { who, title } = run.read();
  await openMarket(page, who);
  await card(page, title).getByRole('button', { name: 'Write a review' }).click(UNBUILT);
  const form = page.getByRole('form', { name: 'Your review' });
  await form.getByRole('textbox', { name: 'Review' }).fill('TEST review');
  await form.getByRole('button', { name: 'Post review' }).click();
  await expect(page.getByRole('status')).toContainText('Review posted');
  await card(page, title).getByRole('button', { name: 'Write a review' }).click();
  await expect(page.getByRole('alert')).toContainText('You have already reviewed this listing.');
});

test(`${J} #8 opens /market/purchases: price, window and status for each; a pending settlement is not shown as a receipt`, async ({
  page,
}) => {
  const { who, title, releasedId } = run.read();
  expect(releasedId, 'a released purchase from #6').toBeTruthy();
  // A further purchase pressed through the page, held now, so the list holds a pending settlement next to #6's refunded
  // and released ones.
  const earlier = await myPurchases(who);
  const held = await buyOnPage(page, who, title);
  expect(held.hold).toMatchObject({ state: 'held' });
  // Its paid period follows the latest period still paid for (a refunded one is not counted), or starts at its own
  // settle when none runs past it.
  const paidUntil = earlier
    .filter((p) => p.listingId === held.listingId && p.status === 'settled' && p.hold?.state !== 'refunded' && p.accessUntil)
    .reduce((max, p) => Math.max(max, Date.parse(p.accessUntil)), Date.parse(held.settledAt));
  expect(Date.parse(held.accessUntil) - paidUntil).toBe(PERIOD_SECONDS * 1000);
  const inventory = await myPurchases(who);
  const statuses = new Set(inventory.map(statusOf));
  expect([...statuses].sort()).toEqual(['Held', 'Refunded', 'Released']);
  expect(statusOf(inventory.find((p) => p.id === held.id))).toBe('Held');
  expect(statusOf(inventory.find((p) => p.id === releasedId))).toBe('Released');
  await openPurchases(page, who);
  await expect(purchasesRoom(page).getByRole('article')).toHaveCount(inventory.length);
  const receipts = [];
  for (const p of inventory) {
    const row = purchaseRow(page, p.id);
    await expect(row).toHaveCount(1);
    await expect(row).toContainText(new RegExp(`Price\\s*${literal(p.price)}\\s*${literal(p.assetId)}`));
    await expect(row.locator(`time[datetime="${p.hold.windowEndsAt}"]`)).toHaveCount(1);
    await expect(row).toContainText(new RegExp(`Status\\s*${statusOf(p)}`));
    await row.getByRole('button', { name: 'Inspect purchase' }).click();
    const inspected = page.getByRole('region', { name: 'Selected original purchase' });
    await expect(inspected.getByRole('heading', { level: 3, name: receiptOf(p), exact: true })).toBeVisible();
    // Only a released purchase is a receipt; a held one, settlement still pending, never shows as one.
    const receipt = p.hold.state === 'released';
    await expect(inspected.getByRole('heading', { name: 'Settlement recorded' })).toHaveCount(receipt ? 1 : 0);
    if (receipt) receipts.push(p.id);
  }
  expect(receipts).toContain(releasedId);
  expect(receipts).not.toContain(held.id);
});
