// World: restart
import { keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { test, expect } from './journey.mjs';
import { ADMIN } from './admin.mjs';
import { api, tool } from './stack.mjs';
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
  return sent.body;
}
let orders = 0;
const buy = () =>
  door({
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

/** The recon the console reads, as the stack's TEST founders' trade-ops token reads it (admin.builderFees.recon). */
let staffDoor;
async function recon(from, to) {
  staffDoor ??= (async () => {
    const gates = await import('../../../../tooling/scripts/local-test-gates.mjs');
    const ctx = await gates.makeContext({ log: () => {} });
    const sessions = await gates.approverSessions(ctx);
    return { ctx, token: await sessions.a.tradeOpsToken() };
  })();
  const { ctx, token } = await staffDoor;
  const res = await ctx.edge.query('trade', 'admin.builderFees.recon', { from: from.toISOString(), to: to.toISOString() }, token);
  expect(res.status, res.text.slice(0, 300)).toBe(200);
  return JSON.parse(res.text).result.data;
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
  await door(
    { kind: 'approve_builder_fee', builder: builder.builder.address, maxFeeBps: builder.builder.feeBps },
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
