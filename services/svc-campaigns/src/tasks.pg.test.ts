import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDatabase, postgresAvailable, type TestDatabase } from '@intafaced/db/testing';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  MemoryLedger,
  houseFees,
  parseAmount,
  recipes,
  rewardsEngine,
  userAvailable,
  type LedgerClient,
  type PostRequest,
} from '@intafaced/ledger-client';
import type { CampaignParticipant } from '@intafaced/contracts';
import type { CampaignDefinitionInput, CampaignTasks } from '@intafaced/contracts/campaigns-catalogue';
import { CampaignService, zonedClock } from './campaigns.js';
import { CampaignsError } from './codes.js';
import { PayoutSaga, REWARD_REASON, answerOf } from './payouts.js';
import { createMarketNames, type MarketNames } from './markets.js';
import { TaskService, meetsGate, rewardKeyOf, stepMatches, type FillEvent } from './tasks.js';

/**
 * Task campaigns and the reward saga against real Postgres and the in-memory reference ledger (CM-tasks-quests-01,
 * CM-payouts-ledger-02, J-campaigns-02). Every money test ends with the invariant: what the posted intents say was paid
 * is exactly what the customers hold, the pot paid exactly that, and every ledger key is a reward intent's own.
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

let people = new Map<string, CampaignParticipant>();
const participants = { read: async (userId: string) => people.get(userId) ?? null };
const person = (userId: string, over: Partial<CampaignParticipant> = {}): CampaignParticipant => ({
  userId,
  accountType: 'individual',
  region: 'DE',
  status: 'active',
  kycTier: 'full',
  ...over,
});

const STEPS: CampaignTasks = {
  steps: [
    { title: 'TEST buy BTC', event: 'trade.fill', market: 'BTC/USDT', side: 'buy', count: 1, streakDays: null },
    { title: 'TEST sell BTC', event: 'trade.fill', market: 'BTC/USDT', side: 'sell', count: 1, streakDays: null },
    { title: 'TEST trade twice', event: 'trade.fill', market: null, side: null, count: 2, streakDays: null },
  ],
  claimWindowSeconds: 3600,
  kycGate: 'full',
};

let names = 0;
const definition = (over: Partial<CampaignDefinitionInput> = {}): CampaignDefinitionInput => ({
  name: `TEST task campaign ${(names += 1)}`,
  type: 'task',
  rules: 'TEST rules',
  startsAt: new Date(Date.now() - HOUR).toISOString(),
  endsAt: new Date(Date.now() + 30 * 24 * HOUR).toISOString(),
  participation: { exclusions: [], regionScope: 'platform', restrictedRegions: null },
  budget: { asset: 'USDT', limit: '100' },
  reward: { asset: 'USDT', amount: '10' },
  tasks: STEPS,
  ...over,
});

const campaigns = () => new CampaignService({ sql: db!.sql, timeZone: () => 'UTC', participants });

async function live(over: Partial<CampaignDefinitionInput> = {}) {
  const s = campaigns();
  const c = await s.create({ definition: definition(over), actor: A });
  await s.transition({ id: c.id, action: 'submit', revision: 1, actor: A });
  await s.transition({ id: c.id, action: 'approve', revision: 1, actor: B });
  return s.transition({ id: c.id, action: 'activate', revision: 1, actor: A });
}

/** svc-trade puts a market's id on a fill, never its symbol. */
const BTC_USDT = '0b6f6a8e-4d1c-4f7a-9a31-5c2e7d9b1a01';
const ETH_USDT = '0b6f6a8e-4d1c-4f7a-9a31-5c2e7d9b1a02';
const LISTED: MarketNames = {
  symbolOf: async (id) => ({ [BTC_USDT]: 'BTC/USDT', [ETH_USDT]: 'ETH/USDT' })[id] ?? null,
};

let fills = 0;
const fill = (userId: string, over: Partial<FillEvent> = {}): FillEvent => ({
  fillId: `fill-${(fills += 1)}`,
  userId,
  marketId: BTC_USDT,
  side: 'buy',
  ts: new Date().toISOString(),
  ...over,
});

/** A ledger that can drop the reply of a post that booked, or fail before sending, on demand. */
function flaky(inner: MemoryLedger) {
  const mode = { next: 'ok' as 'ok' | 'lose-reply' | 'never-sent' };
  const ledger: LedgerClient = {
    post: async (request: PostRequest) => {
      const now = mode.next;
      mode.next = 'ok';
      if (now === 'never-sent') throw new Error('socket hang up');
      const tx = await inner.post(request);
      if (now === 'lose-reply') throw new Error('reply lost after the post landed');
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
let wire: ReturnType<typeof flaky>;
let saga: PayoutSaga;
let tasks: TaskService;
let clock: Date | null = null;

/** Earned trade fees the pot can be funded from: a TEST customer pays a fee into the trade fee account. */
async function earnFees(amount: string) {
  await book.post(
    recipes.deposit({ userId: FUNDER, assetId: 'USDT', amount: parseAmount(amount), rail: 'test', railRef: `fees-${amount}-${fills}` }),
  );
  await book.post(
    recipes.feeCharge({
      chargeId: `test-${amount}-${fills}`,
      userId: FUNDER,
      module: 'trade',
      mode: 'asset',
      assetId: 'USDT',
      amount: parseAmount(amount),
    }),
  );
}

async function fundPot(reference: string, amount: string) {
  await tasks.requestFunding({ reference, sourceModule: 'trade', asset: 'USDT', amount, actor: A });
  return tasks.approveFunding({ reference, actor: B });
}

async function code(p: Promise<unknown>): Promise<string> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(CampaignsError);
  return (err as CampaignsError).code;
}

const free = async (userId: string) => (await book.balance(userAvailable(userId, 'USDT'))).amount;

/** The invariant: paid intents equal what customers got, the pot paid exactly that, and every key is an intent's own. */
async function reconciles(potFunded: bigint) {
  const paid = await db!.sql<{ account_id: string; amount: string; reward_key: string }[]>`
    SELECT account_id, amount::text AS amount, reward_key FROM campaigns.reward_intents WHERE state = 'posted'`;
  let total = 0n;
  for (const p of paid) {
    total += parseAmount(p.amount);
    expect(await book.getTxByKey(`reward:${p.reward_key}`)).not.toBeNull();
  }
  const got = (await free(ME)) + (await free(YOU));
  expect(got).toBe(total);
  expect((await book.balance(rewardsEngine('USDT'))).amount).toBe(potFunded - total);
}

if (!db) {
  describe.skip('task campaigns (Postgres unavailable)', () => {
    it('skipped', () => undefined);
  });
} else {
  describe('task campaigns (Postgres)', () => {
    beforeEach(async () => {
      await db.sql`TRUNCATE campaigns.redemption_attempts, campaigns.reward_intents, campaigns.task_progress,
        campaigns.task_completions, campaigns.pot_fundings, campaigns.participations, campaigns.eligibility_reviews,
        campaigns.audit_log, campaigns.campaigns CASCADE`;
      people = new Map([
        [ME, person(ME)],
        [YOU, person(YOU)],
      ]);
      book = new MemoryLedger();
      wire = flaky(book);
      clock = null;
      saga = new PayoutSaga({ sql: db.sql, ledger: wire.ledger, reconcileAfterSeconds: 1 });
      tasks = new TaskService({
        sql: db.sql,
        participants,
        saga,
        markets: LISTED,
        timeZone: () => 'UTC',
        rollbackWindowSeconds: 86_400,
        now: () => clock ?? new Date(),
      });
    });

    async function joined(over: Partial<CampaignDefinitionInput> = {}, who = ME) {
      const c = await live(over);
      await campaigns().join({ campaignId: c.id, accountId: who });
      return c;
    }

    /** Every step done by real fills: a buy, a sell (which also makes the trade-twice step). */
    async function complete(campaignId: string, who = ME) {
      await tasks.onFill(fill(who, { side: 'buy' }));
      await tasks.onFill(fill(who, { side: 'sell' }));
      const p = await tasks.progress({ campaignId, accountId: who });
      expect(p.completed).toBe(3);
      return p;
    }

    /** The reconciler runs only for attempts older than its interval. */
    async function reconcileLater() {
      await db!.sql`UPDATE campaigns.reward_intents SET last_attempt_at = now() - interval '1 minute' WHERE last_attempt_at IS NOT NULL`;
      await db!.sql`UPDATE campaigns.pot_fundings SET last_attempt_at = now() - interval '1 minute' WHERE last_attempt_at IS NOT NULL`;
      return saga.reconcile();
    }

    it('counts a step from its real event once: the same fill delivered twice changes nothing', async () => {
      const c = await joined();
      const first = fill(ME);
      expect(await tasks.onFill(first)).toBe(1);
      await tasks.onFill(first);
      const p = await tasks.progress({ campaignId: c.id, accountId: ME });
      expect(p.steps.map((s) => s.done)).toEqual([1, 0, 1]);
      expect(p.completed).toBe(1);
      expect(p.total).toBe(3);
      expect(p.completedAt).toBeNull();
      // Another market does not count for a BTC step, but does for the any-market step.
      await tasks.onFill(fill(ME, { marketId: ETH_USDT, side: 'sell' }));
      expect((await tasks.progress({ campaignId: c.id, accountId: ME })).steps.map((s) => s.done)).toEqual([1, 0, 2]);
    });

    it("counts a market step only when the fill's market can be named; an unreachable list leaves the fill to come again", async () => {
      const c = await joined();
      // A market id the list does not hold counts only for the any-market step.
      await tasks.onFill(fill(ME, { marketId: '0b6f6a8e-4d1c-4f7a-9a31-5c2e7d9b1aff' }));
      expect((await tasks.progress({ campaignId: c.id, accountId: ME })).steps.map((s) => s.done)).toEqual([0, 0, 1]);
      // Without svc-trade wired, a market step counts nothing.
      const unwired = new TaskService({
        sql: db!.sql,
        participants,
        saga,
        markets: null,
        timeZone: () => 'UTC',
        rollbackWindowSeconds: 86_400,
      });
      await unwired.onFill(fill(ME));
      expect((await tasks.progress({ campaignId: c.id, accountId: ME })).steps.map((s) => s.done)).toEqual([0, 0, 2]);
      // An unreachable list throws before anything is written, so the bus delivers the fill again.
      const down = new TaskService({
        sql: db!.sql,
        participants,
        saga,
        markets: { symbolOf: () => Promise.reject(new Error('market list read failed: HTTP 503')) },
        timeZone: () => 'UTC',
        rollbackWindowSeconds: 86_400,
      });
      const again = fill(ME);
      await expect(down.onFill(again)).rejects.toThrow('HTTP 503');
      expect((await tasks.progress({ campaignId: c.id, accountId: ME })).steps.map((s) => s.done)).toEqual([0, 0, 2]);
      await tasks.onFill(again);
      expect((await tasks.progress({ campaignId: c.id, accountId: ME })).steps.map((s) => s.done)).toEqual([1, 0, 2]);
    });

    it('counts nothing for an account that has not joined, or a fill from before it joined', async () => {
      const c = await live();
      await tasks.onFill(fill(ME, { ts: new Date(Date.now() - 60_000).toISOString() }));
      await campaigns().join({ campaignId: c.id, accountId: ME });
      await tasks.onFill(fill(ME, { ts: new Date(Date.now() - 60_000).toISOString() }));
      expect((await tasks.progress({ campaignId: c.id, accountId: ME })).steps.every((s) => s.done === 0)).toBe(true);
      expect(await code(tasks.claim({ campaignId: c.id, accountId: YOU }))).toBe('campaigns.not_joined');
    });

    it('refuses a claim before every step is done, and below the verification gate, storing nothing', async () => {
      const c = await joined();
      expect(await code(tasks.claim({ campaignId: c.id, accountId: ME }))).toBe('campaigns.tasks_incomplete');
      await complete(c.id);
      people.set(ME, person(ME, { kycTier: 'basic' }));
      expect(await code(tasks.claim({ campaignId: c.id, accountId: ME }))).toBe('campaigns.kyc_required');
      expect((await db.sql`SELECT count(*)::int AS n FROM campaigns.reward_intents`)[0]!.n).toBe(0);
      people.delete(ME);
      expect(await code(tasks.claim({ campaignId: c.id, accountId: ME }))).toBe('campaigns.participant_unread');
    });

    it('pays once: an unfunded pot waits, the pot is funded by two people, the reconciler pays the same key', async () => {
      const c = await joined();
      await complete(c.id);
      const claimed = await tasks.claim({ campaignId: c.id, accountId: ME });
      expect(claimed.created).toBe(true);
      expect(claimed.reward.state).toBe('pending_funding');
      expect(claimed.reward.reason).toBe('ledger.insufficient_funds');
      expect(claimed.reward.rewardKey).toBe(rewardKeyOf(c.id, ME, 'once'));
      // The budget holds the reward while it waits.
      expect((await campaigns().get({ id: c.id, accountId: ME })).budget.left).toBe('90');

      await earnFees('25');
      expect(await code(tasks.approveFunding({ reference: 'TEST-none', actor: B }))).toBe('campaigns.funding_unknown');
      await tasks.requestFunding({ reference: 'TEST-pot-1', sourceModule: 'trade', asset: 'USDT', amount: '20', actor: A });
      expect(await code(tasks.approveFunding({ reference: 'TEST-pot-1', actor: A }))).toBe('campaigns.second_person_required');
      const funded = await tasks.approveFunding({ reference: 'TEST-pot-1', actor: B });
      expect(funded.state).toBe('posted');
      expect((await book.balance(houseFees('trade', 'USDT'))).amount).toBe(parseAmount('5'));
      // Approving again returns it; nothing is swept twice.
      expect((await tasks.approveFunding({ reference: 'TEST-pot-1', actor: B })).ledgerTxId).toBe(funded.ledgerTxId);

      await reconcileLater();
      const again = await tasks.claim({ campaignId: c.id, accountId: ME });
      expect(again.created).toBe(false);
      expect(again.reward.state).toBe('posted');
      expect(again.reward.ledgerTxId).toBeTruthy();
      expect(again.reward.attempts.map((a) => a.outcome)).toEqual(['qualified', 'refused', 'posted']);
      expect(again.reward.rollback.windowSeconds).toBe(86_400);
      expect(again.reward.rollback.closesAt).toBeTruthy();
      const tx = await book.getTxByKey(`reward:${again.reward.rewardKey}`);
      expect(tx?.reason).toBe(REWARD_REASON);
      expect(await free(ME)).toBe(parseAmount('10'));
      // Claiming again, and the reconciler again, pay nothing more.
      await tasks.claim({ campaignId: c.id, accountId: ME });
      await reconcileLater();
      expect(await free(ME)).toBe(parseAmount('10'));
      expect((await campaigns().get({ id: c.id, accountId: ME })).budget.left).toBe('90');
      await reconciles(parseAmount('20'));
    });

    it('a lost reply after the post landed resolves to the one payment', async () => {
      const c = await joined();
      await earnFees('10');
      await fundPot('TEST-pot-2', '10');
      await complete(c.id);
      wire.mode.next = 'lose-reply';
      const claimed = await tasks.claim({ campaignId: c.id, accountId: ME });
      expect(claimed.reward.state).toBe('unknown');
      expect(await free(ME)).toBe(parseAmount('10'));
      await reconcileLater();
      const p = await tasks.progress({ campaignId: c.id, accountId: ME });
      expect(p.reward?.state).toBe('posted');
      expect(await free(ME)).toBe(parseAmount('10'));
      await reconciles(parseAmount('10'));
    });

    it('a crash before the post (an intent left qualified or posting) posts once with the same key', async () => {
      const c = await joined();
      await earnFees('10');
      await fundPot('TEST-pot-3', '10');
      await complete(c.id);
      wire.mode.next = 'never-sent';
      expect((await tasks.claim({ campaignId: c.id, accountId: ME })).reward.state).toBe('unknown');
      // As if the process died mid-attempt: the row says posting.
      await db.sql`UPDATE campaigns.reward_intents SET state = 'posting'`;
      // Two reconcilers at once: one credit.
      await db.sql`UPDATE campaigns.reward_intents SET last_attempt_at = now() - interval '1 minute'`;
      await Promise.all([saga.reconcile(), saga.reconcile()]);
      expect(await free(ME)).toBe(parseAmount('10'));
      await reconciles(parseAmount('10'));
    });

    it('a claim after the window forfeits the reward once and draws nothing on the budget', async () => {
      const c = await joined({ tasks: { ...STEPS, claimWindowSeconds: 60 } });
      await complete(c.id);
      clock = new Date(Date.now() + 61_000);
      expect(await code(tasks.claim({ campaignId: c.id, accountId: ME }))).toBe('campaigns.claim_expired');
      const p = await tasks.progress({ campaignId: c.id, accountId: ME });
      expect(p.reward?.state).toBe('forfeited');
      expect(p.reward?.reason).toBe('campaigns.claim_expired');
      const again = await tasks.claim({ campaignId: c.id, accountId: ME });
      expect(again).toMatchObject({ created: false, reward: { state: 'forfeited' } });
      expect((await campaigns().get({ id: c.id, accountId: ME })).budget.left).toBe('100');
      expect(await free(ME)).toBe(0n);
    });

    it('withholds a frozen account’s reward before any ledger call', async () => {
      const c = await joined();
      await earnFees('10');
      await fundPot('TEST-pot-4', '10');
      await complete(c.id);
      people.set(ME, person(ME, { status: 'frozen' }));
      const claimed = await tasks.claim({ campaignId: c.id, accountId: ME });
      expect(claimed.reward.state).toBe('withheld');
      await reconcileLater();
      expect(await free(ME)).toBe(0n);
      expect(await book.getTxByKey(`reward:${claimed.reward.rewardKey}`)).toBeNull();
    });

    it('pays a withheld reward once the account is active again, inside the window', async () => {
      const c = await joined();
      await earnFees('10');
      await fundPot('TEST-pot-6', '10');
      await complete(c.id);
      people.set(ME, person(ME, { status: 'frozen' }));
      const withheld = await tasks.claim({ campaignId: c.id, accountId: ME });
      expect(withheld.reward).toMatchObject({ state: 'withheld', reason: 'account.frozen' });
      // Still frozen: the same withheld reward, nothing new.
      expect(await tasks.claim({ campaignId: c.id, accountId: ME })).toMatchObject({ created: false, reward: { state: 'withheld' } });
      people.set(ME, person(ME));
      const paid = await tasks.claim({ campaignId: c.id, accountId: ME });
      expect(paid.reward.state).toBe('posted');
      expect(paid.reward.attempts.map((a) => a.outcome)).toEqual(['withheld', 'qualified', 'posted']);
      expect(await tasks.claim({ campaignId: c.id, accountId: ME })).toMatchObject({ created: false, reward: { state: 'posted' } });
      await reconciles(parseAmount('10'));
    });

    it('a streak step counts days in a row in the zone; a missed day resets it, and a full run completes it once', async () => {
      const streak: CampaignTasks = {
        steps: [{ title: 'TEST trade 3 days in a row', event: 'trade.fill', market: null, side: null, count: 1, streakDays: 3 }],
        claimWindowSeconds: 3600,
        kycGate: 'full',
      };
      const c = await joined({ tasks: streak, startsAt: new Date(Date.now() - 10 * 24 * HOUR).toISOString() });
      // Joined and traded days ago: the participation moves back, as the stack fixture does.
      await db!.sql`UPDATE campaigns.participations SET created_at = now() - interval '6 days' WHERE campaign_id = ${c.id}`;
      const day = (n: number) => new Date(Date.now() - n * 24 * HOUR).toISOString();
      await tasks.onFill(fill(ME, { ts: day(5) }));
      await tasks.onFill(fill(ME, { ts: day(4) }));
      await tasks.onFill(fill(ME, { ts: day(4) }));
      let [step] = (await tasks.progress({ campaignId: c.id, accountId: ME })).steps;
      expect(step).toMatchObject({ done: 0, target: 3, complete: false, streak: { days: 0, best: 2, reset: true, resetsAt: null } });
      // Trading again starts a new run: one day, alive until the zone midnight two days on.
      await tasks.onFill(fill(ME));
      [step] = (await tasks.progress({ campaignId: c.id, accountId: ME })).steps;
      expect(step).toMatchObject({ done: 1, complete: false, streak: { days: 1, best: 2, reset: false } });
      expect(new Date(step!.streak!.resetsAt!).getUTCHours()).toBe(0);
      expect(await code(tasks.claim({ campaignId: c.id, accountId: ME }))).toBe('campaigns.tasks_incomplete');
      // The two days before today as well: three in a row completes the step, and it stays done.
      await tasks.onFill(fill(ME, { ts: day(1) }));
      await tasks.onFill(fill(ME, { ts: day(2) }));
      const p = await tasks.progress({ campaignId: c.id, accountId: ME });
      expect(p.steps[0]).toMatchObject({ done: 3, complete: true, streak: { best: 3, reset: false } });
      expect(p.completedAt).not.toBeNull();
    });

    it('a streak step counts one event a day: any other count is refused', async () => {
      const bad: CampaignTasks = {
        steps: [{ title: 'TEST', event: 'trade.fill', market: null, side: null, count: 2, streakDays: 3 }],
        claimWindowSeconds: 3600,
        kycGate: 'none',
      };
      expect(await code(campaigns().create({ definition: definition({ tasks: bad }), actor: A }))).toBe('campaigns.tasks_invalid');
      const good = { ...bad, steps: [{ ...bad.steps[0]!, count: 1 }] };
      // A streak runs every day, inside a time frame at least as long as it.
      expect(await code(campaigns().create({ definition: definition({ tasks: good, weekdays: [1, 2, 3] }), actor: A }))).toBe(
        'campaigns.tasks_invalid',
      );
      const short = { startsAt: new Date(Date.now()).toISOString(), endsAt: new Date(Date.now() + 2 * 24 * HOUR).toISOString() };
      expect(await code(campaigns().create({ definition: definition({ tasks: good, ...short }), actor: A }))).toBe(
        'campaigns.tasks_invalid',
      );
      // With the platform zone blank, the streak is not read as 0 days: progress refuses.
      const c = await joined({ tasks: good });
      const blank = new TaskService({
        sql: db!.sql,
        participants,
        saga,
        markets: LISTED,
        timeZone: () => null,
        rollbackWindowSeconds: 86_400,
      });
      expect(await code(blank.progress({ campaignId: c.id, accountId: ME }))).toBe('campaigns.timezone_unset');
    });

    it('a late fill that closes the steps opens the claim window when it is counted, not on its own day', async () => {
      const c = await joined();
      await db!.sql`UPDATE campaigns.participations SET created_at = now() - interval '3 days' WHERE campaign_id = ${c.id}`;
      const early = new Date(Date.now() - 2 * 24 * HOUR).toISOString();
      await tasks.onFill(fill(ME, { side: 'sell' }));
      await tasks.onFill(fill(ME, { side: 'buy', ts: early }));
      const p = await tasks.progress({ campaignId: c.id, accountId: ME });
      expect(p.completed).toBe(3);
      expect(new Date(p.completedAt!).getTime()).toBeGreaterThan(Date.now() - 60_000);
      expect((await tasks.claim({ campaignId: c.id, accountId: ME })).reward.state).not.toBe('forfeited');
    });

    it("counts no fill outside the campaign's weekdays or hours", async () => {
      // The campaign runs today only: a fill tomorrow is outside it.
      const c = await joined({ weekdays: [zonedClock(new Date(), 'UTC').weekday] });
      await tasks.onFill(fill(ME, { ts: new Date(Date.now() + 24 * HOUR).toISOString() }));
      expect((await tasks.progress({ campaignId: c.id, accountId: ME })).steps.map((s) => s.done)).toEqual([0, 0, 0]);
      await tasks.onFill(fill(ME));
      expect((await tasks.progress({ campaignId: c.id, accountId: ME })).steps.map((s) => s.done)).toEqual([1, 0, 1]);
    });

    it('a funding approved but never posted (a crash after the approval) is posted by the reconciler', async () => {
      await earnFees('10');
      await tasks.requestFunding({ reference: 'TEST-pot-7', sourceModule: 'trade', asset: 'USDT', amount: '10', actor: A });
      await db!.sql`UPDATE campaigns.pot_fundings SET state = 'posting', approved_by = ${B} WHERE reference = 'TEST-pot-7'`;
      expect((await saga.reconcile()).fundings).toBe(1);
      expect((await tasks.fundings()).find((f) => f.reference === 'TEST-pot-7')?.state).toBe('posted');
      expect((await book.balance(rewardsEngine('USDT'))).amount).toBe(parseAmount('10'));
    });

    it('a budget in another asset than the reward cannot go live', async () => {
      const s = campaigns();
      const c = await s.create({ definition: definition({ budget: { asset: 'BTC', limit: '1' } }), actor: A });
      expect((await s.validate({ id: c.id })).missing).toContainEqual({ code: 'campaigns.budget_asset_mismatch', field: 'budget' });
    });

    it('a lost create reply sent again returns the same task draft; a transition shows what the budget has left', async () => {
      const s = campaigns();
      const d = definition();
      const first = await s.create({ definition: d, actor: A });
      expect((await s.create({ definition: d, actor: A })).id).toBe(first.id);
      await earnFees('10');
      await fundPot('TEST-pot-8', '10');
      await s.transition({ id: first.id, action: 'submit', revision: 1, actor: A });
      await s.transition({ id: first.id, action: 'approve', revision: 1, actor: B });
      await s.transition({ id: first.id, action: 'activate', revision: 1, actor: A });
      await s.join({ campaignId: first.id, accountId: ME });
      await complete(first.id);
      await tasks.claim({ campaignId: first.id, accountId: ME });
      const paused = await s.transition({ id: first.id, action: 'pause', revision: 1, actor: A });
      expect(paused.budget?.left).toBe('90');
    });

    it('refuses a claim the budget has no room for', async () => {
      const c = await joined({ budget: { asset: 'USDT', limit: '10' } });
      await campaigns().join({ campaignId: c.id, accountId: YOU });
      await complete(c.id, ME);
      await complete(c.id, YOU);
      await tasks.claim({ campaignId: c.id, accountId: ME });
      expect(await code(tasks.claim({ campaignId: c.id, accountId: YOU }))).toBe('campaigns.budget_exhausted');
    });

    it('a sweep the fee account cannot cover is refused once and final', async () => {
      await tasks.requestFunding({ reference: 'TEST-pot-5', sourceModule: 'trade', asset: 'USDT', amount: '5', actor: A });
      const out = await tasks.approveFunding({ reference: 'TEST-pot-5', actor: B });
      expect(out).toMatchObject({ state: 'refused', reason: 'ledger.insufficient_funds', ledgerTxId: null });
      expect(
        await code(tasks.requestFunding({ reference: 'TEST-pot-5', sourceModule: 'trade', asset: 'USDT', amount: '6', actor: A })),
      ).toBe('campaigns.funding_reference_taken');
      expect(await code(tasks.requestFunding({ reference: 'TEST-pot-6', sourceModule: 'trade', asset: 'USDT', amount: 5, actor: A }))).toBe(
        'campaigns.number_on_wire',
      );
    });

    it('a task campaign with steps and no claim window cannot go live; steps belong to task campaigns only', async () => {
      const s = campaigns();
      const c = await s.create({ definition: definition({ tasks: { ...STEPS, claimWindowSeconds: null } }), actor: A });
      expect((await s.validate({ id: c.id })).missing).toContainEqual({ code: 'campaigns.claim_window_unset', field: 'claimWindow' });
      expect(await code(s.create({ definition: definition({ type: 'referral' }), actor: A }))).toBe('campaigns.tasks_invalid');
    });
  });
}

describe('task rules', () => {
  it('matches a step by market and side, a blank one by anything', () => {
    const step = STEPS.steps[0]!;
    expect(stepMatches(step, { symbol: 'BTC/USDT', side: 'buy' })).toBe(true);
    expect(stepMatches(step, { symbol: 'BTC/USDT', side: 'sell' })).toBe(false);
    expect(stepMatches(step, { symbol: 'ETH/USDT', side: 'buy' })).toBe(false);
    expect(stepMatches(step, { symbol: null, side: 'buy' })).toBe(false);
    expect(stepMatches(STEPS.steps[2]!, { symbol: null, side: 'sell' })).toBe(true);
  });

  it("names a fill's market from the market list once, and throws when the list is unreachable", async () => {
    let reads = 0;
    let clock = 0;
    const names = createMarketNames({
      tradeUrl: 'http://trade.test',
      now: () => clock,
      fetch: (async (url: URL) => {
        reads += 1;
        expect(url.toString()).toBe('http://trade.test/api/v1/markets?limit=500');
        return new Response(JSON.stringify([{ id: BTC_USDT, symbol: 'BTC/USDT' }]), { status: 200 });
      }) as unknown as typeof fetch,
    });
    expect(await names.symbolOf(BTC_USDT)).toBe('BTC/USDT');
    expect(await names.symbolOf(BTC_USDT)).toBe('BTC/USDT');
    expect(reads).toBe(1);
    // An unknown id reads the list again only after a minute, and two at once share one read.
    clock = 60_000;
    expect(await Promise.all([names.symbolOf(ETH_USDT), names.symbolOf(ETH_USDT)])).toEqual([null, null]);
    expect(reads).toBe(2);
    expect(await names.symbolOf(ETH_USDT)).toBeNull();
    expect(reads).toBe(2);
    const down = createMarketNames({
      tradeUrl: 'http://trade.test',
      fetch: (async () => new Response('', { status: 503 })) as unknown as typeof fetch,
    });
    await expect(down.symbolOf(BTC_USDT)).rejects.toThrow('HTTP 503');
  });

  it('reads the verification gate by tier', () => {
    expect(meetsGate('full', 'basic')).toBe(false);
    expect(meetsGate('full', 'full')).toBe(true);
    expect(meetsGate('full', 'institutional')).toBe(true);
    expect(meetsGate('none', 'none')).toBe(true);
  });

  it('only a named engine refusal of a first single attempt is a failure; a lost answer is unknown', () => {
    expect(answerOf(new Error('socket hang up'), true)).toEqual({ state: 'unknown', reason: 'ledger.answer_lost' });
  });
});
