/**
 * The dynamic price range on futures orders (D-instruments-08, J-derivatives-02 #8).
 *
 * The owner's static band (`TRADE_FUTURES_PRICE_BAND`) is a fraction of the mark on each side, and a new order's limit
 * must sit inside it. The mark is built from the spot index, so when the futures book trades away from spot the band
 * around the mark can shut out the prices the book actually trades at. The operator may therefore publish, on the
 * market's versioned, four-eyes limits row (`admin/risk.ts`), a dynamic range:
 *
 *   priceRangeMax             the widest the band may go
 *   priceRangeTrigger         the premium past which the band widens
 *   priceRangeCadenceSeconds  how often the band is worked out again
 *
 * Working it out, once per cadence:
 *
 *   premium = |futures book mid - mark| / mark
 *   band    = static                         when the premium is at or below the trigger, or an input is unreadable
 *           = min(static + premium, max)     otherwise, and never narrower than the static band
 *
 * Each working is kept as the market's band in force, and every change to the band is kept as a record of what it
 * was, what it became and why. The band in force is the static one whenever any of the three values is blank, when no
 * working has happened yet, when the limits row or the static band changed since the last working, or when the last
 * working is older than two cadences (`stale`): a range that is not being kept up never stays wide. A band change
 * applies to new orders only; a resting order is held to the widest band the range allows (`widestBand`), so a band
 * narrowing again never cancels an order accepted inside it.
 */
import type { Sql } from 'postgres';
import { randomUUID } from 'node:crypto';
import { formatAmount, parseAmount, SCALE, type Amount } from '@intafaced/ledger-client';

export interface PriceRangeSettings {
  /** The widest band, as a fraction of the mark. */
  readonly max: Amount;
  /** The premium, as a fraction of the mark, past which the band widens. */
  readonly trigger: Amount;
  readonly cadenceSeconds: number;
}

/** Why the band in force is what it is. */
export type BandReason =
  /** Any of the three values is blank: the static band. */
  | 'price_range_unset'
  /** The range is set and no working has happened yet: the static band. */
  | 'not_worked_yet'
  /** The limits row or the static band changed since the last working: the static band until the next. */
  | 'limits_changed'
  /** The last working is older than two cadences: the static band. */
  | 'stale'
  /** The range or the last working could not be read: the static band. */
  | 'unreadable'
  /** The mark or the futures book mid could not be read: the static band. */
  | 'inputs_missing'
  /** The premium is at or below the trigger: the static band. */
  | 'within_trigger'
  /** The premium is past the trigger: the static band plus the premium. */
  | 'widened'
  /** The premium is past the trigger and the band reached its widest. */
  | 'capped';

/**
 * The operator's three values, or null when any is blank or unreadable. A malformed stored value counts as blank, so
 * the static band stays in force rather than a number being guessed.
 */
export function readPriceRangeSettings(
  row: {
    readonly priceRangeMax: string | null;
    readonly priceRangeTrigger: string | null;
    readonly priceRangeCadenceSeconds: string | null;
  } | null,
): PriceRangeSettings | null {
  if (row?.priceRangeMax == null || row.priceRangeTrigger == null || row.priceRangeCadenceSeconds == null) return null;
  let max: Amount;
  let trigger: Amount;
  try {
    max = parseAmount(row.priceRangeMax);
    trigger = parseAmount(row.priceRangeTrigger);
  } catch {
    return null;
  }
  const cadenceSeconds = /^\d+$/.test(row.priceRangeCadenceSeconds) ? Number(row.priceRangeCadenceSeconds) : NaN;
  if (max <= 0n || max >= SCALE || trigger < 0n || trigger >= SCALE) return null;
  if (!Number.isSafeInteger(cadenceSeconds) || cadenceSeconds < 1 || cadenceSeconds > 86_400) return null;
  return { max, trigger, cadenceSeconds };
}

/** The widest band the range allows: never narrower than the static band. */
export function widestBand(staticBand: Amount, settings: PriceRangeSettings | null): Amount {
  return settings && settings.max > staticBand ? settings.max : staticBand;
}

export interface BandWorking {
  readonly band: Amount;
  readonly premium: Amount | null;
  readonly reason: Extract<BandReason, 'inputs_missing' | 'within_trigger' | 'widened' | 'capped'>;
}

/** One working of the band from the mark and the futures book mid. The premium rounds down, so it never over-widens. */
export function workBand(input: {
  readonly staticBand: Amount;
  readonly settings: PriceRangeSettings;
  readonly mark: Amount | null;
  readonly bookMid: Amount | null;
}): BandWorking {
  const { staticBand, settings, mark, bookMid } = input;
  if (mark == null || bookMid == null || mark <= 0n || bookMid <= 0n) {
    return { band: staticBand, premium: null, reason: 'inputs_missing' };
  }
  const gap = bookMid > mark ? bookMid - mark : mark - bookMid;
  const premium = (gap * SCALE) / mark;
  if (premium <= settings.trigger) return { band: staticBand, premium, reason: 'within_trigger' };
  const widest = widestBand(staticBand, settings);
  const widened = staticBand + premium;
  return widened >= widest ? { band: widest, premium, reason: 'capped' } : { band: widened, premium, reason: 'widened' };
}

/** The market's band in force now, as the last working recorded it. */
export interface PriceBandRecord {
  readonly marketId: string;
  readonly band: Amount;
  readonly staticBand: Amount;
  readonly premium: Amount | null;
  readonly mark: Amount | null;
  readonly bookMid: Amount | null;
  readonly reason: BandWorking['reason'];
  /** The limits row version the working read. */
  readonly riskVersion: string;
  readonly checkedAt: Date;
  /** When the band last changed value. */
  readonly changedAt: Date;
}

export interface BandInForce {
  /** The band a new order is held to, as a fraction of the mark. */
  readonly fraction: Amount;
  readonly staticFraction: Amount;
  /** 'dynamic' only while the band in force is wider than the static band. */
  readonly source: 'static' | 'dynamic';
  readonly reason: BandReason;
  /** The widest the band may go, or null while the range is unset. */
  readonly max: Amount | null;
  readonly premium: Amount | null;
  readonly checkedAt: Date | null;
  readonly changedAt: Date | null;
}

/** The static band in force, for `reason`. */
export function staticBandInForce(staticBand: Amount, reason: BandReason, max: Amount | null = null): BandInForce {
  return {
    fraction: staticBand,
    staticFraction: staticBand,
    source: 'static',
    reason,
    max,
    premium: null,
    checkedAt: null,
    changedAt: null,
  };
}

/** How long a working stays good: two cadences. */
export function staleAfterMs(settings: PriceRangeSettings): number {
  return 2 * settings.cadenceSeconds * 1000;
}

/** The band a new order is held to now. Anything short of a fresh working for these exact limits is the static band. */
export function bandInForce(input: {
  readonly staticBand: Amount;
  readonly settings: PriceRangeSettings | null;
  /** The limits row version in force now ('0' when none was ever written). */
  readonly riskVersion: string;
  readonly current: PriceBandRecord | null;
  readonly now: Date;
}): BandInForce {
  const { staticBand, settings, current } = input;
  const fallback = (reason: BandReason): BandInForce => ({
    ...staticBandInForce(staticBand, reason, settings?.max ?? null),
    premium: current?.premium ?? null,
    checkedAt: current?.checkedAt ?? null,
    changedAt: current?.changedAt ?? null,
  });
  if (!settings) return fallback('price_range_unset');
  if (!current) return fallback('not_worked_yet');
  if (current.riskVersion !== input.riskVersion || current.staticBand !== staticBand) return fallback('limits_changed');
  if (input.now.getTime() - current.checkedAt.getTime() > staleAfterMs(settings)) return fallback('stale');
  // A stored band is held to the range it was worked under: never below the static band, never past the widest.
  const widest = widestBand(staticBand, settings);
  const band = current.band < staticBand ? staticBand : current.band > widest ? widest : current.band;
  return {
    fraction: band,
    staticFraction: staticBand,
    source: band > staticBand ? 'dynamic' : 'static',
    reason: current.reason,
    max: settings.max,
    premium: current.premium,
    checkedAt: current.checkedAt,
    changedAt: current.changedAt,
  };
}

export interface PriceBandChange {
  readonly marketId: string;
  readonly band: Amount;
  readonly previousBand: Amount | null;
  readonly staticBand: Amount;
  readonly premium: Amount | null;
  readonly reason: BandWorking['reason'];
  readonly riskVersion: string;
  readonly changedAt: Date;
}

export interface PriceBandStore {
  current(marketId: string): Promise<PriceBandRecord | null>;
  /** Keep a working as the band in force; a change of value is also kept as a change. */
  record(working: Omit<PriceBandRecord, 'changedAt'>): Promise<{ readonly changed: boolean }>;
  changes(marketId: string, limit: number): Promise<PriceBandChange[]>;
}

interface CurrentRow {
  market_id: string;
  band: string;
  static_band: string;
  premium: string | null;
  mark: string | null;
  book_mid: string | null;
  reason: BandWorking['reason'];
  risk_version: string;
  checked_at: Date;
  changed_at: Date;
}

const amountOrNull = (v: string | null): Amount | null => (v == null ? null : parseAmount(v));
const textOrNull = (v: Amount | null): string | null => (v == null ? null : formatAmount(v));

function presentCurrent(row: CurrentRow): PriceBandRecord {
  return {
    marketId: row.market_id,
    band: parseAmount(row.band),
    staticBand: parseAmount(row.static_band),
    premium: amountOrNull(row.premium),
    mark: amountOrNull(row.mark),
    bookMid: amountOrNull(row.book_mid),
    reason: row.reason,
    riskVersion: row.risk_version,
    checkedAt: row.checked_at,
    changedAt: row.changed_at,
  };
}

export function sqlPriceBandStore(sql: Sql): PriceBandStore {
  return {
    async current(marketId) {
      const [row] = await sql<CurrentRow[]>`
        SELECT market_id, band, static_band, premium, mark, book_mid, reason, risk_version::text, checked_at, changed_at
          FROM trade.futures_price_band_current WHERE market_id = ${marketId}`;
      return row ? presentCurrent(row) : null;
    },
    async record(w) {
      return sql.begin(async (tx) => {
        // One working at a time per market: two hosts working the same market keep one history between them.
        const [prev] = await tx<{ band: string; changed_at: Date }[]>`
          SELECT band, changed_at FROM trade.futures_price_band_current WHERE market_id = ${w.marketId} FOR UPDATE`;
        const band = formatAmount(w.band);
        const changed = !prev || prev.band !== band;
        const changedAt = changed ? w.checkedAt : prev.changed_at;
        await tx`
          INSERT INTO trade.futures_price_band_current
            (market_id, band, static_band, premium, mark, book_mid, reason, risk_version, checked_at, changed_at)
          VALUES (${w.marketId}, ${band}, ${formatAmount(w.staticBand)}, ${textOrNull(w.premium)}, ${textOrNull(w.mark)},
                  ${textOrNull(w.bookMid)}, ${w.reason}, ${w.riskVersion}::bigint, ${w.checkedAt.toISOString()},
                  ${changedAt.toISOString()})
          ON CONFLICT (market_id) DO UPDATE SET
            band = EXCLUDED.band, static_band = EXCLUDED.static_band, premium = EXCLUDED.premium, mark = EXCLUDED.mark,
            book_mid = EXCLUDED.book_mid, reason = EXCLUDED.reason, risk_version = EXCLUDED.risk_version,
            checked_at = EXCLUDED.checked_at, changed_at = EXCLUDED.changed_at`;
        if (changed) {
          await tx`
            INSERT INTO trade.futures_price_band_changes
              (id, market_id, band, previous_band, static_band, premium, mark, book_mid, reason, risk_version, changed_at)
            VALUES (${randomUUID()}, ${w.marketId}, ${band}, ${prev?.band ?? null}, ${formatAmount(w.staticBand)},
                    ${textOrNull(w.premium)}, ${textOrNull(w.mark)}, ${textOrNull(w.bookMid)}, ${w.reason},
                    ${w.riskVersion}::bigint, ${w.checkedAt.toISOString()})`;
        }
        return { changed };
      });
    },
    async changes(marketId, limit) {
      const rows = await sql<
        {
          market_id: string;
          band: string;
          previous_band: string | null;
          static_band: string;
          premium: string | null;
          reason: BandWorking['reason'];
          risk_version: string;
          changed_at: Date;
        }[]
      >`
        SELECT market_id, band, previous_band, static_band, premium, reason, risk_version::text, changed_at
          FROM trade.futures_price_band_changes
         WHERE market_id = ${marketId}
         ORDER BY changed_at DESC, id
         LIMIT ${limit}`;
      return rows.map((r) => ({
        marketId: r.market_id,
        band: parseAmount(r.band),
        previousBand: amountOrNull(r.previous_band),
        staticBand: parseAmount(r.static_band),
        premium: amountOrNull(r.premium),
        reason: r.reason,
        riskVersion: r.risk_version,
        changedAt: r.changed_at,
      }));
    },
  };
}

export interface PriceBandTickDeps {
  /** The owner's static band; null (unset) works nothing, since every new order refuses anyway. */
  readonly staticBand: Amount | null;
  /** Every futures market whose band may be worked. */
  readonly markets: () => Promise<readonly { readonly id: string; readonly symbol: string }[]>;
  /** The market's limits row now: its version and its three range values. */
  readonly limitsFor: (marketId: string) => Promise<{ readonly version: string; readonly settings: PriceRangeSettings | null }>;
  readonly mark: (marketId: string, symbol: string) => Promise<Amount | null>;
  readonly bookMid: (marketId: string, symbol: string) => Promise<Amount | null>;
  readonly store: PriceBandStore;
  readonly now: () => Date;
}

export interface PriceBandTickResult {
  readonly worked: { readonly marketId: string; readonly band: string; readonly reason: BandReason; readonly changed: boolean }[];
  readonly failed: { readonly marketId: string; readonly message: string }[];
}

/**
 * Work out the band of every market whose range is set and whose last working is a cadence old, or was made under
 * other limits. A market with the range unset is left alone: its band in force is the static one without a record.
 */
export async function runPriceBandTick(deps: PriceBandTickDeps): Promise<PriceBandTickResult> {
  const worked: PriceBandTickResult['worked'][number][] = [];
  const failed: PriceBandTickResult['failed'][number][] = [];
  if (deps.staticBand == null) return { worked, failed };
  const staticBand = deps.staticBand;
  for (const market of await deps.markets()) {
    try {
      const limits = await deps.limitsFor(market.id);
      if (!limits.settings) continue;
      const now = deps.now();
      const current = await deps.store.current(market.id);
      const due =
        !current ||
        current.riskVersion !== limits.version ||
        current.staticBand !== staticBand ||
        now.getTime() - current.checkedAt.getTime() >= limits.settings.cadenceSeconds * 1000;
      if (!due) continue;
      const [mark, bookMid] = await Promise.all([
        deps.mark(market.id, market.symbol).catch(() => null),
        deps.bookMid(market.id, market.symbol).catch(() => null),
      ]);
      const w = workBand({ staticBand, settings: limits.settings, mark, bookMid });
      const { changed } = await deps.store.record({
        marketId: market.id,
        band: w.band,
        staticBand,
        premium: w.premium,
        mark,
        bookMid,
        reason: w.reason,
        riskVersion: limits.version,
        checkedAt: now,
      });
      worked.push({ marketId: market.id, band: formatAmount(w.band), reason: w.reason, changed });
    } catch (err) {
      failed.push({ marketId: market.id, message: err instanceof Error ? err.message : String(err) });
    }
  }
  return { worked, failed };
}
