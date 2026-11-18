import { TIER_ORDER } from '@intafaced/auth';
import type { ListedVenueMarket } from './venue-listing.js';
import type { VenueGatedBlocker } from './venue-gated-list.js';

/**
 * THE VENUE'S PERPETUALS: WHO IS ELIGIBLE (J-derivatives-12 #5). The owner sets the verification level an account needs
 * for the perpetuals we show on a venue (`TRADE_USER_VENUE_ELIGIBILITY_LEVEL`). It is one rule for three places, so they
 * never disagree: the eligible list for the account, the gated list's reasons, and a new perpetual position at prepare.
 *
 *   - blank: no account is eligible. The list is empty with `trade.venue_eligibility_level_unset` named, and every new
 *     perpetual position refuses with it. A blank owner value refuses; it never means "no requirement".
 *   - set: an account whose trading level (the trading checks' clear counting as `basic`, as everywhere on the venue door)
 *     is below it is not eligible: `trade.venue_eligibility_level_insufficient`.
 *
 * A reduce-only order, a cancel and a withdrawal are never checked: they only take risk off the venue.
 */

export const VENUE_ELIGIBILITY_LEVELS = ['basic', 'full', 'institutional'] as const;
export type VenueEligibilityLevel = (typeof VENUE_ELIGIBILITY_LEVELS)[number];

export const VENUE_ELIGIBILITY_LEVEL_UNSET = 'trade.venue_eligibility_level_unset' as const;
export const VENUE_ELIGIBILITY_LEVEL_INSUFFICIENT = 'trade.venue_eligibility_level_insufficient' as const;

/** Why an account is not eligible: one of the two codes, with words a person reads. */
export interface VenueEligibilityBlocker extends VenueGatedBlocker {
  readonly code: typeof VENUE_ELIGIBILITY_LEVEL_UNSET | typeof VENUE_ELIGIBILITY_LEVEL_INSUFFICIENT;
}

const isLevel = (v: string): v is VenueEligibilityLevel => VENUE_ELIGIBILITY_LEVELS.some((l) => l === v);
const TIER_RANK: ReadonlyMap<string, number> = new Map(Object.entries(TIER_ORDER));

/** The owner value: blank is `null`; anything but a level name is refused at boot, never read as blank or as a level. */
export function parseVenueEligibilityLevel(raw: string | undefined): VenueEligibilityLevel | null {
  const v = (raw ?? '').trim();
  if (v === '') return null;
  if (!isLevel(v))
    throw new Error(
      `TRADE_USER_VENUE_ELIGIBILITY_LEVEL must be blank or one of ${VENUE_ELIGIBILITY_LEVELS.join(', ')}, got ${JSON.stringify(v)}`,
    );
  return v;
}

/** Why this account is not eligible for the venue's perpetuals, or null when it is. `tier` is its trading level. */
export function venueEligibilityBlocker(level: VenueEligibilityLevel | null, tier: string | null): VenueEligibilityBlocker | null {
  if (level === null)
    return {
      code: VENUE_ELIGIBILITY_LEVEL_UNSET,
      message: 'The eligibility level for perpetuals is not set, so no perpetual is open to any account',
    };
  const rank = (tier === null ? undefined : TIER_RANK.get(tier)) ?? -1;
  if (rank >= TIER_ORDER[level]) return null;
  return {
    code: VENUE_ELIGIBILITY_LEVEL_INSUFFICIENT,
    message: `Perpetuals here need the ${level} verification level; your account is below it`,
  };
}

/** One perpetual this account may trade, and the asset it settles and is margined in. */
export interface VenueEligibleInstrument {
  readonly symbol: string;
  readonly settleAsset: string;
  readonly maxLeverageBps: number | null;
}

export interface VenueEligibleInstruments {
  /** The owner's level, or null when blank. */
  readonly level: VenueEligibilityLevel | null;
  /** Why the list is empty for this account, or null when it is eligible. */
  readonly reason: VenueGatedBlocker | null;
  readonly instruments: readonly VenueEligibleInstrument[];
}

/**
 * The account's eligible instruments: every perpetual we show here when it is eligible, each with its settle asset (the
 * deployer's own margin asset where the market keeps one, else its quote asset); none, with the reason, when it is not.
 */
export function venueEligibleInstruments(
  markets: readonly ListedVenueMarket[],
  level: VenueEligibilityLevel | null,
  tier: string | null,
): VenueEligibleInstruments {
  const reason = venueEligibilityBlocker(level, tier);
  if (reason) return { level, reason, instruments: [] };
  const instruments = markets
    .filter((m) => m.kind === 'perpetual')
    .map((m) => ({
      symbol: m.symbol,
      settleAsset: m.marginAccount?.known ? m.marginAccount.value.collateralAsset : m.quoteAsset,
      maxLeverageBps: m.maxLeverageBps,
    }));
  return { level, reason: null, instruments };
}
