/**
 * CARD F4 money proof — ADL unconfigured without ranking (PTX-M09-R05).
 *
 * Hitch is already on origin/main: runAdlLastResort / parkUnderfundedWithAdl
 * refuse `trade.adl_unconfigured` when owner maxReduceBps is unset or invalid.
 * The mill consumes owner-chosen candidate order only — it does not rank,
 * does not default maxReduceBps, and does not run a socialized-loss recipe.
 * Not a redo of B8/#3724 (waterfall already on main). router.ts not recut.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDatabase, postgresAvailable, type TestDatabase } from '@intafaced/db';
import { parseAmount as amt } from '@intafaced/ledger-client';
import { describe, expect, it, afterAll } from 'vitest';
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

const URL = process.env.TEST_DATABASE_URL ?? 'postgres://intafaced_ops:intafaced_ops@localhost:5433/intafaced_test';
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

describe('ADL unconfigured hitch (source) — no ranking, no default maxReduceBps', () => {
  it('adl-last-resort.ts has no maxReduceBps default and does not sort/rank candidates', () => {
    const mill = readFileSync(join(here, 'adl-last-resort.ts'), 'utf8');
    expect(mill).not.toMatch(/maxReduceBps\s*=/);
    expect(mill).toMatch(/for \(const candidate of input\.candidates\)/);
    expect(mill).toMatch(/This module does not rank/);
    expect(mill).toMatch(/owner-chosen order/);
    expect(mill).not.toMatch(/candidates\.sort\s*\(/);
    expect(mill).not.toMatch(/input\.candidates\.slice\([^)]*\)\.sort/);
    expect(mill).not.toMatch(/\[\s*\.\.\.\s*input\.candidates\s*\]\.sort/);
    const runStart = mill.indexOf('export async function runAdlLastResort');
    const runEnd = mill.indexOf('export function memoryAdlDisclosureEventStore');
    expect(runStart).toBeGreaterThan(-1);
    expect(runEnd).toBeGreaterThan(runStart);
    const runFn = mill.slice(runStart, runEnd);
    expect(runFn).not.toMatch(/\.sort\s*\(/);
    expect(runFn).not.toMatch(/leverage\s*score/i);
  });

  it('liquidation-adl-gate.ts does not rank or invent maxReduceBps', () => {
    const gate = readFileSync(join(here, 'liquidation-adl-gate.ts'), 'utf8');
    expect(gate).not.toMatch(/maxReduceBps\s*=/);
    expect(gate).not.toMatch(/candidates\.sort\s*\(/);
    expect(gate).not.toMatch(/\.sort\s*\(/);
    expect(gate).toMatch(/does not rank/);
    expect(gate).toMatch(/owner-chosen order/);
    expect(gate).toMatch(/refuseReducer/);
    expect(gate).toMatch(/parkUnderfundedWithAdl/);
  });

  it('futures-jobs.ts / index.ts do not set maxReduceBps or rank candidates', () => {
    const jobs = readFileSync(join(here, 'futures-jobs.ts'), 'utf8');
    const index = readFileSync(join(here, '..', 'index.ts'), 'utf8');
    expect(jobs).not.toMatch(/maxReduceBps/);
    expect(jobs).not.toMatch(/WIDE_POLICY/);
    expect(jobs).not.toMatch(/candidates\.sort\s*\(/);
    expect(jobs).toMatch(/ADL omitted/);
    expect(index).not.toMatch(/maxReduceBps/);
    expect(index).not.toMatch(/WIDE_POLICY/);
    expect(index).not.toMatch(/startFuturesJobs\([\s\S]{0,1500}adl:/);
  });

  it('router.ts not recut', () => {
    const routerSrc = readFileSync(join(here, '..', 'router.ts'), 'utf8');
    expect(routerSrc).not.toMatch(/runAdlLastResort/);
    expect(routerSrc).not.toMatch(/parkUnderfundedWithAdl/);
    expect(routerSrc).not.toMatch(/adl-last-resort/);
    expect(routerSrc).not.toMatch(/adl-unconfigured/);
    expect(routerSrc).not.toMatch(/maxReduceBps/);
  });
});

describe('ADL unconfigured mill (hermetic)', () => {
  it('null policy + two opposing candidates → trade.adl_unconfigured; reducer idle; no disclosure rows', async () => {
    const events = memoryAdlDisclosureEventStore();
    const outcome = await runAdlLastResort(await unconfiguredInput({ policy: null, events }));
    expect(outcome).toMatchObject({ action: 'refused', code: ADL_UNCONFIGURED });
    expect(await events.listForUser(BOB)).toEqual([]);
    expect(await events.listForUser(CAROL)).toEqual([]);
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
    expect(await events.listForUser(BOB)).toEqual([]);
    expect(await events.listForUser(CAROL)).toEqual([]);
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

const available = await postgresAvailable(URL);

if (!available) {
  describe.skip('svc-trade ADL unconfigured F4 money (Postgres unavailable — start docker compose)', () => {
    it('skipped', () => undefined);
  });
} else {
  const db: TestDatabase = await createTestDatabase({ service: 'trade', url: URL, migrations });
  const sql = db.sql;

  describe('svc-trade ADL unconfigured F4 money', () => {
    afterAll(async () => {
      await db.drop();
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
}
