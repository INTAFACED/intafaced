// World: book, gates, restart
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from './journey.mjs';
import { approverSessions, makeContext, setFeeSchedule } from '../../../../tooling/scripts/local-test-gates.mjs';
import { EDGE, api, bestPrices, fromUnits, fund, otherTrader, times, toUnits } from './stack.mjs';
import { fundedTrader, openOrders } from './desk.mjs';
import { ADMIN, founderSignIn } from './admin.mjs';
import { withPartner } from './partner.mjs';

// J-cex-spot-17, in the running app (docs/roadmap/journeys.json): finance publishes and versions fees, VIP tiers and
// convert limits in the founder console's Fees and convert room (/trade-ops/fees). One test per step, titled
// "J-cex-spot-17 #<n>". Founder A proposes, founder B approves in Freezes & approvals, A writes. Every schedule here is a
// TEST version, never an owner value: the default pair group keeps the stack's regular rates (maker 0.08%, taker 0.10%),
// so every other journey on the stack trades at the rates it always did, and each step puts that schedule back when done.
// TEST groups hold IFC/USDT, a market only fee journeys move between groups.
const J = 'J-cex-spot-17';

/** TEST rates through the real write path, not owner decisions (the same TEST schedule J-cex-spot-10 publishes). */
const REGULAR = { pairGroup: 'all-others', tierId: 'regular', zeroFee: false, makerBps: '8', takerBps: '10', minFee: null };
const VIP = { pairGroup: 'all-others', tierId: 'test-vip-1', zeroFee: false, makerBps: '6', takerBps: '9', minFee: null };
const ZERO = { pairGroup: 'test-zero-fee', tierId: 'regular', zeroFee: true, minFee: null };
const SCHEDULE = {
  defaultPairGroup: 'all-others',
  pairGroups: { 'ETH/USDC': 'test-zero-fee' },
  rows: [REGULAR, VIP, ZERO],
  perpetual: { makerBps: '2', takerBps: '5' },
};
/** IFC/USDT in a TEST group at maker `makerBps`, taker 0.10%. */
const GROUP = 'test-fee-change';
const changeTo = (makerBps) => ({
  ...SCHEDULE,
  pairGroups: { ...SCHEDULE.pairGroups, 'IFC/USDT': GROUP },
  rows: [...SCHEDULE.rows, { pairGroup: GROUP, tierId: 'regular', zeroFee: false, makerBps, takerBps: '10', minFee: null }],
});
/** IFC/USDT in a TEST group whose maker pays nothing and earns 0.05% back out of the taker's 0.10%. */
const REBATE_ROW = {
  pairGroup: 'test-rebate',
  tierId: 'regular',
  zeroFee: false,
  makerBps: '0',
  takerBps: '10',
  makerRebateBps: '5',
  minFee: null,
};
const REBATES = { ...SCHEDULE, pairGroups: { ...SCHEDULE.pairGroups, 'IFC/USDT': 'test-rebate' }, rows: [...SCHEDULE.rows, REBATE_ROW] };
/** SCHEDULE with a TEST tier programme: TEST VIP from 1,000 of 30-day volume, its daily snapshot at `snapshotTimeUtc`. */
const tiersAt = (snapshotTimeUtc) => ({
  ...SCHEDULE,
  rows: [...SCHEDULE.rows, { ...ZERO, tierId: 'test-vip-1' }],
  tierProgram: {
    thresholds: [{ tierId: 'test-vip-1', minVolume30d: '1000' }],
    volumeQuotes: ['USDT', 'USDC'],
    snapshotTimeUtc,
    downgradeGraceDays: null,
    subAccounts: null,
    botsAndCopy: null,
  },
});

test.describe.configure({ mode: 'default' });

/** The stack's two TEST operators, signed in once for the file, for the setup writes the steps start from. */
let operators;
async function ops() {
  if (!operators) {
    const ctx = await makeContext({ log: () => undefined });
    operators = { ctx, sessions: await approverSessions(ctx) };
  }
  return operators;
}

const published = async () => {
  const res = await fetch(`${EDGE}/api/v1/fees/published`);
  return { status: res.status, body: await res.json() };
};

/** The operator read of every stored version, as the room is served it. */
async function storedVersions() {
  const { ctx, sessions } = await ops();
  const res = await ctx.edge.query('trade', 'admin.fees.get', undefined, await sessions.a.tradeOpsToken());
  const data = res.json?.result?.data;
  if (!data) throw new Error(`admin.fees.get refused (${res.status}): ${res.text.slice(0, 300)}`);
  return data;
}

/**
 * Write `schedule` as the next version through the two-person door, effective in ten seconds or just after `after`, and
 * wait until the public read serves it (unless `wait` is false: a version that starts later).
 */
async function publish(schedule, reason, { after = null, leadMs = 10_000, wait = true } = {}) {
  const { ctx, sessions } = await ops();
  const effectiveAt = Math.max(Date.now() + leadMs, after ? Date.parse(after) + 5_000 : 0);
  const row = await setFeeSchedule(ctx, schedule, { effectiveAt, reason: `LOCAL TEST ${J}: ${reason}`, sessions });
  // Follows the version this call wrote, and waits until its own effective time has passed: one written to start after a
  // version still scheduled (`after`) is not served before then.
  const lead = Math.max(0, Date.parse(row.effectiveAt) - Date.now());
  if (wait) await expect.poll(async () => (await published()).body.version, { timeout: lead + 30_000 }).toBe(`v${row.version}`);
  return row;
}

/** The latest stored version's effective time: a new version may not start before it. */
async function latestEffective() {
  const { history } = await storedVersions();
  return history.length ? history[history.length - 1].effectiveAt : null;
}

/** Put the stack's own TEST schedule back, after any version still waiting to take effect. */
async function restore(why) {
  await publish(SCHEDULE, why, { after: await latestEffective() });
}

/** A time as the room writes it: "2026-11-06 10:31:05 UTC". */
const shown = (iso) => `${new Date(iso).toISOString().slice(0, 19).replace('T', ' ')} UTC`;
/** A time as the room's field takes it: "2026-11-06T10:31:05Z". */
const typed = (ms) => `${new Date(ms).toISOString().slice(0, 19)}Z`;
/** A rate as the room writes it: 8 → "0.08% (8 bps)". */
const rate = (bps) => `${Math.floor(bps / 100)}.${String(bps % 100).padStart(2, '0')}% (${bps} bps)`;

/** Founder `key` in their own browser, on the Fees and convert room. */
async function room(browser, key) {
  const page = await (await browser.newContext()).newPage();
  const founder = await founderSignIn(page, key);
  await page.goto(`${ADMIN}/trade-ops/fees`);
  await expect(page.locator('[data-room=fees]')).toBeVisible();
  return { page, founder, close: () => page.context().close() };
}

const versionRow = (page, group, version, tier = 'regular') =>
  page.locator(`[data-fees=versions] [data-pair-group="${group}"] tr[data-version="v${version}"][data-tier="${tier}"]`);

/** Founder B approves exactly `payloadHash` in Freezes & approvals. */
async function approveAsB(b, approvalId, payloadHash) {
  await b.goto(`${ADMIN}/trade-ops/approvals`);
  // The queue's pending list loads after the page and lands above the form, moving "Approve request" down. A press
  // taken before it lands and a release after it misses the button, so no dialog opens (main run 42455893390): act
  // once the list is in, which also means the page is hydrated.
  await expect(b.getByRole('grid', { name: 'Approvals waiting for this operator' })).toBeVisible();
  await b.getByLabel('Approval id', { exact: true }).fill(approvalId);
  await b.getByLabel('Payload hash you reviewed').fill(payloadHash);
  await b.getByRole('button', { name: 'Approve request' }).click();
  const dialog = b.getByRole('alertdialog');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(dialog.locator('[data-outcome=ok]')).toBeVisible();
}

/** The value next to `label` in a filed request's key/value list. */
const valueOf = (scope, label) => scope.locator('dt', { hasText: label }).locator('xpath=following-sibling::dd[1]');

/**
 * A proposal in the room, as founder A files it, B approves it and A writes it. `edit` fills the form. Returns the
 * version the room says it wrote.
 */
async function proposeApproveWrite({ a, b, edit, reason }) {
  const form = a.locator('[data-fees=propose]');
  await edit(form);
  await form.getByLabel('Reason (12 to 500 characters, kept in the audit)').fill(reason);
  await form.getByRole('button', { name: 'Ask a second founder to approve' }).click();
  const filed = a.locator('[data-fees=proposed]');
  await expect(filed).toContainText('Request filed');
  const approvalId = (await valueOf(filed, 'Approval id (apply with this once approved)').innerText()).trim();
  const payloadHash = (await valueOf(filed, 'Payload hash (the approver confirms this)').innerText()).trim();
  expect(payloadHash).toMatch(/^sha256:[0-9a-f]{64}$/);

  await approveAsB(b, approvalId, payloadHash);

  await form.getByLabel('Approved request id').fill(approvalId);
  await form.getByRole('button', { name: 'Apply the approved version' }).click();
  const dialog = a.getByRole('alertdialog');
  await dialog.getByRole('button', { name: 'Write version' }).click();
  const written = a.locator('[data-fees=written]');
  await expect(written).toBeVisible({ timeout: 15_000 });
  const version = (await written.getAttribute('data-version')) ?? '';
  expect(version).toMatch(/^\d+$/);
  return { version, effectiveAt: await written.getAttribute('data-effective-at'), text: await written.innerText() };
}

// ── the TEST venue (J-cex-spot-17 #1 #3, adapted: we hold no customer money, so our fee is the builder fee the customer's
// own order carries on an outside venue, reached through svc-trade's user-venue door) ──

import { keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { tool } from './stack.mjs';

/** The stack's TEST venue simulator, on loopback (local-test-stack.mjs PORTS['test-venue']), for its TEST controls only. */
const TEST_VENUE = 'http://127.0.0.1:14560';
/** The setting that turns svc-trade's user-venue door on and starts the TEST venue (local-stack-services/trade.mjs). */
const VENUE_SWITCH = 'LOCAL_STACK_USER_VENUE';
/** The market our TEST builder-fee versions put in a group of its own. Every other market of the venue takes the default group. */
const VENUE_SPOT = 'BTC-USDC';
const BUILDER_SPOT = 'test-builder-spot';
const BUILDER_ALL = 'test-builder-all';

/** Trade restarted with the door switched `value` (on or off); this process's environment is put back as it was. */
function restartTradeWithVenue(value) {
  const before = process.env[VENUE_SWITCH];
  process.env[VENUE_SWITCH] = value;
  try {
    tool('local-test-stack.mjs', 'restart', 'trade');
  } finally {
    if (before === undefined) delete process.env[VENUE_SWITCH];
    else process.env[VENUE_SWITCH] = before;
  }
}

// The door is on for this file and off after it, so every other file in the shard sees it as it was. A worker that exits
// before afterAll switches it off on its way out; one killed outright (SIGKILL, out of memory) runs no handler.
let venueOn = false;
const venueOffOnExit = () => {
  if (!venueOn) return;
  venueOn = false;
  try {
    restartTradeWithVenue('off');
  } catch {
    /* the worker is exiting: a failed switch-off has no one left to report to */
  }
};
test.beforeAll(() => {
  test.setTimeout(240_000);
  venueOn = true;
  process.once('exit', venueOffOnExit);
  restartTradeWithVenue('on');
});
test.afterAll(() => {
  test.setTimeout(240_000);
  restartTradeWithVenue('off');
  venueOn = false;
  process.off('exit', venueOffOnExit);
});

/** One TEST control call on the TEST venue itself (a deposit, or an outside participant's own signed action). */
async function testVenue(path, body) {
  const res = await fetch(`${TEST_VENUE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  expect(res.status, JSON.stringify(json).slice(0, 300)).toBe(200);
  return json;
}

/** A TEST wallet key derived from a public name: it holds nothing outside the TEST venue's memory. */
function testWallet(name) {
  const key = privateKeyToAccount(keccak256(toHex(`intafaced TEST ${J} wallet ${name}`)));
  const address = key.address.toLowerCase();
  const sign = async (typed) =>
    key.signTypedData({ domain: typed.domain, types: typed.types, primaryType: typed.primaryType, message: typed.message });
  return { address, signer: { role: 'owner', address }, sign };
}

/** svc-trade's own database role on the stack (loopback, the marker's postgres port, the stack's secret). */
function tradeDb(ctx) {
  const postgres = createRequire(path.join(REPO, 'services', 'svc-trade', 'package.json'))('postgres');
  const port = ctx.marker.ports.postgres ?? 15460;
  return postgres(`postgres://svc_trade:${encodeURIComponent(ctx.secrets.pgService)}@127.0.0.1:${port}/intafaced_local_test`, {
    max: 1,
    onnotice: () => {},
  });
}
const REPO = fileURLToPath(new URL('../../../../', import.meta.url));

/** The TEST ramp partner's own catalogue, as the stack loads it (tooling/profiles/test-owner-values/bank.json). */
function partnerRampCatalogue() {
  const values = JSON.parse(readFileSync(path.join(REPO, 'tooling', 'profiles', 'test-owner-values', 'bank.json'), 'utf8'));
  const entry = values.values?.BANK_ONRAMP_SIM_JSON ?? values.BANK_ONRAMP_SIM_JSON;
  expect(entry?.value, 'the TEST ramp catalogue the stack loads').toBeTruthy();
  return JSON.parse(entry.value).quotes;
}

/** The door's status for a signed-in customer: on, the TEST venue it reaches, and our builder address. */
async function venueDoor(client) {
  const { status, body } = await client.get('/api/v1/venue/status');
  expect(status, JSON.stringify(body).slice(0, 300)).toBe(200);
  expect(body).toMatchObject({ enabled: true, available: true, test: true, label: 'TEST' });
  expect(body.builder?.address, 'our builder address (LOCAL TEST owner value)').toMatch(/^0x[0-9a-f]{40}$/);
  return { venueId: body.venue.id, builder: body.builder.address };
}

/** The venue's own builder-fee cap on `symbol`, as the venue publishes it, read through the door. */
async function venueCap(client, symbol) {
  const { status, body } = await client.get('/api/v1/venue/markets');
  expect(status, JSON.stringify(body).slice(0, 300)).toBe(200);
  const market = body.value.find((m) => m.symbol === symbol);
  expect(market?.builderFeeCapBps, `${symbol}'s cap as the venue publishes it`).toMatchObject({ known: true });
  return market.builderFeeCapBps.value;
}

/** SCHEDULE with TEST builder fees on `venueId`: BTC-USDC in a group at `spotBps`, every other market at 0.5 bps. */
const withBuilderFees = (venueId, spotBps) => ({
  ...SCHEDULE,
  builderFees: {
    [venueId]: {
      defaultGroup: BUILDER_ALL,
      marketGroups: { [VENUE_SPOT]: BUILDER_SPOT },
      groups: { [BUILDER_ALL]: '0.5', [BUILDER_SPOT]: spotBps },
    },
  },
});

/** A builder-fee line in the room: venue, group and version. */
const builderRow = (page, venueId, group, version) =>
  page.locator(
    `[data-fees=builder-versions] [data-builder-venue="${venueId}"] [data-builder-group="${group}"] tr[data-version="v${version}"]`,
  );

/** A post-only sell of `amount` BTC at `price` on BTC-USDC, keyed by its business key. */
const venueSell = (owner, price, amount, n) => ({
  kind: 'place_order',
  symbol: VENUE_SPOT,
  side: 'sell',
  type: 'limit',
  amount,
  price,
  timeInForce: 'ALO',
  reduceOnly: false,
  clientOrderKey: `order:${owner}:js17-${n}`,
  builderFee: null,
});

/** The customer prepares `intent` through the door, their wallet signs exactly what was prepared, and the door sends it. */
async function signAndSend(client, wallet, intent, actionKey) {
  const prepared = await client.post('/api/v1/venue/prepare', {
    owner: wallet.address,
    signer: wallet.signer,
    intent,
    ...(actionKey ? { actionKey } : {}),
  });
  expect(prepared.status, JSON.stringify(prepared.body).slice(0, 400)).toBe(200);
  const p = prepared.body.prepared;
  const sent = await client.post('/api/v1/venue/submit', {
    actionKey: prepared.body.actionKey,
    signature: { digest: p.digest, signature: await wallet.sign(p.typedData), signedBy: wallet.address },
  });
  expect(sent.status, JSON.stringify(sent.body).slice(0, 400)).toBe(200);
  expect(sent.body.outcome, JSON.stringify(sent.body.outcome).slice(0, 400)).toMatchObject({ definite: true, accepted: true });
  return { prepared: p, outcome: sent.body.outcome };
}

/** What the venue would charge for `intent` on the customer's account now, as the venue previews it through the door. */
async function venuePreview(client, owner, intent) {
  const { status, body } = await client.post('/api/v1/venue/preview', { owner, intent });
  expect(status, JSON.stringify(body).slice(0, 300)).toBe(200);
  return body.value;
}

/** An outside TEST trader buys `amount` BTC at `price` with an IOC on the TEST venue directly, signing their own order. */
async function outsideBuy(venueId, price, amount, n) {
  const trader = testWallet(`outside buyer ${n}`);
  const account = { venueId, owner: trader.address, subAccount: null };
  await testVenue('/test/deposit', { account, asset: 'USDC', amount: '2000', depositRef: `84532:js17-outside-${n}:0` });
  const intent = { ...venueSell(trader.address, price, amount, `outside-${n}`), side: 'buy', timeInForce: 'IOC' };
  const prepared = await testVenue('/prepare', { account, signer: trader.signer, intent });
  const signature = await trader.sign(prepared.typedData);
  const sent = await testVenue('/submit', { prepared, signature: { digest: prepared.digest, signature, signedBy: trader.address } });
  expect(sent, JSON.stringify(sent).slice(0, 300)).toMatchObject({ definite: true, accepted: true });
}

/** The venue's fills of the customer's order (by its venue client id), as the venue reports them through the door. */
async function venueFillsOf(client, owner, venueClientOrderId, since) {
  let fills = [];
  await expect
    .poll(
      async () => {
        const { status, body } = await client.get(`/api/v1/venue/fills?owner=${owner}&since=${encodeURIComponent(since)}`);
        expect(status, JSON.stringify(body).slice(0, 300)).toBe(200);
        fills = body.value.filter((f) => f.venueClientOrderId === venueClientOrderId);
        return fills.length;
      },
      { timeout: 15_000 },
    )
    .toBeGreaterThan(0);
  return fills;
}

/** price × amount × bps / 10000, exactly (the figures here are chosen so no rounding is needed). */
function builderFeeOn(price, amount, bps) {
  const scaled = times(price, amount) * toUnits(bps);
  const per = toUnits('1') * 10_000n;
  expect(scaled % per, 'a TEST figure that needs no rounding').toBe(0n);
  return fromUnits(scaled / per);
}

/** The same decimal, whatever its trailing zeros. */
const sameAmount = (x, y) => toUnits(String(x)) === toUnits(String(y));

// ── the steps ──

test(`${J} #1 opens builder-fee versions by venue and market group: current and previous versions with effective times, exact rates`, async ({
  page,
  browser,
}) => {
  test.setTimeout(180_000);
  // The venue the door reaches, and the cap it publishes on BTC-USDC, as a signed-in customer reads them through the door.
  const who = await fundedTrader(page, 'js17b', '1');
  const client = await api(who);
  const { venueId } = await venueDoor(client);
  const cap = await venueCap(client, VENUE_SPOT);
  // Two TEST builder-fee versions on that venue, one after the other: BTC-USDC's group at 1.5 bps, then at 2 bps.
  const previous = await publish(withBuilderFees(venueId, '1.5'), 'TEST builder fee 1.5 bps, the previous version', {
    after: await latestEffective(),
  });
  const current = await publish(withBuilderFees(venueId, '2'), 'TEST builder fee 2 bps, the current version', {
    after: previous.effectiveAt,
  });
  const a = await room(browser, 'a');
  try {
    // The venue's own cap, beside the versions: the figure the venue publishes, read from it, labelled TEST.
    const caps = a.page.locator('[data-fees=builder-caps]');
    await expect(caps).toHaveAttribute('data-venue', venueId);
    await expect(caps).toContainText('TEST');
    expect(cap).toBe('100');
    await expect(caps.locator(`tr[data-builder-cap="${VENUE_SPOT}"] td`)).toHaveText(['spot', '1.00% (100 bps)']);

    // BTC-USDC's group on that venue: the current version and the one before it, each with its effective time and exact rate.
    await expect(a.page.locator(`[data-builder-venue="${venueId}"] [data-builder-group="${BUILDER_SPOT}"]`)).toContainText(
      `Markets: ${VENUE_SPOT}`,
    );
    const now = builderRow(a.page, venueId, BUILDER_SPOT, current.version);
    await expect(now).toHaveAttribute('data-state', 'current');
    await expect(now.locator('td')).toHaveText(['Current', shown(current.effectiveAt), '0.02% (2 bps)']);
    const before = builderRow(a.page, venueId, BUILDER_SPOT, previous.version);
    await expect(before).toHaveAttribute('data-state', 'previous');
    await expect(before.locator('td')).toHaveText(['Previous', shown(previous.effectiveAt), '0.015% (1.5 bps)']);
    // Every other market of the venue, in the default group of the same version, at its exact rate.
    await expect(builderRow(a.page, venueId, BUILDER_ALL, current.version).locator('td')).toHaveText([
      'Current',
      shown(current.effectiveAt),
      '0.005% (0.5 bps)',
    ]);

    // What the room calls current is what an order on the venue carries now: the venue's own preview of a resting
    // BTC-USDC sell (0.01 at 90000, far above any bid) prices our builder fee at 2 bps of its notional.
    const preview = await venuePreview(
      client,
      testWallet(`preview ${who.handle}`).address,
      venueSell('preview', '90000', '0.01', 'preview'),
    );
    expect(preview.role).toBe('maker');
    expect(preview.builderFee.known).toBe(true);
    expect(preview.builderFee.value.asset).toBe('USDC');
    expect(sameAmount(preview.builderFee.value.amount, builderFeeOn('90000', '0.01', '2'))).toBe(true);
  } finally {
    await a.close();
  }
});

test(`${J} #2 proposes a new version with a blank taker fee: refused with a typed code, and nothing is sent`, async ({ browser }) => {
  test.setTimeout(120_000);
  const before = await storedVersions();
  const a = await room(browser, 'a');
  try {
    const form = a.page.locator('[data-fees=propose]');
    await expect(form).toContainText(`Starts from v${before.version}`);
    // Every request the console sends from here on: a refused proposal must send none.
    const sent = [];
    a.page.on('request', (req) => {
      if (req.method() !== 'GET') sent.push(`${req.method()} ${new URL(req.url()).pathname}`);
    });
    // A row every version this file publishes carries (`SCHEDULE`), so this step needs no earlier step's version in force.
    await form.getByLabel(`Taker bps, ${REGULAR.pairGroup} / ${REGULAR.tierId}`).fill('');
    await form.getByLabel('Takes effect at (UTC)').fill(typed(Date.now() + 3_600_000));
    await form.getByLabel('Reason (12 to 500 characters, kept in the audit)').fill(`LOCAL TEST ${J}: a version with no taker fee`);
    await form.getByRole('button', { name: 'Ask a second founder to approve' }).click();

    const refusal = a.page.locator('[data-fees=refused]');
    await expect(refusal).toContainText('trade.fee_schedule_blank');
    await expect(refusal).toContainText(`The taker fee of ${REGULAR.pairGroup} / ${REGULAR.tierId} is blank`);
    await expect(refusal).toContainText('Nothing was sent.');
    await expect(a.page.locator('[data-fees=proposed]')).toHaveCount(0);
    // Long enough for a request the click started to have been sent.
    await a.page.waitForTimeout(1_500);
    expect(sent).toEqual([]);
    // And the service holds no new version.
    expect((await storedVersions()).version).toBe(before.version);
  } finally {
    await a.close();
  }
});

test(`${J} #3 proposes a complete builder-fee version; a second operator approves: effective from its time, never above the venue's cap; open orders keep the fee they were signed with`, async ({
  page,
  browser,
}) => {
  // A resting venue order, a refused proposal above the cap, a four-eyes write two minutes ahead, a wait until it takes
  // effect, and two fills after it: the order signed before, and one signed after.
  test.setTimeout(420_000);
  const tag = Date.now().toString(36);
  const who = await fundedTrader(page, 'js17v', '1');
  const client = await api(who);
  const { venueId, builder } = await venueDoor(client);
  const cap = await venueCap(client, VENUE_SPOT);
  const placedUnder = await publish(withBuilderFees(venueId, '2'), 'TEST builder fee 2 bps, before the change', {
    after: await latestEffective(),
  });

  // The customer's own wallet account on the venue: TEST-funded with BTC, and our builder approved up to 5 bps.
  const wallet = testWallet(`customer ${who.handle}`);
  await testVenue('/test/deposit', {
    account: { venueId, owner: wallet.address, subAccount: null },
    asset: 'BTC',
    amount: '0.02',
    depositRef: `84532:js17-${tag}:0`,
  });
  await signAndSend(
    client,
    wallet,
    { kind: 'approve_builder_fee', builder, maxFeeBps: '5' },
    `approve-builder:${wallet.address}:js17-${tag}`,
  );

  // A sell inside the spread (no other bid at or above it, no other ask at or under it), so it rests until bought, and an
  // outside buyer at its price meets only it.
  const PRICE = '60007';
  const AMOUNT = '0.01';
  expect((await venuePreview(client, wallet.address, venueSell(wallet.address, PRICE, AMOUNT, 'check'))).role).toBe('maker');
  const ahead = await venuePreview(client, wallet.address, {
    ...venueSell(wallet.address, PRICE, AMOUNT, 'check'),
    side: 'buy',
    timeInForce: 'IOC',
  });
  expect(sameAmount(ahead.venueFee.value.amount, '0'), `another ask rests at or under ${PRICE}`).toBe(true);

  const a = await room(browser, 'a');
  const b = await room(browser, 'b');
  try {
    // The order, signed now under the version in force: the venue rests it with the 2 bps it was signed with.
    const first = await signAndSend(client, wallet, venueSell(wallet.address, PRICE, AMOUNT, `${tag}-1`));
    expect(first.prepared.builderFee.builder).toBe(builder);
    expect(sameAmount(first.prepared.builderFee.feeBps, '2')).toBe(true);
    const venueOrderId = first.outcome.venueRef;
    expect(venueOrderId).toBeTruthy();
    const open = await client.get(`/api/v1/venue/orders/open?owner=${wallet.address}`);
    expect(open.body.value.map((o) => o.venueOrderId)).toContain(venueOrderId);

    // Never above the venue's cap: a version at 1 bp over the cap the venue publishes is refused on the page, by its code,
    // and nothing is sent.
    const form = a.page.locator('[data-fees=propose]');
    await expect(form).toContainText(`Starts from v${placedUnder.version}`);
    const sent = [];
    const watch = (req) => req.method() !== 'GET' && sent.push(`${req.method()} ${new URL(req.url()).pathname}`);
    a.page.on('request', watch);
    const over = fromUnits(toUnits(cap) + toUnits('1'));
    await form.getByLabel(`Builder fee bps, ${venueId} / ${BUILDER_SPOT}`).fill(over);
    await form.getByLabel('Takes effect at (UTC)').fill(typed(Date.now() + 3_600_000));
    await form.getByLabel('Reason (12 to 500 characters, kept in the audit)').fill(`LOCAL TEST ${J}: a builder fee above the cap`);
    await form.getByRole('button', { name: 'Ask a second founder to approve' }).click();
    const refusal = a.page.locator('[data-fees=refused]');
    await expect(refusal).toContainText('trade.builder_fee_above_venue_cap');
    await expect(refusal).toContainText(`is ${over} bps, above the venue's cap of ${cap} bps on ${VENUE_SPOT}`);
    await expect(refusal).toContainText('Nothing was sent.');
    await a.page.waitForTimeout(1_500);
    expect(sent).toEqual([]);
    a.page.off('request', watch);

    // A complete version, BTC-USDC's group at 3 bps from a stated time; B approves; A writes it.
    const effectiveMs = Math.ceil((Date.now() + 120_000) / 1_000) * 1_000;
    await a.page.reload();
    const written = await proposeApproveWrite({
      a: a.page,
      b: b.page,
      reason: `LOCAL TEST ${J}: builder fee 3 bps from a stated time`,
      edit: async (f) => {
        await expect(f).toContainText(`Starts from v${placedUnder.version}`);
        await f.getByLabel(`Builder fee bps, ${venueId} / ${BUILDER_SPOT}`).fill('3');
        await f.getByLabel('Takes effect at (UTC)').fill(typed(effectiveMs));
      },
    });
    expect(written.effectiveAt).toBe(new Date(effectiveMs).toISOString());
    expect(Date.now()).toBeLessThan(effectiveMs);

    // Scheduled, beside the version in force; and before its time the venue still prices a new order at 2 bps.
    await a.page.reload();
    const next = builderRow(a.page, venueId, BUILDER_SPOT, written.version);
    await expect(next).toHaveAttribute('data-state', 'scheduled');
    await expect(next.locator('td')).toHaveText(['Scheduled', shown(effectiveMs), '0.03% (3 bps)']);
    await expect(builderRow(a.page, venueId, BUILDER_SPOT, placedUnder.version)).toHaveAttribute('data-state', 'current');
    const early = await venuePreview(client, wallet.address, venueSell(wallet.address, PRICE, AMOUNT, 'early'));
    expect(sameAmount(early.builderFee.value.amount, builderFeeOn(PRICE, AMOUNT, '2'))).toBe(true);
    // Writing a version moved nothing: the order still rests, unfilled.
    expect((await client.get(`/api/v1/venue/orders/open?owner=${wallet.address}`)).body.value.map((o) => o.venueOrderId)).toContain(
      venueOrderId,
    );

    // Effective from its time: once it has passed, the room calls it current and the venue prices a new order at 3 bps.
    await expect
      .poll(async () => (await published()).body.version, { timeout: effectiveMs - Date.now() + 30_000 })
      .toBe(`v${written.version}`);
    expect(Date.now()).toBeGreaterThanOrEqual(effectiveMs);
    await a.page.reload();
    await expect(builderRow(a.page, venueId, BUILDER_SPOT, written.version)).toHaveAttribute('data-state', 'current');
    await expect(builderRow(a.page, venueId, BUILDER_SPOT, placedUnder.version)).toHaveAttribute('data-state', 'previous');
    const late = await venuePreview(client, wallet.address, venueSell(wallet.address, PRICE, AMOUNT, 'late'));
    expect(sameAmount(late.builderFee.value.amount, builderFeeOn(PRICE, AMOUNT, '3'))).toBe(true);

    // The order signed before the change fills after it, and the venue charges it the 2 bps it was signed with.
    const since = new Date(Date.now() - 60_000).toISOString();
    await outsideBuy(venueId, PRICE, AMOUNT, `${tag}-1`);
    const [kept] = await venueFillsOf(client, wallet.address, first.prepared.venueClientOrderId, since);
    expect(kept.role).toBe('maker');
    expect(sameAmount(kept.builderFee, builderFeeOn(PRICE, AMOUNT, '2'))).toBe(true);

    // An order signed after the effective time carries the new builder fee, and so does its fill.
    const second = await signAndSend(client, wallet, venueSell(wallet.address, PRICE, AMOUNT, `${tag}-2`));
    expect(sameAmount(second.prepared.builderFee.feeBps, '3')).toBe(true);
    await outsideBuy(venueId, PRICE, AMOUNT, `${tag}-2`);
    const [fresh] = await venueFillsOf(client, wallet.address, second.prepared.venueClientOrderId, since);
    expect(sameAmount(fresh.builderFee, builderFeeOn(PRICE, AMOUNT, '3'))).toBe(true);
  } finally {
    await a.close();
    await b.close();
    await restore('the stack schedule back, without TEST builder fees');
  }
});

test(`${J} #4 edits VIP thresholds and the snapshot time: the same proposal and approval path, and the snapshot row shows its figures`, async ({
  browser,
}) => {
  // A programme version, a four-eyes edit, and a wait of up to four minutes for the snapshot it names.
  test.setTimeout(420_000);
  const far = new Date(Date.now() + 6 * 3_600_000).toISOString().slice(11, 16);
  const base = await publish(tiersAt(far), 'TEST tier programme to edit', { after: await latestEffective() });
  const a = await room(browser, 'a');
  const b = await room(browser, 'b');
  try {
    const form = a.page.locator('[data-fees=propose]');
    await expect(form).toContainText(`Starts from v${base.version}`);
    await expect(form.getByLabel('Threshold (30-day volume), test-vip-1')).toHaveValue('1000');
    await expect(form.getByLabel('Snapshot time (UTC, HH:MM)')).toHaveValue(far);

    // The new version takes effect in 90 s; its snapshot runs at the first whole minute a minute after that.
    const effectiveMs = Math.ceil((Date.now() + 90_000) / 1_000) * 1_000;
    const snapshotAt = new Date(Math.ceil((effectiveMs + 60_000) / 60_000) * 60_000);
    const hhmm = snapshotAt.toISOString().slice(11, 16);
    const written = await proposeApproveWrite({
      a: a.page,
      b: b.page,
      reason: `LOCAL TEST ${J}: TEST VIP from 500, snapshot at ${hhmm}`,
      edit: async (f) => {
        await f.getByLabel('Threshold (30-day volume), test-vip-1').fill('500');
        await f.getByLabel('Snapshot time (UTC, HH:MM)').fill(hhmm);
        await f.getByLabel('Takes effect at (UTC)').fill(typed(effectiveMs));
      },
    });
    // Stored as proposed, through the same two-person write as the rates.
    const stored = (await storedVersions()).history.find((row) => row.version === written.version);
    expect(stored.schedule.tierProgram).toMatchObject({
      thresholds: [{ tierId: 'test-vip-1', minVolume30d: '500' }],
      snapshotTimeUtc: hhmm,
    });
    expect(stored.approverId).toBe(b.founder.userId);
    await a.page.reload();
    await expect(a.page.locator(`[data-fees=programme][data-version="v${written.version}"]`)).toContainText(
      `test-vip-1 from 500 · snapshot ${hhmm} UTC`,
    );

    // The snapshot runs at its minute under the new version, and its row shows the figures it used.
    const row = a.page.locator(`[data-fees=snapshots] tr[data-snapshot="${snapshotAt.toISOString()}"]`);
    await expect
      .poll(
        async () => {
          await a.page.reload();
          return row.count();
        },
        { timeout: snapshotAt.getTime() - Date.now() + 120_000, intervals: [10_000] },
      )
      .toBe(1);
    await expect(row.locator('th')).toHaveText(shown(snapshotAt.toISOString()));
    const cells = row.locator('td');
    // Every figure exactly as the snapshot's own rows hold them, read with svc-trade's own database role: the run's
    // version and account count, the accounts above regular, and the sum of the counted 30-day volume. Each account's
    // tier is the one its volume reached under the new threshold of 500.
    const sql = tradeDb((await ops()).ctx);
    try {
      const [run] = await sql`SELECT schedule_version, accounts FROM trade.fee_tier_snapshot_runs WHERE instant = ${snapshotAt}`;
      const accounts = await sql`
        SELECT tier_id, volume_30d::text AS volume, schedule_version
          FROM trade.fee_tier_snapshots WHERE instant = ${snapshotAt}`;
      expect(run, `the run row at ${snapshotAt.toISOString()}`).toBeTruthy();
      expect(run.accounts).toBe(accounts.length);
      expect(run.schedule_version.replace(/^v/, '')).toBe(String(written.version));
      for (const r of accounts) {
        expect(r.schedule_version, JSON.stringify(r)).toBe(run.schedule_version);
        expect(r.tier_id, JSON.stringify(r)).toBe(toUnits(r.volume) >= toUnits('500') ? 'test-vip-1' : 'regular');
      }
      const above = accounts.filter((r) => r.tier_id !== 'regular').length;
      const volume = accounts.reduce((sum, r) => sum + toUnits(r.volume), 0n);
      await expect(cells.nth(0)).toHaveText(`v${written.version}`);
      await expect(cells.nth(1)).toHaveText(String(accounts.length));
      await expect(cells.nth(2)).toHaveText(String(above));
      expect(toUnits(await cells.nth(3).innerText()), 'counted 30-day volume, exactly').toBe(volume);
    } finally {
      await sql.end();
    }
  } finally {
    await a.close();
    await b.close();
    await restore('tier programme off');
  }
});

test(`${J} #5 reads maker rebate tiers: a read-only list with the owner values`, async ({ browser }) => {
  test.setTimeout(150_000);
  const version = await publish(REBATES, 'TEST maker rebate on IFC/USDT', { after: await latestEffective() });
  const a = await room(browser, 'a');
  try {
    const list = a.page.locator('[data-fees=rebates]');
    await expect(list.getByRole('heading', { name: 'Maker rebate tiers' })).toBeVisible();
    await expect(list).toContainText(`From the version in force: v${version.version}`);
    await expect(list.locator('tr[data-pair-group="test-rebate"][data-tier="regular"] td')).toHaveText([
      'test-rebate',
      'regular',
      rate(0),
      rate(5),
    ]);
    await expect(list.locator('tr[data-pair-group="all-others"][data-tier="regular"] td')).toHaveText([
      'all-others',
      'regular',
      rate(8),
      'not set',
    ]);
    // Read only: nothing in the list can be typed into or pressed.
    await expect(list.locator('input, textarea, select, button')).toHaveCount(0);
  } finally {
    await a.close();
    await restore('maker rebate off');
  }
});

test(`${J} #6 publishes a fee-change notice: the customer notice and its effective time`, async ({ page, browser }) => {
  // A version three minutes ahead, a four-eyes notice for it, and the wait for it to take effect before the restore.
  test.setTimeout(420_000);
  const tag = Date.now().toString(36);
  const next = await publish(changeTo('3'), 'IFC/USDT maker 0.03% from a time a notice names', {
    after: await latestEffective(),
    leadMs: 180_000,
    wait: false,
  });
  const a = await room(browser, 'a');
  const b = await room(browser, 'b');
  try {
    const panel = a.page.locator('[data-fees=notice]');
    await panel.getByLabel('Version the notice is for').selectOption(`v${next.version}`);
    await expect(panel.locator('[data-fees=notice-effective]')).toHaveText(`Takes effect ${shown(next.effectiveAt)}`);
    const title = `TEST fee change ${tag}`;
    await panel.getByLabel('Notice title').fill(title);
    await panel.getByLabel('Notice text').fill('TEST: the IFC/USDT maker fee goes from 0.10% to 0.03%.');
    await panel.getByRole('button', { name: 'Save the notice draft' }).click();
    const draft = panel.locator('[data-fees=notice-draft]');
    await expect(draft).toContainText('Draft saved');
    const noticeId = await draft.getAttribute('data-notice-id');
    expect(noticeId).toMatch(/^[0-9a-f-]{36}$/);

    await panel.getByRole('button', { name: 'Ask a second founder to approve the notice' }).click();
    const filed = panel.locator('[data-fees=notice-proposed]');
    await expect(filed).toContainText('Request filed');
    const approvalId = (await valueOf(filed, 'Approval id (publish with this once approved)').innerText()).trim();
    const payloadHash = (await valueOf(filed, 'Payload hash (the approver confirms this)').innerText()).trim();
    await approveAsB(b.page, approvalId, payloadHash);

    await panel.getByLabel('Approved notice request id').fill(approvalId);
    await panel.getByRole('button', { name: 'Publish the notice' }).click();
    await expect(panel.locator('[data-fees=notice-published]')).toHaveText(
      `Published. Customers see it on the notice board; it takes effect ${shown(next.effectiveAt)}.`,
    );

    // The customer reads it on the public board, with the time the version takes effect, before it does.
    await page.goto('/notice');
    const card = page.getByTestId(`notice-${noticeId}`);
    await expect(card).toContainText(title);
    await expect(card).toContainText('Fee change');
    const when = card.getByTestId('notice-effective');
    await expect(when).toHaveText(`Takes effect ${shown(next.effectiveAt)}`);
    await expect(when).toHaveAttribute('datetime', new Date(next.effectiveAt).toISOString());
    expect(Date.now()).toBeLessThan(Date.parse(next.effectiveAt));
  } finally {
    await a.close();
    await b.close();
    await restore('IFC/USDT back in the default pair group');
  }
});

test(`${J} #7 reads convert maintenance and limits: the state and per-asset maximums, "not set" where blank`, async ({ page, browser }) => {
  test.setTimeout(120_000);
  // What a customer is told converts now, and each coin's limit: the room must read the same.
  const who = await fundedTrader(page, 'js17cv', '10');
  const pairs = (await (await api(who)).get('/api/trade/trpc/convert.pairs')).body.result.data;
  expect(pairs.assets.length).toBeGreaterThan(0);
  const a = await room(browser, 'a');
  try {
    const convert = a.page.locator('[data-fees=convert]');
    await expect(convert.locator('[data-convert=state]')).toHaveText(
      pairs.paused ? 'Convert is paused for maintenance: every quote refuses trade.convert_disabled.' : 'Convert is open.',
    );
    for (const { asset, maxPerConvert } of pairs.assets) {
      await expect(convert.locator(`tr[data-asset="${asset}"] td`)).toHaveText([
        asset,
        maxPerConvert ? `${maxPerConvert.amount} ${maxPerConvert.asset}` : 'not set',
      ]);
    }
    // The stack's TEST values, and the one it leaves blank.
    await expect(valueOf(convert, 'Spread on a quote')).toHaveText(rate(20));
    await expect(valueOf(convert, 'A quote holds for')).toHaveText('15000 ms');
    await expect(valueOf(convert, 'Size at the desk price, convert')).toHaveText('0.1 to 5');
    await expect(valueOf(convert, 'Size at the desk price, one-click buy')).toHaveText('not set');
  } finally {
    await a.close();
  }
});

test(`${J} #8 reads sell quotes and partner buy fees: a finance read of venue sell prices with exact amounts, and the partner's buy fees as the partner reports them, or "not known"`, async ({
  page,
  browser,
}) => {
  // Two TEST fee versions (one to price under, one to put back), each a short wait for its effective time.
  test.setTimeout(240_000);
  // A customer asks for a sell quote on Convert and a price to buy USDT with money, as the screens do.
  const who = await fundedTrader(page, 'js17q', '10');
  fund(who.email, 'BTC', '0.01');
  const client = await api(who);
  const asked = await client.get(
    `/api/trade/trpc/convert.quote?input=${encodeURIComponent(JSON.stringify({ symbol: 'BTC/USDT', side: 'sell', qty: '0.001' }))}`,
  );
  expect(asked.status, JSON.stringify(asked.body).slice(0, 300)).toBe(200);
  const quote = asked.body.result.data;
  const ways = await client.get(
    `/api/bank/trpc/addMoney.methods?input=${encodeURIComponent(JSON.stringify({ assetId: 'USDT', amount: '50', country: 'NL' }))}`,
  );
  expect(ways.status, JSON.stringify(ways.body).slice(0, 300)).toBe(200);
  const priced = ways.body.result.data.methods.filter((m) => m.quote);
  expect(priced.length, JSON.stringify(ways.body.result.data.methods).slice(0, 300)).toBeGreaterThan(0);

  // The TEST partner's ramp gives no fee (its `fee unknown` switch, this customer's only): every way it priced reads
  // "not known", never 0, and the buy the customer asks for anyway is refused bank.onramp_fee_not_known and kept refused.
  const way = priced[0].method;
  const unknown = await withPartner(who, { rampFee: 'unknown' }, async () => {
    const none = await client.get(
      `/api/bank/trpc/addMoney.methods?input=${encodeURIComponent(JSON.stringify({ assetId: 'USDT', amount: '20', country: 'NL' }))}`,
    );
    expect(none.status, JSON.stringify(none.body).slice(0, 300)).toBe(200);
    const stillListed = none.body.result.data.methods.filter((x) => priced.some((p) => p.method === x.method));
    // Every way it priced is still offered, unpriced: a partner that dropped them would make the check below vacuous.
    expect(stillListed.map((m) => m.method).sort(), JSON.stringify(none.body.result.data.methods).slice(0, 300)).toEqual(
      priced.map((p) => p.method).sort(),
    );
    for (const m of stillListed) {
      expect(m, JSON.stringify(m)).toMatchObject({ quote: null, blocker: 'bank.onramp_fee_not_known' });
    }
    const started = await client.post('/api/bank/trpc/addMoney.start', {
      requestId: randomUUID(), // a new ask, as the screen makes one
      assetId: 'USDT',
      amount: '20',
      method: way,
      country: 'NL',
    });
    expect(started.status, JSON.stringify(started.body).slice(0, 300)).toBe(200);
    return started.body.result.data;
  });
  expect(unknown, JSON.stringify(unknown)).toMatchObject({ status: 'refused', refusalCode: 'bank.onramp_fee_not_known', onramp: null });

  // A sell on Convert priced by the venue on the customer's own TEST venue account: the venue's own preview of a market
  // sell of that size, under a TEST builder fee of 2 bps on BTC-USDC published for this step.
  const { venueId, builder } = await venueDoor(client);
  const priceUnder = await publish(withBuilderFees(venueId, '2'), 'TEST builder fee 2 bps, for venue sell quotes', {
    after: await latestEffective(),
  });
  try {
    const wallet = testWallet(`seller ${who.handle}`);
    await testVenue('/test/deposit', {
      account: { venueId, owner: wallet.address, subAccount: null },
      asset: 'BTC',
      amount: '2',
      depositRef: `84532:js17-sells-${who.handle}:0`,
    });
    const SELL = '0.75';
    const quoteKey = `js17-sell-${randomUUID()}`; // made once per ask, as the screen makes one
    const venueQuoted = await client.post('/api/v1/venue/convert/sell-quote', {
      owner: wallet.address,
      symbol: VENUE_SPOT,
      amount: SELL,
      quoteKey,
    });
    expect(venueQuoted.status, JSON.stringify(venueQuoted.body).slice(0, 400)).toBe(200);
    const vq = venueQuoted.body;
    // The TEST venue's own answer for the same sell on the same account, read from the venue directly, not through us.
    const tick = (await testVenue('/markets', {})).value.find((m) => m.symbol === VENUE_SPOT).tickSize;
    const venueOwn = (
      await testVenue('/preview', {
        account: { venueId, owner: wallet.address, subAccount: null },
        intent: {
          kind: 'place_order',
          symbol: VENUE_SPOT,
          side: 'sell',
          type: 'market',
          amount: SELL,
          price: tick,
          timeInForce: 'IOC',
          reduceOnly: false,
          clientOrderKey: `convert-quote:${client.userId}:${quoteKey}`,
          builderFee: { builder, feeBps: '2' },
        },
      })
    ).value;
    expect(venueOwn.fill, JSON.stringify(venueOwn).slice(0, 400)).toMatchObject({ known: true });
    expect(toUnits(venueOwn.fill.value.amount), 'the book takes some of the sell').toBeGreaterThan(0n);
    expect(venueOwn.builderFee, 'our builder fee, as the venue figures it').toMatchObject({ known: true });
    expect(venueOwn.venueFee, "the venue's own fee: the TEST venue publishes BTC-USDC's").toMatchObject({ known: true });
    expect(vq).toMatchObject({
      quoteId: `venue-sell:${client.userId}:${quoteKey}`,
      userId: client.userId,
      venueId,
      test: true,
      owner: wallet.address,
      symbol: VENUE_SPOT,
      baseAsset: 'BTC',
      quoteAsset: 'USDC',
      fill: { known: true },
      venueFee: { known: true, asset: venueOwn.venueFee.value.asset },
      builderFee: { known: true, asset: venueOwn.builderFee.value.asset },
    });
    expect(sameAmount(vq.amount, SELL)).toBe(true);
    expect(sameAmount(vq.fill.amount, venueOwn.fill.value.amount), `fill ${vq.fill.amount} vs ${venueOwn.fill.value.amount}`).toBe(true);
    expect(
      sameAmount(vq.fill.averagePrice, venueOwn.fill.value.averagePrice),
      `average ${vq.fill.averagePrice} vs ${venueOwn.fill.value.averagePrice}`,
    ).toBe(true);
    expect(
      sameAmount(vq.venueFee.amount, venueOwn.venueFee.value.amount),
      `venue fee ${vq.venueFee.amount} vs ${venueOwn.venueFee.value.amount}`,
    ).toBe(true);
    expect(sameAmount(vq.builderFee.amount, venueOwn.builderFee.value.amount)).toBe(true);
    // A retry under the same key gives the quote first given; the same key for another sell refuses.
    const retried = await client.post('/api/v1/venue/convert/sell-quote', {
      owner: wallet.address,
      symbol: VENUE_SPOT,
      amount: SELL,
      quoteKey,
    });
    expect(retried.status).toBe(200);
    expect(retried.body).toEqual(vq);
    const reused = await client.post('/api/v1/venue/convert/sell-quote', {
      owner: wallet.address,
      symbol: VENUE_SPOT,
      amount: '0.5',
      quoteKey,
    });
    expect(reused.status, JSON.stringify(reused.body).slice(0, 300)).toBe(409);
    expect(JSON.stringify(reused.body)).toContain('trade.venue_sell_quote_key_reused');
    // A quote sends nothing: no order of the customer's rests on the venue.
    expect((await testVenue('/open-orders', { account: { venueId, owner: wallet.address, subAccount: null } })).value).toEqual([]);

    const a = await room(browser, 'a');
    try {
      // Each venue sell price as the venue gave it: the customer, the venue, what they sell, what fills now and at what
      // average price, the venue's fee and our builder fee, and the venue's time, exactly; labelled TEST on a TEST venue.
      const venueSells = a.page.locator('[data-fees=venue-sells]');
      const vrow = venueSells.locator(`tr[data-venue-quote="${vq.quoteId}"]`);
      await expect(vrow.locator('th')).toHaveText(shown(vq.createdAt));
      await expect(vrow.locator('td')).toHaveText([
        client.userId,
        venueId,
        `${vq.amount} BTC on ${VENUE_SPOT}`,
        `${vq.fill.amount} BTC`,
        `${vq.fill.averagePrice} USDC`,
        `${vq.venueFee.amount} ${vq.venueFee.asset}`,
        `${vq.builderFee.amount} ${vq.builderFee.asset}`,
        shown(vq.asOf),
      ]);
      await expect(venueSells).toContainText('TEST: these prices come from a TEST venue, not a live one.');
      await expect(venueSells.locator('input, button, select')).toHaveCount(0);

      // Each sell quote as it was given: what the customer sells and gets, the book price, and the spread kept, exactly.
      const sells = a.page.locator('[data-fees=quotes]');
      const row = sells.locator(`tr[data-quote="${quote.quoteId}"] td`);
      await expect(row.nth(0)).toHaveText(client.userId);
      await expect(row.nth(1)).toHaveText(`${quote.inAmount} ${quote.inAsset}`);
      await expect(row.nth(2)).toHaveText(`${quote.outAmount} ${quote.outAsset}`);
      await expect(row.nth(3)).toHaveText(quote.avgPrice);
      const spread = toUnits(quote.bookNotional) - toUnits(quote.userNotional);
      const spreadText = await row.nth(4).innerText();
      expect(spreadText).toMatch(new RegExp(` USDT \\(${quote.convertSpreadBps} bps\\)$`));
      expect(toUnits(spreadText.split(' ')[0])).toBe(spread);

      // Each fiat buy price with its fee, exactly as the bank gave it to the customer.
      const fiat = a.page.locator('[data-fees=fiat-buy]');
      // The partner's own figures: the TEST ramp stand-in's catalogue the stack loads (BANK_ONRAMP_SIM_JSON), read here from
      // its source, not from the bank. Each price's fee and rate are the partner's, and it pays amount × rate, rounded up,
      // plus the fee.
      const partnerQuotes = partnerRampCatalogue();
      for (const { quote: q } of priced) {
        const own = partnerQuotes.find((p) => p.country === 'NL' && p.method === q.method && p.asset === q.assetId);
        expect(own, `the TEST partner's own price for ${q.method}`).toBeTruthy();
        expect(own.payCurrency).toBe(q.payCurrency);
        expect(sameAmount(q.fee, own.fee), `fee ${q.fee} vs the partner's ${own.fee}`).toBe(true);
        expect(sameAmount(q.rate, own.rate), `rate ${q.rate} vs the partner's ${own.rate}`).toBe(true);
        const scale = toUnits('1');
        const product = toUnits(q.amount) * toUnits(own.rate);
        const payUnits = (product + scale - 1n) / scale + toUnits(own.fee);
        expect(toUnits(q.payAmount), `pay ${q.payAmount} = ${q.amount} × ${own.rate}, rounded up, + ${own.fee}`).toBe(payUnits);
        await expect(fiat.locator(`tr[data-onramp-quote="${q.quoteId}"] td`)).toHaveText([
          client.userId,
          `${q.amount} ${q.assetId}`,
          q.method,
          `${q.payAmount} ${q.payCurrency}`,
          `${q.fee} ${q.payCurrency}`,
          q.rate,
        ]);
      }
      // The buy the partner gave no fee for: the customer and what they asked to buy, and its pay amount, fee and rate
      // "not known", never 0 and never a price; it is not among the priced fees.
      const notKnown = a.page.locator('[data-fees=fiat-buy-not-known]');
      await expect(notKnown.locator(`tr[data-onramp-request="${unknown.requestId}"] td`)).toHaveText([
        client.userId,
        `20 USDT`,
        way,
        'NL',
        'not known',
        'not known',
        'not known',
      ]);
      // The stack's partner is the TEST partner bank, and the list says so.
      await expect(notKnown).toContainText('TEST: the TEST partner bank stands in for a payment partner here.');
      await expect(fiat.locator(`tr[data-onramp-request="${unknown.requestId}"]`)).toHaveCount(0);
      // A read only: no control on any list.
      await expect(sells.locator('input, button, select')).toHaveCount(0);
      await expect(fiat.locator('input, button, select')).toHaveCount(0);
      await expect(notKnown.locator('input, button, select')).toHaveCount(0);
    } finally {
      await a.close();
    }
  } finally {
    await restore(`builder fee off after v${priceUnder.version}`);
  }
});
