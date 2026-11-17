// World: book, gates, restart, stack
import { createHash, randomBytes } from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';
import { test, expect } from './journey.mjs';
import { approverSessions, makeContext, twoPerson } from '../../../../tooling/scripts/local-test-gates.mjs';
import { api, journeyState, toUnits } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';
import { testWalletKey } from './test-wallet.mjs';
import { ADMIN, founderSignIn } from './admin.mjs';
import { sameDecimal, testDeposit, testVenue, venueForThisFile, venueInfo, venueRecord } from './venue.mjs';

// J-cex-spot-16, in the running app (docs/roadmap/journeys.json), on the stack's outside TEST venue: two founders choose
// which of the venue's markets INTAFACED shows, set its routing state, stop routing, set our own largest routed order and
// schedule a delisting, in the founder console's Markets room (/trade-ops/markets, its Venue markets section). One test
// per step, titled "J-cex-spot-16 #<n>". Founder A proposes in the room, founder B approves in Freezes & approvals, A
// writes. Steps 5 and 7 come later (custody) and are not here.
//
// Every market here is the file's own: each step adds a fresh TEST market to the TEST venue (its `/test/market-add`
// control, with a random TEST symbol per attempt, not a key), so no step touches the BTC-USDC or BTC-PERP markets other
// venue journeys trade, and a retry of a step starts on a market nobody listed, routed or delisted yet. Only step 1 lists
// its market through the room; every other step's market is listed by the same two-person door through the API as its
// setup. A customer whose own TEST wallet (a TEST key, signing in this process) places through our door is made once
// for the file and funded by the TEST venue's deposit control. Every figure is TEST. The door is on for this file only.
const J = 'J-cex-spot-16';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
/** The TEST venue's own largest order on every market this file adds. TEST figures. */
const VENUE_MAX = { qty: '10', notional: '1000' };
/** A TEST resting buy, far under any price: nothing on these markets sells. */
const PRICE = '10';
const LISTING_SET = 'trade.venue_listing_set';
const ROUTING_SET = 'trade.venue_routing_set';
const POLICY = 'trade-venue-markets-v1';
const REASON = (what) => `LOCAL TEST ${J}: ${what}`;
const FORM = {
  listing: 'List a venue market',
  routing: 'Set a routing state',
  limits: 'Edit our routed-order limits',
  delisting: 'Schedule a delisting',
};

test.describe.configure({ mode: 'default' });
venueForThisFile(test);

// ── the operators, for setup writes and reads the steps start from ──

let operators;
async function ops() {
  if (!operators) {
    const ctx = await makeContext({ log: () => undefined });
    operators = { ctx, sessions: await approverSessions(ctx) };
  }
  return operators;
}

/** Keys sorted, no spaces: the canonical form svc-trade hashes (services/svc-trade/src/admin/common.ts payloadHash). */
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const keys = Object.keys(value)
    .filter((k) => value[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
}
const hashOf = (body) => `sha256:${createHash('sha256').update(canonical(body)).digest('hex')}`;
const trpcData = (res) => res.json?.result?.data?.json ?? res.json?.result?.data;
const trpcCode = (res) => res.json?.error?.data?.cause?.code ?? res.json?.error?.json?.data?.cause?.code ?? null;

/** The operators' read of every venue market (svc-trade `admin.venueMarkets.list`). */
async function desk() {
  const { ctx, sessions } = await ops();
  const res = await ctx.edge.query('trade', 'admin.venueMarkets.list', undefined, await sessions.a.tradeOpsToken());
  const data = trpcData(res);
  if (!data) throw new Error(`admin.venueMarkets.list refused (${res.status}): ${res.text.slice(0, 300)}`);
  return data;
}
const deskRow = async (symbol) => (await desk()).markets.find((m) => m.symbol === symbol);

/** A fresh TEST spot market on the TEST venue, trading, with the venue's own TEST largest order. */
async function freshMarket(tag) {
  const base = `T16${tag}${randomBytes(3).toString('hex').toUpperCase()}`;
  const symbol = `${base}-USDC`;
  const added = await testVenue('/test/market-add', {
    symbol,
    baseAsset: base,
    quoteAsset: 'USDC',
    maxOrderQty: VENUE_MAX.qty,
    maxOrderNotional: VENUE_MAX.notional,
  });
  expect(added.status, JSON.stringify(added.body)).toBe(200);
  expect(added.body.label).toBe('TEST');
  return symbol;
}

/** Setup, not a step: two operators list `symbol` through svc-trade's own two-person door, open from a minute ago. */
async function listByApi(symbol) {
  const { ctx, sessions } = await ops();
  const venueId = (await venueInfo()).id;
  const opensAt = new Date(Date.now() - 60_000).toISOString();
  const reason = REASON(`list ${symbol} for this step`);
  const ids = await twoPerson(ctx, sessions, {
    actionType: LISTING_SET,
    targetService: 'svc-trade',
    targetId: `venue-listing:${venueId}:${symbol}`,
    expectedVersion: '0',
    payloadHash: hashOf({ actionType: LISTING_SET, venueId, symbol, opensAt, expectedVersion: '0', reason }),
    policyVersion: POLICY,
  });
  const res = await ctx.edge.mutate(
    'trade',
    'admin.venueMarkets.listingSet',
    { symbol, opensAt, expectedVersion: '0', reason, ...ids },
    await sessions.a.tradeOpsToken(),
  );
  expect(trpcData(res)?.listing?.version, res.text.slice(0, 300)).toBe(1);
}

// ── the console, as each founder uses it ──

/** Founder `key` in their own browser, on the Markets room's Venue markets section. */
async function room(browser, key) {
  const page = await (await browser.newContext()).newPage();
  const founder = await founderSignIn(page, key);
  await page.goto(`${ADMIN}/trade-ops/markets`);
  await expect(page.locator('[data-room=venue-markets] [data-venue=desk]')).toBeVisible({ timeout: 30_000 });
  return { page, founder, close: () => page.context().close() };
}

const marketRow = (page, symbol) => page.locator(`[data-venue=markets] tr[data-venue-market="${symbol}"]`);
const form = (page, change) => page.getByRole('form', { name: FORM[change] });

/** Chooses the market in one of the room's forms, once the page has taken it (the version line names it). */
async function chooseMarket(page, change, symbol) {
  const f = form(page, change);
  await expect(async () => {
    await f.getByLabel('Market', { exact: true }).selectOption(symbol);
    await expect(f).toContainText(`of ${symbol}'s`, { timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
  return f;
}

/** Fills the reason and files the request; returns the filed approval id and payload hash. */
async function propose(f, reason) {
  await f.getByLabel('Reason (12 to 500 characters, kept in the audit)').fill(reason);
  await f.getByRole('button', { name: 'Ask a second founder to approve' }).click();
  const filed = f.locator('[data-filed]');
  await expect(filed).toBeVisible({ timeout: 15_000 });
  await expect(f.getByRole('status').filter({ hasText: 'Request filed' })).toBeVisible();
  const approvalId = (await filed.locator('[data-field="Approval id"]').innerText()).trim();
  const payloadHash = (await filed.locator('[data-field="Payload hash"]').innerText()).trim();
  expect(payloadHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  return { approvalId, payloadHash };
}

/** Presses "Propose" and expects the room to refuse with `code`, filing nothing. */
async function proposeRefused(f, reason, code) {
  await f.getByLabel('Reason (12 to 500 characters, kept in the audit)').fill(reason);
  await f.getByRole('button', { name: 'Ask a second founder to approve' }).click();
  const refused = f.locator(`[data-refused="${code}"]`);
  await expect(refused).toBeVisible();
  await expect(refused).toContainText('Nothing was filed.');
  await expect(f.locator('[data-filed]')).toHaveCount(0);
}

/** Founder `page` acts on `approvalId` in Freezes & approvals; returns the dialog after the service answered. */
async function actOnApproval(page, approvalId, payloadHash) {
  await page.goto(`${ADMIN}/trade-ops/approvals`);
  // The pending list lands above the form and moves the button: act once it is in (J-cex-spot-17's approveAsB).
  await expect(page.getByRole('grid', { name: 'Approvals waiting for this operator' })).toBeVisible();
  await page.getByLabel('Approval id', { exact: true }).fill(approvalId);
  await page.getByLabel('Payload hash you reviewed').fill(payloadHash);
  await page.getByRole('button', { name: 'Approve request' }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(dialog.locator('[data-outcome]')).toBeVisible({ timeout: 15_000 });
  return dialog;
}

async function approveAsB(b, approvalId, payloadHash) {
  const dialog = await actOnApproval(b, approvalId, payloadHash);
  await expect(dialog.locator('[data-outcome=ok]')).toBeVisible();
}

/** Founder A writes the approved change from the same form; returns the dialog's outcome. */
async function apply(page, f, approvalId) {
  await f.getByLabel('Approved request id').fill(approvalId);
  await f.getByRole('button', { name: 'Apply the approved change' }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Write change' }).click();
  const outcome = dialog.locator('[data-outcome]');
  await expect(outcome).toBeVisible({ timeout: 15_000 });
  return { dialog, outcome };
}

async function applyWritten(page, f, approvalId) {
  const { dialog } = await apply(page, f, approvalId);
  await expect(dialog.locator('[data-outcome=ok]')).toBeVisible();
  await dialog.getByRole('button', { name: 'Close' }).click();
  const written = page.locator('[data-venue=written]');
  await expect(written).toBeVisible({ timeout: 15_000 });
  return written;
}

/** A write tried before B approved: refused as still waiting, and nothing written. */
async function applyStillPending(page, f, approvalId) {
  const { dialog, outcome } = await apply(page, f, approvalId);
  await expect(outcome).toHaveAttribute('data-outcome', 'refused');
  await expect(outcome).toContainText('action_approval.pending');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);
}

/** B approves in their browser, then A writes and the room reads the market again. */
async function bApprovesAWrites(browser, a, f, filed) {
  const b = await room(browser, 'b');
  try {
    await approveAsB(b.page, filed.approvalId, filed.payloadHash);
  } finally {
    await b.close();
  }
  return { written: await applyWritten(a.page, f, filed.approvalId), approverId: b.founder.userId };
}

// ── the customer, whose own TEST wallet places through our door ──

function customer() {
  const s = run.read();
  if (!s.account || !s.walletKey) throw new Error(`${J}'s TEST setup made no customer and wallet, so this step has no one to place`);
  const wallet = privateKeyToAccount(s.walletKey);
  return { ...s, wallet, owner: wallet.address.toLowerCase() };
}

/**
 * TEST setup, not a journey step: a verified customer, this run's TEST wallet key, and TEST 1000 USDC in its venue
 * account by the TEST venue's deposit control (keyed by a chain-transfer-shaped reference, so a replay credits nothing).
 */
test.beforeAll(async ({ browser }) => {
  if (process.env.JOURNEY_RUN_ID && run.read().account) return;
  test.setTimeout(300_000);
  const page = await browser.newPage();
  try {
    const account = await signUp(page, 'v16');
    await verify(page, account);
    const walletKey = testWalletKey();
    run.reset({ account, walletKey });
    const owner = privateKeyToAccount(walletKey).address.toLowerCase();
    expect(await testDeposit(owner, 'USDC', '1000', `84532:0x${randomBytes(32).toString('hex')}:0`)).toBe(true);
  } finally {
    await page.close();
  }
});

const limitBuy = (symbol, owner, amount, tag) => ({
  kind: 'place_order',
  symbol,
  side: 'buy',
  type: 'limit',
  amount,
  price: PRICE,
  timeInForce: 'GTC',
  reduceOnly: false,
  clientOrderKey: `order:${owner}:${symbol.toLowerCase()}:${tag}`,
  builderFee: null,
});

/** Our door's preview of a new order (nothing is placed). */
const preview = (client, owner, intent) => client.post('/api/v1/venue/preview', { owner, intent });
/** Our door prepares the action for the customer's own wallet to sign. */
const prepare = (client, owner, intent) =>
  client.post('/api/v1/venue/prepare', { owner, signer: { role: 'owner', address: owner }, intent });

/** The customer's own TEST wallet signs the prepared action, and our door sends it. */
async function signAndSend(client, wallet, prepared) {
  const p = prepared.prepared;
  const t = p.typedData;
  const signature = await wallet.signTypedData({ domain: t.domain, types: t.types, primaryType: t.primaryType, message: t.message });
  return client.post('/api/v1/venue/submit', {
    actionKey: prepared.actionKey,
    signature: { digest: p.digest, signature, signedBy: wallet.address.toLowerCase() },
  });
}

/** Places and sends one order through our door; the venue rests it. Returns its venue client order id. */
async function restingBuy(client, c, symbol, amount, tag) {
  const prepared = await prepare(client, c.owner, limitBuy(symbol, c.owner, amount, tag));
  expect(prepared.status, JSON.stringify(prepared.body).slice(0, 300)).toBe(200);
  const sent = await signAndSend(client, c.wallet, prepared.body);
  expect(sent.status, JSON.stringify(sent.body).slice(0, 300)).toBe(200);
  expect(sent.body.outcome).toMatchObject({ definite: true, accepted: true });
  const id = prepared.body.prepared.venueClientOrderId;
  expect((await venueRecord(c.owner, '/order-by-client-id', { venueClientOrderId: id })).value.status).toBe('open');
  return id;
}

/** A door answer refused with our own typed code. */
function refusedWith(res, code) {
  expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(422);
  expect(res.body.intafacedCode).toBe(code);
}

/** What the customer's markets read shows of `symbol`, or undefined when we do not show it. */
async function customerMarket(client, symbol) {
  const res = await client.get('/api/v1/venue/markets');
  expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
  return res.body.value.find((m) => m.symbol === symbol);
}

/**
 * The TEST venue's own record of `symbol` (its `/markets` read), straight from the TEST venue on loopback, never through
 * our door: the state and largest order the desk's "venue's own" cells and the customer's read must equal.
 */
async function venueMarket(owner, symbol) {
  const own = (await venueRecord(owner, '/markets')).value.find((m) => m.symbol === symbol);
  expect(own, `the TEST venue's own record lists ${symbol}`).toBeTruthy();
  return own;
}
/** The desk's label for a venue's own state (apps/admin venue markets room). */
const VENUE_STATE_LABEL = { trading: 'Trading', halted: 'Halted' };

/** The customer's ledger balances: a routing state, a limit or a delisting posts nothing to them. */
const ledgerBalances = async (client) => JSON.stringify(await client.balances());

// ── the steps ──

test(`${J} #1 reviews which venue markets to show: shown only with a second approver; an approved listing with a blank opening window is refused`, async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const symbol = await freshMarket('L');
  const c = customer();
  const client = await api(c.account);
  // The venue lists it (its own record, read from the venue); we do not show it until two founders list it.
  expect((await venueMarket(c.owner, symbol)).status).toBe('trading');
  expect(await customerMarket(client, symbol)).toBeUndefined();
  expect((await deskRow(symbol))?.listing).toBeNull();

  // An approved listing with a blank opening window: two founders approved the hash, and svc-trade's door still refuses
  // the write by name, before the approval is spent. Nothing is shown.
  const { ctx, sessions } = await ops();
  const venueId = (await venueInfo()).id;
  const reason = REASON(`a listing of ${symbol} with no opening time`);
  const ids = await twoPerson(ctx, sessions, {
    actionType: LISTING_SET,
    targetService: 'svc-trade',
    targetId: `venue-listing:${venueId}:${symbol}`,
    expectedVersion: '0',
    payloadHash: hashOf({ actionType: LISTING_SET, venueId, symbol, opensAt: '', expectedVersion: '0', reason }),
    policyVersion: POLICY,
  });
  const blank = await ctx.edge.mutate(
    'trade',
    'admin.venueMarkets.listingSet',
    { symbol, opensAt: null, expectedVersion: '0', reason, ...ids },
    await sessions.a.tradeOpsToken(),
  );
  expect(trpcCode(blank), blank.text.slice(0, 300)).toBe('trade.venue_listing_opening_window_blank');
  expect(await customerMarket(client, symbol)).toBeUndefined();

  // In the room: a blank opening window is refused by the same code and nothing is filed.
  const a = await room(browser, 'a');
  try {
    const f = await chooseMarket(a.page, 'listing', symbol);
    await expect(marketRow(a.page, symbol)).toHaveAttribute('data-shown', 'no');
    await expect(marketRow(a.page, symbol).locator('[data-cell=listing]')).toHaveText('Not shown: no approved listing');
    await proposeRefused(f, REASON(`list ${symbol} with no opening time`), 'trade.venue_listing_opening_window_blank');

    // A proposes the listing with its opening window; with one approver only it is still not shown.
    const opensAt = new Date(Math.floor(Date.now() / 1000) * 1000).toISOString();
    await f.getByLabel('Opens at (ISO time with zone)').fill(opensAt);
    const filed = await propose(f, REASON(`list ${symbol}, open now`));
    await applyStillPending(a.page, f, filed.approvalId);
    expect(await customerMarket(client, symbol)).toBeUndefined();

    // B approves; A writes; the customer's read shows it, with our listing beside the venue's own state.
    const { written, approverId } = await bApprovesAWrites(browser, a, f, filed);
    await expect(written).toHaveAttribute('data-version', '1');
    await expect(written).toHaveAttribute('data-approver', approverId);
    expect(approverId).not.toBe(a.founder.userId);
    await expect(marketRow(a.page, symbol)).toHaveAttribute('data-shown', 'yes');
    await expect(marketRow(a.page, symbol).locator('[data-cell=listing]')).toContainText('Shown · v1 · open');
    await expect(marketRow(a.page, symbol).locator('[data-test-label]')).toHaveText('TEST');
    const shown = await customerMarket(client, symbol);
    expect(shown?.listing).toMatchObject({ version: 1, routing: 'show', open: true, delisted: false });
    expect(Date.parse(shown.listing.opensAt)).toBe(Date.parse(opensAt));
    expect(shown.status).toBe('trading');
    // The venue's own state beside our listing is the venue's own record, on the desk and in the customer's read.
    const venueOwn = await venueMarket(c.owner, symbol);
    expect(shown.status).toBe(venueOwn.status);
    await expect(marketRow(a.page, symbol).locator('[data-cell=venue-status]')).toHaveText(VENUE_STATE_LABEL[venueOwn.status]);
    const row = await deskRow(symbol);
    expect(row.listing).toMatchObject({ version: 1, proposerId: a.founder.userId, approverId });
  } finally {
    await a.close();
  }
});

test(`${J} #2 proposes a routing state for a market: a proposal waiting for a second operator; the desk shows the state once approved, with the venue's own state beside it`, async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const symbol = await freshMarket('R');
  await listByApi(symbol);
  // The venue's own state, set by its TEST control, so the desk shows two different states side by side.
  expect((await testVenue('/test/market-status', { symbol, status: 'halted' })).status).toBe(200);
  const c = customer();
  expect((await venueMarket(c.owner, symbol)).status).toBe('halted');
  const client = await api(c.account);
  const a = await room(browser, 'a');
  try {
    const row = marketRow(a.page, symbol);
    await expect(row.locator('[data-cell=venue-status]')).toHaveText('Halted');
    await expect(row).toHaveAttribute('data-routing', 'show');
    const f = await chooseMarket(a.page, 'routing', symbol);
    await f.getByLabel('Routing state').selectOption('close_only');
    const filed = await propose(f, REASON(`route ${symbol} close only`));

    // Waiting for a second operator: identity holds it PENDING, the write refuses, and our state has not moved.
    const { ctx, sessions } = await ops();
    const pending = await ctx.edge.query(
      'identity',
      'actionApproval.get',
      { approvalId: filed.approvalId },
      await sessions.a.approvalToken(),
    );
    expect(trpcData(pending)).toMatchObject({ status: 'PENDING', actionType: ROUTING_SET, approverId: null });
    await applyStillPending(a.page, f, filed.approvalId);
    await expect(row).toHaveAttribute('data-routing', 'show');
    expect((await customerMarket(client, symbol)).listing.routing).toBe('show');

    // Approved by B and written: the desk shows ours, close only, beside the venue's own, halted.
    const { written, approverId } = await bApprovesAWrites(browser, a, f, filed);
    await expect(written).toHaveAttribute('data-version', '2');
    await expect(row).toHaveAttribute('data-routing', 'close_only');
    await expect(row.locator('[data-cell=routing]')).toHaveText('Close only (reduce-only orders)');
    await expect(row.locator('[data-cell=venue-status]')).toHaveText('Halted');
    const shown = await customerMarket(client, symbol);
    expect(shown.listing.routing).toBe('close_only');
    expect(shown.status).toBe('halted');
    // The venue's own state beside ours is the venue's own record, which our routing state did not move.
    const venueOwn = await venueMarket(c.owner, symbol);
    expect(venueOwn.status).toBe('halted');
    expect(shown.status).toBe(venueOwn.status);
    await expect(row.locator('[data-cell=venue-status]')).toHaveText(VENUE_STATE_LABEL[venueOwn.status]);
    expect((await deskRow(symbol)).listing).toMatchObject({ version: 2, change: 'routing', routing: 'close_only', approverId });
  } finally {
    await a.close();
    await testVenue('/test/market-status', { symbol, status: 'trading' });
  }
});

test(`${J} #3 the proposer tries to approve their own proposal: refused with the same-person code`, async ({ browser }) => {
  test.setTimeout(180_000);
  const symbol = await freshMarket('S');
  await listByApi(symbol);
  const a = await room(browser, 'a');
  try {
    const f = await chooseMarket(a.page, 'routing', symbol);
    await f.getByLabel('Routing state').selectOption('stop');
    const filed = await propose(f, REASON(`stop routing ${symbol}, approved by its own proposer`));

    // A, in Freezes & approvals, approves their own request: identity refuses by its code.
    const dialog = await actOnApproval(a.page, filed.approvalId, filed.payloadHash);
    const outcome = dialog.locator('[data-outcome=refused]');
    await expect(outcome).toBeVisible();
    await expect(outcome).toContainText('action_approval.same_person');

    // Nothing was approved and nothing changed: the request still waits for a second operator, routing is still show.
    const { ctx, sessions } = await ops();
    const still = await ctx.edge.query(
      'identity',
      'actionApproval.get',
      { approvalId: filed.approvalId },
      await sessions.a.approvalToken(),
    );
    expect(trpcData(still)).toMatchObject({ status: 'PENDING', approverId: null });
    expect((await deskRow(symbol)).listing).toMatchObject({ version: 1, routing: 'show' });
    // And the venue's own record of the market is as it was: still trading, beside our unchanged state on the desk
    // (A is back in the Markets room, from Freezes & approvals).
    const venueOwn = await venueMarket(customer().owner, symbol);
    expect(venueOwn.status).toBe('trading');
    await a.page.goto(`${ADMIN}/trade-ops/markets`);
    const row = marketRow(a.page, symbol);
    await expect(row).toHaveAttribute('data-routing', 'show', { timeout: 30_000 });
    await expect(row.locator('[data-cell=venue-status]')).toHaveText(VENUE_STATE_LABEL[venueOwn.status]);
  } finally {
    await a.close();
  }
});

test(`${J} #4 stop routing takes effect: new orders routed through INTAFACED refuse with our state; cancels still work; in-flight venue orders show their venue state; the venue's own state shows beside it`, async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const symbol = await freshMarket('T');
  await listByApi(symbol);
  const c = customer();
  const client = await api(c.account);
  const ledgerBefore = await ledgerBalances(client);
  // Before the stop: an order resting on the venue, and one prepared but not yet sent.
  const resting = await restingBuy(client, c, symbol, '1', 'before-stop');
  const unsent = await prepare(client, c.owner, limitBuy(symbol, c.owner, '1', 'prepared-before-stop'));
  expect(unsent.status, JSON.stringify(unsent.body).slice(0, 300)).toBe(200);

  const a = await room(browser, 'a');
  try {
    const f = await chooseMarket(a.page, 'routing', symbol);
    await f.getByLabel('Routing state').selectOption('stop');
    const filed = await propose(f, REASON(`stop routing ${symbol}`));
    // One approver only: the stop has not taken effect, a new order still previews.
    expect((await preview(client, c.owner, limitBuy(symbol, c.owner, '1', 'while-pending'))).status).toBe(200);

    const { written } = await bApprovesAWrites(browser, a, f, filed);
    await expect(written).toHaveAttribute('data-version', '2');
    const row = marketRow(a.page, symbol);
    await expect(row).toHaveAttribute('data-routing', 'stop');
    await expect(row.locator('[data-cell=routing]')).toHaveText('Stop routing (no new orders)');
    // The venue's own state beside ours: still trading on the venue.
    await expect(row.locator('[data-cell=venue-status]')).toHaveText('Trading');
  } finally {
    await a.close();
  }

  // New orders through INTAFACED refuse with our state: at preview, at prepare, and at first send of one prepared before.
  refusedWith(await preview(client, c.owner, limitBuy(symbol, c.owner, '1', 'after-stop')), 'trade.venue_routing_stopped');
  refusedWith(await prepare(client, c.owner, limitBuy(symbol, c.owner, '1', 'after-stop')), 'trade.venue_routing_stopped');
  refusedWith(await signAndSend(client, c.wallet, unsent.body), 'trade.venue_routing_stopped');
  const shown = await customerMarket(client, symbol);
  expect(shown.listing.routing).toBe('stop');
  expect(shown.status).toBe('trading');

  // The order in flight shows its venue state through our door, the venue's own record: still open, nothing cancelled.
  const venueOwn = (await venueRecord(c.owner, '/order-by-client-id', { venueClientOrderId: resting })).value;
  expect(venueOwn.status).toBe('open');
  const open = await client.get(`/api/v1/venue/orders/open?owner=${c.owner}`);
  expect(open.status).toBe(200);
  const ours = open.body.value.find((o) => o.venueClientOrderId === resting);
  expect(ours?.status).toBe('open');
  expect(sameDecimal(ours.amount, venueOwn.amount)).toBe(true);

  // Cancels still work through our door.
  const cancel = await prepare(client, c.owner, {
    kind: 'cancel_order',
    symbol,
    clientOrderKey: `order:${c.owner}:${symbol.toLowerCase()}:before-stop`,
  });
  expect(cancel.status, JSON.stringify(cancel.body).slice(0, 300)).toBe(200);
  const cancelled = await signAndSend(client, c.wallet, cancel.body);
  expect(cancelled.status, JSON.stringify(cancelled.body).slice(0, 300)).toBe(200);
  expect(cancelled.body.outcome).toMatchObject({ definite: true, accepted: true });
  expect((await venueRecord(c.owner, '/order-by-client-id', { venueClientOrderId: resting })).value.status).toBe('canceled');
  // The ledger posted nothing.
  expect(await ledgerBalances(client)).toBe(ledgerBefore);
});

test(`${J} #6 edits our own per-pair limits for routed orders: edit proposes and a second operator approves; never above the venue's; a blank value is refused with a typed code; the new version records who approved it; open orders are untouched`, async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const symbol = await freshMarket('M');
  await listByApi(symbol);
  const c = customer();
  const client = await api(c.account);
  const ledgerBefore = await ledgerBalances(client);
  // An open venue order larger than the limit about to be set.
  const resting = await restingBuy(client, c, symbol, '5', 'before-limit');

  // svc-trade's door itself: a blank limit and one above the venue's own refuse by name, before any approval is read.
  const { ctx, sessions } = await ops();
  const direct = async (maxOrderQty, maxOrderNotional) =>
    ctx.edge.mutate(
      'trade',
      'admin.venueMarkets.limitsSet',
      {
        symbol,
        maxOrderQty,
        maxOrderNotional,
        expectedVersion: '0',
        reason: REASON('limits refused by name'),
        approvalId: `venue-limits:unapproved:${symbol}`,
        operationId: `venue-limits:unapproved:${symbol}`,
      },
      await sessions.a.tradeOpsToken(),
    );
  expect(trpcCode(await direct(null, '100'))).toBe('trade.venue_limit_blank');
  expect(trpcCode(await direct('11', '100'))).toBe('trade.venue_limit_above_venue');

  const a = await room(browser, 'a');
  try {
    const row = marketRow(a.page, symbol);
    await expect(row.locator('[data-cell=venue-limits]')).toHaveText(`${VENUE_MAX.qty} size · ${VENUE_MAX.notional} notional`);
    await expect(row.locator('[data-cell=limits]')).toHaveText("None of ours: the venue's own applies");
    const f = await chooseMarket(a.page, 'limits', symbol);
    // Above the venue's own, then blank: each refused in the room with its code, nothing filed.
    await f.getByLabel('Largest order size').fill('11');
    await f.getByLabel('Largest order notional').fill('100');
    await proposeRefused(f, REASON(`limits on ${symbol} above the venue's`), 'trade.venue_limit_above_venue');
    await f.getByLabel('Largest order size').fill('');
    await proposeRefused(f, REASON(`limits on ${symbol} left blank`), 'trade.venue_limit_blank');

    // A valid edit: proposed, waiting, then approved by B and written as version 1 with its approver.
    await f.getByLabel('Largest order size').fill('2');
    const filed = await propose(f, REASON(`limits on ${symbol}: 2 size, 100 notional`));
    await applyStillPending(a.page, f, filed.approvalId);
    expect((await deskRow(symbol)).limits).toBeNull();
    const { written, approverId } = await bApprovesAWrites(browser, a, f, filed);
    await expect(written).toHaveAttribute('data-version', '1');
    await expect(written).toHaveAttribute('data-approver', approverId);
    await expect(row.locator('[data-cell=limits]')).toContainText('2 size · 100 notional');
    await expect(row.locator('[data-cell=limits-version]')).toHaveText(`v1 · proposed by ${a.founder.userId} · approved by ${approverId}`);
    await expect(row.locator('[data-cell=venue-limits]')).toHaveText(`${VENUE_MAX.qty} size · ${VENUE_MAX.notional} notional`);
    const limits = (await deskRow(symbol)).limits;
    expect(limits).toMatchObject({ version: 1, proposerId: a.founder.userId, approverId });
    expect(sameDecimal(limits.maxOrderQty, '2') && sameDecimal(limits.maxOrderNotional, '100')).toBe(true);
    expect(approverId).not.toBe(a.founder.userId);
    // Never above the venue's: the venue's own record of its largest order, read from the venue, is what the desk shows
    // as the venue's and what ours sits under.
    const venueOwnMarket = await venueMarket(c.owner, symbol);
    expect(sameDecimal(venueOwnMarket.maxOrderQty, VENUE_MAX.qty) && sameDecimal(venueOwnMarket.maxOrderNotional, VENUE_MAX.notional)).toBe(
      true,
    );
    expect(toUnits(limits.maxOrderQty) <= toUnits(venueOwnMarket.maxOrderQty)).toBe(true);
    expect(toUnits(limits.maxOrderNotional) <= toUnits(venueOwnMarket.maxOrderNotional)).toBe(true);
  } finally {
    await a.close();
  }

  // Open orders are untouched: the venue's own record of the larger order is still open at its full size.
  const venueOwn = (await venueRecord(c.owner, '/order-by-client-id', { venueClientOrderId: resting })).value;
  expect(venueOwn.status).toBe('open');
  expect(sameDecimal(venueOwn.amount, '5')).toBe(true);
  // A new order above our limit refuses with our code; one inside it previews.
  refusedWith(await prepare(client, c.owner, limitBuy(symbol, c.owner, '3', 'above-limit')), 'trade.venue_order_above_limit');
  expect((await preview(client, c.owner, limitBuy(symbol, c.owner, '1', 'inside-limit'))).status).toBe(200);
  expect(await ledgerBalances(client)).toBe(ledgerBefore);

  // TEST tidy-up, not the step: the customer's own cancel through our door releases the order's lock.
  const cancel = await prepare(client, c.owner, {
    kind: 'cancel_order',
    symbol,
    clientOrderKey: `order:${c.owner}:${symbol.toLowerCase()}:before-limit`,
  });
  expect(cancel.status).toBe(200);
  expect((await signAndSend(client, c.wallet, cancel.body)).status).toBe(200);
});

test(`${J} #8 schedules a delisting: customers get one dated notice; opens refuse after the date`, async ({ browser, page }) => {
  test.setTimeout(420_000);
  // A market of its own, so step 4's stop and step 6's limits never stand in front of the delisting.
  const symbol = await freshMarket('D');
  await listByApi(symbol);
  const c = customer();
  const client = await api(c.account);
  // Two and a half minutes ahead, on a whole second: time for B to approve and A to write before it.
  const delistsAt = new Date(Math.ceil((Date.now() + 150_000) / 1000) * 1000).toISOString();

  const a = await room(browser, 'a');
  try {
    const f = await chooseMarket(a.page, 'delisting', symbol);
    await proposeRefused(f, REASON(`delist ${symbol} with no date`), 'trade.venue_delisting_date_blank');
    await f.getByLabel('Delists at (ISO time with zone)').fill(delistsAt);
    const filed = await propose(f, REASON(`delist ${symbol}`));
    const { written } = await bApprovesAWrites(browser, a, f, filed);
    await expect(written).toHaveAttribute('data-version', '2');
    await expect(marketRow(a.page, symbol).locator('[data-cell=delists-at]')).toContainText(delistsAt);
  } finally {
    await a.close();
  }
  expect(Date.now(), 'the write landed after the delisting date: the step has no time left to check before it').toBeLessThan(
    Date.parse(delistsAt),
  );
  // Before the date an open still previews.
  expect((await preview(client, c.owner, limitBuy(symbol, c.owner, '1', 'before-delisting'))).status).toBe(200);

  // One dated notice in the customer's inbox, filed under the delisting's key: exactly one, carrying the date.
  const notices = async () => {
    const res = await client.get(`/api/notify/trpc/notify.list?input=${encodeURIComponent(JSON.stringify({ limit: 100 }))}`);
    expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
    const items = res.body.result.data.json?.items ?? res.body.result.data.items;
    return items.filter((n) => n.kind === 'trade.venue_delisting' && n.params?.symbol === symbol);
  };
  await expect.poll(async () => (await notices()).length, { timeout: 60_000 }).toBe(1);
  const [notice] = await notices();
  expect(Date.parse(notice.params.delistsAt)).toBe(Date.parse(delistsAt));
  // The desk's read again (which sends any notice still pending) leaves it at one.
  expect((await deskRow(symbol)).delistingNotice).toMatchObject({ delistsAt });
  expect(await notices()).toHaveLength(1);
  // And the customer sees that one notice in the app.
  await signIn(page, c.account);
  await page.getByRole('button', { name: /^Notifications/ }).click();
  await expect(page.getByRole('dialog', { name: /Notifications/ }).getByText(`${symbol} is being delisted`)).toHaveCount(1, {
    timeout: 20_000,
  });

  // After the date, a new open refuses with our code.
  await expect
    .poll(async () => (await preview(client, c.owner, limitBuy(symbol, c.owner, '1', 'after-delisting'))).body?.intafacedCode ?? null, {
      timeout: Math.max(0, Date.parse(delistsAt) - Date.now()) + 60_000,
      intervals: [5_000],
    })
    .toBe('trade.venue_market_delisted');
  expect(Date.now()).toBeGreaterThanOrEqual(Date.parse(delistsAt));
  refusedWith(await prepare(client, c.owner, limitBuy(symbol, c.owner, '1', 'after-delisting')), 'trade.venue_market_delisted');
  const shown = await customerMarket(client, symbol);
  expect(shown.listing).toMatchObject({ delisted: true });
  expect(Date.parse(shown.listing.delistsAt)).toBe(Date.parse(delistsAt));
});
