import { z } from 'zod';
import { PLANES, type Plane } from '@intafaced/config/modules';

/**
 * THE INSTRUMENT MODEL — one shape for crypto, commodities and forex (§5.2).
 *
 * The exchange was crypto-shaped: `trade.markets` carried a symbol, a pair, a
 * tick and a lot, and nothing else, because every market it described was open
 * every second of every day. Doctrine §5.2 already says forex is "the same
 * engine, `kind:spot` with fiat pairs" — but "the same engine" is only true once
 * the *listing* can say the three things a non-crypto market has and a crypto
 * market does not:
 *
 *   1. **What class of thing is this.** A gold order and a BTC order are not the
 *      same product to a regulator, a risk engine, or a tax report.
 *   2. **What one unit means.** `BTC/USDT` prices one coin. `XAU/USD` prices one
 *      TROY OUNCE, `WTI/USD` one BARREL, `NATGAS/USD` one MMBtu. A quantity
 *      without its unit is a number, not a size.
 *   3. **When it trades.** Crypto is continuous. Forex runs Sunday evening to
 *      Friday evening New York time. CME metals and energy close for an hour
 *      every weekday afternoon Chicago time. A market that cannot say it is shut
 *      will accept an order it cannot possibly fill, hold the user's funds
 *      against it, and only discover the problem when a human asks why.
 *
 * WHY THE SCHEDULE IS IN AN IANA TIMEZONE AND NOT IN UTC. The forex week is
 * defined by the 17:00 New York close, not by a UTC offset — so the UTC instant
 * it happens at moves by an hour twice a year, and the US and EU do not shift on
 * the same weekend. A schedule pinned to UTC is therefore correct for most of
 * the year and quietly wrong for the rest, in both directions. Resolving through
 * `Intl` with a real timezone costs nothing (it is in the runtime) and is right
 * on every date, including the ones nobody tests.
 *
 * Money here obeys the same rule it obeys everywhere: DECIMAL STRINGS on the
 * wire, parsed to scaled bigint before arithmetic (Doctrine §0.6). There is not
 * a `number` in this file that describes a price or a size.
 */

// ── Primitives ───────────────────────────────────────────────────────────────

/**
 * Decimal string. Deliberately identical to `@intafaced/exchange-contract`'s
 * rule rather than imported from it: `@intafaced/contracts` is the package every
 * service depends on, and it does not take a dependency on the public CCXT
 * surface to borrow one regex. `services/svc-matching/src/router.ts` restates it
 * for the same reason.
 */
/** Wire money — JSON numbers are refused, not coerced. No owner min/max here. */
export const decimalString = z
  .string({ error: (issue) => (issue.input === undefined ? undefined : 'JS number refused — amounts are decimal strings') })
  .regex(/^\d+(\.\d{1,18})?$/, 'amounts are positive decimal strings with at most 18 decimal places');

/** A size or increment that must be strictly greater than zero. */
const positiveDecimal = decimalString.refine((v) => /[1-9]/.test(v), 'must be greater than zero');

/**
 * A size as a scaled bigint at 18 dp — the rule this file's own header states.
 *
 * The size comparison below used `Number()` on both sides, in the file whose
 * header says "there is not a `number` in this file that describes a price or a
 * size". It was not decorative: `minQty: '1.000000000000000001'` and
 * `maxQty: '1'` both become exactly `1` as doubles, so the refine passed and the
 * schema accepted a maxQty BELOW its minQty. `decimalString` already guarantees
 * the shape, so the scaled form is exact and needs no parser.
 */
function scaledQty(value: string): bigint {
  const [whole = '0', frac = ''] = value.split('.');
  return BigInt(whole) * 10n ** 18n + BigInt(frac.padEnd(18, '0') || '0');
}

/**
 * Instrument id — branded so it cannot be passed where a market UUID or a
 * display symbol is expected.
 *
 * These are three different strings for the same market and they are trivially
 * swappable by accident: `trade.markets.id` is a UUID, `symbol` is the CCXT
 * unified form (`XAU/USD`), and this is the stable catalogue key (`XAU-USD`).
 * The brand makes the compiler notice the swap that a `string` parameter would
 * accept in silence.
 */
export const instrumentIdSchema = z
  .string()
  .regex(/^[A-Z0-9]{2,16}-[A-Z0-9]{2,16}$/, 'instrument ids are BASE-QUOTE in upper case')
  .brand<'InstrumentId'>();
export type InstrumentId = z.infer<typeof instrumentIdSchema>;

export const ASSET_CLASSES = ['crypto', 'commodity', 'forex'] as const;
export const assetClassSchema = z.enum(ASSET_CLASSES);
export type AssetClass = z.infer<typeof assetClassSchema>;

/**
 * What one unit of the base asset IS.
 *
 * `unit` covers anything counted (a coin, a token, a unit of currency).
 * The rest name a physical measure, and they are not interchangeable: an order
 * for 10 of `WTI/USD` is ten barrels and an order for 10 of `XAU/USD` is ten
 * troy ounces, and no amount of care downstream can recover which was meant if
 * the listing did not say.
 */
export const INSTRUMENT_UNITS = ['unit', 'troy_ounce', 'barrel', 'mmbtu'] as const;
export const instrumentUnitSchema = z.enum(INSTRUMENT_UNITS);
export type InstrumentUnit = z.infer<typeof instrumentUnitSchema>;

/** Mirrors `trade.market_kind`. Only `spot` is served today; the others are listable states. */
export const instrumentKindSchema = z.enum(['spot', 'futures', 'options']);
export type InstrumentKind = z.infer<typeof instrumentKindSchema>;

/** Mirrors `trade.market_status`. */
export const instrumentStatusSchema = z.enum(['pending', 'active', 'halted', 'delisted']);
export type InstrumentStatus = z.infer<typeof instrumentStatusSchema>;

// ── Quote convention ─────────────────────────────────────────────────────────

/**
 * How to read a price on this instrument.
 *
 * The sentence this encodes: "one price is `priceAsset` per `unitSize`
 * `unit`(s) of `baseAsset`". Spelling it out is what lets a single formatter
 * render `1.0845` as EUR/USD and `2412.30` as dollars-per-ounce without a
 * per-market special case, and what stops a risk check from treating a lot of
 * gold as a lot of Bitcoin.
 */
export const quoteConventionSchema = z.object({
  /** Asset the price is denominated in — always the instrument's quote asset. */
  priceAsset: z.string().min(2).max(16),
  /** The physical or notional unit one price refers to. */
  unit: instrumentUnitSchema,
  /** How many `unit`s one quoted price covers. Almost always '1'. */
  unitSize: positiveDecimal,
  /**
   * The conventional smallest move traders quote in — 0.0001 on most FX pairs,
   * 0.01 on JPY crosses, 0.01 on gold. NULL on crypto, which has no pip
   * convention: a null here means "there is none", not "unknown".
   *
   * Distinct from `tickSize`, which is what the ENGINE enforces. FX venues quote
   * fractional pips, so tick is routinely a tenth of a pip; conflating the two
   * is how a spread gets displayed off by a factor of ten.
   */
  pipSize: positiveDecimal.nullable(),
});
export type QuoteConvention = z.infer<typeof quoteConventionSchema>;

// ── Trading hours ────────────────────────────────────────────────────────────

/** Minutes-from-midnight is not used on the wire; sessions are `HH:MM` so a listing is readable. */
const timeOfDaySchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'session times are HH:MM, 24-hour');

/** 0 = Sunday, per `Date.getDay()`. */
const weekdaySchema = z.number().int().min(0).max(6);

export const sessionBoundarySchema = z.object({
  day: weekdaySchema,
  time: timeOfDaySchema,
});
export type SessionBoundary = z.infer<typeof sessionBoundarySchema>;

/**
 * One continuous open window in the venue's local week.
 *
 * A window may wrap the week boundary (`open` later in the week than `close`),
 * which is how a Sunday-evening open that runs into Monday is expressed.
 */
export const tradingWindowSchema = z.object({
  open: sessionBoundarySchema,
  close: sessionBoundarySchema,
});
export type TradingWindow = z.infer<typeof tradingWindowSchema>;

/**
 * When an instrument trades.
 *
 * `continuous` is not "a schedule with every window filled in" — it is the
 * assertion that this market has no close at all, which is true of crypto and of
 * nothing else here. Keeping it a separate variant means the crypto path does no
 * timezone work and cannot be broken by a bad session table.
 */
export const tradingScheduleSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('continuous') }),
  z.object({
    kind: z.literal('sessions'),
    /** IANA zone. The venue's own clock — see the header for why not UTC. */
    timezone: z.string().min(3),
    windows: z.array(tradingWindowSchema).min(1),
    /**
     * Venue-local `YYYY-MM-DD` dates on which the market does not open at all.
     *
     * OPERATOR NOTE: this list is a STRUCTURE, not a maintained calendar. It
     * must be refreshed from the venue's published holiday schedule each year
     * before these markets are switched on; an out-of-date list fails OPEN,
     * which is the wrong direction.
     */
    holidays: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).default([]),
  }),
]);
export type TradingSchedule = z.infer<typeof tradingScheduleSchema>;

export const CONTINUOUS: TradingSchedule = { kind: 'continuous' };

/**
 * The interbank forex week: opens 17:00 Sunday New York, closes 17:00 Friday
 * New York, continuous in between. One window, because it genuinely is one —
 * there is no daily close on the interbank market.
 */
export const FX_GLOBAL: TradingSchedule = {
  kind: 'sessions',
  timezone: 'America/New_York',
  windows: [{ open: { day: 0, time: '17:00' }, close: { day: 5, time: '17:00' } }],
  holidays: [],
};

/**
 * CME Globex metals and energy: 17:00 Sunday Chicago through 16:00 Friday
 * Chicago, with a 60-minute settlement break every weekday at 16:00.
 *
 * The break is expressed as five separate windows rather than one window plus a
 * list of exclusions. Same result, but "is now inside any window" stays a single
 * predicate with no second rule that could disagree with the first.
 */
export const CME_GLOBEX: TradingSchedule = {
  kind: 'sessions',
  timezone: 'America/Chicago',
  windows: [
    { open: { day: 0, time: '17:00' }, close: { day: 1, time: '16:00' } },
    { open: { day: 1, time: '17:00' }, close: { day: 2, time: '16:00' } },
    { open: { day: 2, time: '17:00' }, close: { day: 3, time: '16:00' } },
    { open: { day: 3, time: '17:00' }, close: { day: 4, time: '16:00' } },
    { open: { day: 4, time: '17:00' }, close: { day: 5, time: '16:00' } },
  ],
  holidays: [],
};

/**
 * Stable keys so a database row can name a schedule without embedding it.
 *
 * THIS OBJECT IS THE AUTHORITY (ADR 2026-08-04 instrument-enum-authority).
 * `scheduleKeySchema` is derived from its keys — never a second handwritten
 * list. A schedule name present in the DB enum but absent here must refuse at
 * the order path, and adding a key without a definition here is a type error
 * via `satisfies Record<…, TradingSchedule>` once the key is referenced.
 */
export const TRADING_SCHEDULES = {
  'crypto-24x7': CONTINUOUS,
  'fx-global': FX_GLOBAL,
  'cme-globex': CME_GLOBEX,
} as const satisfies Record<string, TradingSchedule>;

export type ScheduleKey = keyof typeof TRADING_SCHEDULES;

/** Non-empty tuple of every key in `TRADING_SCHEDULES` — single source for zod + refuse messages. */
export const SCHEDULE_KEYS = Object.keys(TRADING_SCHEDULES) as [ScheduleKey, ...ScheduleKey[]];

export const scheduleKeySchema = z.enum(SCHEDULE_KEYS);

/** Runtime guard — unknown values refuse; they never default to 24/7. */
export function isScheduleKey(value: unknown): value is ScheduleKey {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(TRADING_SCHEDULES, value);
}

/** Runtime guard for `asset_class` — permitted set is `ASSET_CLASSES` alone. */
export function isAssetClass(value: unknown): value is AssetClass {
  return typeof value === 'string' && (ASSET_CLASSES as readonly string[]).includes(value);
}

// ── Schedule evaluation ──────────────────────────────────────────────────────

const WEEKDAY_INDEX: Readonly<Record<string, number>> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Formatters are cached: building one is the expensive part, and this is called per order. */
const formatterCache = new Map<string, Intl.DateTimeFormat>();

function venueFormatter(timezone: string): Intl.DateTimeFormat {
  let cached = formatterCache.get(timezone);
  if (!cached) {
    cached = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      weekday: 'short',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      // h23 explicitly: `hour12: false` yields '24' for midnight under some ICU
      // builds, which would put the open of a day at minute 1440 of the previous one.
      hourCycle: 'h23',
    });
    formatterCache.set(timezone, cached);
  }
  return cached;
}

interface VenueClock {
  /** 0 = Sunday. */
  weekday: number;
  /** Minutes since midnight, venue-local. */
  minutes: number;
  /** Venue-local calendar date, `YYYY-MM-DD`, for the holiday check. */
  date: string;
}

/**
 * The instant, as the venue's own wall clock sees it.
 *
 * Exported because a caller that wants to explain a rejection ("XAU/USD is
 * closed — it is 16:30 Friday in Chicago") would otherwise re-derive this, and a
 * second derivation is a second thing that can be wrong about DST.
 */
export function venueClock(at: Date, timezone: string): VenueClock {
  const parts = venueFormatter(timezone).formatToParts(at);
  const get = (type: Intl.DateTimeFormatPartTypes): string => parts.find((p) => p.type === type)?.value ?? '';

  return {
    weekday: WEEKDAY_INDEX[get('weekday')] ?? 0,
    minutes: Number(get('hour')) * 60 + Number(get('minute')),
    date: `${get('year')}-${get('month')}-${get('day')}`,
  };
}

const boundaryMinutes = (b: SessionBoundary): number => {
  const [hh, mm] = b.time.split(':') as [string, string];
  return b.day * 1440 + Number(hh) * 60 + Number(mm);
};

/** Is this instant inside any of the schedule's windows? */
export function isScheduleOpen(schedule: TradingSchedule, at: Date = new Date()): boolean {
  if (schedule.kind === 'continuous') return true;

  const clock = venueClock(at, schedule.timezone);
  if (schedule.holidays.includes(clock.date)) return false;

  const now = clock.weekday * 1440 + clock.minutes;

  return schedule.windows.some((w) => {
    const open = boundaryMinutes(w.open);
    const close = boundaryMinutes(w.close);
    // A window that wraps the week boundary is two ranges, not one.
    return open <= close ? now >= open && now < close : now >= open || now < close;
  });
}

/** One week of minutes — the bound on how far ahead a weekly schedule can hide a transition. */
const WEEK_MINUTES = 7 * 1440;

/**
 * When the schedule next flips, and to what.
 *
 * Returns `null` for a continuous market, which never flips — an honest absence
 * rather than a date far in the future that a caller might render.
 *
 * The scan is minute-by-minute over at most nine days. It is not clever, and
 * that is the point: window boundaries, week wraps, DST shifts and holidays all
 * fall out of asking `isScheduleOpen` the same question the order path asks,
 * rather than out of a second implementation that could answer differently. Nine
 * days rather than seven so a holiday sitting across a weekend cannot make it
 * return `null` while the market is genuinely still shut.
 */
export function nextScheduleTransition(schedule: TradingSchedule, from: Date = new Date()): { open: boolean; at: Date } | null {
  if (schedule.kind === 'continuous') return null;

  const start = isScheduleOpen(schedule, from);
  const limit = WEEK_MINUTES + 2 * 1440;

  for (let step = 1; step <= limit; step++) {
    const at = new Date(from.getTime() + step * 60_000);
    if (isScheduleOpen(schedule, at) !== start) return { open: !start, at };
  }

  // Only reachable if a schedule is open or shut for more than nine days
  // straight, which no window table above can express.
  return null;
}

// ── The instrument ───────────────────────────────────────────────────────────

const planeSchema = z.enum(PLANES);

/**
 * A listable instrument.
 *
 * This is the CONTRACT for a listing, not the database row: `trade.markets`
 * stores it (see `0001_multi_asset_instruments.sql`), svc-trade serves it, and
 * `@intafaced/exchange-contract`'s CCXT `marketSchema` is the public projection
 * of it. All three agree because this is the one place the shape is declared.
 */
export const instrumentSchema = z
  .object({
    id: instrumentIdSchema,
    /** CCXT unified symbol — `BTC/USDT`, `XAU/USD`, `EUR/USD`. */
    symbol: z.string().regex(/^[A-Z0-9]{2,16}\/[A-Z0-9]{2,16}$/, 'symbols are BASE/QUOTE in upper case'),
    assetClass: assetClassSchema,
    base: z.string().min(2).max(16),
    quote: z.string().min(2).max(16),
    kind: instrumentKindSchema,
    /** Human label for the base — 'Gold', 'Crude Oil (WTI)'. i18n-keyed at the surface. */
    displayName: z.string().min(1).max(64),
    quoteConvention: quoteConventionSchema,
    /** Minimum price increment the ENGINE enforces. */
    tickSize: positiveDecimal,
    /** Minimum quantity increment. */
    lotSize: positiveDecimal,
    minQty: positiveDecimal,
    /** NULL = no per-order ceiling. */
    maxQty: positiveDecimal.nullable(),
    /** Smallest order value in the quote asset. */
    minNotional: positiveDecimal,
    makerBps: z.number().int().min(0).max(9_999),
    takerBps: z.number().int().min(0).max(9_999),
    schedule: scheduleKeySchema,
    /**
     * Which plane lists this instrument (§22, §17.5).
     *
     * NOT decoration: the DEX/CEX switch reads this to decide what the venue can
     * show. A market listed on `protocol` is one the Protocol Plane can actually
     * match; listing one it cannot would advertise a book that does not exist.
     */
    planes: z.array(planeSchema).min(1),
    status: instrumentStatusSchema,
  })
  .superRefine((i, ctx) => {
    if (i.base === i.quote) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['quote'], message: 'an instrument cannot price itself against itself' });
    }
    if (i.symbol !== `${i.base}/${i.quote}`) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['symbol'], message: `symbol must be ${i.base}/${i.quote}` });
    }
    if (i.quoteConvention.priceAsset !== i.quote) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['quoteConvention', 'priceAsset'],
        message: 'a price is denominated in the quote asset',
      });
    }
    // Crypto has no pip convention and the non-crypto classes all have one.
    // Stated as a rule rather than left to each listing, because a missing pip
    // on an FX pair silently becomes "display the tick", which is a tenth.
    if (i.assetClass === 'crypto' && i.quoteConvention.pipSize !== null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['quoteConvention', 'pipSize'], message: 'crypto has no pip convention' });
    }
    if (i.assetClass !== 'crypto' && i.quoteConvention.pipSize === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['quoteConvention', 'pipSize'],
        message: `${i.assetClass} instruments quote in pips`,
      });
    }
    // THE HOURS RULE. The whole reason this model exists: crypto is the only
    // class that trades continuously, and a forex or commodity listing marked
    // 24/7 would accept orders into a closed venue every weekend.
    if (i.assetClass === 'crypto' && i.schedule !== 'crypto-24x7') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['schedule'], message: 'crypto markets are continuous' });
    }
    if (i.assetClass !== 'crypto' && i.schedule === 'crypto-24x7') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['schedule'],
        message: `${i.assetClass} does not trade 24/7 — give it a session schedule`,
      });
    }
    if (i.maxQty !== null && scaledQty(i.maxQty) < scaledQty(i.minQty)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['maxQty'], message: 'maxQty must be at least minQty' });
    }
  });
export type Instrument = z.infer<typeof instrumentSchema>;

/** Is this instrument accepting orders right now? */
export function isInstrumentOpen(instrument: Instrument, at: Date = new Date()): boolean {
  if (instrument.status !== 'active') return false;
  return isScheduleOpen(TRADING_SCHEDULES[instrument.schedule], at);
}

/** Instruments a given plane lists. The DEX/CEX switch is a filter on this. */
export function instrumentsForPlane(catalogue: readonly Instrument[], plane: Plane): Instrument[] {
  return catalogue.filter((i) => i.planes.includes(plane));
}

export function instrumentsByClass(catalogue: readonly Instrument[], assetClass: AssetClass): Instrument[] {
  return catalogue.filter((i) => i.assetClass === assetClass);
}

// ── The catalogue ────────────────────────────────────────────────────────────

const id = (v: string): InstrumentId => instrumentIdSchema.parse(v);

/**
 * Every crypto listing is on BOTH planes; every commodity and forex listing is
 * on the Fiat Plane only.
 *
 * That asymmetry is a statement of fact, not a policy preference. A Protocol
 * Plane listing requires a book svc-protocol can actually match against, and for
 * a non-crypto underlying that means an oracle-priced synthetic contract —
 * neither of which exists in this repo today (see the audit note in the branch
 * report). When it does, moving XAU/USD onto the DEX is adding `'protocol'` to
 * one array and one row of seed data. Until then, the honest thing is for the
 * DEX to show what it can fill.
 */
const crypto = (base: string, quote: string, displayName: string, tickSize: string, lotSize: string, minNotional: string): Instrument => ({
  id: id(`${base}-${quote}`),
  symbol: `${base}/${quote}`,
  assetClass: 'crypto',
  base,
  quote,
  kind: 'spot',
  displayName,
  quoteConvention: { priceAsset: quote, unit: 'unit', unitSize: '1', pipSize: null },
  tickSize,
  lotSize,
  minQty: lotSize,
  maxQty: null,
  minNotional,
  makerBps: 10,
  takerBps: 20,
  schedule: 'crypto-24x7',
  planes: ['fiat', 'protocol'],
  status: 'active',
});

const commodity = (
  base: string,
  displayName: string,
  unit: InstrumentUnit,
  tickSize: string,
  lotSize: string,
  pipSize: string,
  minNotional: string,
): Instrument => ({
  id: id(`${base}-USD`),
  symbol: `${base}/USD`,
  assetClass: 'commodity',
  base,
  quote: 'USD',
  kind: 'spot',
  displayName,
  quoteConvention: { priceAsset: 'USD', unit, unitSize: '1', pipSize },
  tickSize,
  lotSize,
  minQty: lotSize,
  maxQty: null,
  minNotional,
  makerBps: 15,
  takerBps: 25,
  schedule: 'cme-globex',
  planes: ['fiat'],
  status: 'active',
});

const forex = (base: string, quote: string, displayName: string, tickSize: string, pipSize: string): Instrument => ({
  id: id(`${base}-${quote}`),
  symbol: `${base}/${quote}`,
  assetClass: 'forex',
  base,
  quote,
  kind: 'spot',
  displayName,
  quoteConvention: { priceAsset: quote, unit: 'unit', unitSize: '1', pipSize },
  tickSize,
  /** One micro lot. The retail floor on every major. */
  lotSize: '1000',
  minQty: '1000',
  maxQty: null,
  minNotional: '1000',
  makerBps: 5,
  takerBps: 10,
  schedule: 'fx-global',
  planes: ['fiat'],
  status: 'active',
});

/**
 * THE LAUNCH CATALOGUE.
 *
 * Adding an instrument is a row here and a row in the seed migration — never a
 * code change, which is the same property `ledger.assets` has. The two are kept
 * in step by `instruments.test.ts`, which parses every entry through
 * `instrumentSchema`, and by the migration, which seeds exactly these symbols.
 */
export const INSTRUMENTS: readonly Instrument[] = [
  // ── Crypto · continuous, both planes ──────────────────────────────────────
  crypto('BTC', 'USDT', 'Bitcoin', '0.01', '0.00001', '5'),
  crypto('ETH', 'USDT', 'Ether', '0.01', '0.0001', '5'),
  crypto('BTC', 'USDC', 'Bitcoin', '0.01', '0.00001', '5'),
  crypto('ETH', 'USDC', 'Ether', '0.01', '0.0001', '5'),
  crypto('IFC', 'USDT', 'INTAFACED Coin', '0.0001', '0.01', '5'),

  // ── Commodities · CME Globex hours, Fiat Plane ────────────────────────────
  // Gold and silver price per TROY OUNCE; the energies per barrel and per
  // MMBtu. `unit` is what makes those three different products rather than
  // three numbers.
  commodity('XAU', 'Gold', 'troy_ounce', '0.01', '0.01', '0.01', '10'),
  commodity('XAG', 'Silver', 'troy_ounce', '0.001', '0.1', '0.01', '10'),
  commodity('WTI', 'Crude Oil (WTI)', 'barrel', '0.01', '1', '0.01', '10'),
  commodity('BRENT', 'Crude Oil (Brent)', 'barrel', '0.01', '1', '0.01', '10'),
  commodity('NATGAS', 'Natural Gas', 'mmbtu', '0.001', '10', '0.001', '10'),

  // ── Forex majors · interbank week, Fiat Plane ─────────────────────────────
  // Tick is a FRACTIONAL pip on every pair — a tenth of `pipSize` — which is how
  // the interbank market has quoted for two decades. JPY crosses pip at 0.01
  // rather than 0.0001 because the yen is quoted to two places, and that single
  // difference is the one every naive FX integration gets wrong.
  forex('EUR', 'USD', 'Euro', '0.00001', '0.0001'),
  forex('GBP', 'USD', 'Pound Sterling', '0.00001', '0.0001'),
  forex('USD', 'JPY', 'US Dollar', '0.001', '0.01'),
  forex('AUD', 'USD', 'Australian Dollar', '0.00001', '0.0001'),
  forex('USD', 'CHF', 'US Dollar', '0.00001', '0.0001'),
  forex('USD', 'CAD', 'US Dollar', '0.00001', '0.0001'),
];

/** Assets the catalogue requires `ledger.assets` to carry. Asserted by the tests. */
export const CATALOGUE_ASSETS: readonly string[] = [...new Set(INSTRUMENTS.flatMap((i) => [i.base, i.quote]))].sort();

export function instrumentById(id: string): Instrument | undefined {
  return INSTRUMENTS.find((i) => i.id === id);
}

export function instrumentBySymbol(symbol: string): Instrument | undefined {
  return INSTRUMENTS.find((i) => i.symbol === symbol.toUpperCase());
}
