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
import { DIVIDEND_OWNER_QUESTION, type CampaignDefinitionInput } from '@intafaced/contracts/campaigns-catalogue';
import { CampaignService } from './campaigns.js';
import { DistributionService, READ_GRACE_MS, distributionKeyOf, splitPool } from './distributions.js';
import { PayoutSaga, ledgerRewardId } from './payouts.js';
import type { EquitySource } from './venue-equity.js';

/**
 * Airdrop distributions (J-campaigns-13 #1 to #3, CM-airdrop-campaigns-01) against real Postgres and the in-memory
 * reference ledger with the custodial layer off. Every run test ends with the invariant: the shares sum exactly to the
 * pool (or to nothing when no equity counted), each share is one reward intent under its business key, owed once in the
 * ledger for exactly its amount, and no account excluded or held out is owed anything.
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
const EVE = '00000000-0000-4000-8000-0000000000e5';
const FUNDER = '00000000-0000-4000-8000-0000000000f6';
const MIN = 60_000;
const HOUR = 3_600_000;
/** USDC on the TEST chain: 6 decimals. */
const PAY_DECIMALS = 6;

const participants = {
  read: async (userId: string): Promise<CampaignParticipant> => ({
    userId,
    accountType: 'individual',
    region: 'DE',
    status: 'active',
    kycTier: 'full',
  }),
};

let names = 0;
const definition = (over: Partial<CampaignDefinitionInput> = {}): CampaignDefinitionInput => ({
  name: `TEST airdrop ${(names += 1)}`,
  type: 'distribution',
  rules: 'TEST rules: join before the snapshot; your share of the TEST pool follows your venue equity at the snapshot.',
  startsAt: new Date(Date.now() - HOUR).toISOString(),
  endsAt: new Date(Date.now() + 24 * HOUR).toISOString(),
  participation: { exclusions: [], regionScope: 'platform', restrictedRegions: null },
  budget: { asset: 'USDC', limit: '0.05' },
  limits: { perCustomer: { count: 1, periodSeconds: 86_400 }, totalRedemptions: null },
  reward: null,
  distribution: { kind: 'airdrop', snapshotAt: new Date(Date.now() + 5 * MIN).toISOString(), equityAsset: 'USDC' },
  ...over,
});

let book: MemoryLedger;
let saga: PayoutSaga;
let campaigns: CampaignService;
/** Each account's equity as the venue would answer, or `unread`, or `throw` (the process dies mid-read). */
let equities: Map<string, string | 'unread' | 'throw'>;
let reads: string[];
/** Null: real time. */
let clock: number | null;
let distributions: DistributionService;

const equity: EquitySource = {
  equity: async (userId, asset) => {
    expect(asset).toBe('USDC');
    reads.push(userId);
    const e = equities.get(userId) ?? '0';
    if (e === 'throw') throw new Error('TEST: the process stopped here');
    return e === 'unread' ? { unread: 'trade.venue.venue_down' } : { venueId: 'test-venue', asOf: new Date().toISOString(), equity: e };
  },
};

beforeEach(async () => {
  if (!db) return;
  await db.sql`TRUNCATE campaigns.campaigns, campaigns.participations, campaigns.reward_intents, campaigns.redemption_attempts,
    campaigns.distribution_runs, campaigns.distribution_standings, campaigns.audit_log CASCADE`;
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
  equities = new Map();
  reads = [];
  distributions = new DistributionService({
    sql: db.sql,
    saga,
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

/** Joins each account, then moves the clock past the snapshot. */
async function joinedThenSnapshot(campaignId: string, accounts: readonly string[]) {
  for (const accountId of accounts) await campaigns.join({ campaignId, accountId });
  clock = Date.now() + 6 * MIN;
}

const intents = async (campaignId: string) =>
  db!.sql<{ reward_key: string; account_id: string; amount: string; state: string; period: string }[]>`
    SELECT reward_key, account_id, amount::text AS amount, state, period FROM campaigns.reward_intents
    WHERE campaign_id = ${campaignId} ORDER BY reward_key`;

/** The invariant (see the file's comment). */
async function reconciles(campaignId: string) {
  const [run] = await db!.sql<{ pool: string; shares_total: string; total_equity: string; state: string }[]>`
    SELECT pool::text AS pool, shares_total::text AS shares_total, total_equity::text AS total_equity, state
    FROM campaigns.distribution_runs WHERE campaign_id = ${campaignId}`;
  expect(run!.state).toBe('owed');
  let owed = 0n;
  for (const r of await intents(campaignId)) {
    expect(r.state, r.reward_key).toBe('owed');
    expect(r.reward_key).toBe(distributionKeyOf(campaignId, r.account_id));
    const amount = parseAmount(r.amount);
    expect((await book.balance(rewardOwedAccount(ledgerRewardId(campaignId, r.reward_key)))).amount, r.reward_key).toBe(amount);
    owed += amount;
  }
  expect(parseAmount(run!.shares_total)).toBe(owed);
  expect(owed).toBe(parseAmount(run!.total_equity) === 0n ? 0n : parseAmount(run!.pool));
  const outside = await db!.sql<{ account_id: string }[]>`
    SELECT s.account_id FROM campaigns.distribution_standings s
    JOIN campaigns.reward_intents i ON i.reward_key = s.reward_key
    WHERE s.campaign_id = ${campaignId} AND s.standing <> 'counted'`;
  expect(outside).toEqual([]);
}

describe('splitPool', () => {
  const unit = 10n ** 12n;
  it('rounds each share down to a payable unit and gives the units left to the largest remainders, summing to the pool', () => {
    const pool = parseAmount('0.05');
    const shares = splitPool(pool, unit, [
      { key: 'a', weight: 1n },
      { key: 'b', weight: 1n },
      { key: 'c', weight: 1n },
    ]);
    expect([...shares.entries()]).toEqual([
      ['a', parseAmount('0.016667')],
      ['b', parseAmount('0.016667')],
      ['c', parseAmount('0.016666')],
    ]);
    expect([...shares.values()].reduce((n, s) => n + s, 0n)).toBe(pool);
  });

  it('keeps the sum exact for any weights, and shares nothing when no weight counts', () => {
    for (let seed = 1; seed <= 200; seed += 1) {
      const weights = Array.from({ length: (seed % 7) + 1 }, (_, i) => ({
        key: `k${i}`,
        weight: BigInt((seed * 7919 * (i + 3)) % 100_003),
      }));
      const pool = BigInt(seed * 13) * unit;
      const shares = splitPool(pool, unit, weights);
      const total = weights.reduce((n, w) => n + w.weight, 0n);
      const sum = [...shares.values()].reduce((n, s) => n + s, 0n);
      expect(sum).toBe(total === 0n ? 0n : pool);
      for (const s of shares.values()) expect(s % unit).toBe(0n);
    }
    expect(splitPool(parseAmount('1'), unit, [{ key: 'a', weight: 0n }]).size).toBe(0);
  });

  it('refuses a pool that is not a whole number of payable units', () => {
    expect(() => splitPool(parseAmount('0.0000001'), unit, [{ key: 'a', weight: 1n }])).toThrow(
      expect.objectContaining({ code: 'campaigns.distribution_invalid' }),
    );
  });
});

describe.skipIf(!available)('airdrop distributions (J-campaigns-13)', () => {
  it('refuses to go live without its snapshot or equity asset, and a dividend refuses the owner decision naming it', async () => {
    const gaps = async (over: Partial<CampaignDefinitionInput>) => {
      const c = await campaigns.create({ definition: definition(over), actor: A });
      return campaigns
        .transition({ id: c.id, action: 'submit', revision: 1, actor: A })
        .then(() => [] as string[])
        .catch((err: { code?: string; message?: string }) => [err.code ?? '', err.message ?? '']);
    };
    expect((await gaps({ distribution: { kind: 'airdrop', snapshotAt: null, equityAsset: 'USDC' } }))[0]).toBe(
      'campaigns.distribution_unset',
    );
    expect((await gaps({ distribution: { kind: 'airdrop', snapshotAt: new Date().toISOString(), equityAsset: null } }))[0]).toBe(
      'campaigns.distribution_unset',
    );
    expect((await gaps({ distribution: null }))[0]).toBe('campaigns.distribution_unset');
    expect(
      (
        await gaps({ distribution: { kind: 'airdrop', snapshotAt: new Date(Date.now() + 48 * HOUR).toISOString(), equityAsset: 'USDC' } })
      )[0],
    ).toBe('campaigns.distribution_invalid');
    expect(await gaps({ distribution: { kind: 'dividend', snapshotAt: new Date().toISOString(), equityAsset: 'USDC' } })).toEqual([
      'owner.decision',
      DIVIDEND_OWNER_QUESTION,
    ]);
    await expect(campaigns.create({ definition: definition({ type: 'task' }), actor: A })).rejects.toMatchObject({
      code: 'campaigns.distribution_invalid',
    });
  });

  it('lists nothing before any distribution, and refuses the dividend list with the owner question', async () => {
    expect(await distributions.mine({ accountId: ANN, kind: 'airdrop' })).toEqual({ records: [] });
    await expect(distributions.mine({ accountId: ANN, kind: 'dividend' })).rejects.toMatchObject({
      code: 'owner.decision',
      message: DIVIDEND_OWNER_QUESTION,
    });
  });

  it('refuses to run before the snapshot; a joiner waits until it is taken', async () => {
    const c = await live();
    await campaigns.join({ campaignId: c.id, accountId: ANN });
    await expect(distributions.run(c.id)).rejects.toMatchObject({ code: 'campaigns.snapshot_not_due' });
    await distributions.tick();
    expect(reads).toEqual([]);
    const { records } = await distributions.mine({ accountId: ANN, kind: 'airdrop' });
    expect(records).toMatchObject([{ campaignId: c.id, standing: 'waiting', share: null, equity: null, chainTx: null }]);
  });

  it('owes each share of the pool by equity, summing exactly to the pool; a negative equity is excluded, zero owed nothing', async () => {
    const c = await live();
    equities.set(ANN, '100').set(BEN, '100').set(CAT, '100').set(DAN, '-25.5').set(EVE, '0');
    await joinedThenSnapshot(c.id, [ANN, BEN, CAT, DAN, EVE]);
    const run = await distributions.run(c.id);
    expect(run).toMatchObject({
      state: 'owed',
      pool: '0.05',
      totalEquity: '300',
      counted: 4,
      excludedNegative: 1,
      heldOut: 0,
      sharesTotal: '0.05',
    });
    const owed = await intents(c.id);
    // 0.05 in three equal parts, to the cent's ten-thousandth the TEST chain pays in; the extra unit to the lowest id.
    expect(owed.map((r) => [r.account_id, r.amount])).toEqual([
      [ANN, '0.016667000000000000'],
      [BEN, '0.016667000000000000'],
      [CAT, '0.016666000000000000'],
    ]);
    await reconciles(c.id);
    const mine = async (who: string) => (await distributions.mine({ accountId: who, kind: 'airdrop' })).records[0]!;
    expect(await mine(ANN)).toMatchObject({
      standing: 'counted',
      equity: '100',
      share: '0.016667',
      rewardKey: distributionKeyOf(c.id, ANN),
      state: 'owed',
      chainTx: null,
    });
    expect(await mine(DAN)).toMatchObject({ standing: 'excluded_negative', equity: '-25.5', share: null, rewardKey: null });
    expect(await mine(EVE)).toMatchObject({ standing: 'counted', equity: '0', share: '0', rewardKey: null, state: null });
  });

  it('leaves out an account that joined after the snapshot', async () => {
    const c = await live();
    equities.set(ANN, '10').set(BEN, '10');
    await campaigns.join({ campaignId: c.id, accountId: ANN });
    await campaigns.join({ campaignId: c.id, accountId: BEN });
    await db!.sql`
      UPDATE campaigns.participations SET created_at = now() + interval '10 minutes' WHERE campaign_id = ${c.id} AND account_id = ${BEN}`;
    clock = Date.now() + 6 * MIN;
    expect(await distributions.run(c.id)).toMatchObject({ counted: 1, sharesTotal: '0.05' });
    expect((await intents(c.id)).map((r) => [r.account_id, r.amount])).toEqual([[ANN, '0.050000000000000000']]);
    expect(reads).toEqual([ANN]);
    expect((await distributions.mine({ accountId: BEN, kind: 'airdrop' })).records).toEqual([]);
    await reconciles(c.id);
  });

  it('names an unread account and waits; after the wait it is held out, never counted as zero, and owed nothing', async () => {
    const c = await live();
    equities.set(ANN, '30').set(BEN, 'unread').set(CAT, '10');
    await joinedThenSnapshot(c.id, [ANN, BEN, CAT]);
    expect(await distributions.run(c.id)).toMatchObject({ state: 'reading', heldOut: 1, counted: 2, sharesTotal: null });
    expect(await intents(c.id)).toEqual([]);
    // Within the wait it is read again; still unread.
    await distributions.tick();
    expect(reads.filter((r) => r === BEN)).toHaveLength(2);
    expect(reads.filter((r) => r === ANN)).toHaveLength(1);
    expect((await distributions.mine({ accountId: BEN, kind: 'airdrop' })).records[0]).toMatchObject({ standing: 'waiting' });
    // Past the wait: held out, named, out of the total; the others share the whole pool.
    clock = Date.now() + 6 * MIN + READ_GRACE_MS + 1_000;
    expect(await distributions.run(c.id)).toMatchObject({ state: 'owed', heldOut: 1, counted: 2, totalEquity: '40', sharesTotal: '0.05' });
    expect((await intents(c.id)).map((r) => [r.account_id, r.amount])).toEqual([
      [ANN, '0.037500000000000000'],
      [CAT, '0.012500000000000000'],
    ]);
    expect((await distributions.mine({ accountId: BEN, kind: 'airdrop' })).records[0]).toMatchObject({
      standing: 'held_out',
      heldOut: 'trade.venue.venue_down',
      equity: null,
      share: null,
      rewardKey: null,
    });
    await reconciles(c.id);
  });

  it('an account read late within the wait is counted from its own read', async () => {
    const c = await live();
    equities.set(ANN, '30').set(BEN, 'unread');
    await joinedThenSnapshot(c.id, [ANN, BEN]);
    expect(await distributions.run(c.id)).toMatchObject({ state: 'reading' });
    equities.set(BEN, '20');
    expect(await distributions.run(c.id)).toMatchObject({ state: 'owed', counted: 2, heldOut: 0, totalEquity: '50' });
    expect((await intents(c.id)).map((r) => [r.account_id, r.amount])).toEqual([
      [ANN, '0.030000000000000000'],
      [BEN, '0.020000000000000000'],
    ]);
    await reconciles(c.id);
  });

  it('a run killed part way resumes: nobody is read twice, and nobody is owed twice', async () => {
    const c = await live();
    equities.set(ANN, '1').set(BEN, 'throw').set(CAT, '3');
    await joinedThenSnapshot(c.id, [ANN, BEN, CAT]);
    await expect(distributions.run(c.id)).rejects.toThrow('TEST: the process stopped here');
    expect(await intents(c.id)).toEqual([]);
    equities.set(BEN, '1');
    // The next pass resumes: ANN is not read again.
    await distributions.tick();
    expect(reads.filter((r) => r === ANN)).toHaveLength(1);
    const first = await intents(c.id);
    expect(first.map((r) => [r.account_id, r.amount])).toEqual([
      [ANN, '0.010000000000000000'],
      [BEN, '0.010000000000000000'],
      [CAT, '0.030000000000000000'],
    ]);
    // Run again, by the tick and by an operator, and at the same time: nothing more is written or owed.
    await Promise.all([distributions.tick(), distributions.run(c.id, { actor: A, reason: 'TEST re-run' }), distributions.run(c.id)]);
    expect(await intents(c.id)).toEqual(first);
    expect(reads).toHaveLength(4);
    await reconciles(c.id);
    const [audited] = await db!.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM campaigns.audit_log WHERE target = ${c.id} AND action = 'campaign.distribution.run_requested'`;
    expect(audited!.n).toBe(1);
  });

  it('a share written but not yet owed when the process stopped is owed once by the reconciler', async () => {
    const c = await live();
    equities.set(ANN, '1');
    await joinedThenSnapshot(c.id, [ANN]);
    // The run with no saga: the share is written and the run owed, but nothing reached the ledger.
    const stopped = new DistributionService({ sql: db!.sql, saga: null, equity, payDecimals: PAY_DECIMALS, now: () => new Date(clock!) });
    expect(await stopped.run(c.id)).toMatchObject({ state: 'owed' });
    expect((await intents(c.id)).map((r) => r.state)).toEqual(['qualified']);
    await distributions.run(c.id);
    expect((await intents(c.id)).map((r) => r.state)).toEqual(['qualified']);
    await saga.reconcile();
    await saga.reconcile();
    await reconciles(c.id);
  });

  it('two runs at once write one set of shares', async () => {
    const c = await live();
    equities.set(ANN, '2').set(BEN, '3');
    await joinedThenSnapshot(c.id, [ANN, BEN]);
    await Promise.all([distributions.run(c.id), distributions.run(c.id), distributions.tick()]);
    expect((await intents(c.id)).map((r) => [r.account_id, r.amount])).toEqual([
      [ANN, '0.020000000000000000'],
      [BEN, '0.030000000000000000'],
    ]);
    await reconciles(c.id);
  });
});
