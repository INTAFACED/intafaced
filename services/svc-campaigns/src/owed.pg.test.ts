import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDatabase, postgresAvailable, type TestDatabase } from '@intafaced/db/testing';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  CUSTODY_LAYER_OFF_CODE,
  LedgerError,
  MemoryLedger,
  campaignBudgetAccount,
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
import { PAYOUT_UNAVAILABLE, PayoutSaga, ledgerRewardId } from './payouts.js';
import { TaskService, rewardKeyOf } from './tasks.js';

/**
 * The launch reward path against real Postgres and the in-memory reference ledger (launch money model, OWNER 288;
 * J-campaigns-03 #2 #4 #5): a USDC reward is owed by INTAFACED from its campaign's budget, never credited to a customer
 * balance. The ledger here refuses every post that touches a customer account, as svc-ledger does with the custodial
 * layer off. Every money test ends with the invariant: what the owed intents say is exactly what the ledger owes, under
 * one Owe key each, the budgets set aside exactly that, and no customer account holds anything.
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
const ME = '00000000-0000-4000-8000-0000000000a1';
const YOU = '00000000-0000-4000-8000-0000000000b2';
const FUNDER = '00000000-0000-4000-8000-0000000000c3';
const HOUR = 3_600_000;
const CEILING: RewardCeiling = { perCampaign: parseAmount('15'), total: parseAmount('25') };

const people = new Map<string, CampaignParticipant>();
const participants = { read: async (userId: string) => people.get(userId) ?? null };
const person = (userId: string): CampaignParticipant => ({
  userId,
  accountType: 'individual',
  region: 'DE',
  status: 'active',
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
const definition = (over: Partial<CampaignDefinitionInput> = {}): CampaignDefinitionInput => ({
  name: `TEST owed campaign ${(names += 1)}`,
  type: 'task',
  rules: 'TEST rules',
  startsAt: new Date(Date.now() - HOUR).toISOString(),
  endsAt: new Date(Date.now() + 30 * 24 * HOUR).toISOString(),
  participation: { exclusions: [], regionScope: 'platform', restrictedRegions: null },
  budget: { asset: 'USDC', limit: '100' },
  limits: { perCustomer: { count: 100, periodSeconds: 86_400 }, totalRedemptions: null },
  reward: { asset: 'USDC', amount: '10' },
  tasks: STEPS,
  ...over,
});

const campaigns = () => new CampaignService({ sql: db!.sql, timeZone: () => 'UTC', participants });
async function joined(over: Partial<CampaignDefinitionInput> = {}, who = ME) {
  const s = campaigns();
  const c = await s.create({ definition: definition(over), actor: A });
  await s.transition({ id: c.id, action: 'submit', revision: 1, actor: A });
  await s.transition({ id: c.id, action: 'approve', revision: 1, actor: B });
  await s.transition({ id: c.id, action: 'activate', revision: 1, actor: A });
  await s.join({ campaignId: c.id, accountId: who });
  return c;
}

/** svc-ledger with the custodial layer off: a post that touches a customer account is refused; `frozen` refuses all. */
function custodyOff(inner: MemoryLedger) {
  const mode = { frozen: false, loseNextReply: false, posts: [] as string[] };
  const ledger: LedgerClient = {
    post: async (request: PostRequest) => {
      if (mode.frozen) throw new LedgerError('Ledger posting is frozen: TEST freeze', 'ledger.frozen');
      if (movesCustomerBalance(request.entries)) throw new LedgerError('custody layer off', CUSTODY_LAYER_OFF_CODE);
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

let book: MemoryLedger;
let wire: ReturnType<typeof custodyOff>;
let tasks: TaskService;
let saga: PayoutSaga;
let clock: Date | null = null;

function wireUp(ceiling: RewardCeiling | undefined) {
  saga = new PayoutSaga({ sql: db!.sql, ledger: wire.ledger, reconcileAfterSeconds: 1, rewardCeiling: ceiling });
  tasks = new TaskService({
    sql: db!.sql,
    participants,
    saga,
    markets: null,
    timeZone: () => 'UTC',
    rollbackWindowSeconds: 86_400,
    now: () => clock ?? new Date(),
  });
}

/** TEST USDC in the rewards engine, set up on the reference book directly: fees a TEST customer paid, swept in. */
let seeds = 0;
async function seedRewardsEngine(amount: string) {
  const ref = `seed-${(seeds += 1)}`;
  await book.post(recipes.deposit({ userId: FUNDER, assetId: 'USDC', amount: parseAmount(amount), rail: 'test', railRef: ref }));
  await book.post(
    recipes.feeCharge({ chargeId: ref, userId: FUNDER, module: 'trade', mode: 'asset', assetId: 'USDC', amount: parseAmount(amount) }),
  );
  await book.post(recipes.sweepFeesToRewards({ windowId: ref, sourceModule: 'trade', assetId: 'USDC', amount: parseAmount(amount) }));
}

/** Every step done (task_progress.pg covers counting them from events; here only the claim and its money matter). */
async function complete(campaignId: string, who = ME) {
  await db!.sql`
    INSERT INTO campaigns.task_completions (campaign_id, account_id, completed_at) VALUES (${campaignId}, ${who}, now())
    ON CONFLICT DO NOTHING`;
}

async function reconcileLater() {
  await db!.sql`UPDATE campaigns.reward_intents SET last_attempt_at = now() - interval '1 minute' WHERE last_attempt_at IS NOT NULL`;
  return saga.reconcile();
}

const owedOnBook = async (key: string) => (await book.balance(rewardOwedAccount(ledgerRewardId(key)))).amount;

/** The invariant: owed intents equal the ledger's owed pots, one Owe key each; budgets are spent to zero; no customer holds anything. */
async function reconciles() {
  const rows = await db!.sql<{ reward_key: string; campaign_id: string; account_id: string; amount: string; state: string }[]>`
    SELECT reward_key, campaign_id, account_id, amount::text AS amount, state FROM campaigns.reward_intents`;
  let owed = 0n;
  for (const r of rows) {
    const onBook = await owedOnBook(r.reward_key);
    expect(onBook, r.reward_key).toBe(r.state === 'owed' ? parseAmount(r.amount) : 0n);
    if (r.state === 'owed') owed += onBook;
    expect((await book.balance(campaignBudgetAccount(r.campaign_id))).amount, r.campaign_id).toBe(0n);
    expect((await book.balance(userAvailable(r.account_id, 'USDC'))).amount, r.account_id).toBe(0n);
  }
  // A retry posts the same key and the ledger answers it with the first transaction: each Owe key booked once.
  const oweKeys = [...new Set(wire.mode.posts.filter((k) => k.startsWith('campaigns:owe:')))];
  for (const key of oweKeys) expect(await book.getTxByKey(key), key).not.toBeNull();
  expect(oweKeys.sort()).toEqual(
    rows
      .filter((r) => r.state === 'owed')
      .map((r) => `campaigns:owe:${ledgerRewardId(r.reward_key)}`)
      .sort(),
  );
  expect(book.reconcile()).toEqual({ ok: true });
  return owed;
}

if (!db) {
  describe.skip('owed rewards (Postgres unavailable)', () => {
    it('skipped', () => undefined);
  });
} else {
  describe('owed rewards, custody off (Postgres)', () => {
    beforeEach(async () => {
      await db.sql`TRUNCATE campaigns.redemption_attempts, campaigns.reward_intents, campaigns.task_progress,
        campaigns.task_completions, campaigns.pot_fundings, campaigns.participations, campaigns.eligibility_reviews,
        campaigns.audit_log, campaigns.campaigns CASCADE`;
      people.clear();
      people.set(ME, person(ME));
      people.set(YOU, person(YOU));
      book = new MemoryLedger();
      wire = custodyOff(book);
      clock = null;
      wireUp(CEILING);
    });

    it('owes a claimed USDC reward once from its campaign budget, never to the customer, and says why it is not in the wallet', async () => {
      await seedRewardsEngine('50');
      const c = await joined();
      await complete(c.id);
      const claimed = await tasks.claim({ campaignId: c.id, accountId: ME });
      expect(claimed.reward).toMatchObject({ state: 'owed', reason: PAYOUT_UNAVAILABLE, ledgerTxId: null, form: 'paid' });
      expect(claimed.reward.owed?.txId).toBeTruthy();
      // A second claim and later reconciler passes book nothing more.
      expect((await tasks.claim({ campaignId: c.id, accountId: ME })).created).toBe(false);
      await reconcileLater();
      await reconcileLater();
      expect(await owedOnBook(claimed.reward.rewardKey)).toBe(parseAmount('10'));
      expect((await book.balance(rewardsEngine('USDC'))).amount).toBe(parseAmount('40'));
      const mine = await tasks.myRewards({ accountId: ME });
      expect(mine.rewards.map((r) => r.status)).toEqual(['owed']);
      expect(mine.totals).toEqual([{ status: 'owed', asset: 'USDC', amount: '10', count: 1 }]);
      const progress = await tasks.progress({ campaignId: c.id, accountId: ME });
      expect(progress.reward?.attempts.filter((a) => a.outcome === 'owed')).toHaveLength(1);
      expect(await reconciles()).toBe(parseAmount('10'));
    });

    it('owes a held reward at its claim: it reads on hold until the hold ends, then owed; the hold release leaves it alone', async () => {
      await seedRewardsEngine('50');
      const c = await joined({ tasks: { ...STEPS, holdSeconds: 3600 } });
      await complete(c.id);
      const claimed = await tasks.claim({ campaignId: c.id, accountId: ME });
      expect(claimed.reward.state).toBe('owed');
      expect(claimed.reward.holdUntil).not.toBeNull();
      let mine = await tasks.myRewards({ accountId: ME });
      expect(mine.rewards[0]!.status).toBe('on_hold');
      expect(mine.totals).toEqual([{ status: 'on_hold', asset: 'USDC', amount: '10', count: 1 }]);
      clock = new Date(Date.now() + 2 * HOUR);
      expect(await tasks.releaseHolds()).toBe(0);
      mine = await tasks.myRewards({ accountId: ME });
      expect(mine.rewards[0]).toMatchObject({ status: 'owed', state: 'owed' });
      expect(await reconciles()).toBe(parseAmount('10'));
    });

    it('owes nothing while the ceiling is unset, and owes it once on a later pass when it is set', async () => {
      wireUp(undefined);
      await seedRewardsEngine('50');
      const c = await joined();
      await complete(c.id);
      const claimed = await tasks.claim({ campaignId: c.id, accountId: ME });
      expect(claimed.reward).toMatchObject({ state: 'pending_retry', reason: 'ledger.reward_ceiling_unset' });
      expect(wire.mode.posts).toEqual([]);
      expect((await tasks.myRewards({ accountId: ME })).rewards[0]!.status).toBe('still_open');
      wireUp(CEILING);
      await reconcileLater();
      expect((await tasks.progress({ campaignId: c.id, accountId: ME })).reward?.state).toBe('owed');
      expect(await reconciles()).toBe(parseAmount('10'));
    });

    it('refuses an Owe that would pass the per-campaign ceiling, with nothing booked for it', async () => {
      await seedRewardsEngine('50');
      const c = await joined();
      await complete(c.id, ME);
      await campaigns().join({ campaignId: c.id, accountId: YOU });
      await complete(c.id, YOU);
      expect((await tasks.claim({ campaignId: c.id, accountId: ME })).reward.state).toBe('owed');
      const second = await tasks.claim({ campaignId: c.id, accountId: YOU });
      expect(second.reward).toMatchObject({ state: 'pending_retry', reason: 'ledger.reward_ceiling_exceeded' });
      expect(await owedOnBook(second.reward.rewardKey)).toBe(0n);
      expect(await reconciles()).toBe(parseAmount('10'));
    });

    it('waits for the rewards engine to hold enough, and owes it once it does', async () => {
      const c = await joined();
      await complete(c.id);
      const claimed = await tasks.claim({ campaignId: c.id, accountId: ME });
      expect(claimed.reward).toMatchObject({ state: 'pending_funding', reason: 'ledger.insufficient_funds' });
      await seedRewardsEngine('10');
      await reconcileLater();
      expect((await tasks.progress({ campaignId: c.id, accountId: ME })).reward?.state).toBe('owed');
      expect((await book.balance(rewardsEngine('USDC'))).amount).toBe(0n);
      expect(await reconciles()).toBe(parseAmount('10'));
    });

    it('stays open under the posting freeze and is owed once after it lifts', async () => {
      await seedRewardsEngine('50');
      const c = await joined();
      await complete(c.id);
      wire.mode.frozen = true;
      const claimed = await tasks.claim({ campaignId: c.id, accountId: ME });
      expect(claimed.reward).toMatchObject({ state: 'pending_retry', reason: 'ledger.frozen' });
      await reconcileLater();
      expect((await tasks.progress({ campaignId: c.id, accountId: ME })).reward?.state).toBe('pending_retry');
      wire.mode.frozen = false;
      await reconcileLater();
      await reconcileLater();
      const reward = (await tasks.progress({ campaignId: c.id, accountId: ME })).reward!;
      expect(reward.state).toBe('owed');
      expect(reward.attempts.filter((a) => a.outcome === 'owed')).toHaveLength(1);
      expect(await reconciles()).toBe(parseAmount('10'));
    });

    it('a lost answer after the Owe booked is read back by posting the same key: owed once, with the first transaction', async () => {
      await seedRewardsEngine('50');
      const c = await joined();
      await complete(c.id);
      // The funding answers; the Owe books and its reply is lost.
      const realPost = wire.ledger.post;
      let calls = 0;
      wire.ledger.post = async (request) => {
        calls += 1;
        if (calls === 2) wire.mode.loseNextReply = true;
        return realPost(request);
      };
      const claimed = await tasks.claim({ campaignId: c.id, accountId: ME });
      expect(claimed.reward.state).toBe('unknown');
      wire.ledger.post = realPost;
      await reconcileLater();
      const reward = (await tasks.progress({ campaignId: c.id, accountId: ME })).reward!;
      expect(reward.state).toBe('owed');
      expect(reward.owed?.txId).toBe((await book.getTxByKey(`campaigns:owe:${ledgerRewardId(rewardKeyOf(c.id, ME, 'once'))}`))?.id);
      expect(await owedOnBook(reward.rewardKey)).toBe(parseAmount('10'));
      expect(await reconciles()).toBe(parseAmount('10'));
    });

    it('keeps a USDT reward on the custodial recipes: with custody off it is refused and nothing is owed', async () => {
      const c = await joined({ budget: { asset: 'USDT', limit: '100' }, reward: { asset: 'USDT', amount: '10' } });
      await complete(c.id);
      const claimed = await tasks.claim({ campaignId: c.id, accountId: ME });
      expect(claimed.reward.state).not.toBe('owed');
      expect(claimed.reward.owed).toBeNull();
      expect(wire.mode.posts).toEqual([]);
    });
  });
}
