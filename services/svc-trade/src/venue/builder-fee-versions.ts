import type { Sql } from 'postgres';
import { compare, formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client/money';
import type { UserVenueMarket } from '@intafaced/venue-contracts';

/**
 * OUR BUILDER FEE, VERSIONED BY VENUE AND MARKET GROUP (J-cex-spot-17 #1 #3, custody delta: we hold no customer money,
 * so our fee is the builder fee the customer's order carries on the venue).
 *
 * A builder-fee version is the `builderFees` part of an owner fee schedule version (`trade.fee_schedule_versions`), so it
 * takes the same two-person proposal and approval, the same effective time and the same history as the engine's rates:
 *
 *   "builderFees": {
 *     "<venueId>": {
 *       "defaultGroup": "all-markets",                 every market of the venue not named below
 *       "marketGroups": { "BTC-PERP": "perpetuals" },  venue symbol → group
 *       "groups": { "all-markets": "1.5", "perpetuals": "0.5" }   bps of notional, exact decimal strings
 *     }
 *   }
 *
 * A rate is a decimal string of bps (up to four places: a venue may set tenths of a bp) and is a scaled bigint in
 * memory, never a `number` (AGENTS.md floor 2). A version is never written above the venue's own published cap
 * (`UserVenueMarket.builderFeeCapBps`, read from the venue through the door), and a venue that publishes no cap refuses
 * the write: "never above the cap" can't be checked against a cap no one stated. An order prepared through the door
 * carries the fee of the version in force when it is prepared for signing; the venue keeps that fee on the order, so an
 * order still open when a later version takes effect keeps the fee it was signed with.
 */

export type BuilderFeeVersionCode =
  | 'trade.builder_fee_blank'
  | 'trade.builder_fee_above_venue_cap'
  | 'trade.builder_fee_cap_unknown'
  | 'trade.builder_fee_venue_unknown'
  | 'trade.builder_fee_market_unknown';

export class BuilderFeeVersionError extends Error {
  constructor(
    readonly code: BuilderFeeVersionCode,
    message: string,
  ) {
    super(message);
    this.name = 'BuilderFeeVersionError';
  }
}

export interface VenueBuilderFees {
  readonly defaultGroup: string;
  readonly marketGroups: ReadonlyMap<string, string>;
  /** Scaled decimal bps, as `PlaceUserOrderIntent.builderFee.feeBps`. */
  readonly groups: ReadonlyMap<string, Amount>;
}

export type BuilderFeeBook = ReadonlyMap<string, VenueBuilderFees>;

const ID = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/;
/** 0 to 9999 bps, at most four decimal places. */
const RATE = /^(?:0|[1-9]\d{0,3})(?:\.\d{1,4})?$/;

const rec = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const blank = (message: string): never => {
  throw new BuilderFeeVersionError('trade.builder_fee_blank', message);
};

/**
 * The `builderFees` of a schedule version. `undefined` (the version has none) is null. Anything present but blank or
 * malformed refuses `trade.builder_fee_blank`, naming the field.
 */
export function parseBuilderFees(raw: unknown): BuilderFeeBook | null {
  if (raw === undefined) return null;
  if (!rec(raw) || Object.keys(raw).length === 0) blank('builderFees must name at least one venue');
  const book = new Map<string, VenueBuilderFees>();
  for (const [venueId, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (!ID.test(venueId)) blank(`builderFees names a venue id that is not an id: ${JSON.stringify(venueId)}`);
    if (!rec(entry)) blank(`builderFees.${venueId} must be an object`);
    const e = entry as Record<string, unknown>;
    for (const key of Object.keys(e))
      if (key !== 'defaultGroup' && key !== 'marketGroups' && key !== 'groups') blank(`builderFees.${venueId}.${key} is not a field`);
    if (!rec(e.groups) || Object.keys(e.groups).length === 0) blank(`builderFees.${venueId}.groups must name at least one group`);
    const groups = new Map<string, Amount>();
    for (const [group, rate] of Object.entries(e.groups as Record<string, unknown>)) {
      if (!ID.test(group)) blank(`builderFees.${venueId}.groups names a group that is not an id: ${JSON.stringify(group)}`);
      if (typeof rate !== 'string' || rate.trim() === '') blank(`the builder fee of ${venueId} / ${group} is blank`);
      if (!RATE.test(rate as string))
        blank(`the builder fee of ${venueId} / ${group} must be a decimal string of bps from 0 to 9999, at most four places`);
      groups.set(group, parseAmount(rate as string));
    }
    if (typeof e.defaultGroup !== 'string' || !groups.has(e.defaultGroup))
      blank(`builderFees.${venueId}.defaultGroup must be one of its groups`);
    const marketGroups = new Map<string, string>();
    if (e.marketGroups !== undefined) {
      if (!rec(e.marketGroups)) blank(`builderFees.${venueId}.marketGroups must be an object of symbol to group`);
      for (const [symbol, group] of Object.entries(e.marketGroups as Record<string, unknown>)) {
        if (!ID.test(symbol)) blank(`builderFees.${venueId}.marketGroups names a symbol that is not an id: ${JSON.stringify(symbol)}`);
        if (typeof group !== 'string' || !groups.has(group)) blank(`builderFees.${venueId}.marketGroups.${symbol} names no group of it`);
        marketGroups.set(symbol, group as string);
      }
    }
    book.set(venueId, { defaultGroup: e.defaultGroup as string, marketGroups, groups });
  }
  return book;
}

/** The group and fee `book` sets for `symbol` on `venueId`; null when the book names no fees for that venue. */
export function builderFeeOf(book: BuilderFeeBook | null, venueId: string, symbol: string): { group: string; feeBps: Amount } | null {
  const venue = book?.get(venueId);
  if (!venue) return null;
  const group = venue.marketGroups.get(symbol) ?? venue.defaultGroup;
  const feeBps = venue.groups.get(group);
  // parseBuilderFees only admits groups it holds; a missing one is a stored book this code did not write.
  if (feeBps === undefined)
    throw new BuilderFeeVersionError('trade.builder_fee_blank', `the builder fee of ${venueId} / ${group} is blank`);
  return { group, feeBps };
}

/**
 * Refuses a book any of whose fees is above the venue's own published cap on a market it applies to, or that names a
 * venue other than the one the door reaches, or a market that venue does not list. `venue` is null when the door is off.
 */
export function assertWithinVenueCaps(
  book: BuilderFeeBook,
  venue: { readonly venueId: string; readonly markets: readonly UserVenueMarket[] } | null,
): void {
  for (const [venueId, fees] of book) {
    if (!venue || venue.venueId !== venueId) {
      throw new BuilderFeeVersionError(
        'trade.builder_fee_venue_unknown',
        venue
          ? `builder fees name ${venueId}, but the user-venue door reaches ${venue.venueId}: a cap can only be read from the venue itself`
          : `builder fees name ${venueId}, but the user-venue door is off, so the venue's cap cannot be read`,
      );
    }
    const listed = new Map(venue.markets.map((m) => [m.symbol, m]));
    for (const symbol of fees.marketGroups.keys()) {
      if (!listed.has(symbol)) throw new BuilderFeeVersionError('trade.builder_fee_market_unknown', `${venueId} lists no market ${symbol}`);
    }
    for (const market of venue.markets) {
      const fee = builderFeeOf(book, venueId, market.symbol)!;
      const cap = market.builderFeeCapBps;
      if (!cap.known) {
        throw new BuilderFeeVersionError(
          'trade.builder_fee_cap_unknown',
          `${venueId} publishes no builder-fee cap on ${market.symbol}, so a builder fee there cannot be shown to be within it`,
        );
      }
      if (compare(fee.feeBps, cap.value) > 0) {
        throw new BuilderFeeVersionError(
          'trade.builder_fee_above_venue_cap',
          `the builder fee of ${venueId} / ${fee.group} is ${formatAmount(fee.feeBps)} bps, above ${venueId}'s cap of ${formatAmount(cap.value)} bps on ${market.symbol}`,
        );
      }
    }
  }
}

/**
 * The builder fees of the schedule version in force at `at` (the latest effective by then), and that version's number;
 * `book` is null when no version is in force or it names no builder fees (the door then uses the boot owner value).
 */
export async function builderFeesAt(sql: Sql, at: Date): Promise<{ version: string | null; book: BuilderFeeBook | null }> {
  const [row] = await sql<Array<{ version: string; schedule: Record<string, unknown> | string }>>`
    SELECT version::text, schedule
      FROM trade.fee_schedule_versions
     WHERE effective_at <= ${at.toISOString()}
     ORDER BY effective_at DESC, fee_schedule_versions.version DESC
     LIMIT 1`;
  if (!row) return { version: null, book: null };
  const schedule = typeof row.schedule === 'string' ? (JSON.parse(row.schedule) as Record<string, unknown>) : row.schedule;
  return { version: row.version, book: parseBuilderFees(schedule.builderFees) };
}
