import { describe, expect, it } from 'vitest';
import { parseAmount as A, type Amount } from '@intafaced/ledger-client';
import {
  bandInForce,
  readPriceRangeSettings,
  runPriceBandTick,
  widestBand,
  workBand,
  type PriceBandChange,
  type PriceBandRecord,
  type PriceBandStore,
  type PriceRangeSettings,
} from './dynamic-price-band.js';

const STATIC = A('0.05');
const RANGE: PriceRangeSettings = { max: A('0.2'), trigger: A('0.01'), cadenceSeconds: 30 };
const T0 = new Date('2026-10-23T12:00:00.000Z');
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);

function record(over: Partial<PriceBandRecord> = {}): PriceBandRecord {
  return {
    marketId: 'm',
    band: A('0.08'),
    staticBand: STATIC,
    premium: A('0.03'),
    mark: A('65000'),
    bookMid: A('66950'),
    reason: 'widened',
    riskVersion: '4',
    checkedAt: T0,
    changedAt: T0,
    ...over,
  };
}

function memoryStore(): PriceBandStore & { rows: Map<string, PriceBandRecord>; log: PriceBandChange[] } {
  const rows = new Map<string, PriceBandRecord>();
  const log: PriceBandChange[] = [];
  return {
    rows,
    log,
    async current(marketId) {
      return rows.get(marketId) ?? null;
    },
    async record(w) {
      const prev = rows.get(w.marketId);
      const changed = !prev || prev.band !== w.band;
      rows.set(w.marketId, { ...w, changedAt: changed ? w.checkedAt : prev.changedAt });
      if (changed) log.push({ ...w, previousBand: prev?.band ?? null, changedAt: w.checkedAt });
      return { changed };
    },
    async changes(marketId) {
      return log.filter((c) => c.marketId === marketId).reverse();
    },
  };
}

describe('dynamic price range (D-instruments-08)', () => {
  it('reads the three operator values, and any blank or malformed one as unset', () => {
    const row = { priceRangeMax: '0.2', priceRangeTrigger: '0.01', priceRangeCadenceSeconds: '30' };
    expect(readPriceRangeSettings(row)).toEqual(RANGE);
    expect(readPriceRangeSettings({ ...row, priceRangeTrigger: '0' })).toMatchObject({ trigger: 0n });
    expect(readPriceRangeSettings(null)).toBeNull();
    for (const bad of [
      { priceRangeMax: null },
      { priceRangeTrigger: null },
      { priceRangeCadenceSeconds: null },
      { priceRangeMax: '0' },
      { priceRangeMax: '1' },
      { priceRangeMax: 'wide' },
      { priceRangeTrigger: '1' },
      { priceRangeCadenceSeconds: '0' },
      { priceRangeCadenceSeconds: '86401' },
      { priceRangeCadenceSeconds: '2.5' },
    ]) {
      expect(readPriceRangeSettings({ ...row, ...bad })).toBeNull();
    }
  });

  it('widens by the premium past the trigger, stops at the widest, and never goes below the static band', () => {
    const work = (mark: string | null, bookMid: string | null, settings = RANGE) =>
      workBand({ staticBand: STATIC, settings, mark: mark == null ? null : A(mark), bookMid: bookMid == null ? null : A(bookMid) });
    // 1% premium is at the trigger: the static band.
    expect(work('65000', '65650')).toEqual({ band: STATIC, premium: A('0.01'), reason: 'within_trigger' });
    // 3% below the mark is a 3% premium as well: 5% + 3%.
    expect(work('65000', '63050')).toEqual({ band: A('0.08'), premium: A('0.03'), reason: 'widened' });
    // 40% premium: held at the widest, 20%.
    expect(work('65000', '91000')).toEqual({ band: A('0.2'), premium: A('0.4'), reason: 'capped' });
    // A widest set below the static band never narrows it.
    expect(work('65000', '91000', { ...RANGE, max: A('0.02') })).toMatchObject({ band: STATIC, reason: 'capped' });
    // An unreadable side is the static band.
    expect(work(null, '65000')).toEqual({ band: STATIC, premium: null, reason: 'inputs_missing' });
    expect(work('65000', null)).toEqual({ band: STATIC, premium: null, reason: 'inputs_missing' });
    // The premium rounds down, so the band never widens past what the book shows.
    expect(work('3', '4').premium).toBe(A('0.333333333333333333'));
  });

  it('holds new orders to the static band unless a fresh working for these exact limits says wider', () => {
    const inForce = (over: { settings?: PriceRangeSettings | null; riskVersion?: string; current?: PriceBandRecord | null; now?: Date }) =>
      bandInForce({
        staticBand: STATIC,
        settings: over.settings === undefined ? RANGE : over.settings,
        riskVersion: over.riskVersion ?? '4',
        current: over.current === undefined ? record() : over.current,
        now: over.now ?? at(10),
      });
    expect(inForce({})).toMatchObject({ fraction: A('0.08'), staticFraction: STATIC, source: 'dynamic', reason: 'widened', max: A('0.2') });
    expect(inForce({ settings: null })).toMatchObject({ fraction: STATIC, source: 'static', reason: 'price_range_unset', max: null });
    expect(inForce({ current: null })).toMatchObject({ fraction: STATIC, reason: 'not_worked_yet' });
    expect(inForce({ riskVersion: '5' })).toMatchObject({ fraction: STATIC, reason: 'limits_changed' });
    expect(inForce({ current: record({ staticBand: A('0.04') }) })).toMatchObject({ fraction: STATIC, reason: 'limits_changed' });
    // Two cadences is still good; one millisecond more is stale.
    expect(inForce({ now: at(60) })).toMatchObject({ fraction: A('0.08'), source: 'dynamic' });
    expect(inForce({ now: new Date(at(60).getTime() + 1) })).toMatchObject({ fraction: STATIC, reason: 'stale' });
    // A working that found the premium within the trigger reads as the static band, with its reason.
    expect(inForce({ current: record({ band: STATIC, reason: 'within_trigger' }) })).toMatchObject({
      fraction: STATIC,
      source: 'static',
      reason: 'within_trigger',
    });
    // A stored band past the widest (only a hand-edited row can hold one) is held to the widest.
    expect(inForce({ current: record({ band: A('0.5') }) })).toMatchObject({ fraction: A('0.2') });
  });

  it('a resting order is held to the widest band the range allows, so a narrowing band never cancels it', () => {
    expect(widestBand(STATIC, RANGE)).toBe(A('0.2'));
    expect(widestBand(STATIC, null)).toBe(STATIC);
    expect(widestBand(STATIC, { ...RANGE, max: A('0.01') })).toBe(STATIC);
  });

  it('works each market once per cadence, again at once when its limits change, and keeps each change', async () => {
    const store = memoryStore();
    let now = T0;
    let version = '4';
    let settings: PriceRangeSettings | null = RANGE;
    let bookMid: Amount | null = A('66950');
    const tick = () =>
      runPriceBandTick({
        staticBand: STATIC,
        markets: async () => [
          { id: 'm', symbol: 'BTC/USDT:USDT' },
          { id: 'unset', symbol: 'ETH/USDT:USDT' },
        ],
        limitsFor: async (marketId) => ({ version, settings: marketId === 'unset' ? null : settings }),
        mark: async () => A('65000'),
        bookMid: async () => bookMid,
        store,
        now: () => now,
      });

    expect((await tick()).worked).toEqual([{ marketId: 'm', band: '0.08', reason: 'widened', changed: true }]);
    // Within the cadence: nothing is worked.
    now = at(29);
    bookMid = A('65000');
    expect((await tick()).worked).toEqual([]);
    // At the cadence: worked again, and the band is back to the static one.
    now = at(30);
    expect((await tick()).worked).toEqual([{ marketId: 'm', band: '0.05', reason: 'within_trigger', changed: true }]);
    // New limits are worked at once, before the cadence; the same band is not a change.
    now = at(31);
    version = '5';
    expect((await tick()).worked).toEqual([{ marketId: 'm', band: '0.05', reason: 'within_trigger', changed: false }]);
    expect(store.log.map((c) => [c.band, c.previousBand])).toEqual([
      [A('0.08'), null],
      [STATIC, A('0.08')],
    ]);
    // A market whose range is unset is never recorded; a range cleared leaves the record, and the band in force is static.
    expect(store.rows.has('unset')).toBe(false);
    settings = null;
    now = at(120);
    expect((await tick()).worked).toEqual([]);
  });

  it('an unreadable book is worked as the static band, and a failing market does not stop the others', async () => {
    const store = memoryStore();
    const failing: PriceBandStore = {
      ...store,
      current: async (id) => (id === 'bad' ? Promise.reject(new Error('db down')) : store.current(id)),
    };
    const out = await runPriceBandTick({
      staticBand: STATIC,
      markets: async () => [
        { id: 'bad', symbol: 'X' },
        { id: 'm', symbol: 'BTC/USDT:USDT' },
      ],
      limitsFor: async () => ({ version: '1', settings: RANGE }),
      mark: async () => A('65000'),
      bookMid: async () => Promise.reject(new Error('matching down')),
      store: failing,
      now: () => T0,
    });
    expect(out.failed).toEqual([{ marketId: 'bad', message: 'db down' }]);
    expect(out.worked).toEqual([{ marketId: 'm', band: '0.05', reason: 'inputs_missing', changed: true }]);
  });

  it('works nothing while the static band is unset: every new order refuses anyway', async () => {
    const store = memoryStore();
    const out = await runPriceBandTick({
      staticBand: null,
      markets: async () => [{ id: 'm', symbol: 'BTC/USDT:USDT' }],
      limitsFor: async () => ({ version: '1', settings: RANGE }),
      mark: async () => A('65000'),
      bookMid: async () => A('70000'),
      store,
      now: () => T0,
    });
    expect(out).toEqual({ worked: [], failed: [] });
  });
});
