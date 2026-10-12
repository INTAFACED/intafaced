import { describe, expect, it } from 'vitest';
import { checkAccess, parseScreeningList, SCREENING_REVIEWED_EMPTY } from '@intafaced/config';
import {
  ASSET_CLASSES,
  CATALOGUE_ASSETS,
  CME_GLOBEX,
  FX_GLOBAL,
  INSTRUMENTS,
  instrumentBySymbol,
  instrumentSchema,
  instrumentsByClass,
  instrumentsForPlane,
  isAssetClass,
  isInstrumentOpen,
  isScheduleKey,
  isScheduleOpen,
  nextScheduleTransition,
  SCHEDULE_KEYS,
  scheduleKeySchema,
  TRADING_SCHEDULES,
  venueClock,
} from './instruments.js';

/**
 * The schedule tests use fixed UTC instants and assert against the venue's local
 * clock, because that is the only way to prove the DST handling: the same
 * "17:00 New York" boundary is 21:00 UTC in January and 21:00 UTC... no — 22:00
 * UTC in January and 21:00 UTC in July. A test written in UTC offsets would
 * encode the bug it is meant to catch.
 */

describe('enum authority (D-S-05 / D26-P1-T9)', () => {
  it('derives scheduleKeySchema from TRADING_SCHEDULES — no handwritten mirror list', () => {
    expect([...SCHEDULE_KEYS].sort()).toEqual(Object.keys(TRADING_SCHEDULES).sort());
    expect([...scheduleKeySchema.options].sort()).toEqual(Object.keys(TRADING_SCHEDULES).sort());
  });

  it('refuses an unknown schedule key rather than defaulting to continuous', () => {
    expect(isScheduleKey('lse-equities')).toBe(false);
    expect(isScheduleKey('crypto-24x7')).toBe(true);
    expect(scheduleKeySchema.safeParse('lse-equities').success).toBe(false);
  });

  it('refuses an unknown asset_class, naming the permitted set as the sole authority', () => {
    expect(isAssetClass('equity')).toBe(false);
    expect(isAssetClass('crypto')).toBe(true);
    expect([...ASSET_CLASSES]).toEqual(['crypto', 'commodity', 'forex']);
  });

  it('keeps every crypto spot listing continuous (additive bar — spot suite unchanged)', () => {
    for (const i of instrumentsByClass(INSTRUMENTS, 'crypto')) {
      expect(i.schedule).toBe('crypto-24x7');
      expect(isInstrumentOpen(i, new Date('2026-01-10T12:00:00Z'))).toBe(true); // Saturday
      expect(isInstrumentOpen(i, new Date('2026-01-14T12:00:00Z'))).toBe(true); // Wednesday
    }
  });
});

describe('the catalogue', () => {
  it('every listing satisfies the published schema', () => {
    for (const instrument of INSTRUMENTS) {
      const result = instrumentSchema.safeParse(instrument);
      expect(result.success, `${instrument.symbol}: ${result.success ? '' : JSON.stringify(result.error.issues)}`).toBe(true);
    }
  });

  it('covers all three asset classes', () => {
    expect(instrumentsByClass(INSTRUMENTS, 'crypto').length).toBeGreaterThan(0);
    expect(instrumentsByClass(INSTRUMENTS, 'commodity').map((i) => i.symbol)).toEqual([
      'XAU/USD',
      'XAG/USD',
      'WTI/USD',
      'BRENT/USD',
      'NATGAS/USD',
    ]);
    expect(instrumentsByClass(INSTRUMENTS, 'forex').map((i) => i.symbol)).toEqual([
      'EUR/USD',
      'GBP/USD',
      'USD/JPY',
      'AUD/USD',
      'USD/CHF',
      'USD/CAD',
    ]);
  });

  it('has no duplicate symbols', () => {
    const symbols = INSTRUMENTS.map((i) => i.symbol);
    expect(new Set(symbols).size).toBe(symbols.length);
  });

  it('prices JPY crosses in 0.01 pips and every other major in 0.0001', () => {
    expect(instrumentBySymbol('USD/JPY')?.quoteConvention.pipSize).toBe('0.01');
    expect(instrumentBySymbol('EUR/USD')?.quoteConvention.pipSize).toBe('0.0001');
  });

  it('carries the physical unit on every commodity', () => {
    expect(instrumentBySymbol('XAU/USD')?.quoteConvention.unit).toBe('troy_ounce');
    expect(instrumentBySymbol('WTI/USD')?.quoteConvention.unit).toBe('barrel');
    expect(instrumentBySymbol('NATGAS/USD')?.quoteConvention.unit).toBe('mmbtu');
  });

  it('names every asset the ledger must carry', () => {
    // The seed migration must list all of these; if this array changes without
    // the migration changing, the app boots with a market whose asset does not
    // exist and the first order fails at the ledger rather than at the listing.
    expect(CATALOGUE_ASSETS).toEqual([
      'AUD',
      'BRENT',
      'BTC',
      'CAD',
      'CHF',
      'ETH',
      'EUR',
      'GBP',
      'IFC',
      'JPY',
      'NATGAS',
      'USD',
      'USDC',
      'USDT',
      'WTI',
      'XAG',
      'XAU',
    ]);
  });

  it('refuses a listing that prices itself against itself', () => {
    const base = INSTRUMENTS[0]!;
    expect(instrumentSchema.safeParse({ ...base, quote: base.base, symbol: `${base.base}/${base.base}` }).success).toBe(false);
  });

  it('refuses a commodity marked as trading 24/7', () => {
    const gold = instrumentBySymbol('XAU/USD')!;
    const result = instrumentSchema.safeParse({ ...gold, schedule: 'crypto-24x7' });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toMatch(/does not trade 24\/7/);
  });

  it('refuses an FX pair with no pip convention', () => {
    const eur = instrumentBySymbol('EUR/USD')!;
    const result = instrumentSchema.safeParse({ ...eur, quoteConvention: { ...eur.quoteConvention, pipSize: null } });
    expect(result.success).toBe(false);
  });
});

describe('the plane split', () => {
  it('lists every crypto market on both planes', () => {
    for (const i of instrumentsByClass(INSTRUMENTS, 'crypto')) {
      expect(i.planes).toEqual(['fiat', 'protocol']);
    }
  });

  it('keeps commodities and forex on the Fiat Plane only', () => {
    // The DEX must not advertise a book svc-protocol cannot match. When an
    // oracle-priced synthetic exists, this expectation is what has to change
    // first — deliberately, in a reviewed commit.
    for (const i of [...instrumentsByClass(INSTRUMENTS, 'commodity'), ...instrumentsByClass(INSTRUMENTS, 'forex')]) {
      expect(i.planes).toEqual(['fiat']);
    }
  });

  it('gives the DEX a non-empty catalogue', () => {
    expect(instrumentsForPlane(INSTRUMENTS, 'protocol').length).toBeGreaterThan(0);
  });

  it('lists strictly more on the CEX than on the DEX', () => {
    expect(instrumentsForPlane(INSTRUMENTS, 'fiat').length).toBeGreaterThan(instrumentsForPlane(INSTRUMENTS, 'protocol').length);
  });

  /**
   * THE SWITCH IS THE SOVEREIGNTY LAW, NOT A FILTER.
   *
   * `instrumentsForPlane` decides what a venue SHOWS. `checkAccess` decides who
   * may TRADE it. Those are two different functions, and a catalogue that
   * disagreed with the access decision would be the worst kind of wrong: the DEX
   * would render a market and then refuse the order, or — far worse — the CEX
   * would render one it should have gated.
   *
   * These bind the two together, so the new instrument model cannot drift away
   * from §22 without a test failing here first.
   */
  it('lets a wholly unverified caller reach every DEX listing', () => {
    const decision = checkAccess({
      module: 'dex',
      plane: 'protocol',
      region: 'GB',
      kycTier: 'none',
      screening: parseScreeningList(SCREENING_REVIEWED_EMPTY, 'counsel-memo-ref'),
    });
    expect(decision.allowed).toBe(true);
    expect(decision.code).toBe('allowed.permissionless');
    expect(instrumentsForPlane(INSTRUMENTS, 'protocol').length).toBeGreaterThan(0);
  });

  it('gates the same caller out of the CEX listings', () => {
    const decision = checkAccess({ module: 'trade', plane: 'fiat', region: 'GB', kycTier: 'none' });
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe('denied.kyc_required');
  });

  it('never lists a commodity or forex market on the permissionless plane', () => {
    // The load-bearing one. Commodities and forex are custodial products: they
    // settle in assets svc-ledger holds. If one ever appeared on the protocol
    // plane, the DEX would be offering a market whose settlement requires
    // custody — which is the precise thing `custodial: false` promises it does
    // not do, and the promise the whole zero-KYC claim rests on.
    for (const i of instrumentsForPlane(INSTRUMENTS, 'protocol')) {
      expect(i.assetClass, `${i.symbol} is on the protocol plane`).toBe('crypto');
    }
  });
});

describe('venueClock', () => {
  it('resolves an instant to the venue wall clock, not to UTC', () => {
    // 2026-01-05T22:30:00Z is 17:30 Monday in New York (EST, UTC-5).
    expect(venueClock(new Date('2026-01-05T22:30:00Z'), 'America/New_York')).toEqual({
      weekday: 1,
      minutes: 17 * 60 + 30,
      date: '2026-01-05',
    });
  });

  it('tracks daylight saving', () => {
    // Same UTC time in July is 18:30 (EDT, UTC-4) — one hour later locally.
    expect(venueClock(new Date('2026-07-06T22:30:00Z'), 'America/New_York').minutes).toBe(18 * 60 + 30);
  });

  it('reports midnight as minute zero, never as 1440', () => {
    expect(venueClock(new Date('2026-01-06T05:00:00Z'), 'America/New_York').minutes).toBe(0);
  });
});

describe('crypto is continuous', () => {
  it('is open at every instant tested', () => {
    for (const iso of ['2026-01-03T03:00:00Z', '2026-07-04T12:00:00Z', '2026-12-25T00:00:00Z']) {
      expect(isScheduleOpen(TRADING_SCHEDULES['crypto-24x7'], new Date(iso))).toBe(true);
    }
  });

  it('never transitions', () => {
    expect(nextScheduleTransition(TRADING_SCHEDULES['crypto-24x7'])).toBeNull();
  });
});

describe('the forex week', () => {
  it('is shut on Saturday', () => {
    expect(isScheduleOpen(FX_GLOBAL, new Date('2026-01-10T12:00:00Z'))).toBe(false);
  });

  it('is shut early Sunday and open after the 17:00 New York open', () => {
    // 2026-01-11 is a Sunday. 21:00Z = 16:00 EST — still shut.
    expect(isScheduleOpen(FX_GLOBAL, new Date('2026-01-11T21:00:00Z'))).toBe(false);
    // 22:30Z = 17:30 EST — open.
    expect(isScheduleOpen(FX_GLOBAL, new Date('2026-01-11T22:30:00Z'))).toBe(true);
  });

  it('is open right through the middle of the week', () => {
    expect(isScheduleOpen(FX_GLOBAL, new Date('2026-01-14T03:00:00Z'))).toBe(true);
  });

  it('closes at 17:00 New York on Friday', () => {
    // 2026-01-16 is a Friday. 21:30Z = 16:30 EST — open.
    expect(isScheduleOpen(FX_GLOBAL, new Date('2026-01-16T21:30:00Z'))).toBe(true);
    // 22:30Z = 17:30 EST — shut for the weekend.
    expect(isScheduleOpen(FX_GLOBAL, new Date('2026-01-16T22:30:00Z'))).toBe(false);
  });

  it('shifts with US daylight saving rather than staying pinned to a UTC offset', () => {
    // July: EDT is UTC-4, so the Friday close is at 21:00Z, not 22:00Z.
    // 2026-07-17 is a Friday. 21:30Z = 17:30 EDT — already shut.
    expect(isScheduleOpen(FX_GLOBAL, new Date('2026-07-17T21:30:00Z'))).toBe(false);
    // The same wall-clock instant in January was open (asserted above), which is
    // the whole point: a UTC-pinned schedule gets one of these two wrong.
    expect(isScheduleOpen(FX_GLOBAL, new Date('2026-07-17T20:30:00Z'))).toBe(true);
  });

  it('honours a holiday, on the VENUE-LOCAL date', () => {
    const withHoliday = { ...FX_GLOBAL, holidays: ['2026-01-14'] } as typeof FX_GLOBAL;

    // 15:00Z is 10:00 EST on the 14th — inside the holiday, so shut.
    expect(isScheduleOpen(withHoliday, new Date('2026-01-14T15:00:00Z'))).toBe(false);

    // 03:00Z on the 14th is 22:00 EST on the THIRTEENTH, which is not the
    // holiday and is therefore still open. Asserting this is the point: a
    // holiday is a day on the venue's calendar, not a 24-hour UTC slice, and
    // the two differ by five hours for every New York session.
    expect(isScheduleOpen(withHoliday, new Date('2026-01-14T03:00:00Z'))).toBe(true);
  });

  it('reports when it next opens', () => {
    // Saturday — shut. The next transition must be an open, on the Sunday.
    const next = nextScheduleTransition(FX_GLOBAL, new Date('2026-01-10T12:00:00Z'));
    expect(next?.open).toBe(true);
    expect(venueClock(next!.at, 'America/New_York')).toMatchObject({ weekday: 0, minutes: 17 * 60 });
  });
});

describe('the CME Globex week', () => {
  it('shuts for the daily settlement break', () => {
    // 2026-01-13 is a Tuesday. 22:30Z = 16:30 CST — inside the 16:00-17:00 break.
    expect(isScheduleOpen(CME_GLOBEX, new Date('2026-01-13T22:30:00Z'))).toBe(false);
    // 23:30Z = 17:30 CST — reopened.
    expect(isScheduleOpen(CME_GLOBEX, new Date('2026-01-13T23:30:00Z'))).toBe(true);
  });

  it('is shut all weekend', () => {
    expect(isScheduleOpen(CME_GLOBEX, new Date('2026-01-10T12:00:00Z'))).toBe(false);
    expect(isScheduleOpen(CME_GLOBEX, new Date('2026-01-11T12:00:00Z'))).toBe(false);
  });

  it('is open overnight mid-week', () => {
    expect(isScheduleOpen(CME_GLOBEX, new Date('2026-01-14T06:00:00Z'))).toBe(true);
  });
});

describe('isInstrumentOpen', () => {
  it('is always true for crypto', () => {
    expect(isInstrumentOpen(instrumentBySymbol('BTC/USDT')!, new Date('2026-01-10T12:00:00Z'))).toBe(true);
  });

  it('is false for gold on a Saturday', () => {
    expect(isInstrumentOpen(instrumentBySymbol('XAU/USD')!, new Date('2026-01-10T12:00:00Z'))).toBe(false);
  });

  it('is false for EUR/USD on a Saturday', () => {
    expect(isInstrumentOpen(instrumentBySymbol('EUR/USD')!, new Date('2026-01-10T12:00:00Z'))).toBe(false);
  });

  it('is false for a halted market even inside its session', () => {
    const halted = { ...instrumentBySymbol('EUR/USD')!, status: 'halted' as const };
    expect(isInstrumentOpen(halted, new Date('2026-01-14T03:00:00Z'))).toBe(false);
  });
});

/**
 * Sizes are compared as scaled bigints, not as doubles.
 *
 * The maxQty ≥ minQty refine used `Number()` on both sides — in the file whose
 * header states "there is not a `number` in this file that describes a price or
 * a size". Not decorative: two decimal strings that differ in the 18th place
 * become the same double, so the check passed on a pair it exists to reject.
 */
describe('size comparison is exact', () => {
  /** A real instrument, with only the two sizes under test changed. */
  function withQty(minQty: string, maxQty: string) {
    const base = INSTRUMENTS.find((i) => i.symbol === 'BTC/USDT');
    expect(base, 'fixture instrument must exist').toBeDefined();
    return { ...base!, minQty, maxQty };
  }

  it('rejects a maxQty below minQty by one unit in the last place', () => {
    // Both sides are exactly 1 as a double, so `Number(max) < Number(min)` was
    // false and the schema accepted a maximum smaller than its minimum.
    const result = instrumentSchema.safeParse(withQty('1.000000000000000001', '1'));
    expect(result.success).toBe(false);
  });

  it('still accepts an equal pair and an ordinary range', () => {
    expect(instrumentSchema.safeParse(withQty('1', '1')).success).toBe(true);
    expect(instrumentSchema.safeParse(withQty('0.00001', '1000')).success).toBe(true);
  });
});

/**
 * Price, size and notional are decimal strings. A JSON number is a refusal, not
 * a coerce — the same law events and exchange-contract already pin.
 */
describe('instrument money fields refuse JS numbers', () => {
  const base = INSTRUMENTS.find((i) => i.symbol === 'BTC/USDT');

  function issueOn(path: string, poison: unknown) {
    expect(base, 'fixture instrument must exist').toBeDefined();
    const result = instrumentSchema.safeParse({ ...base!, ...((poison as object) || {}) });
    expect(result.success).toBe(false);
    const messages = result.success ? [] : result.error.issues.filter((i) => i.path.join('.') === path).map((i) => i.message);
    expect(messages.join(' ')).toMatch(/JS number refused/);
  }

  it('rejects a number on tickSize, lotSize, minQty, maxQty, minNotional', () => {
    issueOn('tickSize', { tickSize: 0.01 });
    issueOn('lotSize', { lotSize: 0.00001 });
    issueOn('minQty', { minQty: 1 });
    issueOn('maxQty', { maxQty: 100 });
    issueOn('minNotional', { minNotional: 5 });
  });

  it('rejects a number on quoteConvention unitSize and pipSize', () => {
    expect(base, 'fixture instrument must exist').toBeDefined();
    const unit = instrumentSchema.safeParse({
      ...base!,
      quoteConvention: { ...base!.quoteConvention, unitSize: 1 },
    });
    expect(unit.success).toBe(false);
    expect(JSON.stringify(unit.error?.issues)).toMatch(/JS number refused/);

    const gold = instrumentBySymbol('XAU/USD')!;
    const pip = instrumentSchema.safeParse({
      ...gold,
      quoteConvention: { ...gold.quoteConvention, pipSize: 0.01 },
    });
    expect(pip.success).toBe(false);
    expect(JSON.stringify(pip.error?.issues)).toMatch(/JS number refused/);
  });

  it('still accepts the catalogue strings', () => {
    expect(instrumentSchema.safeParse(base).success).toBe(true);
  });
});
