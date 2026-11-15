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
import type { CampaignCompetition, CampaignDefinitionInput } from '@intafaced/contracts/campaigns-catalogue';
import { CampaignService } from './campaigns.js';
import { CompetitionService, SETTLE_AFTER_MS, milestoneKeyOf, placeKeyOf, type CompetitionFill } from './competitions.js';
import { PayoutSaga, ledgerRewardId } from './payouts.js';

/**
 * Trading competitions (J-campaigns-11, CM-promotions-events-01) against real Postgres and the in-memory reference ledger
 * with the custodial layer off. Every prize test ends with the invariant: each prize is one reward intent under its
 * business key, owed once in the ledger for exactly its amount, and the settlement's prizes + remainder equal the pool.
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
const FUNDER = '00000000-0000-4000-8000-0000000000f4';
const HOUR = 3_600_000;
const WALLET_ANN = '0x1111111111111111111111111111111111111111';
const FORWARDED = { 'x-intafaced-principal': 'TEST' };

const participants = {
  read: async (userId: string): Promise<CampaignParticipant> => ({
    userId,
    accountType: 'individual',
    region: 'DE',
    status: 'active',
    kycTier: 'full',
  }),
};

const TERMS: CampaignCompetition = {
  basis: 'volume',
  volumeAsset: 'USDC',
  threshold: '1000',
  seats: 3,
  prizes: [
    { rank: 1, amount: '5' },
    { rank: 2, amount: '3' },
  ],
  milestones: [
    { volume: '2000', amount: '1' },
    { volume: '50000', amount: '2' },
  ],
};
let names = 0;
const definition = (over: Partial<CampaignDefinitionInput> = {}): CampaignDefinitionInput => ({
  name: `TEST competition ${(names += 1)}`,
  type: 'competition',
  rules: 'TEST rules: trade on the venue through INTAFACED; ranked by volume.',
  startsAt: new Date(Date.now() - HOUR).toISOString(),
  endsAt: new Date(Date.now() + 24 * HOUR).toISOString(),
  participation: { exclusions: [], regionScope: 'platform', restrictedRegions: null },
  // Places 5 + 3, and three seats each reaching both milestones (3 x 3): 17, the least a pool may be.
  budget: { asset: 'USDC', limit: '20' },
  limits: { perCustomer: { count: 10, periodSeconds: 86_400 }, totalRedemptions: null },
  reward: null,
  competition: TERMS,
  ...over,
});

let book: MemoryLedger;
let ledger: LedgerClient;
let saga: PayoutSaga;
let campaigns: CampaignService;
let fills: Map<string, CompetitionFill[] | 'unread'>;
/** Null: real time. Set only to step past the period's close. */
let clock: number | null;
let wallets: string[] | null;
let competitions: CompetitionService;

const fill = (fillId: string, notional: string, over: Partial<CompetitionFill> = {}): CompetitionFill => ({
  fillId,
  venueAccount: '0xowner',
  symbol: 'BTC-USDC',
  quoteAsset: 'USDC',
  notional,
  builderFee: '0.3',
  // A second ago: after every entrant's join (`entered` puts it a minute back) and before now.
  filledAt: new Date(Date.now() - 1_000).toISOString(),
  ...over,
});

beforeEach(async () => {
  if (!db) return;
  await db.sql`TRUNCATE campaigns.campaigns, campaigns.participations, campaigns.reward_intents, campaigns.redemption_attempts,
    campaigns.competition_entries, campaigns.competition_fills, campaigns.competition_milestones, campaigns.competition_settlements,
    campaigns.audit_log CASCADE`;
  book = new MemoryLedger();
  // svc-ledger with the custodial layer off: a recipe that touches a customer account is refused.
  ledger = {
    post: async (request: PostRequest) => {
      if (movesCustomerBalance(request.entries)) throw new LedgerError('custody layer off', CUSTODY_LAYER_OFF_CODE);
      return book.post(request);
    },
    balance: (ref) => book.balance(ref),
    balances: (t, id) => book.balances(t, id),
    getTx: (id) => book.getTx(id),
    getTxByKey: (key) => book.getTxByKey(key),
  };
  // TEST USDC in the rewards engine, swept there from TEST fees, as the stack's founders fund it.
  await book.post(recipes.deposit({ userId: FUNDER, assetId: 'USDC', amount: parseAmount('100'), rail: 'test', railRef: 'seed' }));
  await book.post(
    recipes.feeCharge({ chargeId: 'seed', userId: FUNDER, module: 'trade', mode: 'asset', assetId: 'USDC', amount: parseAmount('100') }),
  );
  await book.post(recipes.sweepFeesToRewards({ windowId: 'seed', sourceModule: 'trade', assetId: 'USDC', amount: parseAmount('100') }));
  saga = new PayoutSaga({
    sql: db.sql,
    ledger,
    reconcileAfterSeconds: 5,
    rewardCeiling: { perCampaign: parseAmount('100'), total: parseAmount('1000') },
  });
  clock = null;
  campaigns = new CampaignService({ sql: db.sql, timeZone: () => 'UTC', participants });
  fills = new Map();
  wallets = [WALLET_ANN];
  competitions = new CompetitionService({
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
    wallets: async (forwarded) => (Object.keys(forwarded).length > 0 ? wallets : null),
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

/**
 * The entrants joined a minute ago: a TEST fill stamped by this process's millisecond clock then always falls after the
 * join, which Postgres stamps to the microsecond.
 */
async function entered(campaignId: string) {
  await db!.sql`UPDATE campaigns.competition_entries SET joined_at = joined_at - interval '1 minute' WHERE campaign_id = ${campaignId}`;
}

/** Ends the period now, by operators, and moves the clock past the settle delay. */
async function close(id: string) {
  await campaigns.transition({ id, action: 'end', revision: 1, actor: A });
  clock = Date.now() + SETTLE_AFTER_MS + 1_000;
}

const intents = async (campaignId: string) =>
  db!.sql<{ reward_key: string; amount: string; state: string; period: string; hold_until: Date | null; pay_to_wallet: string | null }[]>`
    SELECT reward_key, amount::text AS amount, state, period, hold_until, pay_to_wallet FROM campaigns.reward_intents
    WHERE campaign_id = ${campaignId} ORDER BY reward_key`;

/** The invariant (see the file's comment). */
async function reconciles(campaignId: string) {
  let owed = 0n;
  for (const r of await intents(campaignId)) {
    expect(r.state, r.reward_key).toBe('owed');
    const amount = parseAmount(r.amount);
    expect((await book.balance(rewardOwedAccount(ledgerRewardId(campaignId, r.reward_key)))).amount, r.reward_key).toBe(amount);
    owed += amount;
  }
  const [s] = await db!.sql<{ pool: string; prizes_total: string; remainder: string }[]>`
    SELECT pool::text AS pool, prizes_total::text AS prizes_total, remainder::text AS remainder
    FROM campaigns.competition_settlements WHERE campaign_id = ${campaignId}`;
  if (s) {
    expect(parseAmount(s.prizes_total)).toBe(owed);
    expect(parseAmount(s.prizes_total) + parseAmount(s.remainder)).toBe(parseAmount(s.pool));
  }
}

describe.skipIf(!available)('competitions (J-campaigns-11)', () => {
  it('#1 refuses to go live without its terms, ranking by returns, or a pool short of every prize it could pay', async () => {
    const gaps = async (over: Partial<CampaignDefinitionInput>) => {
      const c = await campaigns.create({ definition: definition(over), actor: A });
      return campaigns
        .transition({ id: c.id, action: 'submit', revision: 1, actor: A })
        .then(() => [] as string[])
        .catch((err: { code?: string; message?: string }) => [err.code ?? '', err.message ?? '']);
    };
    expect((await gaps({ competition: { ...TERMS, basis: 'returns' } }))[0]).toBe('owner.decision');
    expect((await gaps({ competition: { ...TERMS, seats: null } }))[0]).toBe('campaigns.competition_unset');
    expect((await gaps({ competition: { ...TERMS, threshold: null } }))[0]).toBe('campaigns.competition_unset');
    expect((await gaps({ budget: { asset: 'USDC', limit: '16.99' } }))[0]).toBe('campaigns.prize_pool_short');
    expect((await gaps({ competition: null }))[0]).toBe('campaigns.competition_unset');
    // Only a competition has competition terms.
    await expect(campaigns.create({ definition: definition({ type: 'task' }), actor: A })).rejects.toMatchObject({
      code: 'campaigns.competition_invalid',
    });
    // The board shows the rules' terms: threshold, prize table, seats and the basis.
    const c = await live();
    const board = await competitions.board({ campaignId: c.id, accountId: ANN });
    expect(board).toMatchObject({
      basis: 'volume',
      volumeAsset: 'USDC',
      threshold: '1000',
      prizeAsset: 'USDC',
      pool: '20',
      prizes: TERMS.prizes,
      seats: 3,
      seatsLeft: 3,
      closed: false,
      mine: null,
      settlement: null,
    });
  });

  it('#2 gives the last seat to one of two joins at once; the other is refused, and a double press keeps one seat', async () => {
    const c = await live({ competition: { ...TERMS, seats: 2 }, budget: { asset: 'USDC', limit: '20' } });
    const [first, again] = await Promise.all([
      campaigns.join({ campaignId: c.id, accountId: ANN }),
      campaigns.join({ campaignId: c.id, accountId: ANN }),
    ]);
    expect(first.participation).toEqual(again.participation);
    expect((await competitions.board({ campaignId: c.id, accountId: ANN })).seatsLeft).toBe(1);
    const race = await Promise.allSettled([
      campaigns.join({ campaignId: c.id, accountId: BEN }),
      campaigns.join({ campaignId: c.id, accountId: CAT }),
    ]);
    expect(race.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const refused = race.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(refused.reason).toMatchObject({ code: 'campaigns.seats_full' });
    const seats = await db!.sql<
      { seat: number }[]
    >`SELECT seat FROM campaigns.competition_entries WHERE campaign_id = ${c.id} ORDER BY seat`;
    expect(seats.map((s) => s.seat)).toEqual([1, 2]);
    expect((await competitions.board({ campaignId: c.id, accountId: ANN })).seatsLeft).toBe(0);
  });

  it('#3 counts each venue fill once, leaves out fills that do not count, and keeps a stable order on a tie', async () => {
    const c = await live();
    for (const who of [ANN, BEN, CAT]) await campaigns.join({ campaignId: c.id, accountId: who });
    await entered(c.id);
    fills.set(ANN, [
      fill('f1', '600'),
      fill('f2', '600'),
      // No builder fee of ours, or below zero; another quote asset; before the join: none counts.
      fill('f3', '9000', { builderFee: '0' }),
      fill('f4', '9000', { builderFee: '-0.1' }),
      fill('f5', '9000', { quoteAsset: 'USDT' }),
      fill('f6', '9000', { filledAt: new Date(Date.now() - 2 * HOUR).toISOString() }),
    ]);
    fills.set(BEN, [fill('g1', '1200')]);
    await competitions.tick();
    // Read again (a redelivery of the same fills): nothing more counts.
    await competitions.tick();
    const board = await competitions.board({ campaignId: c.id, accountId: BEN });
    expect(board.standings.map((s) => [s.seat, s.volume, s.fills, s.you, s.qualifies])).toEqual([
      // A tie at 1200: the earlier seat first, on every read.
      [1, '1200', 2, false, true],
      [2, '1200', 1, true, true],
      [3, '0', 0, false, false],
    ]);
    expect(board.mine).toMatchObject({ seat: 2, rank: 2, volume: '1200' });
    const counted = await db!.sql`SELECT fill_id FROM campaigns.competition_fills WHERE campaign_id = ${c.id} ORDER BY fill_id`;
    expect(counted.map((r) => r.fill_id)).toEqual(['f1', 'f2', 'g1']);
    // A venue that does not answer is named, never read as no volume.
    fills.set(CAT, 'unread');
    expect((await competitions.board({ campaignId: c.id, accountId: CAT })).unread).toBe('trade.venue.venue_down');
  });

  it('#4 queues a milestone prize once when it is reached: owed now, held until the period closes', async () => {
    const c = await live();
    await campaigns.join({ campaignId: c.id, accountId: ANN });
    await entered(c.id);
    fills.set(ANN, [fill('f1', '1500')]);
    await competitions.tick();
    let board = await competitions.board({ campaignId: c.id, accountId: ANN, forwarded: FORWARDED });
    expect(board.milestones.map((m) => m.reached)).toEqual([false, false]);
    fills.set(ANN, [fill('f1', '1500'), fill('f2', '600')]);
    await competitions.tick();
    await competitions.tick();
    board = await competitions.board({ campaignId: c.id, accountId: ANN, forwarded: FORWARDED });
    expect(board.milestones[0]).toMatchObject({ tier: 1, reached: true, rewardKey: milestoneKeyOf(c.id, ANN, 1) });
    expect(board.milestones[1]!.reached).toBe(false);
    const rows = await intents(c.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ reward_key: milestoneKeyOf(c.id, ANN, 1), amount: '1.000000000000000000', state: 'owed' });
    expect(rows[0]!.hold_until?.getTime()).toBeGreaterThan(Date.now());
    // The wallet Ann had connected when she read the board in her own request.
    expect(rows[0]!.pay_to_wallet).toBe(WALLET_ANN);
    await reconciles(c.id);
  });

  it('#5 settles a closed period once: each place to its winner above the threshold, owed once, and prizes + remainder = pool', async () => {
    const c = await live();
    for (const who of [ANN, BEN, CAT]) await campaigns.join({ campaignId: c.id, accountId: who });
    await entered(c.id);
    fills.set(ANN, [fill('a1', '3000')]);
    fills.set(BEN, [fill('b1', '1500')]);
    // Below the threshold: no place prize, though a place is left.
    fills.set(CAT, [fill('c1', '999')]);
    await competitions.tick();
    // While a read of the venue fails, the period waits to be settled.
    await close(c.id);
    fills.set(CAT, 'unread');
    expect(await competitions.settle(c.id)).toBe(false);
    fills.set(CAT, [fill('c1', '999'), fill('c-late', '1', { filledAt: new Date(clock!).toISOString() })]);
    // Settled twice at once and again: written once.
    const [one, two] = await Promise.all([competitions.settle(c.id), competitions.settle(c.id)]);
    expect([one, two].filter(Boolean)).toHaveLength(1);
    expect(await competitions.settle(c.id)).toBe(false);
    await competitions.tick();
    const rows = await intents(c.id);
    expect(rows.map((r) => [r.reward_key, r.amount])).toEqual(
      [
        [milestoneKeyOf(c.id, ANN, 1), '1.000000000000000000'],
        [placeKeyOf(c.id, ANN), '5.000000000000000000'],
        [placeKeyOf(c.id, BEN), '3.000000000000000000'],
      ].sort((x, y) => x[0]!.localeCompare(y[0]!)),
    );
    // A milestone queued before the early close is paid at the close.
    const milestone = rows.find((r) => r.reward_key === milestoneKeyOf(c.id, ANN, 1))!;
    expect(milestone.hold_until!.getTime()).toBeLessThanOrEqual(clock!);
    const board = await competitions.board({ campaignId: c.id, accountId: BEN });
    expect(board.closed).toBe(true);
    expect(board.settlement).toMatchObject({
      winners: [
        { rank: 1, seat: 1, you: false, amount: '5' },
        { rank: 2, seat: 2, you: true, amount: '3' },
      ],
      prizesTotal: '9',
      remainder: '11',
    });
    // A fill after the close never counts.
    expect(board.standings.find((s) => s.seat === 3)!.volume).toBe('999');
    await reconciles(c.id);
  });
});
