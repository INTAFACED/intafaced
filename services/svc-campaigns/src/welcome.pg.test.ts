import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDatabase, postgresAvailable, type TestDatabase } from '@intafaced/db/testing';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { MemoryLedger, houseFees, parseAmount, recipes, rewardsEngine, userAvailable } from '@intafaced/ledger-client';
import type { CampaignParticipant } from '@intafaced/contracts';
import type { CampaignDefinitionInput, CampaignTasks } from '@intafaced/contracts/campaigns-catalogue';
import { CampaignService } from './campaigns.js';
import { CampaignsError } from './codes.js';
import { PayoutSaga } from './payouts.js';
import { TaskService, rewardKeyOf, welcomePeriodOf } from './tasks.js';

/**
 * The welcome checklist against real Postgres and the in-memory reference ledger (CM-rewards-hub-03, J-campaigns-04).
 * Every money test ends with the invariant: what the posted welcome intents say was paid is exactly what the customers
 * hold, the pot paid exactly that, and every ledger key is a reward intent's own.
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
const LATE = '00000000-0000-4000-8000-0000000000d4';
const FUNDER = '00000000-0000-4000-8000-0000000000c3';
const HOUR = 3_600_000;

let people = new Map<string, CampaignParticipant>();
const participants = { read: async (userId: string) => people.get(userId) ?? null };
const person = (userId: string, over: Partial<CampaignParticipant> = {}): CampaignParticipant => ({
  userId,
  accountType: 'individual',
  region: 'DE',
  status: 'active',
  kycTier: 'basic',
  ...over,
});

const WELCOME: CampaignTasks = {
  steps: [
    {
      title: 'TEST verify',
      event: 'identity.verified',
      market: null,
      side: null,
      count: 1,
      streakDays: null,
      reward: { asset: 'USDT', amount: '1' },
    },
    {
      title: 'TEST first deposit',
      event: 'pay.deposit',
      market: null,
      side: null,
      count: 1,
      streakDays: null,
      reward: { asset: 'USDT', amount: '2' },
    },
    {
      title: 'TEST first trade',
      event: 'trade.fill',
      market: null,
      side: null,
      count: 1,
      streakDays: null,
      reward: { asset: 'USDT', amount: '3' },
    },
  ],
  claimWindowSeconds: null,
  holdSeconds: 0,
  lock: null,
  kycGate: 'none',
  welcomeWindowSeconds: 7 * 24 * 3600,
};

let names = 0;
const definition = (over: Partial<CampaignDefinitionInput> = {}): CampaignDefinitionInput => ({
  name: `TEST welcome ${(names += 1)}`,
  type: 'welcome',
  rules: 'TEST welcome rules',
  startsAt: new Date(Date.now() - HOUR).toISOString(),
  endsAt: new Date(Date.now() + 30 * 24 * HOUR).toISOString(),
  participation: { exclusions: [], regionScope: 'platform', restrictedRegions: null },
  budget: { asset: 'USDT', limit: '100' },
  // TEST limits: wide enough that only a test about limits meets them.
  limits: { perCustomer: { count: 100, periodSeconds: 86_400 }, totalRedemptions: null },
  tasks: WELCOME,
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

async function code(p: Promise<unknown>): Promise<string> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(CampaignsError);
  return (err as CampaignsError).code;
}

let book: MemoryLedger;
let tasks: TaskService;
let clock: Date | null = null;
let events = 0;
const now = () => clock ?? new Date();
const ago = (ms: number) => new Date(now().getTime() - ms).toISOString();

const signUp = (userId: string, at = ago(60_000)) => tasks.onSignUp({ userId, eventId: `user.created:${userId}`, at });
const happen = (userId: string, event: 'identity.verified' | 'pay.deposit' | 'trade.fill', at = now().toISOString(), eventId?: string) =>
  tasks.onWelcomeEvent({ userId, event, eventId: eventId ?? `${event}-${(events += 1)}`, at });

/** The reward pot, funded from earned trade fees as svc-campaigns funds it. */
async function fundPot(amount: string) {
  await book.post(
    recipes.deposit({ userId: FUNDER, assetId: 'USDT', amount: parseAmount(amount), rail: 'test', railRef: `fees-${amount}` }),
  );
  await book.post(
    recipes.feeCharge({
      chargeId: `test-${amount}`,
      userId: FUNDER,
      module: 'trade',
      mode: 'asset',
      assetId: 'USDT',
      amount: parseAmount(amount),
    }),
  );
  await tasks.requestFunding({ reference: `welcome-${amount}`, sourceModule: 'trade', asset: 'USDT', amount, actor: A });
  await tasks.approveFunding({ reference: `welcome-${amount}`, actor: B });
  expect((await book.balance(houseFees('trade', 'USDT'))).amount).toBe(0n);
}

const free = async (userId: string) => (await book.balance(userAvailable(userId, 'USDT'))).amount;

async function reconciles(potFunded: bigint) {
  const paid = await db!.sql<{ amount: string; reward_key: string }[]>`
    SELECT amount::text AS amount, reward_key FROM campaigns.reward_intents WHERE state = 'posted'`;
  let total = 0n;
  for (const p of paid) {
    total += parseAmount(p.amount);
    expect(await book.getTxByKey(`reward:${p.reward_key}`)).not.toBeNull();
  }
  expect((await free(ME)) + (await free(YOU))).toBe(total);
  expect((await book.balance(rewardsEngine('USDT'))).amount).toBe(potFunded - total);
}

if (!db) {
  describe.skip('welcome checklist (Postgres unavailable)', () => {
    it('skipped', () => undefined);
  });
} else {
  describe('welcome checklist (Postgres)', () => {
    beforeEach(async () => {
      await db.sql`TRUNCATE campaigns.redemption_attempts, campaigns.reward_intents, campaigns.welcome_events,
        campaigns.welcome_accounts, campaigns.pot_fundings, campaigns.audit_log, campaigns.campaigns CASCADE`;
      people = new Map([
        [ME, person(ME)],
        [YOU, person(YOU)],
      ]);
      book = new MemoryLedger();
      clock = null;
      const saga = new PayoutSaga({ sql: db.sql, ledger: book, reconcileAfterSeconds: 1 });
      tasks = new TaskService({
        sql: db.sql,
        participants,
        saga,
        markets: null,
        timeZone: () => 'UTC',
        rollbackWindowSeconds: 86_400,
        now,
      });
    });

    it('cannot go live with a blank window; a blank task reward goes live and reads not set', async () => {
      const s = campaigns();
      const blank = await s.create({ definition: definition({ tasks: { ...WELCOME, welcomeWindowSeconds: null } }), actor: A });
      expect((await s.validate({ id: blank.id })).missing.map((m) => m.code)).toEqual(['campaigns.window_unset']);
      expect(await code(s.transition({ id: blank.id, action: 'submit', revision: 1, actor: A }))).toBe('campaigns.window_unset');
      // A welcome campaign has no campaign-wide reward: each task carries its own, and a blank one does not stop it.
      const steps = WELCOME.steps.map((step, i) => (i === 1 ? { ...step, reward: null } : step));
      const c = await live({ tasks: { ...WELCOME, steps } });
      expect(c.state).toBe('active');
      await signUp(ME);
      const list = await tasks.welcomeChecklist({ accountId: ME });
      expect(list.campaign?.id).toBe(c.id);
      expect(list.window?.state).toBe('open');
      expect(list.tasks.map((t) => [t.event, t.state, t.reward?.amount ?? 'not set'])).toEqual([
        ['identity.verified', 'open', '1'],
        ['pay.deposit', 'open', 'not set'],
        ['trade.fill', 'open', '3'],
      ]);
      await happen(ME, 'pay.deposit');
      expect(await code(tasks.welcomeClaim({ accountId: ME, event: 'pay.deposit' }))).toBe('campaigns.reward_unset');
      expect(await db.sql`SELECT 1 FROM campaigns.reward_intents`).toHaveLength(0);
    });

    it('keeps welcome tasks to the first-time list, and task campaigns to spot fills', async () => {
      const s = campaigns();
      const twice = { ...WELCOME, steps: [WELCOME.steps[0]!, WELCOME.steps[0]!] };
      expect(await code(s.create({ definition: definition({ tasks: twice }), actor: A }))).toBe('campaigns.tasks_invalid');
      const market = { ...WELCOME, steps: [{ ...WELCOME.steps[2]!, market: 'BTC/USDT' }] };
      expect(await code(s.create({ definition: definition({ tasks: market }), actor: A }))).toBe('campaigns.tasks_invalid');
      const task = definition({ type: 'task', reward: { asset: 'USDT', amount: '1' }, tasks: { ...WELCOME, claimWindowSeconds: 60 } });
      expect(await code(s.create({ definition: task, actor: A }))).toBe('campaigns.tasks_invalid');
      // A welcome campaign is listed in the catalogue, and is not joined: it applies from sign-up.
      const c = await live();
      expect((await s.catalogue(ME)).campaigns.map((x) => x.id)).toContain(c.id);
      expect(await code(s.join({ campaignId: c.id, accountId: ME }))).toBe('campaign.type_locked');
    });

    it('opens the window at sign-up under the campaign live then; an account from before it has no checklist', async () => {
      await signUp(LATE, ago(2 * HOUR));
      const c = await live();
      expect(await signUp(ME)).toBe(true);
      expect(await signUp(ME, ago(10))).toBe(false);
      const mine = await tasks.welcomeChecklist({ accountId: ME });
      expect(mine.campaign?.id).toBe(c.id);
      expect(new Date(mine.window!.closesAt!).getTime() - new Date(mine.window!.opensAt).getTime()).toBe(7 * 24 * HOUR);
      expect(await tasks.welcomeChecklist({ accountId: LATE })).toEqual({ campaign: null, signedUpAt: null, window: null, tasks: [] });
      expect(await code(tasks.welcomeClaim({ accountId: LATE, event: 'identity.verified' }))).toBe('campaigns.welcome_none');
    });

    it('ticks each task once from its own event; the same event again or a later one changes nothing', async () => {
      await live();
      await signUp(ME);
      const at = ago(30_000);
      await happen(ME, 'identity.verified', at, 'kyc.approved:me:basic');
      await happen(ME, 'identity.verified', at, 'kyc.approved:me:basic');
      await happen(ME, 'identity.verified', ago(1_000), 'kyc.approved:me:full');
      const list = await tasks.welcomeChecklist({ accountId: ME });
      expect(list.tasks.map((t) => t.state)).toEqual(['done', 'open', 'open']);
      expect(list.tasks[0]!.doneAt).toBe(at);
      expect(await db.sql`SELECT event_id FROM campaigns.welcome_events WHERE account_id = ${ME}`).toEqual([
        { event_id: 'kyc.approved:me:basic' },
      ]);
      // A fill is no deposit: only a crypto deposit credited ticks the deposit task.
      await happen(ME, 'trade.fill');
      expect((await tasks.welcomeChecklist({ accountId: ME })).tasks.map((t) => t.state)).toEqual(['done', 'open', 'done']);
      expect(await code(tasks.welcomeClaim({ accountId: ME, event: 'pay.deposit' }))).toBe('campaigns.tasks_incomplete');
    });

    it('counts an event the bus delivers before the sign-up, and never one from before the window', async () => {
      await live();
      await happen(YOU, 'pay.deposit', ago(30_000));
      await signUp(YOU, ago(60_000));
      await happen(ME, 'pay.deposit', ago(120_000));
      await signUp(ME, ago(60_000));
      expect((await tasks.welcomeChecklist({ accountId: YOU })).tasks[1]!.state).toBe('done');
      expect((await tasks.welcomeChecklist({ accountId: ME })).tasks[1]!.state).toBe('open');
    });

    it('a per-customer limit stops the next task’s reward, and a total limit stops everyone at it', async () => {
      await fundPot('50');
      await live({ limits: { perCustomer: { count: 2, periodSeconds: 86_400 }, totalRedemptions: 3 } });
      await signUp(ME);
      await signUp(YOU);
      for (const e of ['identity.verified', 'pay.deposit', 'trade.fill'] as const) await happen(ME, e);
      for (const e of ['identity.verified', 'pay.deposit'] as const) await happen(YOU, e);
      expect((await tasks.welcomeClaim({ accountId: ME, event: 'identity.verified' })).created).toBe(true);
      expect((await tasks.welcomeClaim({ accountId: ME, event: 'pay.deposit' })).created).toBe(true);
      // My third reward in the period passes my limit; nothing is written for it.
      expect(await code(tasks.welcomeClaim({ accountId: ME, event: 'trade.fill' }))).toBe('campaigns.customer_limit_reached');
      expect((await tasks.welcomeClaim({ accountId: YOU, event: 'identity.verified' })).created).toBe(true);
      // Three rewards given in all: the campaign's total.
      expect(await code(tasks.welcomeClaim({ accountId: YOU, event: 'pay.deposit' }))).toBe('campaigns.redemption_limit_reached');
      const [{ n }] = (await db.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM campaigns.reward_intents`) as unknown as [
        { n: number },
      ];
      expect(n).toBe(3);
      await reconciles(parseAmount('50'));
    });

    it('pays one reward per task, each once, under its own key, and it reconciles', async () => {
      await fundPot('50');
      const c = await live();
      await signUp(ME);
      await signUp(YOU);
      for (const e of ['identity.verified', 'pay.deposit', 'trade.fill'] as const) await happen(ME, e);
      await happen(YOU, 'trade.fill');
      for (const e of ['identity.verified', 'pay.deposit', 'trade.fill'] as const) {
        const first = await tasks.welcomeClaim({ accountId: ME, event: e });
        expect(first.created).toBe(true);
        expect(first.reward.state).toBe('posted');
        expect(first.reward.rewardKey).toBe(rewardKeyOf(c.id, ME, welcomePeriodOf(e)));
        const again = await tasks.welcomeClaim({ accountId: ME, event: e });
        expect(again).toMatchObject({ created: false, reward: { rewardKey: first.reward.rewardKey, ledgerTxId: first.reward.ledgerTxId } });
      }
      // Two claims at once: one intent and one posting.
      const both = await Promise.all([
        tasks.welcomeClaim({ accountId: YOU, event: 'trade.fill' }),
        tasks.welcomeClaim({ accountId: YOU, event: 'trade.fill' }),
      ]);
      expect(both.filter((r) => r.created)).toHaveLength(1);
      expect(await free(ME)).toBe(parseAmount('6'));
      expect(await free(YOU)).toBe(parseAmount('3'));
      const list = await tasks.welcomeChecklist({ accountId: ME });
      expect(list.tasks.map((t) => [t.state, t.record?.state])).toEqual([
        ['claimed', 'posted'],
        ['claimed', 'posted'],
        ['claimed', 'posted'],
      ]);
      await reconciles(parseAmount('50'));
    });

    it('after the window: every task reads expired, a claim refuses and nothing is written', async () => {
      await fundPot('50');
      await live({ tasks: { ...WELCOME, welcomeWindowSeconds: 60 } });
      await signUp(ME, ago(50_000));
      await happen(ME, 'identity.verified', ago(40_000));
      await happen(YOU, 'identity.verified');
      clock = new Date(Date.now() + 20_000);
      const list = await tasks.welcomeChecklist({ accountId: ME });
      expect(list.window?.state).toBe('expired');
      expect(list.tasks.map((t) => t.state)).toEqual(['expired', 'expired', 'expired']);
      expect(await code(tasks.welcomeClaim({ accountId: ME, event: 'identity.verified' }))).toBe('campaigns.claim_expired');
      expect(await db.sql`SELECT 1 FROM campaigns.reward_intents`).toHaveLength(0);
      await reconciles(parseAmount('50'));
    });

    it('withholds the reward of an account that is not active, before any ledger call', async () => {
      await fundPot('50');
      await live();
      await signUp(ME);
      await happen(ME, 'trade.fill');
      people.set(ME, person(ME, { status: 'frozen' }));
      const held = await tasks.welcomeClaim({ accountId: ME, event: 'trade.fill' });
      expect(held.reward).toMatchObject({ state: 'withheld', reason: 'account.frozen', ledgerTxId: null });
      expect(await free(ME)).toBe(0n);
      // Active again inside the window: the same key is paid once.
      people.set(ME, person(ME));
      const paid = await tasks.welcomeClaim({ accountId: ME, event: 'trade.fill' });
      expect(paid.reward.state).toBe('posted');
      expect(await free(ME)).toBe(parseAmount('3'));
      await reconciles(parseAmount('50'));
    });

    it('keeps an empty pot open as pending funding; it pays once on the same key after funding', async () => {
      const c = await live();
      await signUp(ME);
      await happen(ME, 'identity.verified');
      const first = await tasks.welcomeClaim({ accountId: ME, event: 'identity.verified' });
      expect(first.reward.state).toBe('pending_funding');
      await fundPot('10');
      await db.sql`UPDATE campaigns.reward_intents SET last_attempt_at = now() - interval '1 minute'`;
      const saga = new PayoutSaga({ sql: db.sql, ledger: book, reconcileAfterSeconds: 1 });
      await saga.reconcile();
      await saga.reconcile();
      const key = rewardKeyOf(c.id, ME, welcomePeriodOf('identity.verified'));
      expect(await book.getTxByKey(`reward:${key}`)).not.toBeNull();
      expect(await free(ME)).toBe(parseAmount('1'));
      await reconciles(parseAmount('10'));
    });

    it('places a sign-up read late under the campaign that ran then, even once it has ended', async () => {
      const c = await live();
      const at = ago(30_000);
      await campaigns().transition({ id: c.id, action: 'end', revision: 1, actor: A });
      await signUp(ME, at);
      const list = await tasks.welcomeChecklist({ accountId: ME });
      expect(list.campaign).toMatchObject({ id: c.id, state: 'ended' });
      // The campaign no longer runs: claims refuse by name, and nothing is written.
      await happen(ME, 'trade.fill');
      expect(await code(tasks.welcomeClaim({ accountId: ME, event: 'trade.fill' }))).toBe('campaign.not_active');
      expect(await db.sql`SELECT 1 FROM campaigns.reward_intents`).toHaveLength(0);
    });

    it('pays a reward withheld when its hold ended once the account is active again, after the window, once, without a second hold', async () => {
      await fundPot('50');
      const c = await live({ tasks: { ...WELCOME, holdSeconds: 60, welcomeWindowSeconds: 600 } });
      await signUp(ME, ago(60_000));
      await happen(ME, 'trade.fill', ago(30_000));
      const held = await tasks.welcomeClaim({ accountId: ME, event: 'trade.fill' });
      expect(held.reward.state).toBe('held');
      // The hold ends while the account is frozen: withheld, nothing posted.
      people.set(ME, person(ME, { status: 'frozen' }));
      clock = new Date(Date.now() + 120_000);
      await tasks.releaseHolds();
      const key = rewardKeyOf(c.id, ME, welcomePeriodOf('trade.fill'));
      expect((await db.sql`SELECT state FROM campaigns.reward_intents WHERE reward_key = ${key}`)[0]).toEqual({ state: 'withheld' });
      // Active again after the welcome window closed: the claim pays the served reward at once, under the same key.
      people.set(ME, person(ME));
      clock = new Date(Date.now() + 3_600_000);
      expect((await tasks.welcomeChecklist({ accountId: ME })).window?.state).toBe('expired');
      const paid = await tasks.welcomeClaim({ accountId: ME, event: 'trade.fill' });
      expect(paid.reward).toMatchObject({ rewardKey: key, state: 'posted', amount: '3' });
      expect(await free(ME)).toBe(parseAmount('3'));
      await reconciles(parseAmount('50'));
    });

    it('keeps nothing for an account whose sign-up was read with no welcome campaign live', async () => {
      await signUp(LATE);
      await happen(LATE, 'trade.fill');
      expect(await db.sql`SELECT 1 FROM campaigns.welcome_events WHERE account_id = ${LATE}`).toHaveLength(0);
    });
  });
}
