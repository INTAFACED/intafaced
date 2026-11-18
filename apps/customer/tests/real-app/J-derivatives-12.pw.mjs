// World: book, gates, restart, stack
import { randomBytes } from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';
import { test, expect } from './journey.mjs';
import { approverSessions, makeContext } from '../../../../tooling/scripts/local-test-gates.mjs';
import { api, journeyState, restartWithSetting, toUnits } from './stack.mjs';
import { signUp, verify } from './desk.mjs';
import { testWalletKey } from './test-wallet.mjs';
import { ledgerView, venueAtBase } from './venue-door.mjs';
import { openVenueDesk, sameDecimal, TEST_VENUE, TEST_VENUE_B, venueForThisFile, venueRecord } from './venue.mjs';

// J-derivatives-12, "I see my derivatives fees, VIP level, account summary, bills and eligible instruments", on the venue
// futures desk's account panel, in the running app against the stack's two TEST venue simulators (LOCAL_STACK_USER_VENUE=two).
// One test per step, titled "J-derivatives-12 #<n>", run in order on one TEST account. Every figure on the page is checked
// against the TEST venue's own record, read straight from that venue (never through our door), and every builder fee
// against svc-ledger's own operator trace under the fill's key. Every figure is TEST.
//
// The Starts line, made at the start of #1 through our door, signed with the person's own key: TEST USDC on both venues,
// our builder fee approved and an isolated 10x long of 0.2 XBIL-PERP on the first venue (XBIL-PERP is this journey's own
// TEST perpetual: only this file moves its mark or closes its funding period), one funding period closed on it, 0.1
// closed reduce-only, and the other 0.1 liquidated by moving its TEST mark to its liquidation price (one lot: one part).
const J = 'J-derivatives-12';
const DESK = '/trade/futures';
const SYMBOL = 'XBIL-PERP';
const FUNDS = '1000';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);

test.describe.configure({ mode: 'default' });
venueForThisFile(test, 'two');

// ── the two TEST venues, read and changed directly (what the page must equal) ──

const at = venueAtBase;
const info = async (base) => {
  const v = await at(base, '/venue');
  expect(v.label).toBe('TEST');
  return { id: v.venue.id, name: v.venue.displayName, base };
};
const both = async () => [await info(TEST_VENUE), await info(TEST_VENUE_B)];
/** The venue's own record of the person's account on `venue`. */
const record = async (venue, owner, path, extra = {}) => (await venueRecord(owner, path, extra, venue.base)).value;
const marketsOn = async (venue) => (await at(venue.base, '/markets', {})).value;

// ── svc-ledger's own operator door (J-cex-spot-06, J-derivatives-17) ──

let operators = null;
async function ledgerRead(path) {
  operators ??= (async () => {
    const ctx = await makeContext({ log: () => undefined });
    return { ctx, sessions: await approverSessions(ctx) };
  })();
  const { ctx, sessions } = await operators;
  const res = await fetch(`${ctx.url('ledger')}${path}`, { headers: { authorization: `Bearer ${await sessions.a.treasuryToken()}` } });
  const text = await res.text();
  expect(res.status, text.slice(0, 300)).toBe(200);
  return JSON.parse(text);
}
const traceOf = (key) => ledgerRead(`/operator/trace?businessKey=${encodeURIComponent(key)}`);

// ── the person, our door and the page ──

function state() {
  const s = run.read();
  if (!s.account || !s.walletKey) throw new Error(`${J} #1 made no account and wallet, so this step has no one to act as`);
  return { ...s, key: privateKeyToAccount(s.walletKey), owner: privateKeyToAccount(s.walletKey).address.toLowerCase() };
}

/** One action through our door on `venue`, as the person: prepare, sign with their key, submit. */
async function door(s, venue, intent, actionKey) {
  const client = await api(s.account);
  const prep = await client.post('/api/v1/venue/prepare', {
    venueId: venue.id,
    owner: s.owner,
    signer: { role: 'owner', address: s.owner },
    intent,
    ...(actionKey ? { actionKey } : {}),
  });
  expect(prep.status, JSON.stringify(prep.body).slice(0, 300)).toBe(200);
  const t = prep.body.prepared.typedData;
  const signature = await s.key.signTypedData({ domain: t.domain, types: t.types, primaryType: t.primaryType, message: t.message });
  const sent = await client.post('/api/v1/venue/submit', {
    actionKey: prep.body.actionKey,
    signature: { digest: prep.body.prepared.digest, signature, signedBy: s.owner },
  });
  expect(sent.body.outcome, JSON.stringify(sent.body).slice(0, 300)).toMatchObject({ definite: true, accepted: true });
  return { ...sent.body, prepared: prep.body.prepared };
}
const order = (s, side, amount, price, reduceOnly, step) => ({
  kind: 'place_order',
  symbol: SYMBOL,
  side,
  type: 'limit',
  amount,
  price,
  timeInForce: 'IOC',
  reduceOnly,
  clientOrderKey: `order:jd12:${s.tag}:${step}`,
  builderFee: null,
});

/** The futures desk as the person, with XBIL-PERP picked and the account panel's `tab` open. */
async function accountTab(page, s, tab) {
  const [a] = await both();
  await openVenueDesk(page, s.account, DESK, s.walletKey);
  const pick = page.getByTestId('venue-contract-list').getByRole('button', { name: `${SYMBOL} · ${a.name}`, exact: true });
  await pick.click();
  await expect(pick).toHaveAttribute('aria-pressed', 'true');
  const panel = page.getByTestId('venue-account');
  await expect(panel).toBeVisible({ timeout: 30_000 });
  await panel.getByRole('group', { name: 'Your venue accounts', exact: true }).getByRole('button', { name: tab, exact: true }).click();
  return panel;
}
const section = (panel, venue) => panel.locator(`section[data-venue="${venue.id}"]`);
const plain = (text) => text.replace(/,/g, '').trim();
/** The page comes to show `want` (a decimal, compared exactly) where `read` reads it: retried until it does. */
const shows = (read, want, message) => expect.poll(async () => sameDecimal(await read(), want), { message, timeout: 20_000 }).toBe(true);
const textOf = (locator) => async () => plain(await locator.innerText());
const attrOf = (locator, name) => async () => locator.getAttribute(name);

/** TEST setup, not a step (the Starts line). */
async function startsLine(browser) {
  const page = await browser.newPage();
  try {
    const [a, b] = await both();
    await at(a.base, '/test/set-index', { symbol: SYMBOL, price: '100' });
    await at(a.base, '/test/set-mark', { symbol: SYMBOL, price: '100' });
    const account = await signUp(page, 'jd12');
    await verify(page, account);
    const walletKey = testWalletKey();
    const owner = privateKeyToAccount(walletKey).address.toLowerCase();
    for (const venue of [a, b])
      await at(venue.base, '/test/deposit', {
        account: { venueId: venue.id, owner, subAccount: null },
        asset: 'USDC',
        amount: FUNDS,
        depositRef: `84532:0x${randomBytes(32).toString('hex')}:0`,
      });
    const startedAt = new Date(Date.now() - 60_000).toISOString();
    run.reset({ account, walletKey, tag: randomBytes(4).toString('hex'), since: startedAt });
    const s = state();
    const client = await api(account);
    const builder = (await client.get('/api/v1/venue/status')).body.builder;
    expect(builder?.feeBps, 'the stack publishes a TEST builder fee').toBeTruthy();
    await door(
      s,
      a,
      { kind: 'approve_builder_fee', builder: builder.address, maxFeeBps: builder.feeBps },
      `builder-approval:${owner}:${a.id}:${builder.address}:${builder.feeBps}`,
    );
    await door(
      s,
      a,
      { kind: 'update_leverage', symbol: SYMBOL, leverageBps: 100_000, marginMode: 'isolated' },
      `leverage:${owner}:${SYMBOL}:isolated:10:jd12-${s.tag}`,
    );
    const opened = await door(s, a, order(s, 'buy', '0.2', '100.5', false, 'open'));
    expect(opened.prepared.builderFee, 'our door signs our builder fee into the order').not.toBeNull();
    let p = (await record(a, owner, '/positions')).find((x) => x.symbol === SYMBOL);
    expect(p).toMatchObject({ side: 'long', size: '0.2', marginMode: 'isolated' });
    // One funding period closed on the TEST venue's clock: a payment on the long (the interest component, mark = index).
    await at(a.base, '/test/settle-funding', { symbol: SYMBOL });
    // Half closed reduce-only against the TEST makers' bids.
    await door(s, a, order(s, 'sell', '0.1', '99.5', true, 'close'));
    p = (await record(a, owner, '/positions')).find((x) => x.symbol === SYMBOL);
    expect(p).toMatchObject({ side: 'long', size: '0.1' });
    // The rest: the TEST mark reaches its liquidation price, and the venue liquidates the one lot in one part.
    expect(p.liquidationPrice.known).toBe(true);
    await at(a.base, '/test/set-mark', { symbol: SYMBOL, price: p.liquidationPrice.value });
    expect((await record(a, owner, '/liquidation-status', { symbol: SYMBOL })).state).toBe('done');
    expect((await record(a, owner, '/positions')).find((x) => x.symbol === SYMBOL)).toBeUndefined();
    await at(a.base, '/test/set-mark', { symbol: SYMBOL, price: '100' });
    run.write({ ledger: await ledgerView(account), builder });
  } finally {
    await page.close();
  }
}

test(`${J} #1 opens My Fees: the venue's maker and taker rates and our builder fee per product family; a builder fee not set reads "fee schedule not set" and opens refuse`, async ({
  page,
  browser,
}) => {
  test.setTimeout(600_000);
  await startsLine(browser);
  const s = state();
  const venues = await both();
  const client = await api(s.account);
  const panel = await accountTab(page, s, 'My fees');
  for (const venue of venues) {
    const box = section(panel, venue).getByTestId('venue-my-fees');
    const theirs = new Map((await marketsOn(venue)).map((m) => [m.symbol, m]));
    const ours = (await client.get(`/api/v1/venue/fees?venueId=${venue.id}`)).body.value.markets;
    expect(ours.length, `${venue.name} lists markets`).toBeGreaterThan(0);
    for (const m of ours) {
      const row = box.locator(`tr[data-market="${m.symbol}"]`);
      const v = theirs.get(m.symbol);
      expect(v, `${m.symbol} is the venue's own market`).toBeTruthy();
      // The venue's maker and taker rates, digit for digit as the venue publishes them.
      for (const side of ['maker', 'taker']) {
        const rate = v[`${side}FeeBps`];
        const cell = row.locator(`[data-cell="${side}"]`);
        await expect(cell).toBeVisible({ timeout: 20_000 });
        if (rate.known) await shows(attrOf(cell, 'data-value'), rate.value, `${venue.name} ${m.symbol} ${side}`);
        else await expect(cell).toHaveText('not published by the venue');
      }
      // Our builder fee: the one our door signs into an order, per family (a perpetual's on both sides, a spot one on sells).
      const builder = row.locator('[data-cell="builder"]');
      expect(m.builderFeeBps.known, `${m.symbol} carries our builder fee`).toBe(true);
      await shows(attrOf(builder, 'data-value'), m.builderFeeBps.value, `${venue.name} ${m.symbol} builder`);
      if (m.kind === 'perpetual') expect(sameDecimal(m.builderFeeBps.value, s.builder.feeBps)).toBe(true);
      await expect(builder).not.toHaveText('fee schedule not set');
    }
    // Each family's line: the account's own rates as the venue reports them for it, or "each market's own rate".
    const tier = await record(venue, s.owner, '/fee-status');
    for (const family of ['perpetual', 'spot']) {
      const fam = box.locator(`div[data-family="${family}"]`);
      if ((await fam.count()) === 0) continue;
      const rates = tier.account?.[family];
      for (const side of ['maker', 'taker']) {
        const rate = rates?.[`${side}FeeBps`];
        const cell = fam.locator(`[data-line="family-rates"] [data-cell="${side}"]`);
        if (rate?.known) await shows(attrOf(cell, 'data-value'), rate.value, `${venue.name} ${family} ${side}`);
      }
    }
  }

  // A builder fee not set (the owner value blank): every row reads "fee schedule not set", and an open refuses by name.
  const savedVenue = process.env.LOCAL_STACK_USER_VENUE;
  process.env.LOCAL_STACK_USER_VENUE = 'two';
  try {
    restartWithSetting('trade', 'LOCAL_STACK_USER_VENUE_BUILDER_FEE', 'off');
    const blank = await accountTab(page, s, 'My fees');
    for (const venue of venues) {
      const cells = section(blank, venue).locator('[data-cell="builder"]');
      await expect(cells.first()).toHaveText('fee schedule not set', { timeout: 20_000 });
      for (const text of await cells.allInnerTexts()) expect(text).toBe('fee schedule not set');
      const prep = await (
        await api(s.account)
      ).post('/api/v1/venue/prepare', {
        venueId: venue.id,
        owner: s.owner,
        signer: { role: 'owner', address: s.owner },
        intent: order(s, 'buy', '0.1', '100.5', false, `blank-${venue.id}`),
      });
      expect(prep.status, JSON.stringify(prep.body).slice(0, 300)).not.toBe(200);
      expect(prep.body.refusal?.code, JSON.stringify(prep.body).slice(0, 300)).toBe('builder_fee_not_published');
    }
    // Nothing reached either venue: no order of this person's is open there.
    for (const venue of venues) expect(await record(venue, s.owner, '/open-orders')).toEqual([]);
  } finally {
    restartWithSetting('trade', 'LOCAL_STACK_USER_VENUE_BUILDER_FEE', null);
    if (savedVenue === undefined) delete process.env.LOCAL_STACK_USER_VENUE;
    else process.env.LOCAL_STACK_USER_VENUE = savedVenue;
  }
});

test(`${J} #2 reads VIP levels and special fees: the venue's tiers against the venue's 30-day volume, and its settlement and other fees where it publishes them`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  const s = state();
  const venues = await both();
  const panel = await accountTab(page, s, 'VIP levels and special fees');
  for (const venue of venues) {
    const box = section(panel, venue);
    const tier = await record(venue, s.owner, '/fee-status');
    const view = box.getByTestId('venue-tier');
    await expect(view).toBeVisible({ timeout: 20_000 });
    // The venue's own window and the volume it counted for the account over it.
    expect(tier.schedule.volumeDays).toBe(30);
    await expect(view.locator('dt').filter({ hasText: 'Volume the venue counted' })).toHaveText('Volume the venue counted (30 days)');
    expect(tier.account.volume.known).toBe(true);
    await expect
      .poll(async () => {
        const now = (await record(venue, s.owner, '/fee-status')).account.volume.value;
        const shown = plain(await view.locator('[data-cell="volume"]').innerText()).split(' ')[0];
        return sameDecimal(shown, now);
      })
      .toBe(true);
    await expect(view.locator('[data-cell="tier"]')).toHaveText(tier.account.tierName);
    // Each tier as the venue publishes it, the account's own one marked.
    for (const t of tier.schedule.tiers) {
      const row = view.locator(`tr[data-tier="${t.name}"]`);
      await shows(textOf(row.locator('[data-cell="from"]')), t.fromVolume, `tier ${t.name}`);
      if (t.name === tier.account.tierName) await expect(row).toHaveAttribute('aria-current', 'true');
      else await expect(row).not.toHaveAttribute('aria-current', 'true');
    }
    // Its settlement and other fees, each as the venue words it.
    expect(tier.otherFees, `${venue.name} publishes its other fees`).toBeTruthy();
    const other = box.getByTestId('venue-other-fees');
    await expect(other.locator('tr[data-other-fee]')).toHaveCount(tier.otherFees.length);
    for (const f of tier.otherFees) {
      const row = other.locator(`tr[data-other-fee="${f.kind}:${f.symbol ?? '*'}"]`);
      await shows(attrOf(row.locator('[data-cell="rate"]'), 'data-value'), f.feeBps, `${f.kind} ${f.symbol}`);
      await expect(row.locator('[data-cell="rule"]')).toHaveText(f.rule);
      await expect(row.locator('[data-cell="applies"]')).toHaveText(f.symbol ?? 'Every market');
      await expect(row.locator('[data-cell="name"]')).toContainText(f.name);
    }
    expect(tier.otherFees.some((f) => f.kind === 'settlement')).toBe(true);
  }

  // Where the venue publishes no other fees, the page says so and shows no figure.
  const [a] = venues;
  await at(a.base, '/test/switches', { otherFeesUnpublished: true });
  try {
    expect((await record(a, s.owner, '/fee-status')).otherFees).toBeNull();
    const again = await accountTab(page, s, 'VIP levels and special fees');
    const box = section(again, a);
    await expect(box.getByTestId('venue-other-fees-unpublished')).toHaveText('Settlement and other fees: not published by the venue.', {
      timeout: 20_000,
    });
    await expect(box.locator('tr[data-other-fee]')).toHaveCount(0);
  } finally {
    await at(a.base, '/test/switches', { otherFeesUnpublished: false });
  }
});

test(`${J} #3 opens the account summary and account configuration: free plus locked equals total on each venue, from the venue; margin mode and collateral as the venue sets them`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  const s = state();
  const venues = await both();
  const client = await api(s.account);
  const panel = await accountTab(page, s, 'Account');
  for (const venue of venues) {
    const box = section(panel, venue).getByTestId('venue-account-summary');
    const balances = await record(venue, s.owner, '/balances');
    expect(balances.length, `${venue.name} holds the TEST USDC`).toBeGreaterThan(0);
    await expect(box.locator('tr[data-asset]')).toHaveCount(balances.length, { timeout: 20_000 });
    for (const bal of balances) {
      // The venue's own figures: free and locked add to its total.
      expect(toUnits(bal.free) + toUnits(bal.locked)).toBe(toUnits(bal.total));
      const row = box.locator(`tr[data-asset="${bal.asset}"]`);
      for (const k of ['free', 'locked', 'total'])
        await shows(textOf(row.locator(`[data-cell="${k}"]`)), bal[k], `${venue.name} ${bal.asset} ${k}`);
    }
    const sum = await record(venue, s.owner, '/account-summary');
    const summary = box.getByTestId('venue-summary');
    await expect(summary).toHaveAttribute('data-asset', sum.asset);
    for (const [line, k] of [
      ['equity', 'equity'],
      ['free', 'free'],
      ['used', 'usedMargin'],
      ['maintenance', 'maintenanceMargin'],
    ])
      await shows(async () => (await textOf(summary.locator(`[data-line="${line}"]`))()).split(' ')[0], sum[k], line);
    const ratio = summary.locator('[data-line="ratio"]');
    if (sum.marginRatio.known) await shows(textOf(ratio), sum.marginRatio.value, 'margin ratio');
    else await expect(ratio).toHaveText('not reported by the venue');

    // Each perpetual's margin mode and leverage as the venue holds them for the account, and the collateral it takes.
    const perps = (await client.get(`/api/v1/venue/markets?venueId=${venue.id}`)).body.value.filter((m) => m.kind === 'perpetual');
    const theirs = new Map((await marketsOn(venue)).map((m) => [m.symbol, m]));
    for (const m of perps) {
      const row = box.locator(`tr[data-market="${m.symbol}"]`);
      const set = await record(venue, s.owner, '/leverage', { symbol: m.symbol });
      const mode = row.locator('[data-cell="margin-mode"]');
      if (set) {
        await expect(row).toHaveAttribute('data-margin-mode', set.marginMode, { timeout: 20_000 });
        await expect(mode).toHaveText(set.marginMode === 'isolated' ? 'Isolated' : 'Cross');
        await expect(row.locator('[data-cell="leverage"]')).toHaveAttribute('data-value', String(set.leverageBps));
      } else await expect(mode).toHaveText('not set on the venue', { timeout: 20_000 });
      const collateral = theirs.get(m.symbol)?.collateral;
      const cell = row.locator('[data-cell="collateral"]');
      if (collateral?.known)
        for (const c of collateral.value)
          await expect(cell).toContainText(c.haircut.known ? `${c.asset}, haircut ` : `${c.asset}, haircut not published`);
      else await expect(cell).toHaveText('not published by the venue');
    }
  }
  // The person's own isolated 10x on XBIL-PERP, as #1's Starts line set it on the first venue.
  const [a] = venues;
  await expect(section(panel, a).locator(`tr[data-market="${SYMBOL}"]`)).toHaveAttribute('data-margin-mode', 'isolated');
  await expect(section(panel, a).locator(`tr[data-market="${SYMBOL}"] [data-cell="collateral"]`)).toHaveText('USDC, haircut 0%');
});

test(`${J} #4 opens the bills log: a funding payment, a close and a liquidation as three rows with types, amounts and the venue's ids; our builder fee for each fill with its ledger id`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  const s = state();
  const [a, b] = await both();
  const funding = (await record(a, s.owner, '/funding-payments', { since: s.since })).filter((p) => p.symbol === SYMBOL);
  const fills = (await record(a, s.owner, '/fills', { since: s.since })).filter((f) => f.symbol === SYMBOL);
  const liquidations = (await record(a, s.owner, '/liquidations', { since: s.since })).filter((l) => l.symbol === SYMBOL);
  expect(funding).toHaveLength(1);
  expect(liquidations).toHaveLength(1);
  expect(liquidations[0].parts).toHaveLength(1);
  const closes = fills.filter((f) => f.realisedPnl !== null);
  expect(closes.length, 'the reduce-only close filled').toBeGreaterThan(0);

  const panel = await accountTab(page, s, 'Bills');
  const box = section(panel, a).getByTestId('venue-bills');
  // The venue's three kinds of line, each with its type, amount and the venue's own id.
  const pay = box.locator(`tr[data-bill="funding"][data-venue-ref="${funding[0].paymentId}"]`);
  await expect(pay).toBeVisible({ timeout: 20_000 });
  await expect(pay.locator('[data-cell="type"]')).toHaveText('Funding');
  await expect(pay.locator('[data-cell="venue-id"]')).toHaveText(funding[0].paymentId);
  await shows(attrOf(pay, 'data-amount'), funding[0].amount, 'funding');
  await expect(pay.locator('[data-cell="amount"]')).toContainText(funding[0].asset);
  for (const f of closes) {
    const row = box.locator(`tr[data-bill="close"][data-venue-ref="${f.fillId}"]`);
    await expect(row.locator('[data-cell="type"]')).toHaveText('Close');
    await expect(row.locator('[data-cell="venue-id"]')).toHaveText(f.fillId);
    await shows(attrOf(row, 'data-amount'), f.realisedPnl, `close ${f.fillId}`);
  }
  const [part] = liquidations[0].parts;
  const liq = box.locator(`tr[data-bill="liquidation"][data-venue-ref="${part.partId}"]`);
  await expect(liq.locator('[data-cell="type"]')).toHaveText('Liquidation fee');
  await expect(liq.locator('[data-cell="venue-id"]')).toHaveText(part.partId);
  await expect(liq).toHaveAttribute('data-liquidation', liquidations[0].liquidationId);
  await shows(attrOf(liq, 'data-amount'), part.fee, 'liquidation');
  // No line the venue did not report: one funding, the closes, one liquidation, and our fee on each fill that carries one.
  const charged = fills.filter((f) => toUnits(f.builderFee) > 0n);
  expect(charged.length, 'our builder fee was charged on the fills').toBe(fills.length);
  await expect(box.locator('tr[data-bill="funding"]')).toHaveCount(1);
  await expect(box.locator('tr[data-bill="close"]')).toHaveCount(closes.length);
  await expect(box.locator('tr[data-bill="liquidation"]')).toHaveCount(1);
  await expect(box.locator('tr[data-bill="builder_fee"]')).toHaveCount(charged.length);

  // Our builder fee on each fill: the venue's figure, and the ledger transaction svc-ledger itself holds under its key.
  for (const f of charged) {
    const key = `builder-fee:${a.id}:${s.owner}:${f.fillId}`;
    await expect.poll(async () => (await traceOf(key)).found, { timeout: 90_000 }).toBe(true);
    const trace = await traceOf(key);
    expect(trace.reason).toBe('trade.builder_fee.earned');
    const debits = trace.postings.filter((p) => p.direction === 'debit');
    expect(debits).toHaveLength(1);
    expect(toUnits(debits[0].amount)).toBe(toUnits(f.builderFee));
    expect(debits[0].assetId).toBe(f.feeAsset);
    const row = box.locator(`tr[data-bill="builder_fee"][data-venue-ref="${f.fillId}"]`);
    await expect(row).toHaveAttribute('data-ledger-tx', trace.txId, { timeout: 30_000 });
    await expect(row.locator('[data-cell="ledger"]')).toHaveText(trace.txId);
    await expect(row.locator('[data-cell="type"]')).toHaveText('Our builder fee');
    await shows(attrOf(row, 'data-amount'), f.builderFee, `builder fee ${f.fillId}`);
  }
  // The second venue: the person traded nothing there, and it reports no bill.
  await expect(section(panel, b).getByTestId('venue-bills-none')).toBeVisible({ timeout: 20_000 });
  expect(await record(b, s.owner, '/fills', { since: s.since })).toEqual([]);
  // Reads: the person's own ledger balances are as the Starts line left them.
  expect(await ledgerView(s.account)).toEqual(s.ledger);
});

test(`${J} #5 opens eligible instruments and the settle currency: the list for this account, or empty with the reason when the eligibility level is blank`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  const s = state();
  const venues = await both();
  const client = await api(s.account);
  const panel = await accountTab(page, s, 'Eligible instruments');
  for (const venue of venues) {
    const box = section(panel, venue).getByTestId('venue-eligible');
    // The list for this account: every perpetual we show on this venue (the account meets the TEST level), each with the
    // asset the venue settles and margins it in and the venue's own leverage limit.
    const shown = (await client.get(`/api/v1/venue/markets?venueId=${venue.id}`)).body.value.filter((m) => m.kind === 'perpetual');
    expect(shown.length).toBeGreaterThan(0);
    const theirs = new Map((await marketsOn(venue)).map((m) => [m.symbol, m]));
    await expect(box.locator('tr[data-instrument]')).toHaveCount(shown.length, { timeout: 20_000 });
    const settles = new Set();
    for (const m of shown) {
      const v = theirs.get(m.symbol);
      const settle = v.marginAccount?.known ? v.marginAccount.value.collateralAsset : v.quoteAsset;
      settles.add(settle);
      const row = box.locator(`tr[data-instrument="${m.symbol}"]`);
      await expect(row.locator('[data-cell="settle"]')).toHaveText(settle);
      await expect(row.locator('[data-cell="max-leverage"]')).toHaveText(
        v.maxLeverageBps ? `${v.maxLeverageBps / 10_000}x` : 'not published by the venue',
      );
    }
    await expect(box.getByTestId('venue-settle-currency')).toHaveText(`Settle currency: ${[...settles].join(', ')}`);
    await expect(box.getByTestId('venue-eligible-none')).toHaveCount(0);
  }

  // The eligibility level blank (the owner value): the list is empty, the page names the reason, and a new position refuses.
  const savedVenue = process.env.LOCAL_STACK_USER_VENUE;
  process.env.LOCAL_STACK_USER_VENUE = 'two';
  try {
    restartWithSetting('trade', 'LOCAL_STACK_USER_VENUE_ELIGIBILITY', 'off');
    const blank = await accountTab(page, s, 'Eligible instruments');
    for (const venue of venues) {
      const none = section(blank, venue).getByTestId('venue-eligible-none');
      await expect(none).toHaveAttribute('data-code', 'trade.venue_eligibility_level_unset', { timeout: 20_000 });
      await expect(none).toHaveText(
        'No instrument is eligible for this account. The eligibility level for perpetuals is not set, so no perpetual is open to any account',
      );
      await expect(section(blank, venue).locator('tr[data-instrument]')).toHaveCount(0);
      const prep = await (
        await api(s.account)
      ).post('/api/v1/venue/prepare', {
        venueId: venue.id,
        owner: s.owner,
        signer: { role: 'owner', address: s.owner },
        intent: order(s, 'buy', '0.1', '100.5', false, `unset-${venue.id}`),
      });
      expect(prep.status).toBe(422);
      expect(prep.body.intafacedCode, JSON.stringify(prep.body).slice(0, 300)).toBe('trade.venue_eligibility_level_unset');
    }
  } finally {
    restartWithSetting('trade', 'LOCAL_STACK_USER_VENUE_ELIGIBILITY', null);
    if (savedVenue === undefined) delete process.env.LOCAL_STACK_USER_VENUE;
    else process.env.LOCAL_STACK_USER_VENUE = savedVenue;
  }
  expect(await ledgerView(s.account)).toEqual(s.ledger);
});
