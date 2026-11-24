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
  type LedgerClient,
  type PostRequest,
} from '@intafaced/ledger-client';
import type { CampaignParticipant } from '@intafaced/contracts';
import type { CampaignDefinitionInput, CampaignPool } from '@intafaced/contracts/campaigns-catalogue';
import { CampaignService } from './campaigns.js';
import type { CompetitionFill } from './competitions.js';
import { PayoutSaga, ledgerRewardId } from './payouts.js';
import { PoolService, SETTLE_AFTER_MS, poolKeyOf } from './pools.js';
import type { EquitySource } from './venue-equity.js';

/**
 * Reward pools paying daily (J-campaigns-13 #4 #5, CM-airdrop-campaigns-02) against real Postgres and the in-memory
 * reference ledger with the custodial layer off. Every settle test ends with the invariant: each settled day's shares
 * plus its remainder equal its slice, each share is one reward intent under its business key owed once in the ledger
 * for exactly its amount, no share passes the per-user cap, and an entrant below the minimum balance is owed nothing.
 */

const adminUrl = process.env.TEST_DATABASE_URL?.trim();
if (!adminUrl && (process.env.REQUIRE_POSTGRES === '1' || process.env.CI === 'true' || process.env.CI === '1')) {
  throw new Error('TEST_DATABASE_URL is required');
}
const available = await postgresAvailable(adminUrl);
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
const ANN = '00000000-0000-4000-8000-0000000000a1';
const BEN = '00000000-0000-4000-8000-0000000000b2';
const CAT = '00000000-0000-4000-8000-0000000000c3';
const DAN = '00000000-0000-4000-8000-0000000000d4';
const FUNDER = '00000000-0000-4000-8000-0000000000f6';
const MIN = 60_000;
const HOUR = 3_600_000;
const PAY_DECIMALS = 6;
const DAY_SECONDS = 600;

const participants = {
  read: async (userId: string): Promise<CampaignParticipant> => ({
    userId,
    accountType: 'individual',
    region: 'DE',
    status: 'active',
    kycTier: 'full',
  }),
};

const TERMS: CampaignPool = { activityAsset: 'USDC', dailySlice: '1', perUserCap: '0.5', minBalance: '10', daySeconds: DAY_SECONDS };
/** The pool started 25 minutes ago: day 1 and day 2 have ended, day 3 is under way. */
let started: number;
let names = 0;
const definition = (over: Partial<CampaignDefinitionInput> = {}): CampaignDefinitionInput => ({
  name: `TEST pool ${(names += 1)}`,
  type: 'pool',
  rules: 'TEST rules: trade on the venue through INTAFACED; each day the slice is shared by activity, capped per person.',
  startsAt: new Date(started).toISOString(),
  endsAt: new Date(started + 24 * HOUR).toISOString(),
  participation: { exclusions: [], regionScope: 'platform', restrictedRegions: null },
  budget: { asset: 'USDC', limit: '10' },
  limits: { perCustomer: { count: 1, periodSeconds: 86_400 }, totalRedemptions: null },
  reward: null,
  pool: TERMS,
  ...over,
});

let book: MemoryLedger;
let saga: PayoutSaga;
let campaigns: CampaignService;
let fills: Map<string, CompetitionFill[] | 'unread'>;
let balances: Map<string, string | 'unread'>;
let clock: number | null;
let pools: PoolService;

const at = (dayNumber: number, minute: number) => new Date(started + (dayNumber - 1) * DAY_SECONDS * 1000 + minute * MIN).toISOString();
const fill = (fillId: string, notional: string, filledAt: string, over: Partial<CompetitionFill> = {}): CompetitionFill => ({
  fillId,
  venueAccount: '0xowner',
  symbol: 'BTC-USDC',
  quoteAsset: 'USDC',
  notional,
  builderFee: '0.3',
  filledAt,
  ...over,
});

beforeEach(async () => {
  if (!db) return;
  await db.sql`TRUNCATE campaigns.campaigns, campaigns.participations, campaigns.reward_intents, campaigns.redemption_attempts,
    campaigns.pool_days, campaigns.pool_day_shares, campaigns.audit_log CASCADE`;
  started = Date.now() - 25 * MIN;
  book = new MemoryLedger();
  const ledger: LedgerClient = {
    post: async (request: PostRequest) => {
      if (movesCustomerBalance(request.entries)) throw new LedgerError('custody layer off', CUSTODY_LAYER_OFF_CODE);
      return book.post(request);
    },
    balance: (ref) => book.balance(ref),
    balances: (t, id) => book.balances(t, id),
    getTx: (id) => book.getTx(id),
    getTxByKey: (key) => book.getTxByKey(key),
  };
  await book.post(recipes.deposit({ userId: FUNDER, assetId: 'USDC', amount: parseAmount('100'), rail: 'test', railRef: 'seed' }));
  await book.post(
    recipes.feeCharge({ chargeId: 'seed', userId: FUNDER, module: 'trade', mode: 'asset', assetId: 'USDC', amount: parseAmount('100') }),
  );
  await book.post(recipes.sweepFeesToRewards({ windowId: 'seed', sourceModule: 'trade', assetId: 'USDC', amount: parseAmount('100') }));
  saga = new PayoutSaga({
    sql: db.sql,
    ledger,
    reconcileAfterSeconds: 0,
    rewardCeiling: { perCampaign: parseAmount('100'), total: parseAmount('1000') },
  });
  clock = null;
  campaigns = new CampaignService({ sql: db.sql, timeZone: () => 'UTC', participants });
  fills = new Map();
  balances = new Map();
  const equity: EquitySource = {
    equity: async (userId) => {
      const b = balances.get(userId) ?? '100';
      return b === 'unread' ? { unread: 'trade.venue.venue_down' } : { venueId: 'test-venue', asOf: new Date().toISOString(), equity: b };
    },
  };
  pools = new PoolService({
    sql: db.sql,
    saga,
    fills: {
      ourFills: async (userId) => {
        const list = fills.get(userId) ?? [];
        return list === 'unread'
          ? { unread: 'trade.venue.venue_down' }
          : { venueId: 'test-venue', asOf: new Date().toISOString(), fills: list };
      },
    },
    equity,
    payDecimals: PAY_DECIMALS,
    now: () => new Date(clock ?? Date.now()),
  });
});

async function live(over: Partial<CampaignDefinitionInput> = {}) {
  const c = await campaigns.create({ definition: definition(over), actor: A });
  await campaigns.transition({ id: c.id, action: 'submit', revision: 1, actor: A });
  await campaigns.transition({ id: c.id, action: 'approve', revision: 1, actor: B });
  await campaigns.transition({ id: c.id, action: 'activate', revision: 1, actor: A });
  return c;
}

/** Joins each account at the pool's start. */
async function joined(campaignId: string, accounts: readonly string[]) {
  for (const accountId of accounts) await campaigns.join({ campaignId, accountId });
  await db!.sql`UPDATE campaigns.participations SET created_at = ${new Date(started)} WHERE campaign_id = ${campaignId}`;
}

const intents = async (campaignId: string) =>
  db!.sql<{ reward_key: string; account_id: string; amount: string; state: string; period: string }[]>`
    SELECT reward_key, account_id, amount::text AS amount, state, period FROM campaigns.reward_intents
    WHERE campaign_id = ${campaignId} ORDER BY reward_key`;

/** The invariant (see the file's comment). */
async function reconciles(campaignId: string) {
  const days = await db!.sql<{ day: number; slice: string; shares_total: string; remainder: string }[]>`
    SELECT day, slice::text AS slice, shares_total::text AS shares_total, remainder::text AS remainder
    FROM campaigns.pool_days WHERE campaign_id = ${campaignId} ORDER BY day`;
  const owed = await intents(campaignId);
  for (const d of days) {
    const mine = owed.filter((r) => r.period === `pool:${d.day}`);
    const total = mine.reduce((n, r) => n + parseAmount(r.amount), 0n);
    expect(total).toBe(parseAmount(d.shares_total));
    expect(parseAmount(d.shares_total) + parseAmount(d.remainder)).toBe(parseAmount(d.slice));
    for (const r of mine) {
      expect(r.state, r.reward_key).toBe('owed');
      expect(r.reward_key).toBe(poolKeyOf(campaignId, d.day, r.account_id));
      expect(parseAmount(r.amount)).toBeLessThanOrEqual(parseAmount(TERMS.perUserCap!));
      expect((await book.balance(rewardOwedAccount(ledgerRewardId(campaignId, r.reward_key)))).amount, r.reward_key).toBe(
        parseAmount(r.amount),
      );
    }
  }
  const below = await db!.sql`
    SELECT 1 FROM campaigns.pool_day_shares WHERE campaign_id = ${campaignId} AND NOT eligible AND reward_key IS NOT NULL`;
  expect(below).toHaveLength(0);
}

describe.skipIf(!available)('reward pools paying daily (J-campaigns-13)', () => {
  it('refuses to go live without every term, or with a budget short of one slice', async () => {
    const gaps = async (over: Partial<CampaignDefinitionInput>) => {
      const c = await campaigns.create({ definition: definition(over), actor: A });
      return campaigns
        .transition({ id: c.id, action: 'submit', revision: 1, actor: A })
        .then(() => [] as string[])
        .catch((err: { code?: string }) => [err.code ?? '']);
    };
    for (const field of ['activityAsset', 'dailySlice', 'perUserCap', 'minBalance', 'daySeconds'] as const) {
      expect(await gaps({ pool: { ...TERMS, [field]: null } }), field).toEqual(['campaigns.pool_unset']);
    }
    expect(await gaps({ pool: null })).toEqual(['campaigns.pool_unset']);
    expect(await gaps({ budget: { asset: 'USDC', limit: '0.5' } })).toEqual(['campaigns.prize_pool_short']);
    await expect(campaigns.create({ definition: definition({ type: 'task' }), actor: A })).rejects.toMatchObject({
      code: 'campaigns.pool_invalid',
    });
    await expect(campaigns.create({ definition: definition({ pool: { ...TERMS, dailySlice: '0' } }), actor: A })).rejects.toMatchObject({
      code: 'campaigns.pool_invalid',
    });
  });

  it("shares a day's slice by activity read from the venue, capped per user, the overflow staying in the pool", async () => {
    const c = await live();
    await joined(c.id, [ANN, BEN, CAT, DAN]);
    fills.set(ANN, [
      fill('a1', '600', at(1, 2)),
      // The same fill again (a redelivery): counted once.
      fill('a1', '600', at(1, 2)),
      // Another asset, no builder fee, and the next day: none counts for day 1.
      fill('a2', '999', at(1, 3), { quoteAsset: 'USDT' }),
      fill('a3', '999', at(1, 3), { builderFee: '0' }),
      fill('a4', '200', at(2, 1)),
    ]);
    fills.set(BEN, [fill('b1', '300', at(1, 4))]);
    fills.set(CAT, [fill('c1', '100', at(1, 5))]);
    // DAN traded but holds less than the minimum balance: nothing today, and not in the total.
    fills.set(DAN, [fill('d1', '5000', at(1, 5))]);
    balances.set(DAN, '9.99');
    const { settled, day } = await pools.settle(c.id, 1, { actor: A, reason: 'TEST settle day 1' });
    expect(settled).toBe(true);
    // Total 1000: ANN 0.6 capped to 0.5, BEN 0.3, CAT 0.1; the 0.1 the cap kept back stays in the pool.
    expect(day).toMatchObject({ day: 1, slice: '1', totalActivity: '1000', sharesTotal: '0.9', remainder: '0.1' });
    expect((await intents(c.id)).map((r) => [r.account_id, r.amount, r.period])).toEqual([
      [ANN, '0.500000000000000000', 'pool:1'],
      [BEN, '0.300000000000000000', 'pool:1'],
      [CAT, '0.100000000000000000', 'pool:1'],
    ]);
    await reconciles(c.id);
    const board = await pools.board({ campaignId: c.id, accountId: ANN });
    expect(board).toMatchObject({ dailySlice: '1', perUserCap: '0.5', minBalance: '10', joined: true });
    expect(board.days.map((d) => d.day)).toEqual([3, 2, 1]);
    expect(board.days.find((d) => d.day === 1)!.mine).toMatchObject({
      activity: '600',
      eligible: true,
      share: '0.5',
      capped: true,
      rewardKey: poolKeyOf(c.id, 1, ANN),
      state: 'owed',
    });
    expect(board.days.find((d) => d.day === 2)!).toMatchObject({ settledAt: null, mine: null });
    const dan = await pools.board({ campaignId: c.id, accountId: DAN });
    expect(dan.days.find((d) => d.day === 1)!.mine).toMatchObject({
      activity: '5000',
      balance: '9.99',
      eligible: false,
      share: '0',
      rewardKey: null,
    });
    // Today, read now from the venue with its as-of time: DAN is below the minimum.
    expect(dan.today).toMatchObject({ day: 3, balance: '9.99', belowMinimum: true, unread: null });
    expect(dan.today!.balanceAsOf).toMatch(/^\d{4}-/);
    expect(board.today).toMatchObject({ day: 3, balance: '100', belowMinimum: false });
  });

  it('a day settled twice, or twice at once, is owed once; the tick settles every ended day in order', async () => {
    const c = await live();
    await joined(c.id, [ANN, BEN]);
    fills.set(ANN, [fill('a1', '10', at(1, 1)), fill('a2', '10', at(2, 1))]);
    fills.set(BEN, [fill('b1', '30', at(1, 1))]);
    const [one, two] = await Promise.all([pools.settle(c.id, 1), pools.settle(c.id, 1)]);
    expect([one.settled, two.settled].sort()).toEqual([false, true]);
    const first = await intents(c.id);
    expect((await pools.settle(c.id, 1)).settled).toBe(false);
    await pools.tick();
    await pools.tick();
    const after = await intents(c.id);
    expect(after.filter((r) => r.period === 'pool:1')).toEqual(first);
    // Day 2 settled by the tick: ANN alone, capped at 0.5 of the 1 slice.
    expect(after.filter((r) => r.period === 'pool:2').map((r) => [r.account_id, r.amount])).toEqual([[ANN, '0.500000000000000000']]);
    expect(first.map((r) => [r.account_id, r.amount])).toEqual([
      [ANN, '0.250000000000000000'],
      [BEN, '0.500000000000000000'],
    ]);
    await reconciles(c.id);
  });

  it('refuses a day still open or past the end, and waits on an unread entrant, writing nothing', async () => {
    const c = await live();
    await joined(c.id, [ANN, BEN]);
    await expect(pools.settle(c.id, 3)).rejects.toMatchObject({ code: 'campaigns.pool_day_open' });
    await expect(pools.settle(c.id, 500)).rejects.toMatchObject({ code: 'campaigns.pool_day_unknown' });
    // Day 2 ended under the settle wait: still open.
    clock = new Date(at(3, 0)).getTime() + SETTLE_AFTER_MS - 1_000;
    await expect(pools.settle(c.id, 2)).rejects.toMatchObject({ code: 'campaigns.pool_day_open' });
    clock = null;
    fills.set(BEN, 'unread');
    await expect(pools.settle(c.id, 1)).rejects.toMatchObject({ code: 'campaigns.fills_unread' });
    fills.set(BEN, []);
    balances.set(ANN, 'unread');
    await expect(pools.settle(c.id, 1)).rejects.toMatchObject({ code: 'campaigns.equity_unread' });
    expect(await db!.sql`SELECT 1 FROM campaigns.pool_days WHERE campaign_id = ${c.id}`).toHaveLength(0);
    expect(await intents(c.id)).toEqual([]);
    const board = await pools.board({ campaignId: c.id, accountId: ANN });
    expect(board.today).toMatchObject({ day: 3, balance: null, belowMinimum: null, unread: 'trade.venue.venue_down' });
  });

  it('a day with no activity keeps its whole slice in the pool, and the slice shrinks to what the budget has left', async () => {
    const c = await live({ budget: { asset: 'USDC', limit: '1.2' } });
    await joined(c.id, [ANN]);
    expect((await pools.settle(c.id, 1)).day).toMatchObject({ slice: '1', totalActivity: '0', sharesTotal: '0', remainder: '1' });
    fills.set(ANN, [fill('a1', '10', at(2, 1))]);
    // Day 1 drew nothing, so day 2 still has its full slice; the cap holds ANN to 0.5.
    expect((await pools.settle(c.id, 2)).day).toMatchObject({ slice: '1', sharesTotal: '0.5', remainder: '0.5' });
    await reconciles(c.id);
    const tight = await live({ budget: { asset: 'USDC', limit: '1.2' } });
    await joined(tight.id, [ANN, BEN]);
    fills.set(ANN, [fill('t1', '10', at(1, 1)), fill('t2', '10', at(2, 1))]);
    fills.set(BEN, [fill('t3', '10', at(1, 1)), fill('t4', '10', at(2, 1))]);
    expect((await pools.settle(tight.id, 1)).day).toMatchObject({ slice: '1', sharesTotal: '1', remainder: '0' });
    // 0.2 left of the budget: day 2's slice is 0.2.
    expect((await pools.settle(tight.id, 2)).day).toMatchObject({ slice: '0.2', sharesTotal: '0.2', remainder: '0' });
    await reconciles(tight.id);
  });

  it('counts only activity after the entrant joined', async () => {
    const c = await live();
    await joined(c.id, [ANN, BEN]);
    await db!.sql`
      UPDATE campaigns.participations SET created_at = ${new Date(at(1, 5))} WHERE campaign_id = ${c.id} AND account_id = ${BEN}`;
    fills.set(ANN, [fill('a1', '10', at(1, 1))]);
    fills.set(BEN, [fill('b1', '1000', at(1, 2)), fill('b2', '10', at(1, 6))]);
    expect((await pools.settle(c.id, 1)).day).toMatchObject({ totalActivity: '20', sharesTotal: '1', remainder: '0' });
    await reconciles(c.id);
  });
});
