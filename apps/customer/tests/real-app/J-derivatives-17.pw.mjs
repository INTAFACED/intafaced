// World: restart
import { keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { test, expect } from './journey.mjs';
import { ADMIN } from './admin.mjs';
import { api, fromUnits, toUnits, tool } from './stack.mjs';
import { signUp, verify, signIn } from './desk.mjs';
import { staffSignIn } from './staff.mjs';

// J-derivatives-17 "I reconcile the builder fees the venues report against the ledger", in the founder console
// (docs/roadmap/journeys.json). One test per step, titled "J-derivatives-17 #<n>", run in order. The person is the
// stack's TEST finance staff member (identity's TEST roster; staff.mjs). The period of TEST routed activity they
// reconcile is made here first: svc-trade's user-venue door is switched on for this file (the stack's LOCAL TEST venue,
// tooling/scripts/local-test-venue.mjs), and a fresh TEST trader approves our builder fee and places orders through the
// door, each signed by a TEST key derived from a public name. Every figure the TEST venue reports is TEST.
const J = 'J-derivatives-17';
const TEST_VENUE = 'http://127.0.0.1:14560';
const key = privateKeyToAccount(keccak256(toHex(`intafaced TEST venue journey trader ${J} ${process.env.JOURNEY_RUN_ID ?? 'local'}`)));
const owner = key.address.toLowerCase();
const signer = { role: 'owner', address: owner };

test.describe.configure({ mode: 'serial' });

/** svc-trade restarted with the door and the builder-fee poster set as asked (tooling/scripts/local-stack-services/trade.mjs). */
function tradeWith({ venue, poster }) {
  const before = { v: process.env.LOCAL_STACK_USER_VENUE, p: process.env.LOCAL_STACK_BUILDER_FEE_POSTER };
  if (venue) process.env.LOCAL_STACK_USER_VENUE = 'on';
  else delete process.env.LOCAL_STACK_USER_VENUE;
  if (poster) delete process.env.LOCAL_STACK_BUILDER_FEE_POSTER;
  else process.env.LOCAL_STACK_BUILDER_FEE_POSTER = 'off';
  try {
    tool('local-test-stack.mjs', 'restart', 'trade');
  } finally {
    for (const [name, value] of [
      ['LOCAL_STACK_USER_VENUE', before.v],
      ['LOCAL_STACK_BUILDER_FEE_POSTER', before.p],
    ]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test.beforeAll(() => {
  test.setTimeout(300_000);
  tradeWith({ venue: true, poster: true });
});
test.afterAll(() => {
  test.setTimeout(300_000);
  tradeWith({ venue: false, poster: true });
});

/** One call to the TEST venue's own record or TEST controls. */
async function testVenue(path, body) {
  const res = await fetch(`${TEST_VENUE}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}
async function venueId() {
  const { status, body } = await testVenue('/venue');
  expect(status, JSON.stringify(body)).toBe(200);
  expect(body.label).toBe('TEST');
  return body.venue.id;
}
const account = async () => ({ venueId: await venueId(), owner, subAccount: null });

/** The venue's own fills for our trader since `since`, with our builder fee on them. */
async function venueFills(since) {
  const { status, body } = await testVenue('/fills', { account: await account(), since: since.toISOString() });
  expect(status, JSON.stringify(body)).toBe(200);
  return body.value.filter((f) => !/^0(\.0+)?$/.test(f.builderFee));
}

/** A decimal string without trailing zeros, so the venue's "0.0000100" and the console's "0.00001" compare equal. */
const dec = (s) =>
  String(s)
    .replace(/(\.\d*?)0+$/, '$1')
    .replace(/\.$/, '');

let trader;
/** One action through svc-trade's user-venue door as the trader: prepare, sign with the TEST key, submit. */
async function door(intent, actionKey) {
  const session = await api(trader);
  const prepared = await session.post('/api/v1/venue/prepare', { owner, signer, intent, ...(actionKey ? { actionKey } : {}) });
  expect(prepared.status, JSON.stringify(prepared.body).slice(0, 400)).toBe(200);
  const p = prepared.body.prepared;
  const t = p.typedData;
  const signature = await key.signTypedData({ domain: t.domain, types: t.types, primaryType: t.primaryType, message: t.message });
  const sent = await session.post('/api/v1/venue/submit', {
    actionKey: prepared.body.actionKey,
    signature: { digest: p.digest, signature, signedBy: owner },
  });
  expect(sent.status, JSON.stringify(sent.body).slice(0, 400)).toBe(200);
  expect(sent.body.outcome, JSON.stringify(sent.body.outcome).slice(0, 400)).toMatchObject({ definite: true, accepted: true });
  return { ...sent.body, prepared: p };
}
let orders = 0;
/** The builder-fee rates our door signed into the orders it routed: the version in force for BTC-USDC, else the boot value. */
const signedRates = new Set();
const buy = async () => {
  const sent = await door({
    kind: 'place_order',
    symbol: 'BTC-USDC',
    side: 'buy',
    type: 'limit',
    amount: '0.01',
    price: '60010',
    timeInForce: 'GTC',
    reduceOnly: false,
    clientOrderKey: `order:${J}:${process.env.JOURNEY_RUN_ID ?? 'local'}:${(orders += 1)}`,
    builderFee: null,
  });
  expect(sent.prepared.builderFee, 'the door signs our builder fee into the order').not.toBeNull();
  signedRates.add(dec(sent.prepared.builderFee.feeBps));
  return sent;
};
/** The venue's own published cap on our builder fee for `symbol`. */
async function venueCap(symbol) {
  const { status, body } = await testVenue('/markets', { account: null });
  expect(status, JSON.stringify(body).slice(0, 300)).toBe(200);
  const market = body.value.find((m) => m.symbol === symbol);
  expect(market?.builderFeeCapBps, `${symbol}'s cap as the venue publishes it`).toMatchObject({ known: true });
  return market.builderFeeCapBps.value;
}

/** The recon the console reads, as the stack's TEST founders' trade-ops token reads it (admin.builderFees.recon). */
let staffDoor;
async function recon(from, to) {
  staffDoor ??= (async () => {
    const gates = await import('../../../../tooling/scripts/local-test-gates.mjs');
    const ctx = await gates.makeContext({ log: () => {} });
    const sessions = await gates.approverSessions(ctx);
    return { ctx, sessions, token: await sessions.a.tradeOpsToken() };
  })();
  const { ctx, token } = await staffDoor;
  const res = await ctx.edge.query('trade', 'admin.builderFees.recon', { from: from.toISOString(), to: to.toISOString() }, token);
  expect(res.status, res.text.slice(0, 300)).toBe(200);
  return JSON.parse(res.text).result.data;
}

/** One read of svc-ledger's own operator door, as the stack's TEST founder a with admin:treasury reads it. */
async function ledgerRead(path) {
  if (!staffDoor) await recon(new Date(Date.now() - 60_000), new Date());
  const { ctx, sessions } = await staffDoor;
  const res = await fetch(`${ctx.url('ledger')}${path}`, { headers: { authorization: `Bearer ${await sessions.a.treasuryToken()}` } });
  const text = await res.text();
  expect(res.status, text.slice(0, 300)).toBe(200);
  return JSON.parse(text);
}

/** What the venue owes us in builder fees, per asset, from the ledger's own receivable accounts (debits less credits, negated). */
async function ledgerOwed(id) {
  const page = await ledgerRead(`/operator/accounts?prefix=${encodeURIComponent(`treasury:venue-builder-fee:${id}`)}`);
  expect(page.nextCursor).toBeNull();
  return new Map(
    page.accounts
      .filter((a) => a.ownerId === `venue-builder-fee:${id}` && a.kind === 'available')
      .map((a) => [a.assetId, -toUnits(a.balance)]),
  );
}

/** Our builder fee on a fill at `feeBps`, worked out here from the venue's own fill: base quantity when charged in the base asset, else notional; rounded up. */
const ceilDiv = (a, b) => (a + b - 1n) / b;
const ONE = toUnits('1');
function feeAt(fill, feeBps) {
  const notional = ceilDiv(toUnits(fill.price) * toUnits(fill.amount), ONE);
  const basis = fill.feeAsset === fill.symbol.split(/[-/]/)[0] ? toUnits(fill.amount) : notional;
  return { notional, fee: ceilDiv(ceilDiv(basis * toUnits(feeBps), ONE) * ONE, toUnits('10000')) };
}

/** The finance operator opens the treasury recon for the period and sees the venue section. */
async function openRecon(page, from, to) {
  await page.goto(`${ADMIN}/ledger/treasury?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`);
  await expect(page.getByRole('heading', { name: 'Builder-fee recon' })).toBeVisible({ timeout: 60_000 });
  return page.getByTestId('builder-fee-venue');
}

let start;
test(`${J} #1 opens recon for a period: the venue's builder fees against the ledger's, green when matched`, async ({ page, browser }) => {
  test.setTimeout(300_000);
  start = new Date(Date.now() - 60_000);
  // A fresh TEST trader, funded on the TEST venue, who approves our builder fee and fills two orders through the door.
  const tab = await (await browser.newContext()).newPage();
  trader = await signUp(tab, 'jd17');
  await verify(tab, trader);
  await signIn(tab, trader);
  await tab.context().close();
  const funded = await testVenue('/test/deposit', {
    account: await account(),
    asset: 'USDC',
    amount: '10000',
    depositRef: `84532:${keccak256(toHex(`${J} ${owner}`))}:0`,
  });
  expect(funded.status, JSON.stringify(funded.body)).toBe(200);
  const builder = (await (await api(trader)).get('/api/v1/venue/status')).body;
  expect(builder, JSON.stringify(builder).slice(0, 300)).toMatchObject({ enabled: true, test: true });
  // The trader approves our builder fee up to the venue's own cap: the rate an order carries is the builder-fee version in
  // force when it is prepared (another journey may have published one on this stack), never above that cap.
  await door(
    { kind: 'approve_builder_fee', builder: builder.builder.address, maxFeeBps: await venueCap('BTC-USDC') },
    `approve-builder:${owner}:${J}`,
  );
  await buy();
  await buy();
  const fills = await venueFills(start);
  expect(fills.length, 'two fills carry our builder fee').toBeGreaterThanOrEqual(2);
  const to = new Date(Date.now() + 10 * 60_000);

  // The poster posts each fee to the ledger on its own cadence; the console reads green once it has.
  await expect.poll(async () => (await recon(start, to)).venues[0]?.matched ?? null, { timeout: 60_000 }).toBe(true);

  await staffSignIn(page, browser, 'finance');
  const venue = await openRecon(page, start, to);
  await expect(venue).toHaveAttribute('data-state', 'green');
  await expect(venue.getByTestId('builder-fee-verdict')).toContainText('Green: every builder fee the venue reports matches the ledger.');
  await expect(venue.getByTestId('builder-fee-test')).toHaveText('TEST');
  // Fill by fill, the venue's own builder fee and the ledger's are shown, the same amount, matched.
  for (const fill of fills) {
    const row = venue.getByTestId('builder-fee-lines').locator(`tr[data-fill-id="${fill.fillId}"]`);
    await expect(row).toHaveAttribute('data-state', 'matched');
    const cells = row.locator('td');
    await expect(cells.nth(1)).toHaveText(fill.fillId);
    expect(dec(await cells.nth(4).innerText())).toBe(dec(fill.builderFee));
    expect(dec(await cells.nth(5).innerText())).toBe(dec(fill.builderFee));
    await expect(cells.nth(6)).toHaveText('Matched');
  }
  // The totals agree: the venue's sum of builder fees and the ledger's, per asset.
  const asset = fills[0].feeAsset;
  const total = venue.getByTestId('builder-fee-totals').locator('tbody tr').filter({ hasText: asset });
  await expect(total).toHaveAttribute('data-state', 'green');
  const shown = await total.locator('td').allInnerTexts();
  expect(dec(shown[1])).toBe(dec(shown[2]));
});

test(`${J} #2 a builder fee is in one record but not the other: the break with its venue id and amount`, async ({ page, browser }) => {
  test.setTimeout(300_000);
  // The poster is stopped, so the next fee the venue charges is not in the ledger yet.
  tradeWith({ venue: true, poster: false });
  const from = new Date(Date.now() - 1000);
  await buy();
  const fills = await venueFills(from);
  expect(fills.length).toBe(1);
  const fill = fills[0];
  const to = new Date(Date.now() + 10 * 60_000);
  const id = await venueId();

  await staffSignIn(page, browser, 'finance');
  const venue = await openRecon(page, from, to);
  await expect(venue).toHaveAttribute('data-state', 'break');
  await expect(venue).toHaveAttribute('data-venue-id', id);
  await expect(venue.getByTestId('builder-fee-verdict')).toContainText('Break: the venue and the ledger do not agree.');
  await expect(venue.getByTestId('builder-fee-verdict')).toContainText(`Venue id ${id}`);
  const row = venue.getByTestId('builder-fee-lines').locator(`tr[data-fill-id="${fill.fillId}"]`);
  await expect(row).toHaveAttribute('data-state', 'not_in_ledger');
  const cells = row.locator('td');
  expect(dec(await cells.nth(4).innerText())).toBe(dec(fill.builderFee));
  await expect(cells.nth(5)).toHaveText('none');
  await expect(cells.nth(6)).toHaveText('Break: the venue reports this fee, the ledger has none');
  // The read is the console's: the service lists the same break, and nothing was posted to make the two agree.
  const read = await recon(from, to);
  const line = read.venues[0].lines.find((l) => l.fillId === fill.fillId);
  expect(line).toMatchObject({ status: 'not_in_ledger', ledgerAmount: null });
  expect(dec(line.venueAmount)).toBe(dec(fill.builderFee));

  // With the poster running again, the fee is posted once and the break clears.
  tradeWith({ venue: true, poster: true });
  await expect.poll(async () => (await recon(from, to)).venues[0]?.matched ?? null, { timeout: 60_000 }).toBe(true);
  await page.reload();
  await expect(page.getByTestId('builder-fee-venue')).toHaveAttribute('data-state', 'green', { timeout: 60_000 });
});

test(`${J} #3 a venue payout of builder fees is not yet received: shown as owed by that venue, with the amount`, async ({
  page,
  browser,
}) => {
  test.setTimeout(300_000);
  const id = await venueId();
  const to = new Date(Date.now() + 10 * 60_000);
  await expect.poll(async () => (await recon(start, to)).venues[0]?.matched ?? null, { timeout: 60_000 }).toBe(true);
  // No payout has been received from the venue (no payout is read until the owner sets the payout model), so every fee
  // the ledger records as earned there is owed. The ledger's own receivable is the figure; the console shows it.
  const before = await ledgerOwed(id);
  expect(before.size, 'the ledger holds a builder-fee receivable for the venue').toBeGreaterThan(0);
  await staffSignIn(page, browser, 'finance');
  const venue = await openRecon(page, start, to);
  const owed = venue.getByTestId('builder-fee-owed');
  await expect(owed).toContainText('not yet received');
  for (const [asset, units] of before) {
    expect(units > 0n, `${asset} is owed, not paid ahead`).toBe(true);
    expect(dec(await owed.locator(`tr[data-asset="${asset}"] td`).nth(1).innerText())).toBe(dec(fromUnits(units)));
  }

  // One more fill: its fee is earned and not received, so what the venue owes grows by exactly that fee.
  const from = new Date(Date.now() - 1000);
  await buy();
  const [fill] = await venueFills(from);
  expect(fill, 'the new fill carries our builder fee').toBeTruthy();
  const want = (before.get(fill.feeAsset) ?? 0n) + toUnits(fill.builderFee);
  await expect.poll(async () => (await ledgerOwed(id)).get(fill.feeAsset) ?? 0n, { timeout: 60_000 }).toBe(want);
  const cell = page.getByTestId('builder-fee-venue').getByTestId('builder-fee-owed').locator(`tr[data-asset="${fill.feeAsset}"] td`).nth(1);
  await expect
    .poll(
      async () => {
        await page.reload();
        return dec(await cell.innerText());
      },
      { timeout: 60_000 },
    )
    .toBe(dec(fromUnits(want)));
});

test(`${J} #4 opens the routed-volume recon: volume by venue against the builder fees, with any gap named`, async ({ page, browser }) => {
  test.setTimeout(300_000);
  const to = new Date(Date.now() + 10 * 60_000);
  const status = (await (await api(trader)).get('/api/v1/venue/status')).body;
  // Our rate: the one the door signed into every order it routed for this trader.
  expect([...signedRates], 'every routed order carries one rate').toHaveLength(1);
  const [feeBps] = signedRates;
  const fills = await venueFills(start);
  // Every fill so far is on an order routed through our door at our rate: worked out here from the venue's own fills.
  let volume = 0n;
  let charged = 0n;
  for (const f of fills) {
    const { notional, fee } = feeAt(f, feeBps);
    expect(fromUnits(fee), `fill ${f.fillId} carries our rate`).toBe(fromUnits(toUnits(f.builderFee)));
    volume += notional;
    charged += toUnits(f.builderFee);
  }
  await staffSignIn(page, browser, 'finance');
  let venue = await openRecon(page, start, to);
  let block = venue.getByTestId('builder-fee-volume');
  await expect(block).toHaveAttribute('data-state', 'green');
  const asset = fills[0].feeAsset;
  const row = block.locator(`tbody tr[data-asset="${asset}"]`);
  await expect(row).toHaveAttribute('data-state', 'green');
  const cells = await row.locator('td').allInnerTexts();
  expect(Number(cells[1])).toBe(fills.length);
  expect(dec(cells[2].split(' ')[0])).toBe(dec(fromUnits(volume)));
  expect(dec(cells[3])).toBe(dec(fromUnits(charged)));
  expect(dec(cells[4])).toBe(dec(fromUnits(charged)));
  expect(dec(cells[5])).toBe('0');
  await expect(venue.getByTestId('builder-fee-volume-gaps')).toHaveCount(0);

  // An order with our builder fee placed on the venue directly, not routed by us: the venue charges our fee on volume we
  // did not route, and the recon names it as a gap with its fill id and amount.
  const from = new Date(Date.now() - 1000);
  const intent = {
    kind: 'place_order',
    symbol: 'BTC-USDC',
    side: 'buy',
    type: 'limit',
    amount: '0.01',
    price: '60010',
    timeInForce: 'GTC',
    reduceOnly: false,
    clientOrderKey: `direct:${J}:${process.env.JOURNEY_RUN_ID ?? 'local'}`,
    builderFee: { builder: status.builder.address, feeBps },
  };
  const prep = await testVenue('/prepare', { account: await account(), signer, intent });
  expect(prep.status, JSON.stringify(prep.body).slice(0, 300)).toBe(200);
  const t = prep.body.typedData;
  const signature = await key.signTypedData({ domain: t.domain, types: t.types, primaryType: t.primaryType, message: t.message });
  const sent = await testVenue('/submit', { prepared: prep.body, signature: { digest: prep.body.digest, signature, signedBy: owner } });
  expect(sent.body, JSON.stringify(sent.body).slice(0, 300)).toMatchObject({ definite: true, accepted: true });
  const [direct] = await venueFills(from);
  expect(direct, 'the direct order filled with our builder fee').toBeTruthy();

  await page.reload();
  venue = page.getByTestId('builder-fee-venue');
  block = venue.getByTestId('builder-fee-volume');
  await expect(block).toHaveAttribute('data-state', 'gap', { timeout: 30_000 });
  const gap = venue.getByTestId('builder-fee-volume-gaps').locator(`tr[data-fill-id="${direct.fillId}"]`);
  await expect(gap).toHaveAttribute('data-reason', 'not_a_routed_order');
  const g = await gap.locator('td').allInnerTexts();
  expect(g[0]).toBe(direct.fillId);
  expect(g[3]).toBe('none');
  expect(dec(g[4])).toBe('0');
  expect(dec(g[5])).toBe(dec(direct.builderFee));
  expect(dec(g[6].split(' ')[0])).toBe(dec(direct.builderFee));
  expect(g[7]).toBe('Gap: the venue charged our builder fee on a fill of no order we routed');
  // Volume we did not route is not counted as routed volume: the routed row is as it was.
  const after = await block.locator(`tbody tr[data-asset="${asset}"] td`).allInnerTexts();
  expect(Number(after[1])).toBe(fills.length);
  expect(dec(after[2].split(' ')[0])).toBe(dec(fromUnits(volume)));
});

test(`${J} #5 exports for the period: a file whose rows match the ledger's builder-fee records`, async ({ page, browser }) => {
  test.setTimeout(300_000);
  const id = await venueId();
  const to = new Date(Date.now() + 10 * 60_000);
  await expect.poll(async () => (await recon(start, to)).venues[0]?.matched ?? null, { timeout: 60_000 }).toBe(true);
  const fills = await venueFills(start);

  await staffSignIn(page, browser, 'finance');
  const venue = await openRecon(page, start, to);
  const download = page.waitForEvent('download');
  await venue
    .getByTestId('builder-fee-export')
    .getByRole('button', { name: /Export CSV/ })
    .click();
  const file = await download;
  const text = await (await import('node:fs/promises')).readFile(await file.path(), 'utf8');
  // The file says when it was made, how fresh its data is and what it covers, on `#` lines above the header.
  const lines = text.trim().split(/\r?\n/);
  const notes = lines.filter((l) => l.startsWith('#'));
  expect(notes[0]).toMatch(/^# Generated at \d{4}-\d\d-\d\dT/);
  expect(notes[1]).toMatch(/^# Data as of /);
  expect(notes[2]).toBe(`# Builder fees the ledger records as earned on ${id}, fills from ${start.toISOString()} to ${to.toISOString()}`);
  const [header, ...rows] = lines.filter((l) => !l.startsWith('#'));
  expect(header).toBe('ledger_tx_id,idempotency_key,venue_id,fill_id,user_id,asset,amount,posted_at');
  // One row per fill the venue charged our fee on in the period, each read back from svc-ledger itself.
  const byFill = new Map(rows.map((r) => r.split(',')).map((c) => [c[3], c]));
  expect([...byFill.keys()].sort()).toEqual(fills.map((f) => f.fillId).sort());
  for (const f of fills) {
    const [txId, key, venueCol, , , asset, amount, postedAt] = byFill.get(f.fillId);
    expect(venueCol).toBe(id);
    expect(key).toBe(`builder-fee:${id}:${f.fillId}`);
    const tx = await ledgerRead(`/operator/transactions/${encodeURIComponent(txId)}`);
    expect(tx).toMatchObject({ txId, businessKey: key, reason: 'trade.builder_fee.earned', postedAt });
    const debit = tx.postings.find((p) => p.direction === 'debit');
    expect(debit.assetId).toBe(asset);
    expect(dec(debit.amount)).toBe(dec(amount));
    expect(dec(amount)).toBe(dec(f.builderFee));
  }
});
