/**
 * CARD F4 money proof — ADL unconfigured without ranking (PTX-M09-R05).
 *
 * Hitch is already on origin/main: runAdlLastResort / parkUnderfundedWithAdl
 * refuse `trade.adl_unconfigured` when owner maxReduceBps is unset or invalid.
 * The mill consumes owner-chosen candidate order only — it does not rank,
 * does not default maxReduceBps, and does not run a socialized-loss recipe.
 * Not a redo of B8/#3724 (waterfall already on main). router.ts not recut.
 *
 * H8a PG-hard: this file never `describe.skip` / `postgresAvailable`. CI uses
 * TEST_DATABASE_URL (per-run `createTestDatabase`, not shared table mutations).
 * Local without that env starts Testcontainers `postgres:16-alpine`. Docker/PG
 * down is a failed suite, not a green skip.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { testPostgres } from '@intafaced/db/test-postgres';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { parseAmount as amt } from '@intafaced/ledger-client';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { partial } from '@intafaced/service-kit/testing';
import { memoryAdlDisclosureStore, ADL_DISCLOSURE_VERSION } from './adl-disclosure.js';
import {
  ADL_UNCONFIGURED,
  memoryAdlDisclosureEventStore,
  runAdlLastResort,
  sqlAdlDisclosureEventStore,
  type AdlCandidate,
  type AdlLastResortInput,
  type AdlOwnerPolicy,
  type AdlReducePort,
} from './adl-last-resort.js';
import { parkUnderfundedWithAdl } from './liquidation-adl-gate.js';
import { TEST_ADL_RANKING } from './adl-pairing.js';
import { tradeRouterPaths } from './testing/doors.js';
import type { FuturesJobsDeps } from './futures-jobs.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const CAROL = '33333333-3333-4333-8333-333333333333';
const BANKRUPT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CAND_SMALL = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CAND_LARGE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const MARKET = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const AT = new Date('2026-09-03T00:00:00.000Z');

function throwingReducer(): AdlReducePort {
  return {
    async reduce() {
      throw new Error('ADL reducer must not run when owner policy is unset — no socialized-loss default');
    },
  };
}

function opposingOutOfOrder(): readonly AdlCandidate[] {
  // Smaller opposing first, larger second. Ranking-by-size would reverse this.
  // The mill must leave both unconsumed when policy is null.
  return [
    { positionId: CAND_SMALL, userId: BOB, marketId: MARKET, side: 'short', size: amt('1') },
    { positionId: CAND_LARGE, userId: CAROL, marketId: MARKET, side: 'short', size: amt('99') },
  ];
}

async function unconfiguredInput(
  overrides: Partial<AdlLastResortInput> & Pick<AdlLastResortInput, 'policy' | 'events'>,
): Promise<AdlLastResortInput> {
  const acks = memoryAdlDisclosureStore();
  await acks.recordAck(BOB, ADL_DISCLOSURE_VERSION, AT);
  await acks.recordAck(CAROL, ADL_DISCLOSURE_VERSION, AT);
  return {
    bankrupt: {
      positionId: BANKRUPT,
      userId: ALICE,
      marketId: MARKET,
      side: 'long',
      uncoveredShortfall: amt('10'),
    },
    candidates: opposingOutOfOrder(),
    disclosureAcks: acks,
    reducer: throwingReducer(),
    at: AT,
    newEventId: () => {
      throw new Error('ADL event id must not mint when owner policy is unset');
    },
    ...overrides,
  };
}

/** A reducer that records the order it was asked to reduce in, and closes what it was asked. */
function recordingReducer(): AdlReducePort & { order: string[] } {
  const order: string[] = [];
  return {
    order,
    async reduce(input) {
      order.push(input.positionId);
      return { sizeClosed: input.sizeClosed };
    },
  };
}

function eventIds(): () => string {
  let n = 0;
  return () => `eeeeeeee-eeee-4eee-8eee-${String(++n).padStart(12, '0')}`;
}

describe('ADL unconfigured hitch — no ranking, no default maxReduceBps', () => {
  it('adl-last-resort.ts has no maxReduceBps default and does not sort/rank candidates', async () => {
    // A policy object with no maxReduceBps is unconfigured: the mill supplies no default of its own.
    const missing = await runAdlLastResort(
      await unconfiguredInput({ policy: partial<AdlOwnerPolicy>({}), events: memoryAdlDisclosureEventStore() }),
    );
    expect(missing).toMatchObject({ action: 'refused', code: ADL_UNCONFIGURED });
    // With an owner policy, the first eligible candidate in the order given is the one reduced: small first when the
    // owner put it first, large first when the owner put it first. Ranking by size would pick the same one both times.
    for (const order of [opposingOutOfOrder(), [...opposingOutOfOrder()].reverse()]) {
      const reducer = recordingReducer();
      const given = order.map((c) => c.positionId);
      const outcome = await runAdlLastResort(
        await unconfiguredInput({
          policy: { maxReduceBps: 10_000 },
          events: memoryAdlDisclosureEventStore(),
          candidates: order,
          reducer,
          newEventId: eventIds(),
        }),
      );
      expect(outcome).toMatchObject({ action: 'reduced', candidatePositionId: given[0] });
      expect(reducer.order).toEqual([given[0]]);
      expect(order.map((c) => c.positionId)).toEqual(given);
    }
  });

  it('liquidation-adl-gate.ts does not rank or invent maxReduceBps', async () => {
    const row = { positionId: BANKRUPT, userId: ALICE, marketId: MARKET, side: 'long' as const };
    const reason = 'insurance underfunded — refuse rather than overdraw';
    const acks = memoryAdlDisclosureStore();
    await acks.recordAck(BOB, ADL_DISCLOSURE_VERSION, AT);
    await acks.recordAck(CAROL, ADL_DISCLOSURE_VERSION, AT);
    // An owner ranking but no owner policy: refused, the reducer never runs.
    const noPolicy = await parkUnderfundedWithAdl({
      adl: { policy: null, ranking: TEST_ADL_RANKING, candidates: opposingOutOfOrder(), reducer: throwingReducer(), disclosureAcks: acks },
      row,
      fromInsurance: amt('10'),
      insuranceReason: reason,
      at: AT,
    });
    expect(noPolicy.reason).toBe(ADL_UNCONFIGURED);
    // A policy but no owner ranking: refused the same way, never a default ranking.
    const noRanking = await parkUnderfundedWithAdl({
      adl: { policy: { maxReduceBps: 10_000 }, candidates: opposingOutOfOrder(), reducer: throwingReducer(), disclosureAcks: acks },
      row,
      fromInsurance: amt('10'),
      insuranceReason: reason,
      at: AT,
    });
    expect(noRanking.reason).toBe(ADL_UNCONFIGURED);
    // Both owner settings: the gate hands the candidates on in the order given (the loader applies the ranking).
    for (const order of [opposingOutOfOrder(), [...opposingOutOfOrder()].reverse()]) {
      const reducer = recordingReducer();
      const parked = await parkUnderfundedWithAdl({
        adl: {
          policy: { maxReduceBps: 10_000 },
          ranking: TEST_ADL_RANKING,
          candidates: order,
          reducer,
          disclosureAcks: acks,
          events: memoryAdlDisclosureEventStore(),
          newEventId: eventIds(),
        },
        row,
        fromInsurance: amt('10'),
        insuranceReason: reason,
        at: AT,
      });
      expect(parked.outcome).toBe('skipped_insurance_underfunded');
      expect(reducer.order).toEqual([order[0]!.positionId]);
    }
    // A policy and ranking but no reducer: the gate's own reducer refuses rather than socialising the loss.
    await expect(
      parkUnderfundedWithAdl({
        adl: {
          policy: { maxReduceBps: 10_000 },
          ranking: TEST_ADL_RANKING,
          candidates: opposingOutOfOrder(),
          disclosureAcks: acks,
          newEventId: eventIds(),
        },
        row,
        fromInsurance: amt('10'),
        insuranceReason: reason,
        at: AT,
      }),
    ).rejects.toThrow(/no socialized-loss default/);
  });

  it('futures-jobs.ts / index.ts do not set maxReduceBps or rank candidates', () => {
    // The live host assembles its jobs through FuturesJobsDeps, which has no ADL slot: no policy, ranking or
    // maxReduceBps can be handed to the jobs. What the jobs hand the tick (no `adl`) is asserted in
    // futures-jobs-tick-wiring.test.ts ("omits the ADL policy").
    const base: FuturesJobsDeps = {
      sql: {} as never,
      ledger: {} as never,
      matching: {} as never,
      bus: null,
      config: { enabled: false, liqIntervalMs: 1000, fundingIntervalMs: null, fundingMarketIds: [], fundingMaxAbsRate: null },
    };
    // @ts-expect-error FuturesJobsDeps has no `adl`: the live jobs cannot carry an ADL policy.
    const withAdl: FuturesJobsDeps = { ...base, adl: { policy: { maxReduceBps: 10_000 } } };
    // @ts-expect-error FuturesJobsDeps has no `maxReduceBps`.
    const withBps: FuturesJobsDeps = { ...base, maxReduceBps: 10_000 };
    expect([withAdl, withBps]).toHaveLength(2);
  });

  it('router.ts not recut', () => {
    // No tRPC procedure runs, parks or tunes ADL: last resort runs only inside the liquidation tick.
    expect(tradeRouterPaths().filter((p) => /\badl|Adl|[dD]eleverag|[sS]ociali[sz]|lastResort/.test(p))).toEqual([]);
  });

  it('H8a money suite is not skip-green (no postgresAvailable / describe.skip)', () => {
    const src = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    expect(src).not.toMatch(/\bpostgresAvailable\s*\(/);
    expect(src).not.toMatch(/describe\.skip\s*\(/);
    expect(src).not.toMatch(/\bit\.skip\s*\(/);
  });
});

describe('ADL consumes the owner-chosen order on every path (no ranking, no reduce default)', () => {
  const DAVE = '44444444-4444-4444-8444-444444444444';
  const CAND_UNACKED = 'eeeeeeee-0000-4eee-8eee-000000000001';
  const CAND_SAME_SIDE = 'eeeeeeee-0000-4eee-8eee-000000000002';
  const CAND_OTHER_MARKET = 'eeeeeeee-0000-4eee-8eee-000000000003';
  /** Two eligible candidates of very different size and three that are never eligible, in every order. */
  const pool: readonly AdlCandidate[] = [
    { positionId: CAND_SMALL, userId: BOB, marketId: MARKET, side: 'short', size: amt('1') },
    { positionId: CAND_LARGE, userId: CAROL, marketId: MARKET, side: 'short', size: amt('99') },
    { positionId: CAND_UNACKED, userId: DAVE, marketId: MARKET, side: 'short', size: amt('500') },
    { positionId: CAND_SAME_SIDE, userId: BOB, marketId: MARKET, side: 'long', size: amt('700') },
    { positionId: CAND_OTHER_MARKET, userId: CAROL, marketId: 'ffffffff-ffff-4fff-8fff-ffffffffffff', side: 'short', size: amt('900') },
  ];
  const eligible = new Set([CAND_SMALL, CAND_LARGE]);
  function permutations<T>(items: readonly T[]): T[][] {
    if (items.length <= 1) return [[...items]];
    return items.flatMap((item, i) => permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]));
  }

  it('runAdlLastResort reduces the first eligible candidate in the order given, by the owner cap only', async () => {
    for (const order of permutations(pool)) {
      for (const maxReduceBps of [2_500, 10_000]) {
        const reducer = recordingReducer();
        const given = order.map((c) => c.positionId);
        const first = order.find((c) => eligible.has(c.positionId))!;
        const outcome = await runAdlLastResort(
          await unconfiguredInput({
            policy: { maxReduceBps },
            events: memoryAdlDisclosureEventStore(),
            candidates: order,
            reducer,
            newEventId: eventIds(),
          }),
        );
        expect(outcome, given.join()).toMatchObject({ action: 'reduced', candidatePositionId: first.positionId });
        expect((outcome as { sizeReduced: bigint }).sizeReduced).toBe((first.size * BigInt(maxReduceBps)) / 10_000n);
        expect(reducer.order).toEqual([first.positionId]);
        expect(order.map((c) => c.positionId)).toEqual(given);
      }
    }
    // Every policy that names no valid cap refuses, whatever the order: there is no default of the mill's own.
    for (const policy of [null, partial<AdlOwnerPolicy>({}), { maxReduceBps: 0 }, { maxReduceBps: 1.5 }, { maxReduceBps: 10_001 }]) {
      for (const order of permutations(pool.slice(0, 3))) {
        const outcome = await runAdlLastResort(
          await unconfiguredInput({ policy: policy as AdlOwnerPolicy | null, events: memoryAdlDisclosureEventStore(), candidates: order }),
        );
        expect(outcome).toMatchObject({ action: 'refused', code: ADL_UNCONFIGURED });
      }
    }
  });

  it('parkUnderfundedWithAdl hands the candidates on in the order given, and refuses without both owner settings', async () => {
    const acks = memoryAdlDisclosureStore();
    await acks.recordAck(BOB, ADL_DISCLOSURE_VERSION, AT);
    await acks.recordAck(CAROL, ADL_DISCLOSURE_VERSION, AT);
    const row = { positionId: BANKRUPT, userId: ALICE, marketId: MARKET, side: 'long' as const };
    for (const order of permutations(pool)) {
      const reducer = recordingReducer();
      const first = order.find((c) => eligible.has(c.positionId))!;
      await parkUnderfundedWithAdl({
        adl: {
          policy: { maxReduceBps: 10_000 },
          ranking: TEST_ADL_RANKING,
          candidates: order,
          reducer,
          disclosureAcks: acks,
          events: memoryAdlDisclosureEventStore(),
          newEventId: eventIds(),
        },
        row,
        fromInsurance: amt('10'),
        insuranceReason: 'insurance underfunded',
        at: AT,
      });
      expect(reducer.order, order.map((c) => c.positionId).join()).toEqual([first.positionId]);
      for (const adl of [
        { policy: null, ranking: TEST_ADL_RANKING },
        { policy: { maxReduceBps: 10_000 } },
        { policy: partial<AdlOwnerPolicy>({}), ranking: TEST_ADL_RANKING },
      ]) {
        const parked = await parkUnderfundedWithAdl({
          adl: { ...adl, candidates: order, reducer: throwingReducer(), disclosureAcks: acks, events: memoryAdlDisclosureEventStore() },
          row,
          fromInsurance: amt('10'),
          insuranceReason: 'insurance underfunded',
          at: AT,
        });
        expect(parked.reason).toBe(ADL_UNCONFIGURED);
      }
    }
  });
});

describe('ADL unconfigured mill (hermetic)', () => {
  it('null policy + two opposing candidates → trade.adl_unconfigured; reducer idle; no disclosure rows', async () => {
    const events = memoryAdlDisclosureEventStore();
    const outcome = await runAdlLastResort(await unconfiguredInput({ policy: null, events }));
    expect(outcome).toMatchObject({ action: 'refused', code: ADL_UNCONFIGURED });
    expect(await events.listForUser(BOB, 500)).toEqual([]);
    expect(await events.listForUser(CAROL, 500)).toEqual([]);
    expect(await events.listForBankrupt(BANKRUPT)).toEqual([]);
  });

  it('invalid maxReduceBps 0 / -1 / 10001 also stay unconfigured; reducer idle', async () => {
    for (const maxReduceBps of [0, -1, 10001]) {
      const events = memoryAdlDisclosureEventStore();
      const outcome = await runAdlLastResort(await unconfiguredInput({ policy: { maxReduceBps } satisfies AdlOwnerPolicy, events }));
      expect(outcome).toMatchObject({ action: 'refused', code: ADL_UNCONFIGURED });
      expect(await events.listForBankrupt(BANKRUPT)).toEqual([]);
    }
  });

  it('candidates passed out-of-order stay unconsumed when policy is null (ranking never runs)', async () => {
    const events = memoryAdlDisclosureEventStore();
    const candidates = opposingOutOfOrder();
    const orderBefore = candidates.map((c) => c.positionId);
    const outcome = await runAdlLastResort(await unconfiguredInput({ policy: null, events, candidates }));
    expect(outcome).toMatchObject({ action: 'refused', code: ADL_UNCONFIGURED });
    expect(candidates.map((c) => c.positionId)).toEqual(orderBefore);
    expect(candidates.map((c) => c.positionId)).toEqual([CAND_SMALL, CAND_LARGE]);
    expect(await events.listForUser(BOB, 500)).toEqual([]);
    expect(await events.listForUser(CAROL, 500)).toEqual([]);
  });

  it('parkUnderfundedWithAdl without owner maxReduceBps stays trade.adl_unconfigured; reducer idle', async () => {
    const events = memoryAdlDisclosureEventStore();
    const parked = await parkUnderfundedWithAdl({
      adl: {
        policy: null,
        candidates: opposingOutOfOrder(),
        events,
        reducer: throwingReducer(),
        newEventId: () => {
          throw new Error('ADL event id must not mint when owner policy is unset');
        },
      },
      row: { positionId: BANKRUPT, userId: ALICE, marketId: MARKET, side: 'long' },
      fromInsurance: amt('10'),
      insuranceReason: 'insurance underfunded — refuse rather than overdraw',
      at: AT,
    });
    expect(parked.outcome).toBe('skipped_insurance_underfunded');
    expect(parked.reason).toBe(ADL_UNCONFIGURED);
    expect(await events.listForBankrupt(BANKRUPT)).toEqual([]);
  });
});

const H8A_IMAGE = 'postgres:16-alpine';

async function openH8aAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) {
    return { url: envUrl, stop: async () => undefined };
  }

  try {
    const container = await testPostgres(H8A_IMAGE)
      .withDatabase('intafaced_h8a_test')
      .withUsername('intafaced')
      .withPassword('intafaced')
      .start();
    return {
      url: container.getConnectionUri(),
      stop: async () => {
        await container.stop();
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `H8a: ADL unconfigured refuse is PG-hard (no skip-green). ` +
        `TEST_DATABASE_URL unset and Testcontainers could not start ${H8A_IMAGE}: ${msg}`,
    );
  }
}

describe('svc-trade ADL unconfigured F4 money', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase | undefined;
  let sql!: TestDatabase['sql'];

  beforeAll(async () => {
    const admin = await openH8aAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'trade', url: admin.url, migrations });
    sql = db.sql;
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  it('null policy refuses trade.adl_unconfigured; reducer idle; no disclosure rows', async () => {
    const events = sqlAdlDisclosureEventStore(sql);
    const outcome = await runAdlLastResort(await unconfiguredInput({ policy: null, events }));
    expect(outcome).toMatchObject({ action: 'refused', code: ADL_UNCONFIGURED });
    const rows = await sql<{ n: string }[]>`SELECT count(*)::text AS n FROM trade.adl_action_disclosures`;
    expect(rows[0]!.n).toBe('0');
  });

  it('invalid maxReduceBps 0 / -1 / 10001 write zero disclosure rows', async () => {
    for (const maxReduceBps of [0, -1, 10001]) {
      const events = sqlAdlDisclosureEventStore(sql);
      const outcome = await runAdlLastResort(await unconfiguredInput({ policy: { maxReduceBps } satisfies AdlOwnerPolicy, events }));
      expect(outcome).toMatchObject({ action: 'refused', code: ADL_UNCONFIGURED });
    }
    const rows = await sql<{ n: string }[]>`SELECT count(*)::text AS n FROM trade.adl_action_disclosures`;
    expect(rows[0]!.n).toBe('0');
  });

  it('parkUnderfundedWithAdl with sql events stays unconfigured and writes no disclosure rows', async () => {
    const events = sqlAdlDisclosureEventStore(sql);
    const parked = await parkUnderfundedWithAdl({
      adl: { policy: null, candidates: opposingOutOfOrder(), events, reducer: throwingReducer() },
      row: { positionId: BANKRUPT, userId: ALICE, marketId: MARKET, side: 'long' },
      fromInsurance: amt('10'),
      insuranceReason: 'insurance underfunded — refuse rather than overdraw',
      at: AT,
    });
    expect(parked.reason).toBe(ADL_UNCONFIGURED);
    const rows = await sql<{ n: string }[]>`SELECT count(*)::text AS n FROM trade.adl_action_disclosures`;
    expect(rows[0]!.n).toBe('0');
  });
});
