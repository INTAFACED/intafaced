import { describe, expect, it } from 'vitest';
import {
  FreezeError,
  MemoryFreezeStore,
  freezeStoreBoardCard,
  freezeStoreStatusLine,
  freezeStoreStatusLineIsEmpty,
  parseFreezeStoreStatusLine,
  freezeStoreStatusLineMatches,
  freezeStoreStatusLineConsistent,
  freezeStoreExportHeader,
  freezeStoreExportLines,
  freezeStoreExportText,
  freezeCountInRange,
  freezeCountAtLeast,
} from './freeze-store.js';

describe('affiliates L3 freeze store (non-pay)', () => {
  it('freeze / unfreeze with audit reason; refuse double freeze', () => {
    const store = new MemoryFreezeStore();
    const rec = store.freeze({
      beneficiaryId: 'u-ref',
      frozenBy: 'op-1',
      reason: 'Chargeback investigation',
      now: new Date('2026-08-05T00:00:00.000Z'),
    });
    expect(rec.reason).toContain('Chargeback');
    expect(store.isFrozen('u-ref')).toBe(true);
    expect(() => store.freeze({ beneficiaryId: 'u-ref', frozenBy: 'op-1', reason: 'again' })).toThrow(FreezeError);
    store.unfreeze('u-ref');
    expect(store.isFrozen('u-ref')).toBe(false);
    expect(() => store.unfreeze('u-ref')).toThrow(FreezeError);
  });

  it('accrue skips frozen beneficiaries', () => {
    const store = new MemoryFreezeStore();
    const parent = new Map([['payer', 'u-ref']]);
    store.freeze({ beneficiaryId: 'u-ref', frozenBy: 'op', reason: 'Policy hold' });
    // Fixture rates for the test only — not a production default.
    const rows = store.accrue({
      fee: {
        feeEventId: 'f1',
        userId: 'payer',
        feeAmount: '10',
        asset: 'USDT',
        at: new Date('2026-08-05T00:00:00.000Z'),
      },
      parent,
      tiers: [{ hop: 0, rate: '0.130' }],
    });
    expect(rows.every((r) => r.beneficiaryId !== 'u-ref')).toBe(true);
  });

  it('refuses short freeze reason', () => {
    const store = new MemoryFreezeStore();
    expect(() => store.freeze({ beneficiaryId: 'a', frozenBy: 'op', reason: 'no' })).toThrow(FreezeError);
  });

  it('L3 freezeCount is zero without invent', () => {
    const store = new MemoryFreezeStore();
    expect(store.freezeCount()).toBe(0);
    store.freeze({ beneficiaryId: 'u-ref', frozenBy: 'op', reason: 'policy hold' });
    expect(store.freezeCount()).toBe(1);
  });

  it('L3 listFrozenBeneficiaryIds sorted without invent', () => {
    const store = new MemoryFreezeStore();
    expect(store.listFrozenBeneficiaryIds()).toEqual([]);
    store.freeze({ beneficiaryId: 'z-ref', frozenBy: 'op', reason: 'policy hold' });
    store.freeze({ beneficiaryId: 'a-ref', frozenBy: 'op', reason: 'policy hold' });
    expect(store.listFrozenBeneficiaryIds()).toEqual(['a-ref', 'z-ref']);
  });

  it('L3 freezeReasonOf null when not frozen', () => {
    const store = new MemoryFreezeStore();
    expect(store.freezeReasonOf('missing')).toBeNull();
    store.freeze({ beneficiaryId: 'u-ref', frozenBy: 'op', reason: 'policy hold' });
    expect(store.freezeReasonOf('u-ref')).toBe('policy hold');
  });

  it('L3 hasAnyFreeze is false when empty', () => {
    const store = new MemoryFreezeStore();
    expect(store.hasAnyFreeze()).toBe(false);
    store.freeze({ beneficiaryId: 'u-ref', frozenBy: 'op', reason: 'policy hold' });
    expect(store.hasAnyFreeze()).toBe(true);
  });
});

describe('L3 wave52 freeze-store status/export', () => {
  it('empty and frozen boards', () => {
    const store = new MemoryFreezeStore();
    expect(freezeStoreStatusLineIsEmpty(store)).toBe(true);
    expect(freezeStoreStatusLineMatches(store)).toBe(true);
    expect(freezeStoreStatusLineConsistent(freezeStoreStatusLine(store))).toBe(true);
    expect(parseFreezeStoreStatusLine('nope')).toBeNull();
    expect(freezeCountInRange(store, 0, 0)).toBe(true);
    store.freeze({ beneficiaryId: 'u-ref', frozenBy: 'op-1', reason: 'Chargeback investigation' });
    expect(freezeStoreBoardCard(store).frozen).toBe(1);
    expect(freezeStoreStatusLine(store)).toBe('frozen=1 any=1');
    expect(freezeStoreStatusLineMatches(store)).toBe(true);
    expect(freezeStoreExportText(store).startsWith(freezeStoreExportHeader())).toBe(true);
    expect(freezeStoreExportLines(store)).toHaveLength(1);
    expect(freezeCountInRange(store, 1, 2)).toBe(true);
    expect(freezeCountInRange(store, 2, 1)).toBe(false);
    expect(freezeCountAtLeast(store, 1)).toBe(true);
    expect(freezeCountAtLeast(store, Number.NaN)).toBe(false);
  });
});
