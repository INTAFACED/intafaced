import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDatabase, postgresAvailable, type TestDatabase } from '@intafaced/db/testing';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  CUSTODY_LAYER_OFF_CODE,
  LedgerError,
  MemoryLedger,
  movesCustomerBalance,
  parseAmount,
  recipes,
  rewardOwedAccount,
  rewardsEngine,
  userAvailable,
  type LedgerClient,
  type PostRequest,
  type RewardCeiling,
} from '@intafaced/ledger-client';
import type { CampaignParticipant } from '@intafaced/contracts';
import type { CampaignDefinitionInput, CampaignTasks } from '@intafaced/contracts/campaigns-catalogue';
import { CampaignService } from './campaigns.js';
import { PayoutSaga, ledgerRewardId } from './payouts.js';
import { RewardPayer, rewardsPaidToWallet, unitsOf, type RewardChain } from './reward-payer.js';
import { RISK_REVIEW, RISK_WITHHELD, RiskService, THRESHOLD_UNSET } from './risk.js';
import { TaskService } from './tasks.js';
import type { VenueDepositSource } from './venue-deposits.js';

/**
 * The risk review of campaign rewards (J-campaigns-18) against real Postgres, the in-memory reference ledger with the
 * custodial layer off, and an in-memory TEST chain. Every money test ends with the invariant: what the ledger owes for each
 * reward is exactly what the reward's row says is owed (owed or reclaiming: its amount; anything else: nothing), each
 * cancelled reward was reclaimed once under `campaigns:reclaim:`, a held or withheld reward never reached the ledger, and
 * no customer account holds anything.
 */

const adminUrl = process.env.TEST_DATABASE_URL?.trim();
if (!adminUrl && (process.env.REQUIRE_POSTGRES === '1' || process.env.CI === 'true' || process.env.CI === '1')) {
  throw new Error('TEST_DATABASE_URL is required');
}
const available = adminUrl ? await postgresAvailable(adminUrl) : false;
const drizzle = join(dirname(fileURLToPath(import.meta.url)), '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));
const db: TestDatabase | null =
  available && adminUrl ? await createTestDatabase({ url: adminUrl, service: 'campaigns', migrations }) : null;

afterAll(async () => {
  await db?.drop();
});

const A = 'operator-a';
const B = 'operator-b';
const ABUSER = '00000000-0000-4000-8000-0000000000a1';
const OTHER = '00000000-0000-4000-8000-0000000000a2';
const FROZEN_ONE = '00000000-0000-4000-8000-0000000000a3';
const FUNDER = '00000000-0000-4000-8000-0000000000c3';
const HOUR = 3_600_000;
const CEILING: RewardCeiling = { perCampaign: parseAmount('50'), total: parseAmount('100') };
const OURS = '0x00000000000000000000000000000000ce510001';
const WALLET_OF: Record<string, string> = {
  [ABUSER]: '0x1111111111111111111111111111111111111111',
  [OTHER]: '0x2222222222222222222222222222222222222222',
};
const WALLET = { walletId: 'test-chain:rewards', address: OURS, tokenDecimals: 6 };
const VENUE = 'test-venue-sim';
const WINDOW = 600;

const people = new Map<string, CampaignParticipant>();
const participants = { read: async (userId: string) => people.get(userId) ?? null };
const person = (userId: string, status: CampaignParticipant['status'] = 'active'): CampaignParticipant => ({
  userId,
  accountType: 'individual',
  region: 'DE',
  status,
  kycTier: 'full',
});

const STEPS: CampaignTasks = {
  steps: [{ title: 'TEST buy BTC', event: 'trade.fill', market: null, side: 'buy', count: 1, streakDays: null }],
  claimWindowSeconds: 3600,
  holdSeconds: 0,
  lock: null,
  kycGate: 'basic',
};
let names = 0;
const definition = (): CampaignDefinitionInput => ({
  name: `TEST risk campaign ${(names += 1)}`,
  type: 'task',
  rules: 'TEST rules',
  startsAt: new Date(Date.now() - HOUR).toISOString(),
  endsAt: new Date(Date.now() + 30 * 24 * HOUR).toISOString(),
  participation: { exclusions: [], regionScope: 'platform', restrictedRegions: null },
  budget: { asset: 'USDC', limit: '100' },
  limits: { perCustomer: { count: 100, periodSeconds: 86_400 }, totalRedemptions: null },
  reward: { asset: 'USDC', amount: '10' },
  tasks: STEPS,
});

function custodyOff(inner: MemoryLedger) {
  const mode = { loseNextReply: false, refuseReclaim: false, posts: [] as string[] };
  const ledger: LedgerClient = {
    post: async (request: PostRequest) => {
      if (movesCustomerBalance(request.entries)) throw new LedgerError('custody layer off', CUSTODY_LAYER_OFF_CODE);
      if (mode.refuseReclaim && request.idempotencyKey.startsWith('campaigns:reclaim:')) {
        throw new LedgerError('Ledger posting is frozen: TEST freeze', 'ledger.frozen');
      }
      const tx = await inner.post(request);
      mode.posts.push(request.idempotencyKey);
      if (mode.loseNextReply) {
        mode.loseNextReply = false;
        throw new Error('reply lost after the post landed');
      }
      return tx;
    },
    balance: (ref) => inner.balance(ref),
    balances: (t, id) => inner.balances(t, id),
    getTx: (id) => inner.getTx(id),
    getTxByKey: (key) => inner.getTxByKey(key),
  };
  return { ledger, mode };
}

/** An in-memory TEST chain that mines every transfer at once. */
function testChain() {
  const balances = new Map<string, bigint>();
  const transfers: { hash: string; from: string; to: string; units: bigint; block: bigint }[] = [];
  let block = 1n;
  let taken = 0;
  const chain: RewardChain = {
    head: async () => block,
    holds: async (from) => balances.get(from) ?? 0n,
    async send(from, to, units) {
      const hash = `0x${(taken += 1).toString(16).padStart(64, 'b')}`;
      block += 1n;
      balances.set(from, (balances.get(from) ?? 0n) - units);
      balances.set(to, (balances.get(to) ?? 0n) + units);
      transfers.push({ hash, from, to, units, block });
      return hash;
    },
    receipt: async (hash) => (transfers.some((t) => t.hash === hash) ? true : null),
    find: async (from, to, units, fromBlock) =>
      transfers.filter((t) => t.from === from && t.to === to && t.units === units && t.block >= fromBlock).map((t) => t.hash),
  };
  return { chain, balances, transfers };
}

let book: MemoryLedger;
let wire: ReturnType<typeof custodyOff>;
let world: ReturnType<typeof testChain>;
let tasks: TaskService;
let payer: RewardPayer;
let saga: PayoutSaga;
let clock: Date | null;
let campaigns: CampaignService;
const makeRisk = (over: { threshold?: number | null; window?: number | null } = {}) =>
  new RiskService({
    sql: db!.sql,
    ledger: wire.ledger,
    participants,
    threshold: over.threshold === undefined ? 2 : over.threshold,
    appealWindowSeconds: over.window === undefined ? WINDOW : over.window,
    now: () => clock ?? new Date(),
  });
let risk: RiskService;

let seeds = 0;
async function seed(engine: string, wallet: string) {
  const ref = `seed-${(seeds += 1)}`;
  await book.post(recipes.deposit({ userId: FUNDER, assetId: 'USDC', amount: parseAmount(engine), rail: 'test', railRef: ref }));
  await book.post(
    recipes.feeCharge({ chargeId: ref, userId: FUNDER, module: 'trade', mode: 'asset', assetId: 'USDC', amount: parseAmount(engine) }),
  );
  await book.post(recipes.sweepFeesToRewards({ windowId: ref, sourceModule: 'trade', assetId: 'USDC', amount: parseAmount(engine) }));
  const a = parseAmount(wallet);
  await book.post(
    recipes.builderFeeEarn({ venueId: VENUE, venueAccount: '0xowner', fillId: `f-${ref}`, assetId: 'USDC', amount: a, userId: FUNDER }),
  );
  await book.post(recipes.builderFeeReceive({ venueId: VENUE, claimId: ref, assetId: 'USDC', amount: a }));
  await book.post(
    recipes.ownFundsMove({
      from: { kind: 'venue-builder-account', venueId: VENUE },
      to: { kind: 'treasury-wallet', walletId: WALLET.walletId },
      assetId: 'USDC',
      amount: a,
      reference: `0x${ref}`,
    }),
  );
  world.balances.set(OURS, (world.balances.get(OURS) ?? 0n) + unitsOf(a, 6)!);
}

/** One TEST campaign, joined and completed by `who`, then claimed: the reward as the claim left it. */
async function earn(who: string, { forwarded = true } = {}) {
  const c = await campaigns.create({ definition: definition(), actor: A });
  await campaigns.transition({ id: c.id, action: 'submit', revision: 1, actor: A });
  await campaigns.transition({ id: c.id, action: 'approve', revision: 1, actor: B });
  await campaigns.transition({ id: c.id, action: 'activate', revision: 1, actor: A });
  await campaigns.join({ campaignId: c.id, accountId: who });
  await db!.sql`
    INSERT INTO campaigns.task_completions (campaign_id, account_id, completed_at) VALUES (${c.id}, ${who}, now())
    ON CONFLICT DO NOTHING`;
  const fwd: Record<string, string> = forwarded ? { 'x-intafaced-principal': who } : {};
  return (await tasks.claim({ campaignId: c.id, accountId: who, forwarded: fwd })).reward;
}

const rowOf = async (key: string) =>
  (
    await db!.sql<{ state: string; reason: string | null; campaign_id: string; amount: string }[]>`
      SELECT state, reason, campaign_id, amount::text AS amount FROM campaigns.reward_intents WHERE reward_key = ${key}`
  )[0]!;
const drawnOf = async (campaignId: string) =>
  parseAmount(
    (await db!.sql<{ budget_drawn: string }[]>`SELECT budget_drawn FROM campaigns.campaign_rows WHERE id = ${campaignId}`)[0]!.budget_drawn,
  );
const postsFor = (key: string, campaignId: string) =>
  wire.mode.posts.filter((k) => k.includes(key) || k.includes(ledgerRewardId(campaignId, key)));

async function invariant() {
  const rows = await db!.sql<{ reward_key: string; campaign_id: string; amount: string; state: string; account_id: string }[]>`
    SELECT reward_key, campaign_id, amount::text AS amount, state, account_id FROM campaigns.reward_intents`;
  for (const r of rows) {
    const rewardId = ledgerRewardId(r.campaign_id, r.reward_key);
    const owed = (await book.balance(rewardOwedAccount(rewardId))).amount;
    const reclaimed = await book.getTxByKey(`campaigns:reclaim:${rewardId}`);
    // Reclaiming: still owed, or reclaimed in the book with the answer lost; never anything in between.
    if (r.state === 'reclaiming') expect(owed, r.reward_key).toBe(reclaimed ? 0n : parseAmount(r.amount));
    else expect(owed, r.reward_key).toBe(r.state === 'owed' ? parseAmount(r.amount) : 0n);
    if (r.state === 'owed') expect(reclaimed, r.reward_key).toBeFalsy();
    const reclaims = wire.mode.posts.filter((k) => k === `campaigns:reclaim:${rewardId}`);
    if (r.state === 'cancelled') expect(reclaims.length, r.reward_key).toBeGreaterThanOrEqual(1);
    if (['review', 'withheld', 'pending_retry'].includes(r.state)) expect(postsFor(r.reward_key, r.campaign_id), r.reward_key).toEqual([]);
    expect((await book.balance(userAvailable(r.account_id, 'USDC'))).amount).toBe(0n);
  }
  // Each reward was reclaimed once at most in the book, whatever was posted again.
  for (const key of new Set(wire.mode.posts.filter((k) => k.startsWith('campaigns:reclaim:')))) {
    expect(await book.getTxByKey(key)).toBeTruthy();
  }
  expect(book.reconcile()).toEqual({ ok: true });
}

if (!db) {
  describe.skip('risk review (Postgres unavailable)', () => {
    it('skipped', () => undefined);
  });
} else {
  describe('the risk review of campaign rewards (Postgres)', () => {
    beforeEach(async () => {
      await db.sql`TRUNCATE campaigns.risk_reclaims, campaigns.risk_actions, campaigns.risk_appeals, campaigns.risk_cases,
        campaigns.risk_signals, campaigns.reward_payments, campaigns.redemption_attempts, campaigns.reward_intents,
        campaigns.task_progress, campaigns.task_completions, campaigns.pot_fundings, campaigns.participations,
        campaigns.eligibility_reviews, campaigns.audit_log, campaigns.campaigns CASCADE`;
      people.clear();
      for (const id of [ABUSER, OTHER]) people.set(id, person(id));
      people.set(FROZEN_ONE, person(FROZEN_ONE, 'frozen'));
      book = new MemoryLedger();
      wire = custodyOff(book);
      world = testChain();
      clock = null;
      campaigns = new CampaignService({ sql: db.sql, timeZone: () => 'UTC', participants });
      risk = makeRisk();
      saga = new PayoutSaga({ sql: db.sql, ledger: wire.ledger, reconcileAfterSeconds: 1, rewardCeiling: CEILING, gate: risk });
      risk.useSaga(saga);
      const wallets: VenueDepositSource = {
        wallets: async (forwarded) => {
          const who = forwarded['x-intafaced-principal'];
          return who && WALLET_OF[who] ? [WALLET_OF[who]!] : null;
        },
        deposits: async () => null,
      };
      tasks = new TaskService({
        sql: db.sql,
        participants,
        saga,
        markets: null,
        timeZone: () => 'UTC',
        rollbackWindowSeconds: 86_400,
        venueDeposits: wallets,
        rewardsPaidTo: rewardsPaidToWallet(db.sql),
        now: () => clock ?? new Date(),
      });
      payer = new RewardPayer({
        sql: db.sql,
        ledger: wire.ledger,
        chain: world.chain,
        wallet: WALLET,
        postingEnabled: async () => true,
        now: () => clock ?? new Date(),
      });
      await seed('100', '100');
    });

    it('stores a signal once; each account is judged on its own signals; a blank threshold waits, never pays (#1 #2)', async () => {
      const device = { kind: 'device' as const, subject: 'device:TEST-1', accountIds: [ABUSER, OTHER] };
      expect((await risk.recordSignal(device, A)).recorded).toEqual([
        { accountId: ABUSER, created: true },
        { accountId: OTHER, created: true },
      ]);
      // The same signal again is the same row.
      expect((await risk.recordSignal(device, B)).recorded.every((r) => !r.created)).toBe(true);
      expect((await db.sql`SELECT 1 FROM campaigns.risk_signals`).length).toBe(2);
      await risk.recordSignal({ kind: 'duplicate_account', subject: 'dup:TEST-1', accountIds: [ABUSER] }, A);
      const queue = await risk.queue();
      expect(queue.rows.find((r) => r.accountId === ABUSER)).toMatchObject({ standing: 'held', signals: 2 });
      expect(queue.rows.find((r) => r.accountId === OTHER)).toMatchObject({ standing: 'watching', signals: 1 });
      // At the threshold: held for review with its budget place, nothing posted. Below it: owed as usual.
      const held = await earn(ABUSER);
      const heldRow = await rowOf(held.rewardKey);
      expect(heldRow).toMatchObject({ state: 'review', reason: RISK_REVIEW });
      expect(postsFor(held.rewardKey, heldRow.campaign_id)).toEqual([]);
      expect(await drawnOf(heldRow.campaign_id)).toBe(parseAmount('10'));
      const untouched = await earn(OTHER);
      expect((await rowOf(untouched.rewardKey)).state).toBe('owed');
      // A blank threshold: an account with any signal waits, refused by name; one with none is owed.
      risk = makeRisk({ threshold: null });
      saga = new PayoutSaga({ sql: db.sql, ledger: wire.ledger, reconcileAfterSeconds: 1, rewardCeiling: CEILING, gate: risk });
      tasks = new TaskService({ sql: db.sql, participants, saga, markets: null, timeZone: () => 'UTC', rollbackWindowSeconds: 86_400 });
      const waiting = await earn(OTHER, { forwarded: false });
      const waitRow = await rowOf(waiting.rewardKey);
      expect(waitRow).toMatchObject({ state: 'pending_retry', reason: THRESHOLD_UNSET });
      expect(postsFor(waiting.rewardKey, waitRow.campaign_id)).toEqual([]);
      expect((await risk.queue()).rows.find((r) => r.accountId === OTHER)?.standing).toBe('unset');
      // The reconciler's retries keep it waiting with one log line, never paid.
      await new Promise((r) => setTimeout(r, 1_100));
      await saga.reconcile();
      expect((await rowOf(waiting.rewardKey)).state).toBe('pending_retry');
      const lines =
        await db.sql`SELECT 1 FROM campaigns.redemption_attempts WHERE reward_key = ${waiting.rewardKey} AND reason = ${THRESHOLD_UNSET}`;
      expect(lines.length).toBe(1);
      await invariant();
    });

    it('withholds a held reward with its reservation and no ledger call; a reward not held refuses (#3)', async () => {
      await risk.recordSignal({ kind: 'device', subject: 'device:TEST-2', accountIds: [ABUSER] }, A);
      await risk.recordSignal({ kind: 'anti_churn', subject: 'churn:TEST-2', accountIds: [ABUSER] }, A);
      const held = await earn(ABUSER);
      const before = [...wire.mode.posts];
      const c = await risk.withhold({ rewardKey: held.rewardKey, reason: 'TEST shares a device', actor: A });
      expect(c.rewards.find((r) => r.rewardKey === held.rewardKey)).toMatchObject({ state: 'review', reason: RISK_WITHHELD });
      // Again: the same, one action.
      await risk.withhold({ rewardKey: held.rewardKey, reason: 'TEST again', actor: B });
      expect((await risk.caseOf(ABUSER)).actions.filter((a) => a.action === 'withhold')).toHaveLength(1);
      expect(wire.mode.posts).toEqual(before);
      expect(await drawnOf((await rowOf(held.rewardKey)).campaign_id)).toBe(parseAmount('10'));
      // Released by nothing: no hold time, no reconciler.
      await tasks.releaseHolds();
      await saga.reconcile();
      expect((await rowOf(held.rewardKey)).state).toBe('review');
      people.set(OTHER, person(OTHER));
      const owed = await earn(OTHER);
      await expect(risk.withhold({ rewardKey: owed.rewardKey, reason: 'TEST', actor: A })).rejects.toMatchObject({
        code: 'campaigns.risk_reward_not_held',
      });
      await invariant();
    });

    it('revokes: an owed reward cancelled once, a paid one recorded and never pulled back, the account flagged (#4)', async () => {
      const paid = await earn(ABUSER);
      expect(await payer.pass()).toEqual({ sent: 1, paid: 1 });
      expect((await rowOf(paid.rewardKey)).state).toBe('paid');
      const owed = await earn(ABUSER, { forwarded: false });
      expect((await rowOf(owed.rewardKey)).state).toBe('owed');
      await risk.recordSignal({ kind: 'device', subject: 'device:TEST-3', accountIds: [ABUSER] }, A);
      await risk.recordSignal({ kind: 'duplicate_account', subject: 'dup:TEST-3', accountIds: [ABUSER] }, A);
      // A blank appeal window refuses the disqualification, and nothing changes.
      await expect(makeRisk({ window: null }).revoke({ accountId: ABUSER, reason: 'TEST abuse', actor: A })).rejects.toMatchObject({
        code: 'campaigns.appeal_window_unset',
      });
      expect((await rowOf(owed.rewardKey)).state).toBe('owed');
      expect((await risk.caseOf(ABUSER)).flagged).toBe(false);
      const engineBefore = (await book.balance(rewardsEngine('USDC'))).amount;
      const c = await risk.revoke({ accountId: ABUSER, reason: 'TEST abuse', actor: A });
      expect(c).toMatchObject({ flagged: true, revokedBy: A, paidUnrecoverable: [{ asset: 'USDC', amount: '10' }] });
      expect(c.rewards.find((r) => r.rewardKey === owed.rewardKey)?.state).toBe('cancelled');
      expect(c.rewards.find((r) => r.rewardKey === paid.rewardKey)?.state).toBe('paid');
      const rewardId = ledgerRewardId((await rowOf(owed.rewardKey)).campaign_id, owed.rewardKey);
      expect(wire.mode.posts.filter((k) => k === `campaigns:reclaim:${rewardId}`)).toHaveLength(1);
      expect((await book.balance(rewardsEngine('USDC'))).amount - engineBefore).toBe(parseAmount('10'));
      // Revoked again: nothing more posted, one record of each.
      const again = await risk.revoke({ accountId: ABUSER, reason: 'TEST again', actor: B });
      expect(again.revokedBy).toBe(A);
      expect(wire.mode.posts.filter((k) => k.startsWith('campaigns:reclaim:'))).toHaveLength(1);
      expect(again.actions.filter((a) => a.action === 'cancel')).toHaveLength(1);
      expect(again.actions.filter((a) => a.action === 'record_paid')).toHaveLength(1);
      // A cancelled reward holds nothing of its budget and is never paid.
      expect(await drawnOf((await rowOf(owed.rewardKey)).campaign_id)).toBe(0n);
      expect(await payer.pass()).toEqual({ sent: 0, paid: 0 });
      expect(world.transfers).toHaveLength(1);
      await invariant();
    });

    it('a reclaim whose answer is lost or refused stays reclaiming, is never paid, and posts the same key once it can (#4)', async () => {
      const owed = await earn(ABUSER, { forwarded: false });
      await risk.recordSignal({ kind: 'device', subject: 'device:TEST-4', accountIds: [ABUSER] }, A);
      wire.mode.loseNextReply = true;
      await risk.revoke({ accountId: ABUSER, reason: 'TEST abuse', actor: A });
      expect((await rowOf(owed.rewardKey)).state).toBe('reclaiming');
      // Its wallet is known now, and the payer runs: a reward being reclaimed is never paid.
      await tasks.recordPayTo(ABUSER, { 'x-intafaced-principal': ABUSER });
      expect(await payer.pass()).toEqual({ sent: 0, paid: 0 });
      await invariant();
      await risk.revoke({ accountId: ABUSER, reason: 'TEST again', actor: A });
      expect((await rowOf(owed.rewardKey)).state).toBe('cancelled');
      // Booked once: the second post under the same key returned the first transaction.
      const rewardId = ledgerRewardId((await rowOf(owed.rewardKey)).campaign_id, owed.rewardKey);
      expect(wire.mode.posts.filter((k) => k === `campaigns:reclaim:${rewardId}`)).toHaveLength(2);
      expect((await book.balance(rewardOwedAccount(rewardId))).amount).toBe(0n);
      // Refused (the platform posting freeze): it stays reclaiming with the reason, and nothing moves.
      const second = await earn(ABUSER, { forwarded: false });
      wire.mode.refuseReclaim = true;
      await risk.revoke({ accountId: ABUSER, reason: 'TEST', actor: A });
      expect((await rowOf(second.rewardKey)).state).toBe('reclaiming');
      const [rc] = await db.sql<
        { state: string; reason: string }[]
      >`SELECT state, reason FROM campaigns.risk_reclaims WHERE reward_key = ${second.rewardKey}`;
      expect(rc).toEqual({ state: 'refused', reason: 'ledger.frozen' });
      await invariant();
      wire.mode.refuseReclaim = false;
      await risk.revoke({ accountId: ABUSER, reason: 'TEST', actor: A });
      expect((await rowOf(second.rewardKey)).state).toBe('cancelled');
      await invariant();
    });

    it('a reward whose payment the payer recorded first is the payer’s: revoking leaves it, and it is paid once (#4)', async () => {
      const owed = await earn(ABUSER);
      await risk.recordSignal({ kind: 'device', subject: 'device:TEST-5', accountIds: [ABUSER] }, A);
      // The payer records its payment, and the revocation comes in before it is booked.
      await db.sql`
        INSERT INTO campaigns.reward_payments (reward_key, from_place, to_wallet, asset, amount, units, from_block, sent_at)
        VALUES (${owed.rewardKey}, ${WALLET.walletId}, ${WALLET_OF[ABUSER]!}, 'USDC', 10, 10000000, 1, now())`;
      await risk.revoke({ accountId: ABUSER, reason: 'TEST abuse', actor: A });
      expect((await rowOf(owed.rewardKey)).state).toBe('owed');
      expect(wire.mode.posts.filter((k) => k.startsWith('campaigns:reclaim:'))).toEqual([]);
      await invariant();
    });

    it('an appeal is filed inside the window and decided by a second person; overturned, a held reward is released (#5)', async () => {
      await risk.recordSignal({ kind: 'device', subject: 'device:TEST-6', accountIds: [ABUSER] }, A);
      await risk.recordSignal({ kind: 'anti_churn', subject: 'churn:TEST-6', accountIds: [ABUSER] }, A);
      const held = await earn(ABUSER, { forwarded: false });
      await expect(risk.appeal({ accountId: ABUSER, text: 'TEST I am one person' })).rejects.toMatchObject({
        code: 'campaigns.appeal_not_open',
      });
      const revoked = await risk.revoke({ accountId: ABUSER, reason: 'TEST abuse', actor: A });
      const mine = await risk.appeal({ accountId: ABUSER, text: 'TEST I am one person' });
      expect(mine.appeal).toMatchObject({ text: 'TEST I am one person', decidedBy: null });
      // Filed again: the first stands.
      expect((await risk.appeal({ accountId: ABUSER, text: 'TEST a second text' })).appeal?.text).toBe('TEST I am one person');
      await expect(risk.decideAppeal({ accountId: ABUSER, outcome: 'upheld', reason: 'TEST', actor: A })).rejects.toMatchObject({
        code: 'campaigns.appeal_same_person',
      });
      const decided = await risk.decideAppeal({ accountId: ABUSER, outcome: 'overturned', reason: 'TEST one person', actor: B });
      expect(decided).toMatchObject({ revokedBy: A, flagged: false, appeal: { decidedBy: B, outcome: 'overturned' } });
      // Released: the account passes its check now, and the reward is owed.
      expect((await rowOf(held.rewardKey)).state).toBe('owed');
      await expect(risk.decideAppeal({ accountId: ABUSER, outcome: 'upheld', reason: 'TEST', actor: B })).rejects.toMatchObject({
        code: 'campaigns.appeal_not_open',
      });
      // Outside the window: refused.
      await risk.recordSignal({ kind: 'device', subject: 'device:TEST-6', accountIds: [OTHER] }, A);
      await risk.revoke({ accountId: OTHER, reason: 'TEST abuse', actor: A });
      clock = new Date(Date.parse(revoked.appealUntil!) + WINDOW * 1000 + 1000);
      await expect(risk.appeal({ accountId: OTHER, text: 'TEST too late now' })).rejects.toMatchObject({
        code: 'campaigns.appeal_window_closed',
      });
      await invariant();
    });

    it('a frozen account’s reward is withheld with the cause on its case, nothing owed (#6)', async () => {
      expect(await risk.judge(FROZEN_ONE)).toEqual({ kind: 'withhold', reason: 'account.frozen' });
      // A reward written for it (as an airdrop share is) and attempted by the saga.
      const [c] = await db.sql<{ id: string }[]>`SELECT id FROM campaigns.campaigns LIMIT 1`;
      const made = c ? c.id : (await campaigns.create({ definition: definition(), actor: A })).id;
      const key = `task:${made}:${FROZEN_ONE}:once`;
      await db.sql`
        INSERT INTO campaigns.reward_intents (reward_key, campaign_id, account_id, period, asset, amount, state, form)
        VALUES (${key}, ${made}, ${FROZEN_ONE}, 'once', 'USDC', 1, 'qualified', 'paid')`;
      await saga.attempt(key);
      expect(await rowOf(key)).toMatchObject({ state: 'withheld', reason: 'account.frozen' });
      expect(postsFor(key, made)).toEqual([]);
      expect((await risk.queue()).rows.find((r) => r.accountId === FROZEN_ONE)).toMatchObject({ causes: ['account.frozen'] });
      expect((await risk.caseOf(FROZEN_ONE)).causes).toEqual(['account.frozen']);
      // Identity unread: it waits, never owed.
      people.delete(OTHER);
      expect(await risk.judge(OTHER)).toEqual({ kind: 'wait', reason: 'campaigns.participant_unread' });
      await invariant();
    });
  });
}
