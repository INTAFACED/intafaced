/**
 * R-E5 money proof — options exercise / assignment / expiry mill.
 *
 * Blank TRADE_OPTIONS_SETTLEMENT_FIXING / settlement asset refuses by name
 * with zero posts. Owner decimal classifies; last trade / mark ignored.
 * No ledger-client options recipe exists (PX-S08-O02) — mill never posts.
 * Listing still refuses blank law/fixing (R-E8 SOCKET). router.ts not recut.
 */
import { MemoryLedger, parseAmount as amt, recipes } from '@intafaced/ledger-client';
import { describe, expect, it } from 'vitest';
import { tradeRouterPaths } from '../__tests__/entry.js';
import { TradeError } from './types.js';
import { OPTIONS_FIXING_UNCONFIGURED, OPTIONS_SETTLEMENT_LAW_UNSET, resolveOptionsListing } from './options-listing.js';
import {
  OPTIONS_TERMS_INCOMPLETE,
  classifyEuropeanCash,
  optionsAssignmentIdFor,
  optionsExerciseIdFor,
  optionsExpiryIdFor,
  runOptionsExerciseJob,
} from './options-exercise.js';

const ALICE = '11111111-1111-4111-8111-111111111111';
const POS_LONG = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const POS_SHORT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const EXPIRY = new Date('2026-12-26T08:00:00.000Z');
const AFTER = new Date('2026-12-26T08:00:01.000Z');
const P0_05_LAW = 'd26-p0-05-adr-published';

function longCall() {
  return { positionId: POS_LONG, userId: ALICE, side: 'long' as const, size: amt('1') };
}
function shortCall() {
  return { positionId: POS_SHORT, userId: ALICE, side: 'short' as const, size: amt('1') };
}

describe('options exercise hitch (source)', () => {
  it('router.ts not recut; mill never last-trade; listing refuse kept; no invented recipe', () => {
    // No tRPC procedure runs the mill: the only exercise path there is the person's read of their own exercises.
    expect(tradeRouterPaths().filter((path) => /exercis/i.test(path))).toEqual(['options.exercises']);
    // Outcomes are keyed by the position, one id per kind, so a replayed scan settles each once (the mill posts
    // nothing today: see the zero-post tests below).
    expect(optionsExerciseIdFor(POS_LONG)).toBe(`option-exercise:${POS_LONG}`);
    expect(optionsAssignmentIdFor(POS_LONG)).toBe(`option-assign:${POS_LONG}`);
    expect(optionsExpiryIdFor(POS_LONG)).toBe(`option-expire:${POS_LONG}`);
    try {
      resolveOptionsListing({
        kind: 'options',
        settlementAssetLawConfigured: '',
        settlementFixingConfigured: 'owner-d7',
        optionType: 'call',
        strike: amt('100'),
        expiryAt: EXPIRY,
      });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(TradeError);
      expect((err as TradeError).code).toBe(OPTIONS_SETTLEMENT_LAW_UNSET);
    }
    try {
      resolveOptionsListing({
        kind: 'options',
        settlementAssetLawConfigured: P0_05_LAW,
        settlementFixingConfigured: '',
        optionType: 'call',
        strike: amt('100'),
        expiryAt: EXPIRY,
      });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(TradeError);
      expect((err as TradeError).code).toBe(OPTIONS_FIXING_UNCONFIGURED);
      expect((err as Error).message).toContain('TRADE_OPTIONS_SETTLEMENT_FIXING');
    }
  });
});

describe('classifyEuropeanCash', () => {
  it('call long ITM → exercise; short ITM → assignment; OTM → expire; ATM omitted', () => {
    expect(classifyEuropeanCash({ optionType: 'call', side: 'long', strike: amt('100'), fixing: amt('110') })).toEqual({
      kind: 'exercise',
    });
    expect(classifyEuropeanCash({ optionType: 'call', side: 'short', strike: amt('100'), fixing: amt('110') })).toEqual({
      kind: 'assignment',
    });
    expect(classifyEuropeanCash({ optionType: 'call', side: 'long', strike: amt('100'), fixing: amt('90') })).toEqual({
      kind: 'expire',
    });
    expect(classifyEuropeanCash({ optionType: 'put', side: 'long', strike: amt('100'), fixing: amt('90') })).toEqual({
      kind: 'exercise',
    });
    expect(classifyEuropeanCash({ optionType: 'call', side: 'long', strike: amt('100'), fixing: amt('100') })).toEqual({
      kind: 'refused',
      reason: 'atm_treatment_unset',
    });
  });
});

describe('options exercise mill (hermetic)', () => {
  it('owner decimal classifies exercise+assignment; never last trade 1 or mark 2; zero posts', async () => {
    const ledger = new MemoryLedger();
    await ledger.post(recipes.deposit({ userId: ALICE, assetId: 'USDT', amount: amt('1000'), rail: 'test', railRef: 'alice-usdt' }));
    const before = ledger.journal().length;
    const result = await runOptionsExerciseJob({
      kind: 'options',
      optionType: 'call',
      optionStyle: 'european',
      strike: amt('100'),
      expiryAt: EXPIRY,
      now: AFTER,
      settlementAssetLawConfigured: P0_05_LAW,
      settlementFixingConfigured: 'owner-d7-stamp',
      ownerSettlementPrice: '110',
      settlementAsset: 'USD',
      lastTradePrice: '1',
      markPrice: '2',
      positions: [longCall(), shortCall()],
      ledger,
    });
    expect(result).toMatchObject({
      status: 'classified',
      settlementPrice: '110',
      source: 'owner_fixing',
      posts: [],
      outcomes: [
        { kind: 'exercise', outcomeId: optionsExerciseIdFor(POS_LONG), positionId: POS_LONG },
        { kind: 'assignment', outcomeId: optionsAssignmentIdFor(POS_SHORT), positionId: POS_SHORT },
      ],
    });
    expect(ledger.journal()).toHaveLength(before);
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('OTM expires under owner decimal, not last trade', async () => {
    const ledger = new MemoryLedger();
    const result = await runOptionsExerciseJob({
      kind: 'options',
      optionType: 'call',
      optionStyle: 'european',
      strike: amt('100'),
      expiryAt: EXPIRY,
      now: AFTER,
      settlementAssetLawConfigured: P0_05_LAW,
      settlementFixingConfigured: 'owner-d7-stamp',
      ownerSettlementPrice: '90',
      settlementAsset: 'USD',
      lastTradePrice: '999',
      markPrice: '999',
      positions: [longCall()],
      ledger,
    });
    expect(result).toMatchObject({
      status: 'classified',
      settlementPrice: '90',
      source: 'owner_fixing',
      posts: [],
      outcomes: [{ kind: 'expire', outcomeId: optionsExpiryIdFor(POS_LONG), positionId: POS_LONG }],
    });
  });

  it('blank TRADE_OPTIONS_SETTLEMENT_FIXING refuses; last trade is not settlement; posts empty', async () => {
    const ledger = new MemoryLedger();
    await ledger.post(recipes.deposit({ userId: ALICE, assetId: 'USDT', amount: amt('1000'), rail: 'test', railRef: 'alice-usdt' }));
    const before = ledger.journal().length;
    const result = await runOptionsExerciseJob({
      kind: 'options',
      optionType: 'call',
      optionStyle: 'european',
      strike: amt('100'),
      expiryAt: EXPIRY,
      now: AFTER,
      settlementAssetLawConfigured: P0_05_LAW,
      settlementFixingConfigured: '',
      ownerSettlementPrice: '110',
      settlementAsset: 'USD',
      lastTradePrice: '1',
      markPrice: '2',
      positions: [longCall()],
      ledger,
    });
    expect(result).toEqual({
      status: 'refused',
      reason: 'fixing_unconfigured',
      code: OPTIONS_FIXING_UNCONFIGURED,
      posts: [],
    });
    expect(ledger.journal()).toHaveLength(before);
  });

  it('blank settlement asset refuses law_unset even with owner decimal; posts empty', async () => {
    const ledger = new MemoryLedger();
    const result = await runOptionsExerciseJob({
      kind: 'options',
      optionType: 'call',
      optionStyle: 'european',
      strike: amt('100'),
      expiryAt: EXPIRY,
      now: AFTER,
      settlementAssetLawConfigured: P0_05_LAW,
      settlementFixingConfigured: 'owner-d7-stamp',
      ownerSettlementPrice: '110',
      settlementAsset: '',
      lastTradePrice: '1',
      markPrice: '2',
      positions: [longCall()],
      ledger,
    });
    expect(result).toEqual({
      status: 'refused',
      reason: 'settlement_law_unset',
      code: OPTIONS_SETTLEMENT_LAW_UNSET,
      posts: [],
    });
  });

  it('blank settlement asset law refuses even when fixing stamp is set', async () => {
    const ledger = new MemoryLedger();
    const result = await runOptionsExerciseJob({
      kind: 'options',
      optionType: 'call',
      optionStyle: 'european',
      strike: amt('100'),
      expiryAt: EXPIRY,
      now: AFTER,
      settlementAssetLawConfigured: '  ',
      settlementFixingConfigured: 'owner-d7-stamp',
      ownerSettlementPrice: '110',
      settlementAsset: 'USD',
      lastTradePrice: '1',
      positions: [longCall()],
      ledger,
    });
    expect(result).toEqual({
      status: 'refused',
      reason: 'settlement_law_unset',
      code: OPTIONS_SETTLEMENT_LAW_UNSET,
      posts: [],
    });
  });

  it('blank owner decimal refuses fixing_unconfigured; last trade 1 is ignored', async () => {
    const ledger = new MemoryLedger();
    const result = await runOptionsExerciseJob({
      kind: 'options',
      optionType: 'call',
      optionStyle: 'european',
      strike: amt('100'),
      expiryAt: EXPIRY,
      now: AFTER,
      settlementAssetLawConfigured: P0_05_LAW,
      settlementFixingConfigured: 'owner-d7-stamp',
      ownerSettlementPrice: '',
      settlementAsset: 'USD',
      lastTradePrice: '1',
      markPrice: '2',
      positions: [longCall()],
      ledger,
    });
    expect(result.status).toBe('refused');
    if (result.status !== 'refused') return;
    expect(result.code).toBe(OPTIONS_FIXING_UNCONFIGURED);
    expect(result.posts).toEqual([]);
  });

  it('idempotent outcome ids are stable across retries', async () => {
    const ledger = new MemoryLedger();
    const input = {
      kind: 'options' as const,
      optionType: 'call' as const,
      optionStyle: 'european' as const,
      strike: amt('100'),
      expiryAt: EXPIRY,
      now: AFTER,
      settlementAssetLawConfigured: P0_05_LAW,
      settlementFixingConfigured: 'owner-d7-stamp',
      ownerSettlementPrice: '110',
      settlementAsset: 'USD',
      positions: [longCall()],
      ledger,
    };
    const a = await runOptionsExerciseJob(input);
    const b = await runOptionsExerciseJob(input);
    expect(a.status).toBe('classified');
    expect(b.status).toBe('classified');
    if (a.status === 'classified' && b.status === 'classified') {
      expect(a.outcomes).toEqual(b.outcomes);
      expect(a.outcomes[0]!.outcomeId).toBe(`option-exercise:${POS_LONG}`);
    }
  });

  it('ATM is omitted, never auto-exercised from last trade', async () => {
    const ledger = new MemoryLedger();
    const result = await runOptionsExerciseJob({
      kind: 'options',
      optionType: 'call',
      optionStyle: 'european',
      strike: amt('100'),
      expiryAt: EXPIRY,
      now: AFTER,
      settlementAssetLawConfigured: P0_05_LAW,
      settlementFixingConfigured: 'owner-d7-stamp',
      ownerSettlementPrice: '100',
      settlementAsset: 'USD',
      lastTradePrice: '999',
      positions: [longCall()],
      ledger,
    });
    expect(result).toMatchObject({ status: 'classified', settlementPrice: '100', source: 'owner_fixing', posts: [], outcomes: [] });
  });

  it('not expired skips; incomplete terms refuse', async () => {
    const ledger = new MemoryLedger();
    const skip = await runOptionsExerciseJob({
      kind: 'options',
      optionType: 'call',
      optionStyle: 'european',
      strike: amt('100'),
      expiryAt: EXPIRY,
      now: new Date('2026-01-01T00:00:00.000Z'),
      settlementAssetLawConfigured: P0_05_LAW,
      settlementFixingConfigured: 'owner-d7-stamp',
      ownerSettlementPrice: '110',
      settlementAsset: 'USD',
      positions: [longCall()],
      ledger,
    });
    expect(skip).toEqual({ status: 'skipped', reason: 'not_expired', posts: [] });
    const terms = await runOptionsExerciseJob({
      kind: 'options',
      optionType: null,
      optionStyle: 'european',
      strike: amt('100'),
      expiryAt: EXPIRY,
      now: AFTER,
      settlementAssetLawConfigured: P0_05_LAW,
      settlementFixingConfigured: 'owner-d7-stamp',
      ownerSettlementPrice: '110',
      settlementAsset: 'USD',
      positions: [longCall()],
      ledger,
    });
    expect(terms).toMatchObject({ status: 'refused', reason: 'terms_incomplete', code: OPTIONS_TERMS_INCOMPLETE, posts: [] });
  });
});
