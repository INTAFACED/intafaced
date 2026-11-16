// World: restart
import { createRequire } from 'node:module';
import path from 'node:path';
import { keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { test, expect } from './journey.mjs';
import { ADMIN, founderSignIn } from './admin.mjs';
import { chosePro, signIn, signUp } from './desk.mjs';
import { CHAIN_ID, TOKEN_USD, fundOnTestChain, testChain } from './dex.mjs';
import { ROOT, STACK_PORTS, api, journeyState, restartWith, staffFreeze, staffRestore, tool } from './stack.mjs';
import { installTestWallet, TEST_WALLET } from './test-wallet.mjs';
import { testVenue, venueForThisFile, venueRecord } from './venue.mjs';
import { chainReceipt, rewardFunds, sumDecimal } from './reward-funds.mjs';

// J-campaigns-18, in the running app (docs/roadmap/journeys.json): stop an abuser and review a flagged account. One test
// per step, titled "J-campaigns-18 #<n>", run in order. The operator is the stack's LOCAL TEST founder A on the founder
// console's risk review desk (/more-ops/campaigns/risk); founder B is the second person. The rewards are this run's TEST
// airdrop campaigns (made by the founders through svc-campaigns' operator doors: A creates and asks, B approves, A
// activates), each paid from INTAFACED's own TEST USDC reward pot, funded from builder fees the TEST venue credited us on
// this file's own sells (reward-funds.mjs), owed once and paid in TEST USDC to the person's own connected wallet on the
// stack's TEST chain, never credited to a balance (launch money model, OWNER 226 and 288).
//
// The world: ABE has a reward paid to their wallet (the first airdrop) and one owed and not yet paid (the second: ABE
// makes no reward read after it is owed, so no wallet is noted on it and the payer leaves it owed). Then the risk signals
// arrive through the desk's signal door: a shared device on ABE and OLI (sent twice), and a duplicate-account and an
// anti-churn signal on ABE alone. FRA is frozen by staff (svc-identity's freeze). The third airdrop then gives each of the
// three a share. The stack's labelled TEST owner values (tooling/profiles/test-owner-values/campaigns.json): two distinct
// signals hold an account's rewards for review, and the appeal window is 900 seconds.
const J = 'J-campaigns-18';
const RUN = process.env.JOURNEY_RUN_ID ?? 'local';
const run = journeyState(`${J}-${RUN}`);
const tag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.toLowerCase();
const ASSET = 'USDC';
const DAY = 86_400_000;
const POOL = '0.01';
const EQUITY = '100';

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
  return { ctx, pair };
}
const funds = rewardFunds({ J, RUN, operators });

const data = (res, what) => {
  const row = res.json?.result?.data;
  if (!row) throw new Error(`${what} refused (${res.status}): ${res.text.slice(0, 300)}`);
  return row;
};

/** svc-campaigns' own database role on the stack, to read what is stored. */
let pg;
async function campaignsDb() {
  if (pg) return pg;
  const c = (await operators()).ctx;
  const postgres = createRequire(path.join(ROOT, 'services', 'svc-campaigns', 'package.json'))('postgres');
  const port = c.marker.ports.postgres ?? STACK_PORTS.postgres;
  pg = postgres(`postgres://svc_campaigns:${encodeURIComponent(c.secrets.pgService)}@127.0.0.1:${port}/intafaced_local_test`, {
    max: 1,
    onnotice: () => {},
  });
  return pg;
}
test.afterAll(async () => {
  await pg?.end();
});

/** One reward row as svc-campaigns stores it. */
async function rewardRow(key) {
  const sql = await campaignsDb();
  const [row] = await sql`
    SELECT reward_key, campaign_id, account_id, amount::text AS amount, state, reason, pay_to_wallet, paid_chain_tx
    FROM campaigns.reward_intents WHERE reward_key = ${key}`;
  return row ?? null;
}

/** The ledger's decision record of a reward, as svc-campaigns keys it (payouts.ts `ledgerRewardId`). */
const rewardIdOf = (campaignId, rewardKey) => `campaign:${campaignId}:${rewardKey.replace(/[^A-Za-z0-9_:-]/g, '_').replaceAll(':', '-')}`;

/** One booked ledger transaction by its business key, as svc-ledger itself holds it (founder A, admin:treasury). */
async function ledgerTrace(businessKey) {
  const { ctx } = await operators();
  return gates.ledgerTrace(ctx, businessKey);
}

/** One TEST airdrop, live now, made by A, approved by B, activated by A; its snapshot `inMs` from now. */
async function liveAirdrop(name, inMs) {
  const { ctx, pair } = await operators();
  const a = await pair.a.campaignsOpsToken();
  const b = await pair.b.campaignsOpsToken();
  const snapshotAt = new Date(Date.now() + inMs).toISOString();
  const definition = {
    name,
    type: 'distribution',
    rules: `TEST rules: join before the snapshot. The TEST ${ASSET} pool is shared by venue equity at the snapshot, paid to your connected wallet.`,
    startsAt: new Date(Date.now() - 60_000).toISOString(),
    endsAt: new Date(Date.now() + 7 * DAY).toISOString(),
    participation: { exclusions: [], regionScope: 'platform' },
    limits: { perCustomer: { count: 1, periodSeconds: 86_400 }, totalRedemptions: null },
    reward: null,
    budget: { asset: ASSET, limit: POOL },
    distribution: { kind: 'airdrop', snapshotAt, equityAsset: ASSET },
  };
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

const join = async (who, campaignId) => {
  const joined = await (await api(who)).post('/api/campaigns/trpc/participation.join', { campaignId });
  expect(joined.body?.result?.data?.created, JSON.stringify(joined.body).slice(0, 300)).toBe(true);
};

/** The airdrop's share of one account, once written, read from the stored rows (no read by the person). */
async function shareOf(campaignId, accountId, { timeout = 240_000 } = {}) {
  const key = `distribution:${campaignId}:${accountId}`;
  await expect
    .poll(async () => (await rewardRow(key))?.state ?? 'none', { timeout, intervals: [3_000] })
    .not.toMatch(/^(none|qualified|posting)$/);
  return rewardRow(key);
}

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

const walletKeyOf = (who) => keccak256(toHex(`intafaced TEST risk wallet ${J} ${RUN} ${who.handle}`));
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

/** A TEST person: signed up in Pro, basic verification, their own TEST wallet connected, TEST USDC on their venue account. */
async function person(browser, prefix) {
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
  const p = { who, key, wallet };
  // Their venue account is one they signed through us: they approve our builder fee through the door once.
  const status = (await (await api(who)).get('/api/v1/venue/status')).body;
  expect(status, JSON.stringify(status).slice(0, 300)).toMatchObject({ enabled: true, test: true });
  const markets = await testVenue('/markets', { account: null });
  const cap = markets.body.value.find((m) => m.symbol === 'BTC-USDC').builderFeeCapBps.value;
  await door(p, { kind: 'approve_builder_fee', builder: status.builder.address, maxFeeBps: cap }, `approve-builder:${wallet}:${J}:${RUN}`);
  const venueId = (await testVenue('/venue')).body.venue.id;
  const funded = await testVenue('/test/deposit', {
    account: { venueId, owner: wallet, subAccount: null },
    asset: ASSET,
    amount: EQUITY,
    depositRef: `84532:${keccak256(toHex(`${J} ${RUN} ${wallet} ${Date.now()}`))}:0`,
  });
  expect(funded.status, JSON.stringify(funded.body)).toBe(200);
  const balances = await venueRecord(wallet, '/balances');
  expect(sumDecimal(balances.value.filter((b) => b.asset === ASSET).map((b) => b.total))).toBe(EQUITY);
  return p;
}

/** One action through svc-trade's user-venue door as `p`, signed with their own TEST wallet: prepare, sign, submit. */
async function door(p, intent, actionKey) {
  const session = await api(p.who);
  const signer = { role: 'owner', address: p.wallet };
  const prepared = await session.post('/api/v1/venue/prepare', { owner: p.wallet, signer, intent, actionKey });
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

/**
 * Joins `p` to the campaign and returns their account id as svc-campaigns names their reward rows
 * (`distribution:<campaign>:<id>`): the one participation the join added. Joins run one at a time.
 */
async function joinAs(p, campaignId) {
  const sql = await campaignsDb();
  const before = new Set(
    (await sql`SELECT account_id FROM campaigns.participations WHERE campaign_id = ${campaignId}`).map((r) => r.account_id),
  );
  await join(p.who, campaignId);
  const added = (await sql`SELECT account_id FROM campaigns.participations WHERE campaign_id = ${campaignId}`)
    .map((r) => r.account_id)
    .filter((id) => !before.has(id));
  expect(added).toHaveLength(1);
  return added[0];
}

/** The founder's risk review desk, signed in as founder `key`, on the queue or on one account's case. */
async function desk(browser, key, accountId = null) {
  const page = await (await browser.newContext()).newPage();
  const founder = await founderSignIn(page, key);
  await page.goto(`${ADMIN}/more-ops/campaigns/risk${accountId ? `?account=${encodeURIComponent(accountId)}` : ''}`);
  await expect(page.getByTestId('campaigns-risk')).toBeVisible({ timeout: 30_000 });
  return { page, founder };
}

const queueRow = (page, accountId) => page.locator(`[data-testid="risk-queue-row"][data-account="${accountId}"]`);
const rewardOnCase = (page, rewardKey) => page.locator(`[data-testid="risk-reward"][data-reward-key="${rewardKey}"]`);

test(`${J} starts: rewards are held for two accounts that share a device signal; an owed reward and a paid one belong to an abuser`, async ({
  browser,
}) => {
  test.setTimeout(1_800_000);
  run.reset({});
  // INTAFACED's TEST reward pot and rewards wallet: builder fees this file's own TEST sells earned us.
  const house = await person(browser, 'jc18h');
  const fees = await funds.earnBuilderFees(house.who, 6);
  await funds.fundPotFromFees(`TEST-${J}-${tag}`, fees);
  await funds.claimOurBuilderFees();
  const abe = await person(browser, 'jc18a');
  const oli = await person(browser, 'jc18o');
  const fra = await person(browser, 'jc18f');

  // The paid one: ABE's share of the first airdrop, paid once to ABE's own wallet.
  const first = await liveAirdrop(`TEST risk airdrop one ${tag}`, 75_000);
  abe.accountId = await joinAs(abe, first.id);
  const paidKey = `distribution:${first.id}:${abe.accountId}`;
  await expect
    .poll(
      async () => {
        // ABE's own read notes their connected wallet on the owed share, so the payer pays it.
        await (
          await api(abe.who)
        ).get(`/api/campaigns/trpc/distribution.mine?input=${encodeURIComponent(JSON.stringify({ kind: 'airdrop' }))}`);
        return (await rewardRow(paidKey))?.state ?? 'none';
      },
      { timeout: 360_000, intervals: [5_000] },
    )
    .toBe('paid');
  const paid = await rewardRow(paidKey);
  expect(paid).toMatchObject({ amount: expect.stringMatching(/^0\.01(0*)$/), pay_to_wallet: abe.wallet });
  const receipt = await chainReceipt(paid.paid_chain_tx);
  expect(receipt.transfers).toEqual([{ token: TOKEN_USD.address, from: receipt.from, to: abe.wallet, value: 10_000n }]);

  // The owed one: ABE's share of the second airdrop. ABE reads nothing after it, so it stays owed, not sent.
  const second = await liveAirdrop(`TEST risk airdrop two ${tag}`, 75_000);
  expect(await joinAs(abe, second.id)).toBe(abe.accountId);
  const owedKey = `distribution:${second.id}:${abe.accountId}`;
  const owed = await shareOf(second.id, abe.accountId);
  expect(owed).toMatchObject({ state: 'owed', pay_to_wallet: null });

  // The third airdrop: all three join before the signals and the freeze; its snapshot comes after both.
  const third = await liveAirdrop(`TEST risk airdrop three ${tag}`, 150_000);
  expect(await joinAs(abe, third.id)).toBe(abe.accountId);
  oli.accountId = await joinAs(oli, third.id);
  fra.accountId = await joinAs(fra, third.id);

  // The signals, through the desk's signal door (founder A). The shared device is sent twice.
  const { ctx, pair } = await operators();
  const a = await pair.a.campaignsOpsToken();
  const device = { kind: 'device', subject: `device:TEST-${tag}`, accountIds: [abe.accountId, oli.accountId], note: 'TEST shared device' };
  const sent = data(await ctx.edge.mutate('campaigns', 'ops.risk.signal', device, a), 'ops.risk.signal');
  expect(sent.recorded.every((r) => r.created)).toBe(true);
  const again = data(await ctx.edge.mutate('campaigns', 'ops.risk.signal', device, a), 'ops.risk.signal');
  expect(again.recorded.every((r) => !r.created)).toBe(true);
  for (const signal of [
    { kind: 'duplicate_account', subject: `dup:TEST-${tag}`, accountIds: [abe.accountId] },
    { kind: 'anti_churn', subject: `churn:TEST-${tag}`, accountIds: [abe.accountId] },
  ]) {
    data(await ctx.edge.mutate('campaigns', 'ops.risk.signal', signal, a), 'ops.risk.signal');
  }
  // FRA is frozen by staff; the freeze is svc-identity's.
  fra.userId = await staffFreeze(fra.who, `LOCAL TEST ${J} freeze ${tag}`);
  expect(fra.userId).toBe(fra.accountId);

  const heldKey = `distribution:${third.id}:${abe.accountId}`;
  const held = await shareOf(third.id, abe.accountId, { timeout: 360_000 });
  expect(held).toMatchObject({ state: 'review', reason: 'risk.review' });
  expect(await shareOf(third.id, oli.accountId)).toMatchObject({ state: 'owed' });
  expect(await shareOf(third.id, fra.accountId)).toMatchObject({ state: 'withheld', reason: 'account.frozen' });
  run.write({
    abe,
    oli,
    fra,
    first: first.id,
    second: second.id,
    third: third.id,
    paidKey,
    owedKey,
    heldKey,
    deviceSubject: device.subject,
  });
});

test(`${J} #1 opens the risk review queue: cases from duplicate-account, device and anti-churn signals; the same signal sent twice is one row`, async ({
  browser,
}) => {
  const { abe, oli, fra, deviceSubject } = state('abe', 'oli', 'fra', 'deviceSubject');
  const { page } = await desk(browser, 'a');
  await expect(page.getByTestId('risk-threshold')).toHaveAttribute('data-value', '2');
  const abeRow = queueRow(page, abe.accountId);
  await expect(abeRow).toHaveCount(1);
  await expect(abeRow).toHaveAttribute('data-kinds', 'anti_churn device duplicate_account');
  await expect(abeRow).toHaveAttribute('data-signals', '3');
  await expect(abeRow).toHaveAttribute('data-standing', 'held');
  const oliRow = queueRow(page, oli.accountId);
  await expect(oliRow).toHaveCount(1);
  await expect(oliRow).toHaveAttribute('data-kinds', 'device');
  // The device was sent twice: one stored row for each account it names, never two.
  const sql = await campaignsDb();
  const stored =
    await sql`SELECT account_id FROM campaigns.risk_signals WHERE kind = 'device' AND subject = ${deviceSubject} ORDER BY account_id`;
  expect(stored.map((r) => r.account_id)).toEqual([abe.accountId, oli.accountId].sort());
  await expect(oliRow).toHaveAttribute('data-signals', '1');
  // The frozen account is listed for its withheld reward.
  await expect(queueRow(page, fra.accountId)).toHaveAttribute('data-causes', 'account.frozen');
});

test(`${J} #2 opens the case for the first account: its reward intent is held, the other account untouched until its own signals pass the threshold; a blank threshold refuses`, async ({
  browser,
}) => {
  test.setTimeout(900_000);
  const { abe, oli, third, heldKey } = state('abe', 'oli', 'third', 'heldKey');
  const { page } = await desk(browser, 'a', abe.accountId);
  await expect(page.getByTestId('risk-case')).toHaveAttribute('data-standing', 'held');
  const heldRow = rewardOnCase(page, heldKey);
  await expect(heldRow).toHaveAttribute('data-state', 'review');
  await expect(heldRow).toHaveAttribute('data-reason', 'risk.review');
  // Held: nothing set aside or owed for it in the ledger.
  const rewardId = rewardIdOf(third, heldKey);
  expect(await ledgerTrace(`campaigns:owe:${rewardId}`)).toMatchObject({ found: false });
  // The other account, sharing the device, is below the threshold: its share of the same airdrop is owed as any other.
  const other = await desk(browser, 'a', oli.accountId);
  await expect(other.page.getByTestId('risk-case')).toHaveAttribute('data-standing', 'watching');
  const oliKey = `distribution:${third}:${oli.accountId}`;
  await expect(rewardOnCase(other.page, oliKey)).toHaveAttribute('data-state', 'owed');
  expect(await ledgerTrace(`campaigns:owe:${rewardIdOf(third, oliKey)}`)).toMatchObject({ found: true });

  // With the threshold blank, the control is not switched off: a new reward of an account with a signal waits, refused by
  // name, and nothing is owed for it; once the threshold is back, it is judged and owed (OLI is below it).
  restartWith('campaigns', 'LOCAL_STACK_CAMPAIGNS_RISK_THRESHOLD', false);
  let fourth;
  try {
    fourth = await liveAirdrop(`TEST risk airdrop four ${tag}`, 75_000);
    expect(await joinAs(oli, fourth.id)).toBe(oli.accountId);
    const blank = await desk(browser, 'a');
    await expect(blank.page.getByTestId('risk-threshold')).toHaveAttribute('data-value', '');
    await expect(blank.page.getByTestId('risk-threshold')).toContainText('Not set');
    await expect(queueRow(blank.page, oli.accountId)).toHaveAttribute('data-standing', 'unset');
    const waiting = await shareOf(fourth.id, oli.accountId, { timeout: 360_000 });
    expect(waiting).toMatchObject({ state: 'pending_retry', reason: 'campaigns.risk_threshold_unset' });
    const waitKey = `distribution:${fourth.id}:${oli.accountId}`;
    expect(await ledgerTrace(`campaigns:owe:${rewardIdOf(fourth.id, waitKey)}`)).toMatchObject({ found: false });
  } finally {
    restartWith('campaigns', 'LOCAL_STACK_CAMPAIGNS_RISK_THRESHOLD', true);
  }
  const waitKey = `distribution:${fourth.id}:${oli.accountId}`;
  await expect.poll(async () => (await rewardRow(waitKey))?.state, { timeout: 120_000, intervals: [3_000] }).toBe('owed');
});

test(`${J} #3 withholds a held reward: it stays withheld with its reservation; no ledger call`, async ({ browser }) => {
  test.setTimeout(300_000);
  const { abe, third, heldKey } = state('abe', 'third', 'heldKey');
  const { page } = await desk(browser, 'a', abe.accountId);
  await page.getByLabel('Reason').fill(`TEST ${J} shares a device with another account and duplicates a third`);
  const row = rewardOnCase(page, heldKey);
  await row.getByRole('button', { name: 'Withhold' }).click();
  await expect(row).toHaveAttribute('data-reason', 'risk.withheld');
  await expect(row).toHaveAttribute('data-state', 'review');
  await expect(page.locator('[data-testid="risk-action"][data-action="withhold"]')).toHaveCount(1);
  // Its reservation stays: the airdrop's budget still counts it as drawn.
  const sql = await campaignsDb();
  const [budget] = await sql`SELECT budget_drawn FROM campaigns.campaign_rows WHERE id = ${third}`;
  expect(Number(budget.budget_drawn)).toBeGreaterThan(0);
  const [kept] = await sql`SELECT amount::text AS amount FROM campaigns.reward_intents WHERE reward_key = ${heldKey} AND state = 'review'`;
  expect(kept).toBeTruthy();
  // No ledger call: nothing set aside, owed or reclaimed for it.
  const rewardId = rewardIdOf(third, heldKey);
  for (const key of [`campaigns:owe:${rewardId}`, `campaigns:reclaim:${rewardId}`]) {
    expect(await ledgerTrace(key)).toMatchObject({ found: false });
  }
});

test(`${J} #4 revokes the abuser's rewards: the owed one cancelled once; the paid one recorded and not pulled back; the account flagged`, async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const { abe, first, second, paidKey, owedKey } = state('abe', 'first', 'second', 'paidKey', 'owedKey');
  const { page, founder } = await desk(browser, 'a', abe.accountId);
  await page.getByLabel('Reason').fill(`TEST ${J} one person behind three accounts' signals`);
  await page.getByRole('button', { name: 'Revoke this account’s rewards' }).click();
  await expect(page.getByTestId('risk-case-flag')).toHaveAttribute('data-flagged', 'true');
  await expect(page.getByTestId('risk-revoked-by')).toHaveAttribute('data-actor', founder.userId);
  await expect(rewardOnCase(page, owedKey)).toHaveAttribute('data-state', 'cancelled');
  await expect(rewardOnCase(page, paidKey)).toHaveAttribute('data-state', 'paid');
  await expect(page.getByTestId('risk-paid-unrecoverable')).toHaveAttribute('data-amounts', '0.01 USDC');
  // Cancelled once, under `reclaim:`, for what was still owed: nothing owed is left for it.
  const owedId = rewardIdOf(second, owedKey);
  const reclaim = await ledgerTrace(`campaigns:reclaim:${owedId}`);
  expect(reclaim).toMatchObject({ found: true, module: 'campaigns' });
  const cancel = page.locator(`[data-testid="risk-action"][data-action="cancel"][data-reward-key="${owedKey}"]`);
  await expect(cancel).toHaveCount(1);
  await expect(cancel).toHaveAttribute('data-tx', reclaim.txId);
  // Revoked again: nothing more is cancelled or booked.
  await page.getByRole('button', { name: 'Revoke this account’s rewards' }).click();
  await expect(page.getByTestId('risk-revoked-by')).toHaveAttribute('data-actor', founder.userId);
  await expect(cancel).toHaveCount(1);
  expect((await ledgerTrace(`campaigns:reclaim:${owedId}`)).txId).toBe(reclaim.txId);
  // The paid one can't be pulled back: no reclaim for it, and the chain's one transfer to ABE's wallet stands.
  expect(await ledgerTrace(`campaigns:reclaim:${rewardIdOf(first, paidKey)}`)).toMatchObject({ found: false });
  const paid = await rewardRow(paidKey);
  expect(paid.state).toBe('paid');
  const receipt = await chainReceipt(paid.paid_chain_tx);
  expect(receipt.transfers).toEqual([{ token: TOKEN_USD.address, from: receipt.from, to: abe.wallet, value: 10_000n }]);
  // The cancelled one is never sent to the wallet.
  expect((await rewardRow(owedKey)).paid_chain_tx).toBeNull();
});

test(`${J} #5 an appeal is filed inside the window; a second person decides: the record shows both people; a blank window refuses disqualification`, async ({
  browser,
}) => {
  test.setTimeout(600_000);
  const { abe, oli } = state('abe', 'oli');
  // A blank appeal window refuses the disqualification, and nothing changes.
  restartWith('campaigns', 'LOCAL_STACK_CAMPAIGNS_APPEAL_WINDOW', false);
  try {
    const { page } = await desk(browser, 'a', oli.accountId);
    await expect(page.getByTestId('risk-appeal-window')).toHaveAttribute('data-value', '');
    await page.getByLabel('Reason').fill(`TEST ${J} blank window`);
    await page.getByRole('button', { name: 'Revoke this account’s rewards' }).click();
    await expect(page.getByTestId('risk-action-refused')).toHaveAttribute('data-code', 'campaigns.appeal_window_unset');
    await expect(page.getByTestId('risk-case-flag')).toHaveAttribute('data-flagged', 'false');
  } finally {
    restartWith('campaigns', 'LOCAL_STACK_CAMPAIGNS_APPEAL_WINDOW', true);
  }
  // ABE appeals, inside the window that started at the revocation.
  const me = await api(abe.who);
  const filed = await me.post('/api/campaigns/trpc/risk.appeal', { text: `TEST ${J}: these accounts are not mine, I share a laptop` });
  const mine = filed.body?.result?.data;
  expect(mine, JSON.stringify(filed.body).slice(0, 300)).toMatchObject({ flagged: true, appeal: { decidedBy: null, outcome: null } });
  expect(Date.parse(mine.appeal.filedAt)).toBeLessThan(Date.parse(mine.appealUntil));
  // The founder who revoked can't decide it.
  const first = await desk(browser, 'a', abe.accountId);
  await expect(first.page.getByTestId('risk-appeal')).toBeVisible();
  await first.page.getByLabel('Reason').fill(`TEST ${J} I revoked these`);
  await first.page.getByRole('button', { name: 'Decide the appeal' }).click();
  await expect(first.page.getByTestId('risk-action-refused')).toHaveAttribute('data-code', 'campaigns.appeal_same_person');
  // A second person decides; the record shows both.
  const second = await desk(browser, 'b', abe.accountId);
  await second.page.getByLabel('Outcome').selectOption('upheld');
  await second.page.getByLabel('Reason').fill(`TEST ${J} three signals stand`);
  await second.page.getByRole('button', { name: 'Decide the appeal' }).click();
  const appeal = second.page.getByTestId('risk-appeal');
  await expect(appeal).toHaveAttribute('data-outcome', 'upheld');
  await expect(appeal).toHaveAttribute('data-decided-by', second.founder.userId);
  await expect(second.page.getByTestId('risk-revoked-by')).toHaveAttribute('data-actor', first.founder.userId);
  expect(second.founder.userId).not.toBe(first.founder.userId);
  await expect(second.page.locator('[data-testid="risk-action"][data-action="appeal"]')).toHaveCount(1);
  await expect(
    second.page.locator(`[data-testid="risk-action"][data-action="appeal_decided"][data-actor="${second.founder.userId}"]`),
  ).toHaveCount(1);
});

test(`${J} #6 a frozen account earns: its intent is withheld and the case notes the cause (the freeze itself belongs to identity)`, async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const { fra, third } = state('fra', 'third');
  try {
    const { page } = await desk(browser, 'a', fra.accountId);
    await expect(page.getByTestId('risk-case-causes')).toHaveAttribute('data-causes', 'account.frozen');
    await expect(page.getByTestId('risk-case-causes')).toContainText('The freeze itself is identity’s');
    const key = `distribution:${third}:${fra.accountId}`;
    await expect(rewardOnCase(page, key)).toHaveAttribute('data-state', 'withheld');
    await expect(rewardOnCase(page, key)).toHaveAttribute('data-reason', 'account.frozen');
    // Nothing owed for it, and the desk has no freeze of its own.
    expect(await ledgerTrace(`campaigns:owe:${rewardIdOf(third, key)}`)).toMatchObject({ found: false });
    await expect(page.getByRole('button', { name: /freeze/i })).toHaveCount(0);
  } finally {
    await staffRestore(fra.userId, `LOCAL TEST ${J} freeze lifted`);
  }
});
