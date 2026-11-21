// World: book, gates, restart
import { randomBytes } from 'node:crypto';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { test, expect } from './journey.mjs';
import { api, journeyState, restartService, toUnits, fromUnits } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';
import { installTestWallet, testWalletKey } from './test-wallet.mjs';
import { connectWhenAsked } from './dex.mjs';
import {
  continueInWallet,
  openVenueDesk,
  openVenuePage,
  TEST_VENUE,
  TEST_VENUE_B,
  testVenueInfoAt,
  venueOk,
  venueForThisFile,
  venueInfo,
  venueRecord,
} from './venue.mjs';

// J-derivatives-30, "I see the builder-fee approval I gave INTAFACED, revoke it, and know why an approval can fail", in
// the running app against the stack's two TEST venue simulators (LOCAL_STACK_USER_VENUE=two). One test per step, titled
// "J-derivatives-30 #<n>", run in order on one TEST person with two TEST wallets. The approvals are the venue's own
// record, read straight from each TEST venue here and never through our door; a revoke is the venue's approval of zero,
// signed by the person's main wallet. The ledger posts nothing. Every figure is TEST.
const J = 'J-derivatives-30';
const SETTINGS = '/uc/trading-permissions';
const DESK = '/trade/futures';
const SYMBOL = 'BTC-PERP';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
/** TEST margin in each venue account, enough for every TEST order here at 10x. */
const FUNDS = '50000';
/** The most active builder approvals the TEST venue allows at a time, as the venue it stands for publishes. */
const LIMIT = 10;

test.describe.configure({ mode: 'default' });
venueForThisFile(test, 'two');

// ── the two TEST venues, read directly (what the app must equal) ──

const both = async () => ({ a: await testVenueInfoAt(TEST_VENUE), b: await testVenueInfoAt(TEST_VENUE_B) });
const account = (venue, owner) => ({ venueId: venue.id, owner: owner.toLowerCase(), subAccount: null });
const approvalOf = async (venue, owner, builder) => (await venueRecord(owner, '/builder-fee-approval', { builder }, venue.base)).value;
const openOrders = async (venue, owner) => (await venueRecord(owner, '/open-orders', {}, venue.base)).value;
const fillsOf = async (venue, owner, since) => (await venueRecord(owner, '/fills', { since }, venue.base)).value;
const switchDown = (venue, venueDown) => venueOk(venue.base, '/test/switches', { venueDown });

/** One action the key's owner signs on its own account at a TEST venue directly: the person's own venue action. */
async function ownAction(venue, key, intent) {
  const wallet = privateKeyToAccount(key);
  const owner = wallet.address.toLowerCase();
  const prepared = await venueOk(venue.base, '/prepare', {
    account: account(venue, owner),
    signer: { role: 'owner', address: owner },
    intent,
  });
  const t = prepared.typedData;
  const signature = await wallet.signTypedData({ domain: t.domain, types: t.types, primaryType: t.primaryType, message: t.message });
  const sent = await venueOk(venue.base, '/submit', { prepared, signature: { digest: prepared.digest, signature, signedBy: owner } });
  expect(sent.accepted, JSON.stringify(sent).slice(0, 300)).toBe(true);
  return sent;
}

/** A venue account funded with TEST USDC and 10x isolated leverage on the market, signed by the owner's own key. */
async function readyToTrade(venue, key) {
  const owner = privateKeyToAccount(key).address.toLowerCase();
  await venueOk(venue.base, '/test/deposit', {
    account: account(venue, owner),
    asset: 'USDC',
    amount: FUNDS,
    depositRef: `84532:0x${randomBytes(32).toString('hex')}:0`,
  });
  await ownAction(venue, key, { kind: 'update_leverage', symbol: SYMBOL, leverageBps: 100_000, marginMode: 'isolated' });
}

function state() {
  const s = run.read();
  if (!s.account || !s.walletKey || !s.secondKey) throw new Error(`${J} #1 made no person and wallets, so this step has no one to act as`);
  return s;
}
const ownerOf = (key) => privateKeyToAccount(key).address.toLowerCase();
/** Our builder as the door publishes it: its address and fee. */
async function ours(client) {
  const status = (await client.get('/api/v1/venue/status')).body;
  expect(status.builder?.address, 'the stack publishes a TEST builder').toBeTruthy();
  return status.builder;
}

const rowOf = (page, venue) =>
  page.getByTestId('trading-permissions').locator(`tr[data-testid="trading-permission-row"][data-venue="${venue.id}"]`);
const cell = (row, name) => row.locator(`[data-cell="${name}"]`);
/** "0.5 bps of each order" for a venue's or our own figure. */
const bpsWords = (bps) => `${bps} bps of each order`;
/** Every POST the page makes to one door route, counted from now. */
function posts(page, route) {
  const seen = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().endsWith(`/api/v1/venue/${route}`)) seen.push(r.postDataJSON());
  });
  return seen;
}

/** The Trading permissions page with the person's main wallet connected. */
const permissions = (page, s, key = s.walletKey) => openVenuePage(page, s.account, SETTINGS, key);

test(`${J} #1 opens Settings, Trading permissions: each venue where they approved our builder fee, with the most they approved as the venue reports it, beside the fee the owner published; a blank published fee reads "not set"; a venue that can't be read reads "unknown"`, async ({
  page,
}) => {
  test.setTimeout(420_000);
  const person = await signUp(page, 'vperm');
  await verify(page, person);
  run.reset({ account: person, walletKey: testWalletKey(), secondKey: testWalletKey(), startedAt: new Date().toISOString() });
  const s = state();
  const v = await both();
  const owner = ownerOf(s.walletKey);
  const client = await api(person);
  const builder = await ours(client);

  // The journey's start: the main wallet approved our builder fee on both venues (J-derivatives-28 #8), and holds an
  // agent key for trading on the first.
  for (const venue of [v.a, v.b]) {
    await readyToTrade(venue, s.walletKey);
    await ownAction(venue, s.walletKey, { kind: 'approve_builder_fee', builder: builder.address, maxFeeBps: builder.feeBps });
  }
  const agentKey = generatePrivateKey();
  await ownAction(v.a, s.walletKey, {
    kind: 'approve_agent',
    agentAddress: ownerOf(agentKey),
    agentName: 'TEST trading agent',
    validUntil: null,
  });
  run.write({ agentKey });

  // Settings, then Trading permissions, as a person reaches it.
  const { chainId } = await venueInfo();
  const wallet = await installTestWallet(page, { chainId, privateKey: s.walletKey });
  await signIn(page, person);
  await page.goto('/uc/account');
  await page.getByTestId('acct-nav').getByRole('link', { name: 'Trading permissions', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`${SETTINGS}$`));
  const address = page.getByTestId('venue-wallet-address');
  await connectWhenAsked(page, address);
  await expect(address).toHaveText(wallet.address.toLowerCase());

  // Each venue's own record of the approval, beside the fee we publish.
  for (const venue of [v.a, v.b]) {
    const approved = await approvalOf(venue, owner, builder.address);
    expect(toUnits(approved)).toBe(toUnits(builder.feeBps));
    const row = rowOf(page, venue);
    await expect(row).toContainText(venue.displayName);
    await expect(row.getByTestId('venue-test')).toHaveText('TEST');
    await expect(row).toHaveAttribute('data-state', 'approved', { timeout: 15_000 });
    await expect(cell(row, 'approved')).toHaveText(bpsWords(approved));
    await expect(cell(row, 'published')).toHaveText(bpsWords(builder.feeBps));
    await expect(cell(row, 'state')).toContainText('Approved');
  }

  // A venue that can't be read reads "unknown", never a figure; the other still reads the venue's own.
  await switchDown(v.b, true);
  try {
    const row = rowOf(page, v.b);
    await expect(row).toHaveAttribute('data-state', 'unknown', { timeout: 15_000 });
    await expect(cell(row, 'approved')).toHaveText('Unknown');
    await expect(cell(row, 'state')).toContainText('Unknown');
    await expect(row.getByRole('button', { name: 'Revoke', exact: true })).toHaveCount(0);
    await expect(rowOf(page, v.a)).toHaveAttribute('data-state', 'approved');
  } finally {
    await switchDown(v.b, false);
  }
  await expect(rowOf(page, v.b)).toHaveAttribute('data-state', 'approved', { timeout: 15_000 });

  // A blank published fee reads "not set"; each venue's approval is still read from the venue.
  try {
    await restartService('trade', { LOCAL_STACK_USER_VENUE: 'two', LOCAL_STACK_USER_VENUE_BUILDER_FEE: 'off' });
    const blank = (await client.get('/api/v1/venue/status')).body;
    expect(blank.builder).toBeNull();
    expect(blank.builderAddress).toBe(builder.address);
    await page.reload();
    await connectWhenAsked(page, address);
    for (const venue of [v.a, v.b]) {
      const row = rowOf(page, venue);
      await expect(row).toHaveAttribute('data-state', 'approved', { timeout: 30_000 });
      await expect(cell(row, 'published')).toHaveText('Not set');
      await expect(cell(row, 'approved')).toHaveText(bpsWords(await approvalOf(venue, owner, builder.address)));
    }
  } finally {
    await restartService('trade', { LOCAL_STACK_USER_VENUE: 'two', LOCAL_STACK_USER_VENUE_BUILDER_FEE: null });
  }
  // Reading asked the wallet for nothing.
  expect(wallet.requests).toHaveLength(0);
});

test(`${J} #2 presses Revoke on one venue while only the agent key is available to sign: the main wallet is asked to sign, never the agent key; with no main wallet signature, refused before sending and the approval stays as the venue reports it`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  const s = state();
  const { agentKey } = run.read();
  const v = await both();
  const owner = ownerOf(s.walletKey);
  const client = await api(s.account);
  const builder = await ours(client);
  const before = await approvalOf(v.a, owner, builder.address);
  expect(toUnits(before)).toBe(toUnits(builder.feeBps));
  // The agent key is the person's, live on the venue.
  expect((await venueRecord(owner, '/agents', {}, v.a.base)).value.map((a) => a.address)).toContain(ownerOf(agentKey));

  // The agent key can't be the signer: our door refuses its revoke before anything is prepared.
  const revoke = { kind: 'approve_builder_fee', builder: builder.address, maxFeeBps: '0' };
  const byAgent = await client.post('/api/v1/venue/prepare', {
    venueId: v.a.id,
    owner,
    signer: { role: 'agent', address: ownerOf(agentKey) },
    intent: revoke,
    actionKey: `builder-revoke:${owner}:${v.a.id}:${J}-agent`,
  });
  expect(byAgent.status, JSON.stringify(byAgent.body).slice(0, 300)).toBe(422);
  expect(byAgent.body.refusal?.code).toBe('agent_not_permitted');
  // Nor its signature over the main wallet's revoke: refused before it is stored or sent.
  const prep = await client.post('/api/v1/venue/prepare', {
    venueId: v.a.id,
    owner,
    signer: { role: 'owner', address: owner },
    intent: revoke,
    actionKey: `builder-revoke:${owner}:${v.a.id}:${J}-agent-signature`,
  });
  expect(prep.status, JSON.stringify(prep.body).slice(0, 300)).toBe(200);
  const t = prep.body.prepared.typedData;
  const agentSignature = await privateKeyToAccount(agentKey).signTypedData({
    domain: t.domain,
    types: t.types,
    primaryType: t.primaryType,
    message: t.message,
  });
  const sentByAgent = await client.post('/api/v1/venue/submit', {
    actionKey: prep.body.actionKey,
    signature: { digest: prep.body.prepared.digest, signature: agentSignature, signedBy: owner },
  });
  expect(sentByAgent.status, JSON.stringify(sentByAgent.body).slice(0, 300)).not.toBe(200);
  expect(await approvalOf(v.a, owner, builder.address)).toBe(before);

  // In the app: Revoke asks the main wallet, which doesn't sign; nothing is sent and the approval stays.
  const wallet = await permissions(page, s);
  const row = rowOf(page, v.a);
  await expect(row).toHaveAttribute('data-state', 'approved', { timeout: 15_000 });
  const prepares = posts(page, 'prepare');
  const submits = posts(page, 'submit');
  await row.getByRole('button', { name: 'Revoke', exact: true }).click();
  const sheet = page.getByTestId('trading-permission-revoke');
  await expect(sheet).toBeVisible();
  await expect(sheet.locator('[data-line="revoke-words"]')).toContainText(
    `Your main wallet ${owner} signs one revoke on ${v.a.displayName}`,
  );
  await expect(sheet.locator('[data-line="revoke-words"]')).toContainText('An agent key can’t sign a revoke');
  wallet.rejectNext();
  await sheet.getByRole('button', { name: 'Revoke in wallet', exact: true }).click();
  await continueInWallet(page);
  await expect(page.getByTestId('trading-permission-refused')).toHaveText(
    `Not revoked: a revoke needs your main wallet’s signature, and an agent key can’t sign it. Nothing was sent; the approval stays as ${v.a.displayName} reports it.`,
  );
  // The main wallet was asked, once, for its own address; the door prepared it for the owner, never the agent.
  expect(wallet.requests).toHaveLength(1);
  expect(wallet.requests[0].method).toBe('eth_signTypedData_v4');
  expect(String(wallet.requests[0].params[0]).toLowerCase()).toBe(owner);
  expect(prepares).toHaveLength(1);
  expect(prepares[0]).toMatchObject({ venueId: v.a.id, owner, signer: { role: 'owner', address: owner }, intent: revoke });
  expect(submits).toHaveLength(0);
  expect(await approvalOf(v.a, owner, builder.address)).toBe(before);
  await expect(row).toHaveAttribute('data-state', 'approved');
  await expect(cell(row, 'approved')).toHaveText(bpsWords(before));
});

test(`${J} #3 presses Revoke on that venue and signs with their main wallet: one signed venue action, sent once; the venue then reports no approval for our builder address and the row reads revoked`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  const s = state();
  const v = await both();
  const owner = ownerOf(s.walletKey);
  const builder = await ours(await api(s.account));
  const wallet = await permissions(page, s);
  const row = rowOf(page, v.a);
  await expect(row).toHaveAttribute('data-state', 'approved', { timeout: 15_000 });
  const prepares = posts(page, 'prepare');
  const submits = posts(page, 'submit');
  await row.getByRole('button', { name: 'Revoke', exact: true }).click();
  const sheet = page.getByTestId('trading-permission-revoke');
  const revokeButton = sheet.getByRole('button', { name: 'Revoke in wallet', exact: true });
  await revokeButton.click();
  await continueInWallet(page);
  await expect(page.getByTestId('trading-permission-revoked')).toHaveText(
    `Revoked on ${v.a.displayName}: the venue now reports no approval for us.`,
    { timeout: 20_000 },
  );
  // One signature from the main wallet, one action prepared and sent once.
  expect(wallet.requests).toHaveLength(1);
  expect(String(wallet.requests[0].params[0]).toLowerCase()).toBe(owner);
  expect(prepares).toHaveLength(1);
  expect(prepares[0]).toMatchObject({ venueId: v.a.id, signer: { role: 'owner', address: owner } });
  expect(prepares[0].intent).toEqual({ kind: 'approve_builder_fee', builder: builder.address, maxFeeBps: '0' });
  expect(prepares[0].actionKey).toMatch(new RegExp(`^builder-revoke:${owner}:`));
  expect(submits).toHaveLength(1);
  expect(submits[0].actionKey).toBe(prepares[0].actionKey);
  // The venue's own record: no approval for our builder address.
  expect(await approvalOf(v.a, owner, builder.address)).toBe('0');
  await expect(row).toHaveAttribute('data-state', 'revoked', { timeout: 15_000 });
  await expect(cell(row, 'state')).toContainText('Revoked');
  await expect(cell(row, 'approved')).toHaveText('None');
  await expect(row.getByRole('button', { name: 'Revoke', exact: true })).toHaveCount(0);
  // The other venue's approval is untouched.
  expect(toUnits(await approvalOf(v.b, owner, builder.address))).toBe(toUnits(builder.feeBps));
  // Sent once: the door holds the one answer under that key; the same key again signs and sends nothing.
  const again = await (
    await api(s.account)
  ).post('/api/v1/venue/prepare', {
    venueId: v.a.id,
    owner,
    signer: { role: 'owner', address: owner },
    intent: prepares[0].intent,
    actionKey: prepares[0].actionKey,
  });
  expect(again.body).toMatchObject({ reused: true, signed: true, lastOutcome: { definite: true, accepted: true } });
  run.write({ revokedVenue: v.a.id });
});

test(`${J} #4 confirms an order on that venue: the approval signature of J-derivatives-28 #8 is asked for again before the order is signed; declining sends no order and says why`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  const s = state();
  const v = await both();
  const owner = ownerOf(s.walletKey);
  const client = await api(s.account);
  const builder = await ours(client);
  expect(s.revokedVenue).toBe(v.a.id);
  expect(await approvalOf(v.a, owner, builder.address)).toBe('0');
  // With our approval revoked, no order carrying our builder code is sent there: the venue refuses it before signing.
  const direct = await client.post('/api/v1/venue/prepare', {
    venueId: v.a.id,
    owner,
    signer: { role: 'owner', address: owner },
    intent: {
      kind: 'place_order',
      symbol: SYMBOL,
      side: 'buy',
      type: 'limit',
      amount: '0.01',
      price: '1000',
      timeInForce: 'GTC',
      reduceOnly: false,
      clientOrderKey: `order:${owner}:${SYMBOL}:${J}-direct`,
      builderFee: null,
    },
  });
  expect(direct.status, JSON.stringify(direct.body).slice(0, 300)).toBe(422);
  expect(direct.body.refusal?.code).toBe('builder_fee_not_approved');

  // The other venue down, so the order routes to the one where the approval was revoked.
  await switchDown(v.b, true);
  try {
    const wallet = await openVenueDesk(page, s.account, DESK, s.walletKey);
    await expect(page.getByTestId('venue-routes')).toBeVisible({ timeout: 30_000 });
    const sheet = await reviewLong(page, await smallOrder(v.a));
    await expect(sheet.locator('[data-line="route-venue"]')).toHaveAttribute('data-venue', v.a.id);
    await sheet.getByRole('button', { name: 'Open long', exact: true }).click();
    const approval = sheet.getByTestId('venue-route-approval');
    await expect(approval).toBeVisible();
    const words = approval.locator('[data-line="approval-words"]');
    await expect(words).toContainText(`signs one approval that lets ${v.a.displayName} charge our builder fee`);
    await expect(words).toContainText(`at most ${builder.feeBps} bps of each order`);
    await approval.getByRole('button', { name: 'Decline', exact: true }).click();
    await expect(sheet.getByTestId('venue-route-declined')).toHaveText(
      `No order was sent: our builder fee on ${v.a.displayName} was not approved, and every order there carries it.`,
    );
    expect(wallet.requests).toHaveLength(0);
    expect(await openOrders(v.a, owner)).toEqual([]);
    expect(await fillsOf(v.a, owner, s.startedAt)).toEqual([]);
    expect(await approvalOf(v.a, owner, builder.address)).toBe('0');
  } finally {
    await switchDown(v.b, false);
  }
});

test(`${J} #5 with the second wallet, confirms an order on a venue where it never approved us: the venue refuses the approval because the wallet holds its maximum of active builder approvals, in the venue's reason and limit, and that revoking one of the others frees a place; no order is sent`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  const s = state();
  const v = await both();
  const second = ownerOf(s.secondKey);
  const builder = await ours(await api(s.account));
  // The journey's start: the second wallet holds the venue's maximum of active builder approvals, all for other builders.
  await readyToTrade(v.a, s.secondKey);
  for (let i = 0; i < LIMIT; i++)
    await ownAction(v.a, s.secondKey, {
      kind: 'approve_builder_fee',
      builder: `0x0be7${i.toString(16).padStart(36, '0')}`,
      maxFeeBps: '1',
    });
  expect(await approvalOf(v.a, second, builder.address)).toBe('0');

  await switchDown(v.b, true);
  try {
    const wallet = await openVenueDesk(page, s.account, DESK, s.secondKey);
    await expect(page.getByTestId('venue-routes')).toBeVisible({ timeout: 30_000 });
    const prepares = posts(page, 'prepare');
    const sheet = await reviewLong(page, await smallOrder(v.a));
    await expect(sheet.locator('[data-line="route-venue"]')).toHaveAttribute('data-venue', v.a.id);
    await sheet.getByRole('button', { name: 'Open long', exact: true }).click();
    const approval = sheet.getByTestId('venue-route-approval');
    await expect(approval).toBeVisible();
    await approval.getByRole('button', { name: 'Approve in wallet', exact: true }).click();
    const limit = sheet.getByTestId('venue-route-approval-limit');
    await expect(limit).toHaveText(
      `${v.a.displayName} refused the approval: this account already holds ${LIMIT} active builder fee approvals, the most ${v.a.displayName} allows at a time (${LIMIT}). Revoking one of the other builders you approved there frees a place. No order was sent.`,
    );
    // In words the person can read: on screen, not cut off below the review's fold.
    await expect(limit).toBeInViewport({ ratio: 1 });
    // The venue refused before the wallet was asked; no order was prepared or sent, and nothing was approved.
    expect(wallet.requests).toHaveLength(0);
    expect(prepares.map((p) => p.intent.kind)).toEqual(['approve_builder_fee']);
    expect(await approvalOf(v.a, second, builder.address)).toBe('0');
    expect(await openOrders(v.a, second)).toEqual([]);
    expect(await fillsOf(v.a, second, s.startedAt)).toEqual([]);
  } finally {
    await switchDown(v.b, false);
  }
});

// ── the futures desk's routed ticket (as J-derivatives-28 drives it) ──

/** A small long the first venue's book fills now: 0.01 BTC, with a worst price above its best ask. */
async function smallOrder(venue) {
  const ask = (await venueOk(venue.base, '/book', { symbol: SYMBOL, depth: 5 })).value.asks[0];
  expect(ask, 'the TEST venue shows an ask').toBeTruthy();
  return { size: '0.01', worst: fromUnits(toUnits(ask.price) + toUnits('200')) };
}

/** The ticket filled for a market long and Review pressed; returns the routed review. */
async function reviewLong(page, { size, worst }) {
  const ticket = page.getByTestId('venue-ticket');
  await ticket.getByRole('button', { name: 'Long', exact: true }).click();
  await ticket.getByRole('button', { name: 'Market', exact: true }).click();
  await ticket.getByRole('textbox', { name: 'Size (BTC)', exact: true }).fill(size);
  await ticket.getByRole('textbox', { name: 'Worst price (slippage limit)', exact: true }).fill(worst);
  await ticket.getByRole('combobox', { name: 'Margin asset', exact: true }).selectOption('USDC');
  await ticket.getByRole('button', { name: 'Review long', exact: true }).click();
  const sheet = page.getByTestId('venue-route-review');
  await expect(sheet).toBeVisible();
  return sheet;
}
