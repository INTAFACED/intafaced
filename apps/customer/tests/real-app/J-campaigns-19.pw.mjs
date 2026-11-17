// World: book, restart, stack
import { keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { test, expect } from './journey.mjs';
import { ADMIN, founderSignIn } from './admin.mjs';
import { chosePro, signIn, signUp } from './desk.mjs';
import { CHAIN_ID, TOKEN_USD, fundOnTestChain, testChain } from './dex.mjs';
import { api, journeyState, tool } from './stack.mjs';
import { ageRecord } from './test-age.mjs';
import { installTestWallet, TEST_WALLET } from './test-wallet.mjs';
import { testVenue, venueForThisFile } from './venue.mjs';
import { chainReceipt, rewardFunds, sumDecimal } from './reward-funds.mjs';
import { GATE_URL } from '../../../../tooling/scripts/local-test-facts.mjs';

// J-campaigns-19, in the running app (docs/roadmap/journeys.json): finance checks payouts, recovers a stuck one, and
// settles a distribution. One test per step, titled "J-campaigns-19 #<n>", run in order. The operator is the stack's
// LOCAL TEST founder A on the founder console's payout board (/more-ops/campaigns/payouts). Every payout is INTAFACED's
// own TEST money: an airdrop share owed from its campaign's budget and paid once in TEST USDC from our TEST rewards wallet
// to the person's own connected wallet on the stack's TEST chain, never credited to a balance. The pot is funded from
// builder fees the TEST venue credited us on this file's own sells (reward-funds.mjs).
//
// A chain send that meets a fault is made so through svc-campaigns' TEST pay-fault door, which applies one fault to the
// next send of one reward on the TEST chain (`lost_after_broadcast`: the chain took it and the answer was lost;
// `unanswered`: nothing reached the chain; `revert`: the chain mined and reverted it). A negative venue equity is a TEST
// deficit the TEST venue books (/test/deficit), and an equity that can't be read is the TEST venue down for that one
// account (/test/account-switches). The wait before an unread account is held out is aged through the TEST age door.
const J = 'J-campaigns-19';
const RUN = process.env.JOURNEY_RUN_ID ?? 'local';
const run = journeyState(`${J}-${RUN}`);
const tag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.toUpperCase();
const ASSET = 'USDC';
const DAY = 86_400_000;
// Each step-1 airdrop has one person and a TEST pool of 0.01 USDC, so that person's share is the whole pool.
const SMALL_POOL = '0.01';
// More than the TEST reward pot holds (funded from a few TEST builder fees), and inside the TEST reward ceiling of 100:
// the budget it needs can't be set aside, so it is pending funding.
const UNFUNDED_POOL = '90';
// The settled airdrop (#5 #6): ANN holds 200 USDC on the venue and BEN 100, so ANN's share is 0.05 x 2/3 and BEN's
// 0.05 x 1/3, rounded down to the TEST token's 6 decimals and the unit left given to the larger remainder (BEN's).
const POOL = '0.05';
const ANN_EQUITY = '200';
const BEN_EQUITY = '100';
const ANN_SHARE = '0.033333';
const BEN_SHARE = '0.016667';
// CAT holds 50 USDC and then books a TEST deficit of 80: her equity at the snapshot is -30, so she is excluded.
const CAT_FUNDS = '50';
const CAT_DEFICIT = '80';
const CAT_EQUITY = '-30';
// DAN holds 10 USDC, but the TEST venue refuses every read of his account at the snapshot: named and held out.
const DAN_FUNDS = '10';
const VENUE_DOWN = 'trade.venue.venue_down';
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

test.describe.configure({ mode: 'default' });
venueForThisFile(test);

function state(...keys) {
  const s = run.read();
  for (const k of keys) if (!s[k]) throw new Error(`${J}: an earlier step left no ${k}, so this step has nothing to act on`);
  return s;
}

let gates;
let ctx;
let pair;
async function operators() {
  gates ??= await import('../../../../tooling/scripts/local-test-gates.mjs');
  ctx ??= await gates.makeContext({ log: () => {} });
  pair ??= await gates.approverSessions(ctx);
  return { ctx, pair, gates };
}
const funds = rewardFunds({ J, RUN, operators });

const data = (res, what) => {
  const row = res.json?.result?.data;
  if (!row) throw new Error(`${what} refused (${res.status}): ${res.text.slice(0, 300)}`);
  return row;
};

async function opsQuery(path, input) {
  const { ctx, pair } = await operators();
  return data(await ctx.edge.query('campaigns', path, input, await pair.a.campaignsOpsToken()), path);
}
const plan = (campaignId) => opsQuery('ops.campaigns.distribution.plan', { campaignId });

/** One TEST campaign, live now, made by A, approved by B, activated by A. */
async function liveCampaign(definition) {
  const { ctx, pair } = await operators();
  const a = await pair.a.campaignsOpsToken();
  const b = await pair.b.campaignsOpsToken();
  const made = data(await ctx.edge.mutate('campaigns', 'ops.campaigns.create', definition, a), 'ops.campaigns.create');
  data(await ctx.edge.mutate('campaigns', 'ops.campaigns.transition', { id: made.id, action: 'submit', revision: 1 }, a), 'submit');
  data(await ctx.edge.mutate('campaigns', 'ops.campaigns.transition', { id: made.id, action: 'approve', revision: 1 }, b), 'approve');
  const live = data(
    await ctx.edge.mutate('campaigns', 'ops.campaigns.transition', { id: made.id, action: 'activate', revision: 1 }, a),
    'activate',
  );
  expect(live.state).toBe('active');
  return live;
}

/** An airdrop's TEST definition: its pool shared by venue equity at `snapshotAt`. */
const airdrop = (name, pool, snapshotAt) => ({
  name,
  participation: { exclusions: [], regionScope: 'platform' },
  limits: { perCustomer: { count: 1, periodSeconds: 86_400 }, totalRedemptions: null },
  reward: null,
  type: 'distribution',
  rules: `TEST rules: join before the snapshot. The TEST ${ASSET} pool is shared by venue equity at the snapshot, paid to your connected wallet.`,
  startsAt: new Date(Date.now() - 60_000).toISOString(),
  endsAt: new Date(Date.now() + 7 * DAY).toISOString(),
  budget: pool === null ? null : { asset: ASSET, limit: pool },
  distribution: { kind: 'airdrop', snapshotAt, equityAsset: ASSET },
});

/** Basic verification through the verification room, granted by the stack's TEST reviewer. */
async function verifyBasic(page) {
  await page.goto('/verification');
  await page.getByLabel('Level to request').selectOption({ label: 'Basic' });
  await page.getByLabel('Country code').fill('DE');
  await page.getByRole('button', { name: 'Review request' }).click();
  await page.getByRole('button', { name: 'Submit this request' }).click();
  await expect(page.getByText('Your reviewed request')).toBeVisible();
  tool('local-test-gates.mjs', 'verify');
}

const walletKeyOf = (who) => keccak256(toHex(`intafaced TEST payout wallet ${J} ${RUN} ${who.handle}`));
const sheet = (page) => page.locator('[data-sheet="sign"]');

/** Connects the person's TEST wallet to their account on Wallet's Venue account tab, as svc-protocol records it. */
async function connectWallet(page, who, privateKey) {
  await installTestWallet(page, { chainId: CHAIN_ID, privateKey, rpcUrl: testChain().gateUrl });
  await signIn(page, who);
  await page.goto('/wallet');
  await page.getByRole('button', { name: 'Venue account', exact: true }).click();
  await expect(page).toHaveURL(/\/wallet\/venue$/);
  await page.getByRole('button', { name: `Connect ${TEST_WALLET.name}` }).click();
  await page.getByRole('button', { name: 'Connect to my account' }).click();
  await sheet(page).getByRole('button', { name: 'Continue in wallet' }).click();
  await expect(page.getByRole('heading', { name: 'Connected' })).toBeVisible();
}

/** A TEST person: signed up in Pro, basic verification, their own TEST wallet connected. */
async function trader(browser, prefix) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await chosePro(page);
  const who = await signUp(page, prefix);
  await verifyBasic(page);
  const key = walletKeyOf(who);
  const wallet = privateKeyToAccount(key).address.toLowerCase();
  fundOnTestChain(wallet, 'venue');
  const connecting = await (await browser.newContext()).newPage();
  await connectWallet(connecting, who, key);
  await connecting.context().close();
  await context.close();
  return { who, key, wallet };
}

/** One action through svc-trade's user-venue door as `p`, signed with their own TEST wallet: prepare, sign, submit. */
async function door(p, intent, actionKey) {
  const session = await api(p.who);
  const signer = { role: 'owner', address: p.wallet };
  const prepared = await session.post('/api/v1/venue/prepare', { owner: p.wallet, signer, intent, ...(actionKey ? { actionKey } : {}) });
  expect(prepared.status, JSON.stringify(prepared.body).slice(0, 400)).toBe(200);
  const t = prepared.body.prepared.typedData;
  const signature = await privateKeyToAccount(p.key).signTypedData({
    domain: t.domain,
    types: t.types,
    primaryType: t.primaryType,
    message: t.message,
  });
  const sent = await session.post('/api/v1/venue/submit', {
    actionKey: prepared.body.actionKey,
    signature: { digest: prepared.body.prepared.digest, signature, signedBy: p.wallet },
  });
  expect(sent.status, JSON.stringify(sent.body).slice(0, 400)).toBe(200);
  expect(sent.body.outcome, JSON.stringify(sent.body.outcome).slice(0, 400)).toMatchObject({ definite: true, accepted: true });
}

const venueId = async () => (await testVenue('/venue')).body.venue.id;
const venueAccount = async (p) => ({ venueId: await venueId(), owner: p.wallet, subAccount: null });

/** The person approves our builder fee through the door once, so their venue account is one they signed through us. */
async function signedThroughUs(p) {
  const status = (await (await api(p.who)).get('/api/v1/venue/status')).body;
  expect(status, JSON.stringify(status).slice(0, 300)).toMatchObject({ enabled: true, test: true });
  const markets = await testVenue('/markets', { account: null });
  const cap = markets.body.value.find((m) => m.symbol === 'BTC-USDC').builderFeeCapBps.value;
  await door(
    p,
    { kind: 'approve_builder_fee', builder: status.builder.address, maxFeeBps: cap },
    `approve-builder:${p.wallet}:${J}:${RUN}`,
  );
}

/** TEST funds on the person's own venue account, by the TEST venue's deposit control (each reference credits once). */
async function venueFunds(p, amount) {
  const funded = await testVenue('/test/deposit', {
    account: await venueAccount(p),
    asset: ASSET,
    amount,
    depositRef: `84532:${keccak256(toHex(`${J} ${RUN} ${p.wallet} ${amount} ${Date.now()}`))}:0`,
  });
  expect(funded.status, JSON.stringify(funded.body)).toBe(200);
}

const join = async (who, campaignId) => {
  const joined = await (await api(who)).post('/api/campaigns/trpc/participation.join', { campaignId });
  expect(joined.body?.result?.data?.created, JSON.stringify(joined.body).slice(0, 300)).toBe(true);
};

/** The person reads their own airdrop records: in their own request, their connected wallet is noted on their open shares. */
async function mine(who) {
  const res = await (
    await api(who)
  ).get(`/api/campaigns/trpc/distribution.mine?input=${encodeURIComponent(JSON.stringify({ kind: 'airdrop' }))}`);
  if (!res.body?.result) throw new Error(`distribution.mine refused (${res.status}): ${JSON.stringify(res.body).slice(0, 300)}`);
  return res.body.result.data.records;
}

/** The next send of one reward meets `fault` on the TEST chain, through svc-campaigns' signed TEST pay-fault door. */
async function payFault(rewardKey, fault) {
  const { ctx } = await operators();
  const raw = JSON.stringify({ rewardKey, fault });
  const res = await fetch(`${ctx.url('campaigns')}/internal/test/pay-fault`, {
    method: 'POST',
    redirect: 'error',
    headers: {
      'content-type': 'application/json',
      ...ctx.contracts.serviceAuthHeadersForBody('local-test-stack', ctx.secrets.internal, raw),
    },
    body: raw,
    signal: AbortSignal.timeout(30_000),
  });
  const answer = await res.json().catch(() => null);
  expect(res.status, JSON.stringify(answer)).toBe(200);
  expect(answer).toMatchObject({ rewardKey, fault, label: 'TEST' });
}

/** Waits until the airdrop's run has written every share; returns its plan. */
async function owedPlan(campaignId) {
  await expect.poll(async () => (await plan(campaignId)).state, { timeout: 240_000, intervals: [3_000] }).toBe('owed');
  return plan(campaignId);
}

async function rpc(method, params) {
  const res = await fetch(GATE_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
  return body.result;
}
const topic = (address) => `0x${address.slice(2).toLowerCase().padStart(64, '0')}`;

/** Every TEST USD transfer from `from` to `to`, read from the TEST chain's own logs (not from us). */
async function transfers(from, to) {
  const logs = await rpc('eth_getLogs', [
    { address: TOKEN_USD.address, fromBlock: '0x0', toBlock: 'latest', topics: [TRANSFER_TOPIC, topic(from), topic(to)] },
  ]);
  return logs.filter((l) => !l.removed).map((l) => ({ tx: l.transactionHash.toLowerCase(), value: BigInt(l.data) }));
}

/** TEST USD units (6 decimals) of a USDC decimal amount. */
function usdUnits(amount) {
  const [w, f = ''] = String(amount).split('.');
  return BigInt(w + f.padEnd(6, '0').slice(0, 6));
}

/** The founder console's payout board, signed in as founder A, optionally on one airdrop's plan. */
async function board(browser, planId = null) {
  const page = await (await browser.newContext()).newPage();
  await founderSignIn(page, 'a');
  await page.goto(`${ADMIN}/more-ops/campaigns/payouts${planId ? `?plan=${encodeURIComponent(planId)}` : ''}`);
  await expect(page.getByTestId('payout-board')).toBeVisible({ timeout: 30_000 });
  return page;
}
const boardRow = (page, rewardKey) => page.locator(`[data-testid="payout-row"][data-reward-key="${rewardKey}"]`);
const planRow = (page, accountId) => page.locator(`[data-testid="plan-account"][data-account="${accountId}"]`);

test(`${J} starts: rewards and an airdrop plan exist; some are pending or retrying`, async ({ browser }) => {
  test.setTimeout(900_000);
  run.reset({});
  // INTAFACED's TEST reward pot and rewards wallet: builder fees this file's own TEST sells earned us.
  const house = await trader(browser, 'jc19h');
  const fees = await funds.earnBuilderFees(house.who, 6);
  await funds.fundPotFromFees(`TEST-${J}-${tag}`, fees);
  await funds.claimOurBuilderFees();
  // Four TEST people, each with their own connected TEST wallet and a venue account they signed through us.
  const ann = await trader(browser, 'jc19a');
  const ben = await trader(browser, 'jc19b');
  const cat = await trader(browser, 'jc19c');
  const dan = await trader(browser, 'jc19d');
  for (const p of [ann, ben, cat, dan]) await signedThroughUs(p);
  await venueFunds(ann, ANN_EQUITY);
  await venueFunds(ben, BEN_EQUITY);
  await venueFunds(cat, CAT_FUNDS);
  await venueFunds(dan, DAN_FUNDS);
  // Five one-person airdrops, all at one snapshot, each to leave its payout in one state on the board.
  const snapshotAt = new Date(Date.now() + 75_000).toISOString();
  const made = {};
  for (const [name, who, pool] of [
    ['paid', ann, SMALL_POOL],
    ['failed', ann, SMALL_POOL],
    ['pending', ann, UNFUNDED_POOL],
    ['sending', ben, SMALL_POOL],
    ['owed', cat, SMALL_POOL],
  ]) {
    const c = await liveCampaign(airdrop(`TEST payouts ${name} ${tag}`, pool, snapshotAt));
    await join(who.who, c.id);
    made[name] = c.id;
  }
  // Each run owes its one share; nobody has read their records yet, so no share has a wallet to be paid to.
  const keys = {};
  for (const [name, id] of Object.entries(made)) {
    const p = await owedPlan(id);
    expect(p.accounts, JSON.stringify(p)).toHaveLength(1);
    keys[name] = p.accounts[0].rewardKey;
    expect(keys[name]).toBe(`distribution:${id}:${p.accounts[0].accountId}`);
  }
  // The faults each send meets on the TEST chain, set before any wallet is noted.
  await payFault(keys.paid, 'lost_after_broadcast');
  await payFault(keys.failed, 'revert');
  await payFault(keys.sending, 'unanswered');
  // ANN and BEN read their records, so their shares are paid to their connected wallets; CAT does not, so hers stays owed.
  await mine(ann.who);
  await mine(ben.who);
  run.write({ ann, ben, cat, dan, made, keys });
});

test(`${J} #1 opens the payout board: intents by state, owed, pending funding, sending, paid, failed, with their keys and chain transaction references`, async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const { ann, ben, cat, keys } = state('ann', 'ben', 'cat', 'keys');
  // The payer and the reconciler have each payout where it settles (read from the board's own service answer).
  const expected = { paid: 'paid', failed: 'failed', pending: 'pending_funding', sending: 'sending', owed: 'owed' };
  const boardOf = async () => {
    const rows = (await opsQuery('ops.payouts.board', {})).rows;
    return Object.fromEntries(Object.entries(keys).map(([name, key]) => [name, rows.find((r) => r.rewardKey === key)?.board ?? null]));
  };
  await expect.poll(boardOf, { timeout: 180_000, intervals: [3_000] }).toEqual(expected);
  const page = await board(browser);
  for (const [name, boardState] of Object.entries(expected)) {
    await expect(boardRow(page, keys[name]), `${name} row`).toHaveAttribute('data-board', boardState);
  }
  // Each state's count and section on the board.
  for (const s of ['owed', 'pending_funding', 'sending', 'paid', 'failed']) {
    const count = page.locator(`[data-testid="payout-count"][data-board="${s}"]`);
    await expect(count).toBeVisible();
    expect(Number(await count.getAttribute('data-count'))).toBeGreaterThanOrEqual(1);
  }
  for (const heading of ['Owed', 'Pending funding', 'Sending', 'Paid', 'Failed']) {
    await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
  }
  // Owed: CAT's share, owed from its budget with its ledger key, no payment, waiting for a connected wallet.
  const owed = boardRow(page, keys.owed);
  await expect(owed).toHaveAttribute('data-state', 'owed');
  await expect(owed).toHaveAttribute('data-reason', 'campaigns.no_connected_wallet');
  await expect(owed).toHaveAttribute('data-chain-tx', '');
  await expect(owed).toContainText(keys.owed);
  // Pending funding: nothing owed, nothing sent, the pot's refusal named.
  const pending = boardRow(page, keys.pending);
  await expect(pending).toHaveAttribute('data-state', 'pending_funding');
  await expect(pending).toHaveAttribute('data-reason', 'ledger.insufficient_funds');
  await expect(pending).toHaveAttribute('data-payment-state', '');
  await expect(pending).toContainText(keys.pending);
  // Sending: BEN's payment recorded and sent to his wallet, its answer lost; it is looked for on the chain, never sent again.
  const sending = boardRow(page, keys.sending);
  await expect(sending).toHaveAttribute('data-payment-state', 'sending');
  await expect(sending).toHaveAttribute('data-chain-tx', '');
  await expect(sending).toContainText(ben.wallet);
  await expect(sending).toContainText('Looked for on the chain');
  expect(await transfers(await rewardsWallet(), ben.wallet)).toEqual([]);
  // Paid: ANN's share, with the chain transaction that paid it and the ledger transaction that booked it.
  const paid = boardRow(page, keys.paid);
  const chainTx = await paid.getAttribute('data-chain-tx');
  expect(chainTx).toMatch(/^0x[0-9a-f]{64}$/);
  await expect(paid).toContainText(chainTx);
  await expect(paid).toContainText(ann.wallet);
  // Failed: the chain reverted ANN's other payment; its transaction is shown and it is never sent again.
  const failed = boardRow(page, keys.failed);
  await expect(failed).toHaveAttribute('data-payment-state', 'failed');
  await expect(failed).toHaveAttribute('data-reason', 'campaigns.reward_payment_reverted');
  const revertedTx = await failed.getAttribute('data-chain-tx');
  expect(revertedTx).toMatch(/^0x[0-9a-f]{64}$/);
  await expect(failed).toContainText(revertedTx);
  expect((await rpc('eth_getTransactionReceipt', [revertedTx])).status).toBe('0x0');
  run.write({ ...run.read(), paidTx: chainTx, cat });
});

/** Our TEST rewards wallet, read from the TEST chain's receipt of a payment it made. */
async function rewardsWallet() {
  const { paidTx } = run.read();
  if (paidTx) return (await chainReceipt(paidTx)).from;
  const { keys } = run.read();
  const rows = await opsQuery('ops.payouts.board', {});
  const paid = rows.rows.find((r) => r.rewardKey === keys?.paid && r.payment?.chainTx);
  if (!paid) throw new Error(`${J}: no payment yet to read our rewards wallet from`);
  return (await chainReceipt(paid.payment.chainTx)).from;
}

test(`${J} #2 a payout's chain send timed out after it was broadcast: the reconciler reads the chain by its reference, marks it paid once, the reservation moved to spent once; nothing sent again`, async ({
  browser,
}) => {
  const { ann, keys, paidTx } = state('ann', 'keys', 'paidTx');
  const { ctx, gates } = await operators();
  const page = await board(browser);
  const row = boardRow(page, keys.paid);
  await expect(row).toHaveAttribute('data-board', 'paid');
  await expect(row).toHaveAttribute('data-chain-tx', paidTx);
  const shown = (await opsQuery('ops.payouts.board', {})).rows.find((r) => r.rewardKey === keys.paid);
  // The send's answer was lost: logged unknown once, then owed once and paid once; never sent again.
  const outcomes = shown.attempts.map((a) => a.outcome);
  expect(outcomes.filter((o) => o === 'owed')).toHaveLength(1);
  expect(outcomes.filter((o) => o === 'paid')).toHaveLength(1);
  expect(shown.attempts.filter((a) => a.outcome === 'unknown').map((a) => a.reason)).toEqual(['campaigns.reward_send_unanswered']);
  expect(outcomes.indexOf('unknown')).toBeLessThan(outcomes.indexOf('paid'));
  await expect(row).toContainText('campaigns.reward_send_unanswered');
  // The chain shows exactly one transfer of the share from our rewards wallet to ANN's wallet: the one the reconciler found.
  const from = await rewardsWallet();
  const moved = (await transfers(from, ann.wallet)).filter((t) => t.value === usdUnits(SMALL_POOL));
  expect(moved).toEqual([{ tx: paidTx, value: usdUnits(SMALL_POOL) }]);
  expect(shown.payment).toMatchObject({ state: 'booked', chainTx: paidTx, toWallet: ann.wallet });
  // The ledger booked the payment once, under the chain transaction's own key: the reservation moved to spent.
  const booked = await gates.ledgerTrace(ctx, `campaigns:reward-paid:${paidTx}`);
  expect(booked).toMatchObject({ found: true, txId: shown.paidTxId });
  await expect(row).toContainText(shown.paidTxId);
  await expect(row).toContainText(shown.owedTxId);
});

test(`${J} #3 a commission payout meets rates not published: the row says so; nothing recorded as owed and nothing sent`, async ({
  browser,
}) => {
  const { ctx, pair } = await operators();
  const feeEventId = `TEST-${J}-${RUN}-${tag}-fee`;
  const refused = await ctx.edge.mutate('identity', 'affiliates.payout', { feeEventId }, await pair.a.tradeOpsToken());
  expect(refused.json?.error?.message ?? refused.text).toContain('affiliate.payout.rates_unset');
  const page = await board(browser);
  const row = page.locator(`[data-testid="payout-row"][data-kind="commission"][data-fee-event="${feeEventId}"]`);
  await expect(row).toHaveAttribute('data-reason', 'affiliate.payout.rates_unset', { timeout: 15_000 });
  await expect(row).toHaveAttribute('data-owed-tx', '');
  await expect(row).toHaveAttribute('data-chain-tx', '');
});

test(`${J} #4 replays a commission plan after a crash between sweep and payout: only the missing leg is paid; the budget is not swept twice; nobody paid twice on chain`, async ({
  browser,
}) => {
  const page = await board(browser);
  const replayed = page.locator('[data-testid="payout-row"][data-kind="commission"][data-replayed="true"]');
  await expect(replayed.first()).toBeVisible({ timeout: 15_000 });
  for (const row of await replayed.all()) {
    await expect(row).toHaveAttribute('data-sweeps', '1');
    await expect(row).toHaveAttribute('data-payments', '1');
  }
});

test(`${J} #5 builds an airdrop plan from a snapshot: a negative equity excluded, an unreadable one named and held out; shares add up to the pool; a blank pool or record date refuses`, async ({
  browser,
}) => {
  test.setTimeout(600_000);
  const { ann, ben, cat, dan } = state('ann', 'ben', 'cat', 'dan');
  const { ctx, pair } = await operators();
  const a = await pair.a.campaignsOpsToken();
  // A blank pool, and a blank record date, each refuse: neither can go live.
  for (const [name, pool, snapshotAt, code] of [
    ['no pool', null, new Date(Date.now() + 60_000).toISOString(), 'campaigns.budget_unset'],
    ['no record date', POOL, null, 'campaigns.distribution_unset'],
  ]) {
    const made = data(
      await ctx.edge.mutate('campaigns', 'ops.campaigns.create', airdrop(`TEST ${name} ${tag}`, pool, snapshotAt), a),
      'create',
    );
    const submit = await ctx.edge.mutate('campaigns', 'ops.campaigns.transition', { id: made.id, action: 'submit', revision: 1 }, a);
    expect(submit.status, submit.text.slice(0, 300)).toBe(412);
    expect(submit.json?.error?.message ?? submit.text).toContain(code);
  }
  // The airdrop: four people join before its snapshot.
  const snapshotAt = new Date(Date.now() + 75_000).toISOString();
  const drop = await liveCampaign(airdrop(`TEST settled airdrop ${tag}`, POOL, snapshotAt));
  for (const p of [ann, ben, cat, dan]) await join(p.who, drop.id);
  // Before the snapshot CAT's loss outruns her collateral (a TEST deficit), and the venue stops answering for DAN.
  const deficit = await testVenue('/test/deficit', {
    account: await venueAccount(cat),
    asset: ASSET,
    amount: CAT_DEFICIT,
    lossRef: `${J}:${RUN}:${tag}`,
  });
  expect(deficit.status, JSON.stringify(deficit.body)).toBe(200);
  const down = await testVenue('/test/account-switches', { owner: dan.wallet, down: true });
  expect(down.status, JSON.stringify(down.body)).toBe(200);
  try {
    // At the snapshot every account is read once; DAN's read is refused, so the run waits for him.
    await expect.poll(async () => (await plan(drop.id)).accounts.length, { timeout: 240_000, intervals: [3_000] }).toBe(4);
    const reading = await plan(drop.id);
    expect(reading.state).toBe('reading');
    const waiting = reading.accounts.filter((x) => x.standing === 'waiting');
    expect(waiting).toHaveLength(1);
    expect(waiting[0].reason).toBe(VENUE_DOWN);
    // The wait for him ends (aged through the TEST age door, his read still refused), and the plan is built.
    await ageRecord('campaigns', 'distribution', drop.id, 11 * 60_000);
    const page = await board(browser, drop.id);
    const shown = page.getByTestId('distribution-plan');
    await page.getByLabel('Reason').fill(`TEST ${J} build the plan`);
    await page.getByRole('button', { name: 'Run the distribution' }).click();
    await expect(page.getByTestId('distribution-run')).toBeVisible({ timeout: 60_000 });
    await expect(shown).toHaveAttribute('data-state', 'owed', { timeout: 60_000 });
    const built = await plan(drop.id);
    const of = (equity) => built.accounts.find((x) => x.equity === equity);
    const annRow = of(ANN_EQUITY);
    const benRow = of(BEN_EQUITY);
    const catRow = of(CAT_EQUITY);
    const danRow = built.accounts.find((x) => x.standing === 'held_out');
    expect(annRow).toMatchObject({ standing: 'counted', share: ANN_SHARE });
    expect(benRow).toMatchObject({ standing: 'counted', share: BEN_SHARE });
    expect(catRow).toMatchObject({ standing: 'excluded_negative', share: null, rewardKey: null });
    expect(danRow).toMatchObject({ equity: null, reason: VENUE_DOWN, share: null, rewardKey: null });
    expect(built).toMatchObject({ state: 'owed', pool: POOL, sharesTotal: POOL, totalEquity: '300' });
    expect(sumDecimal([annRow.share, benRow.share])).toBe(POOL);
    // On screen: CAT excluded for her negative equity, DAN named and held out with the venue's reason, the shares the pool.
    await expect(shown).toHaveAttribute('data-pool', POOL);
    await expect(shown).toHaveAttribute('data-shares-total', POOL);
    await expect(planRow(page, catRow.accountId)).toHaveAttribute('data-standing', 'excluded_negative');
    await expect(planRow(page, catRow.accountId)).toContainText('Excluded: negative equity');
    await expect(planRow(page, danRow.accountId)).toHaveAttribute('data-standing', 'held_out');
    await expect(planRow(page, danRow.accountId)).toContainText(`Held out: ${VENUE_DOWN}`);
    await expect(planRow(page, annRow.accountId)).toHaveAttribute('data-share', ANN_SHARE);
    await expect(planRow(page, benRow.accountId)).toHaveAttribute('data-share', BEN_SHARE);
    run.write({ ...run.read(), dropId: drop.id, annKey: annRow.rewardKey, benKey: benRow.rewardKey });
  } finally {
    await testVenue('/test/account-switches', { owner: dan.wallet, down: false });
  }
});

test(`${J} #6 runs and replays the distribution: the rest are paid once to their connected wallets and nobody twice`, async ({
  browser,
}) => {
  test.setTimeout(600_000);
  const { ann, ben, dropId, annKey, benKey } = state('ann', 'ben', 'dropId', 'annKey', 'benKey');
  // ANN and BEN read their records, so their shares are paid to their connected wallets.
  await mine(ann.who);
  await mine(ben.who);
  const page = await board(browser, dropId);
  for (const key of [annKey, benKey]) {
    await expect
      .poll(async () => (await plan(dropId)).accounts.find((x) => x.rewardKey === key)?.rewardState, {
        timeout: 240_000,
        intervals: [3_000],
      })
      .toBe('paid');
  }
  // Replayed twice by the operator: the run stands as it was and owes nothing more.
  for (const reason of ['replay', 'replay again']) {
    await page.reload();
    await page.getByLabel('Reason').fill(`TEST ${J} ${reason}`);
    await page.getByRole('button', { name: 'Run the distribution' }).click();
    const summary = page.getByTestId('distribution-run');
    await expect(summary).toBeVisible({ timeout: 60_000 });
    await expect(summary).toHaveAttribute('data-state', 'owed');
    await expect(summary).toHaveAttribute('data-shares-total', POOL);
  }
  await page.waitForTimeout(6_000); // two payer passes and a reconciler pass go by
  const after = await plan(dropId);
  expect(after).toMatchObject({ state: 'owed', sharesTotal: POOL });
  const from = await rewardsWallet();
  for (const [p, key, share] of [
    [ann, annKey, ANN_SHARE],
    [ben, benKey, BEN_SHARE],
  ]) {
    const acct = after.accounts.find((x) => x.rewardKey === key);
    expect(acct).toMatchObject({ rewardState: 'paid', share, toWallet: p.wallet });
    // Exactly one transfer of exactly the share to the person's wallet on the TEST chain, the one the plan names.
    const moved = (await transfers(from, p.wallet)).filter((t) => t.value === usdUnits(share));
    expect(moved).toEqual([{ tx: acct.chainTx, value: usdUnits(share) }]);
    const receipt = await chainReceipt(acct.chainTx);
    expect(receipt.transfers).toEqual([{ token: TOKEN_USD.address, from, to: p.wallet, value: usdUnits(share) }]);
    await page.reload();
    await expect(planRow(page, acct.accountId)).toHaveAttribute('data-chain-tx', acct.chainTx);
    await expect(planRow(page, acct.accountId)).toHaveAttribute('data-reward-state', 'paid');
  }
  // On the board, each share is paid once.
  const shown = (await opsQuery('ops.payouts.board', { campaignId: dropId })).rows;
  expect(shown.map((r) => [r.rewardKey, r.board]).sort()).toEqual(
    [
      [annKey, 'paid'],
      [benKey, 'paid'],
    ].sort(),
  );
  for (const r of shown) expect(r.attempts.filter((x) => x.outcome === 'paid')).toHaveLength(1);
});

test(`${J} #7 opens a commission whose builder fee was given back, then one whose fee entry was reversed: unpaid accruals cancelled; a paid one held for an operator, never pulled from the wallet`, async ({
  browser,
}) => {
  const page = await board(browser);
  const givenBack = page.locator('[data-testid="payout-row"][data-kind="commission"][data-cause="fee_given_back"]');
  const corrected = page.locator('[data-testid="payout-row"][data-kind="commission"][data-cause="fee_entry_reversed"]');
  await expect(givenBack.first()).toBeVisible({ timeout: 15_000 });
  await expect(corrected.first()).toBeVisible({ timeout: 15_000 });
  for (const row of [...(await givenBack.all()), ...(await corrected.all())]) {
    const paid = (await row.getAttribute('data-was-paid')) === 'true';
    await expect(row).toHaveAttribute('data-state', paid ? 'held_for_operator' : 'cancelled');
  }
});

test(`${J} #8 opens a reward whose earning activity was cancelled before it counted: cancelled with its reason, pending ones cancelled and budget released once; a paid one flagged for an operator`, async ({
  browser,
}) => {
  const page = await board(browser);
  const reversed = page.locator('[data-testid="payout-row"][data-cause="activity_cancelled"]');
  await expect(reversed.first()).toBeVisible({ timeout: 15_000 });
  for (const row of await reversed.all()) {
    const paid = (await row.getAttribute('data-was-paid')) === 'true';
    await expect(row).toHaveAttribute('data-state', paid ? 'paid' : 'cancelled');
    if (paid) await expect(row).toHaveAttribute('data-flagged', 'true');
    else await expect(row).toHaveAttribute('data-budget-released', '1');
  }
});
