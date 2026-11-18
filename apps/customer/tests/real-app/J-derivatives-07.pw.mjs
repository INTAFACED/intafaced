// World: book, gates, restart, stack
import { randomBytes } from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';
import { test, expect } from './journey.mjs';
import { EDGE, ORIGIN, api, fromUnits, journeyState, toUnits } from './stack.mjs';
import { signUp, verify } from './desk.mjs';
import { testWalletKey } from './test-wallet.mjs';
import { doorCalls, ledgerUntouched, ledgerView, openVenueRoom, signedOnVenue, venueAt, venueNow, walletOwner } from './venue-door.mjs';
import { TEST_VENUE, testVenueAt, venueForThisFile } from './venue.mjs';

// J-derivatives-07, "I understand a liquidation on the venue and its aftermath: fee, insurance fund and
// auto-deleveraging", on the person's own venue account (the launch money model: the venue liquidates, charges its fee and
// runs its insurance fund and auto-deleveraging; INTAFACED runs no fund and our ledger posts nothing), in the running app
// against the stack's TEST venue simulator (packages/venue-sim), which drives the liquidation. One test per step, titled
// "J-derivatives-07 #<n>", run in order on one TEST account.
//
// The Starts line, made at the start of #1 straight on the TEST venue with the person's own key: a TEST isolated long of
// 1 XLIQ-PERP at 10x, taken from the TEST makers' ladder. XLIQ-PERP is the TEST perpetual the TEST venue liquidates on and
// only this journey trades, so moving its mark reaches no other journey. Every figure the page shows is checked against
// the TEST venue's own record, read straight from the venue, never through our door; the ledger is read before and after
// to show it posts nothing. Every figure is TEST.
const J = 'J-derivatives-07';
const ROOM = '/trade/positions';
const LIQ = 'XLIQ-PERP';
const FUNDS = '200';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);

test.describe.configure({ mode: 'default' });
venueForThisFile(test);

// ── the TEST venue, read and signed on directly ──

const accountOf = (venue, owner) => ({ venueId: venue.id, owner, subAccount: null });
/** The venue's own record for the account (`/positions`, `/balances`, `/liquidations`, ...). */
const record = async (venue, owner, path, extra = {}) => (await venueAt(path, { account: accountOf(venue, owner), ...extra })).value;
const positionOn = async (venue, owner) => (await record(venue, owner, '/positions')).find((p) => p.symbol === LIQ) ?? null;
const usdcOn = async (venue, owner) =>
  (await record(venue, owner, '/balances')).find((b) => b.asset === 'USDC') ?? { free: '0', locked: '0', total: '0' };
const liquidationOn = async (venue, owner, id) =>
  (await record(venue, owner, '/liquidations', { since: new Date(0).toISOString() })).find((l) => l.liquidationId === id);
const fundNow = async () => (await venueAt('/insurance-fund', {})).value;
const setMark = (price) => venueAt('/test/set-mark', { symbol: LIQ, price });

const order = (side, price, clientOrderKey) => ({
  kind: 'place_order',
  symbol: LIQ,
  side,
  type: 'limit',
  amount: '1',
  price,
  timeInForce: 'IOC',
  reduceOnly: false,
  clientOrderKey,
  builderFee: null,
});

// ── the person and the page ──

const state = () => walletOwner(run, `${J} #1`);
const signatures = (wallet) => wallet.requests.filter((r) => r.method === 'eth_signTypedData_v4').length;
const same = (a, b) => toUnits(String(a).trim()) === toUnits(String(b).trim());

const rowOf = (page, venue) => page.getByTestId('positions-all').locator(`tr[data-venue="${venue.id}"][data-symbol="${LIQ}"]`);

/** TEST setup, not a step (the Starts line): a verified account, its wallet, TEST USDC on the venue and an isolated long. */
async function startsLine(browser) {
  const page = await browser.newPage();
  try {
    const account = await signUp(page, 'jd7');
    await verify(page, account);
    const walletKey = testWalletKey();
    const key = privateKeyToAccount(walletKey);
    const owner = key.address.toLowerCase();
    const venue = await venueNow();
    // The market back at its TEST start and its makers' ladder rested again, whatever an earlier run left.
    await setMark('100');
    await venueAt('/test/seed', {});
    await venueAt('/test/deposit', {
      account: accountOf(venue, owner),
      asset: 'USDC',
      amount: FUNDS,
      depositRef: `84532:0x${randomBytes(32).toString('hex')}:0`,
    });
    const tag = randomBytes(4).toString('hex');
    await signedOnVenue(venue, key, { kind: 'update_leverage', symbol: LIQ, leverageBps: 100_000, marginMode: 'isolated' });
    await signedOnVenue(venue, key, order('buy', '101', `order:jd7:${tag}:open`));
    const p = await positionOn(venue, owner);
    expect(p).toMatchObject({ side: 'long', marginMode: 'isolated', leverageBps: 100_000 });
    expect(same(p.size, '1')).toBe(true);
    expect(p.liquidationPrice.known).toBe(true);
    const fund = await fundNow();
    expect(fund.known).toBe(true);
    run.reset({ account, walletKey, tag, ledger: await ledgerView(account), fundBefore: fund.value.balance });
  } finally {
    await page.close();
  }
}

test(`${J} #1 opens a position's liquidation panel: the venue's state (none, in progress, done) and price rule; an edit refused during liquidation shows the venue's reason`, async ({
  page,
  browser,
}) => {
  test.setTimeout(600_000);
  await startsLine(browser);
  const s = state();
  const venue = await venueNow();
  const wallet = await openVenueRoom(page, s, ROOM);
  const door = doorCalls(page);
  await rowOf(page, venue).getByRole('button', { name: 'Liquidation', exact: true }).click();
  const panel = page.getByTestId('position-liquidation');
  await expect(panel).toContainText(`Liquidation of ${LIQ}`);
  const stateLine = panel.locator('[data-line="state"]');

  // None: the venue's own state and its price rule, as the venue reports them.
  const none = await record(venue, s.owner, '/liquidation-status', { symbol: LIQ });
  expect(none).toMatchObject({ state: 'none', liquidationId: null });
  await expect(stateLine).toHaveText(`None: ${venue.name} is not liquidating this position.`, { timeout: 20_000 });
  await expect(panel.locator('[data-line="price-rule"]')).toHaveText(none.priceRule);
  // And the fee it charges, in its own words (#3 reads the fee it charged against this rule).
  expect(none.feeRule).toBeTruthy();
  await expect(panel.locator('[data-line="fee-rule"]')).toHaveText(none.feeRule);
  await expect(panel.getByTestId('venue-as-of')).toHaveText(/\d{4}.*\d{2}:\d{2}:\d{2}/);

  // The TEST venue's mark reaches the position's liquidation price: the venue starts liquidating it.
  const p = await positionOn(venue, s.owner);
  await setMark(p.liquidationPrice.value);
  const live = await record(venue, s.owner, '/liquidation-status', { symbol: LIQ });
  expect(live.state).toBe('in_progress');
  await expect(stateLine).toHaveText(`In progress: ${venue.name} is liquidating this position (${live.liquidationId}).`, {
    timeout: 20_000,
  });
  await expect(stateLine).toHaveAttribute('data-state', 'in_progress');

  // An edit during the liquidation: the venue refuses it, before the wallet is asked, and the page shows its reason.
  await rowOf(page, venue).getByRole('button', { name: 'Margin', exact: true }).click();
  const margin = page.getByTestId('position-margin');
  await expect(margin.locator('[data-line="margin"]')).toBeVisible({ timeout: 20_000 });
  const asked = signatures(wallet);
  await margin.getByRole('textbox', { name: 'Amount (USDC)', exact: true }).fill('1');
  await margin.getByRole('button', { name: 'Add margin', exact: true }).click();
  const theirs = await testVenueAt(TEST_VENUE, '/prepare', {
    account: accountOf(venue, s.owner),
    signer: { role: 'owner', address: s.owner },
    intent: { kind: 'update_isolated_margin', symbol: LIQ, direction: 'add', amount: '1', changeKey: `margin:jd7:${s.tag}:probe` },
  });
  expect(theirs.status).toBe(422);
  expect(theirs.body.refusal.detail).toContain(`${LIQ} is being liquidated (${live.liquidationId})`);
  await expect(margin.getByTestId('venue-outcome')).toContainText(theirs.body.refusal.detail, { timeout: 20_000 });
  expect(signatures(wallet)).toBe(asked);
  expect(door.of('submit')).toHaveLength(0);

  // The venue's next mark finishes it: done, and the panel stays to say so once the position is gone.
  await setMark(fromUnits(toUnits(p.liquidationPrice.value) - toUnits('1')));
  const done = await record(venue, s.owner, '/liquidation-status', { symbol: LIQ });
  expect(done).toMatchObject({ state: 'done', liquidationId: live.liquidationId });
  await expect(stateLine).toHaveText(`Done: ${venue.name} liquidated this position (${done.liquidationId}).`, { timeout: 20_000 });
  expect(await positionOn(venue, s.owner)).toBeNull();
  await expect(rowOf(page, venue)).toHaveCount(0, { timeout: 20_000 });
  run.write({ liquidationId: done.liquidationId, feeRule: none.feeRule });
  await ledgerUntouched(s);
});

test(`${J} #2 reads the liquidation list: each liquidation with its price, size, fee and the venue's id; a partial one lists each part`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  const s = state();
  const venue = await venueNow();
  await openVenueRoom(page, s, ROOM);
  const l = await liquidationOn(venue, s.owner, s.liquidationId);
  expect(l).toMatchObject({ symbol: LIQ, side: 'long', state: 'done' });
  // The venue closed it in two parts, half and the rest: each its own row.
  expect(l.parts).toHaveLength(2);
  const list = page.getByRole('region', { name: 'Liquidations', exact: true }).locator(`[data-venue="${venue.id}"]`);
  await expect(list).toContainText(`On ${venue.name}`);
  for (const part of l.parts) {
    const row = list.locator(`tr[data-part="${part.partId}"]`);
    await expect(row).toBeVisible({ timeout: 20_000 });
    await expect(row).toHaveAttribute('data-liquidation', l.liquidationId);
    await expect(row.locator('[data-cell="liquidation"]')).toHaveText(l.liquidationId);
    await expect(row.locator('[data-cell="part"]')).toHaveText(part.partId);
    await expect(row.locator('[data-cell="symbol"]')).toHaveText(LIQ);
    await expect(row.locator('[data-cell="state"]')).toHaveText('Done');
    await expect(row.locator('[data-cell="size"]')).toHaveText(part.size);
    await expect(row.locator('[data-cell="price"]')).toHaveText(part.price);
    await expect(row.locator('[data-cell="fee"]')).toHaveText(`${part.fee} ${part.feeAsset}`);
  }
  // The parts are the whole position, at the two marks the venue liquidated at.
  expect(fromUnits(l.parts.reduce((sum, x) => sum + toUnits(x.size), 0n))).toBe('1');
  expect(toUnits(l.parts[1].price)).toBeLessThan(toUnits(l.parts[0].price));
  await expect(list.getByTestId('venue-as-of')).toHaveText(/\d{4}.*\d{2}:\d{2}:\d{2}/);
  await ledgerUntouched(s);
});

test(`${J} #3 reads the fee charged: the venue's liquidation fee as the venue reports it, read from the venue`, async ({ page }) => {
  test.setTimeout(300_000);
  const s = state();
  const venue = await venueNow();
  await openVenueRoom(page, s, ROOM);
  const l = await liquidationOn(venue, s.owner, s.liquidationId);
  const status = await record(venue, s.owner, '/liquidation-status', { symbol: LIQ });
  const list = page.getByRole('region', { name: 'Liquidations', exact: true }).locator(`[data-venue="${venue.id}"]`);
  // Each part's fee is the venue's own figure, to its last digit, in the asset it charged.
  for (const part of l.parts)
    await expect(list.locator(`tr[data-part="${part.partId}"] [data-cell="fee"]`)).toHaveText(`${part.fee} ${part.feeAsset}`, {
      timeout: 20_000,
    });
  // The fee the venue charged went into its own fund: the fund rose by at least these fees (the same mark may liquidate
  // other TEST accounts on the market, the TEST makers', whose fees go in too).
  const fees = l.parts.reduce((sum, x) => sum + toUnits(x.fee), 0n);
  expect(fees).toBeGreaterThan(0n);
  const fund = await fundNow();
  expect(toUnits(fund.value.balance) - toUnits(s.fundBefore)).toBeGreaterThanOrEqual(fees);
  // The venue's fee rule, in its own words, is the one the position's panel showed in #1.
  expect(status.feeRule).toBe(s.feeRule);
  await ledgerUntouched(s);
});

test(`${J} #4 opens the insurance fund: the venue's fund and where to read it; INTAFACED runs none; a venue that publishes none reads "not published by this venue", never 0`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  const s = state();
  const venue = await venueNow();
  await openVenueRoom(page, s, ROOM);
  const region = page.getByRole('region', { name: 'Insurance fund', exact: true });
  await expect(region).toContainText(`${venue.name} runs its own insurance fund. INTAFACED runs no fund.`);
  const fund = await fundNow();
  expect(fund.known).toBe(true);
  await expect(region.locator('[data-line="fund-name"]')).toHaveText(fund.value.name, { timeout: 20_000 });
  await expect(region.locator('[data-line="fund-where"]')).toHaveText(fund.value.whereToRead);
  await expect(region.locator('[data-line="fund-rule"]')).toHaveText(fund.value.rule);
  await expect(async () => {
    const now = await fundNow();
    expect(await region.locator('[data-line="fund-balance"]').innerText()).toBe(`${now.value.balance} ${now.value.asset}`);
  }).toPass({ timeout: 20_000 });

  // The venue publishes no fund: the page says so, and shows no balance, never a zero.
  await venueAt('/test/insurance-fund', { published: false });
  try {
    await expect(region.locator('[data-line="fund-unpublished"]')).toHaveText('Not published by this venue.', { timeout: 20_000 });
    await expect(region.locator('[data-line="fund-balance"]')).toHaveCount(0);
    await expect(region).not.toContainText(/\b0 USDC\b/);
  } finally {
    await venueAt('/test/insurance-fund', { published: true });
  }
  await ledgerUntouched(s);
});

test(`${J} #5 acknowledges the auto-deleveraging disclosure: "I have read this" stores the acknowledged version; a stale version does not satisfy the gate`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  const s = state();
  const venue = await venueNow();
  await openVenueRoom(page, s, ROOM);
  const rules = (await venueAt('/adl-rules', {})).value;
  expect(rules).toBeTruthy();
  const region = page.getByRole('region', { name: 'Auto-deleveraging', exact: true });
  await expect(region.locator('[data-line="adl-version"]')).toHaveText(`Version ${rules.version}`, { timeout: 20_000 });
  await expect(region.locator('[data-line="adl-rules"]')).toHaveText(rules.text);
  const ack = region.locator('[data-line="adl-ack"]');
  await expect(ack).toHaveText('You haven’t acknowledged these rules.');

  await region.getByRole('button', { name: 'I have read this', exact: true }).click();
  await expect(ack).toHaveAttribute('data-acknowledged', 'true', { timeout: 20_000 });
  await expect(ack).toContainText(`You acknowledged version ${rules.version} at `);
  // Stored: a fresh read of the page, and the door, still hold that version.
  await page.reload();
  await expect(region.locator('[data-line="adl-ack"]')).toHaveAttribute('data-acknowledged', 'true', { timeout: 30_000 });
  const who = await api(s.account);
  const stored = await who.get('/api/v1/venue/adl-disclosure');
  expect(stored.status).toBe(200);
  expect(stored.body).toMatchObject({ acknowledged: true, acknowledgedVersion: rules.version, rules: { version: rules.version } });

  // The venue publishes a new version: the stored one is stale and does not satisfy, and acknowledging the old one is refused.
  const next = { version: `TEST-adl-${s.tag}`, text: `${rules.text} TEST: version ${s.tag}.` };
  await venueAt('/test/adl-rules', next);
  try {
    await expect(region.locator('[data-line="adl-version"]')).toHaveText(`Version ${next.version}`, { timeout: 20_000 });
    await expect(ack).toHaveAttribute('data-acknowledged', 'false');
    await expect(ack).toHaveText(
      `You acknowledged version ${rules.version}; ${venue.name} has since published version ${next.version}. Read the rules above and acknowledge them again.`,
    );
    const stale = await who.post('/api/v1/venue/adl-disclosure/ack', { version: rules.version });
    expect(stale.status).toBe(409);
    expect(stale.body.intafacedCode).toBe('trade.venue_adl_version_stale');
    expect((await who.get('/api/v1/venue/adl-disclosure')).body).toMatchObject({ acknowledged: false, acknowledgedVersion: rules.version });
    // Read again and acknowledged: the new version is stored.
    await region.getByRole('button', { name: 'I have read this', exact: true }).click();
    await expect(ack).toHaveAttribute('data-acknowledged', 'true', { timeout: 20_000 });
    expect((await who.get('/api/v1/venue/adl-disclosure')).body).toMatchObject({ acknowledged: true, acknowledgedVersion: next.version });
  } finally {
    await venueAt('/test/adl-rules', rules);
  }
  await ledgerUntouched(s);
});

test(`${J} #6 is deleveraged by the venue: the close and the venue's notice, read from the venue; INTAFACED pays nothing`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  const s = state();
  const venue = await venueNow();
  // TEST setup on the venue: the market back at its start and a short of 1 XLIQ-PERP, which the venue then deleverages.
  await setMark('100');
  await venueAt('/test/seed', {});
  await signedOnVenue(venue, s.key, order('sell', '99', `order:jd7:${s.tag}:short`));
  const p = await positionOn(venue, s.owner);
  expect(p).toMatchObject({ side: 'short' });
  const before = await usdcOn(venue, s.owner);
  const price = fromUnits(toUnits(p.entryPrice) - toUnits('5'));
  await openVenueRoom(page, s, ROOM);
  await expect(rowOf(page, venue)).toBeVisible({ timeout: 20_000 });

  const { deleverage } = await venueAt('/test/deleverage', { account: accountOf(venue, s.owner), symbol: LIQ, price });
  const theirs = (await record(venue, s.owner, '/deleverages', { since: new Date(0).toISOString() })).find(
    (d) => d.adlId === deleverage.adlId,
  );
  expect(theirs).toMatchObject({ symbol: LIQ, side: 'short', size: '1', price });
  const region = page.getByRole('region', { name: 'Auto-deleveraging', exact: true });
  const event = region.locator(`[data-adl="${theirs.adlId}"]`);
  await expect(event.locator('[data-line="adl-close"]')).toContainText(
    `${venue.name} closed your Short of ${theirs.size} ${LIQ} at ${theirs.price}; realised result ${theirs.realisedPnl}.`,
    { timeout: 20_000 },
  );
  await expect(event.locator('[data-line="adl-notice"]')).toHaveText(theirs.notice);
  await expect(region).toContainText(`INTAFACED pays nothing on an auto-deleveraging: ${venue.name} closes the position and settles it.`);
  // The venue closed it and settled it on the venue: margin and result back to free, no fee.
  expect(await positionOn(venue, s.owner)).toBeNull();
  await expect(rowOf(page, venue)).toHaveCount(0, { timeout: 20_000 });
  expect((await usdcOn(venue, s.owner)).free).toBe(fromUnits(toUnits(before.free) + toUnits(p.margin) + toUnits(theirs.realisedPnl)));
  run.write({ adlId: theirs.adlId, adlPrice: theirs.price });
  // INTAFACED pays nothing: our ledger posted nothing.
  await ledgerUntouched(s);
});

test(`${J} #7 reads the public liquidation and ADL alert streams: symbol, side, size and price with no account identity`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  const s = state();
  const venue = await venueNow();
  await openVenueRoom(page, s, ROOM);
  const l = await liquidationOn(venue, s.owner, s.liquidationId);
  // The venue's own public alerts for the market.
  const alerts = (await venueAt('/liquidation-alerts', { symbol: LIQ, limit: 50 })).value;
  const ofPart = (part) =>
    alerts.find((a) => a.kind === 'liquidation' && a.side === l.side && a.size === part.size && a.price === part.price);
  for (const part of l.parts) expect(ofPart(part)).toBeTruthy();
  const adl = alerts.find((a) => a.kind === 'deleverage' && a.price === s.adlPrice);
  expect(adl).toMatchObject({ symbol: LIQ, side: 'short', size: '1' });

  const region = page.getByTestId('liquidation-alerts');
  const rows = region.locator(`tr[data-symbol="${LIQ}"]`);
  await expect(rows.first()).toBeVisible({ timeout: 20_000 });
  const shown = async () =>
    rows.evaluateAll((trs) =>
      trs.map((tr) => ['kind', 'symbol', 'side', 'size', 'price'].map((c) => tr.querySelector(`[data-cell="${c}"]`)?.textContent ?? '')),
    );
  await expect(async () => {
    const got = await shown();
    for (const part of l.parts) expect(got).toContainEqual(['Liquidation', LIQ, 'Long', part.size, part.price]);
    expect(got).toContainEqual(['Auto-deleveraging', LIQ, 'Short', adl.size, adl.price]);
  }).toPass({ timeout: 20_000 });
  // No account identity on the page's alerts: not the wallet, not the venue's liquidation or deleveraging ids.
  const html = await region.innerHTML();
  expect(html.toLowerCase()).not.toContain(s.owner);
  expect(html).not.toContain(l.liquidationId);
  expect(html).not.toContain(s.adlId);

  // The stream is public: read with no sign-in, it carries each alert's market, side, size, price and time, and nothing more.
  const res = await fetch(`${EDGE}/api/v1/venue/liquidation-alerts?symbol=${LIQ}&limit=50`, { headers: { origin: ORIGIN } });
  expect(res.status).toBe(200);
  const open = await res.json();
  expect(open.value.length).toBeGreaterThan(0);
  for (const a of open.value) expect(Object.keys(a).sort()).toEqual(['alertedAt', 'kind', 'price', 'side', 'size', 'symbol']);
  expect(JSON.stringify(open).toLowerCase()).not.toContain(s.owner);
  await ledgerUntouched(s);
});
