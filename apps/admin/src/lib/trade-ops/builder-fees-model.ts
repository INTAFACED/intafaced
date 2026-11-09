/**
 * Builder-fee versions in the Fees and convert room (J-cex-spot-17 #1 #3). INTAFACED holds no customer money: customers
 * trade from their own wallet on an outside venue, and our fee is the builder fee their order carries there. A version's
 * builder fees are the `builderFees` part of the owner fee schedule version (svc-trade
 * `services/svc-trade/src/venue/builder-fee-versions.ts`), by venue and market group, each rate an exact decimal string
 * of bps. The venue's own cap on a builder fee is read from the venue through svc-trade's user-venue door
 * (`admin.fees.builderCaps`), never held here. Rates stay strings; comparisons use scaled bigints, never a float. No
 * network and no clock of its own: safe in tests.
 */
import type { VersionState } from './fees-versions-model';

const rec = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === 'string';

/** 0 to 9999 bps, at most four places: svc-trade's own rule for our rates. */
export const BUILDER_RATE = /^(?:0|[1-9]\d{0,3})(?:\.\d{1,4})?$/;
/** A figure the venue publishes (its cap) may carry more places than our rates: any plain decimal, at most 18 places. */
const VENUE_BPS = /^(?:0|[1-9]\d{0,19})(?:\.\d{1,18})?$/;

export interface VenueBuilderFeesView {
  readonly defaultGroup: string;
  readonly marketGroups: Readonly<Record<string, string>>;
  readonly groups: Readonly<Record<string, string>>;
}

/** The builder fees a stored schedule sets, by venue id; empty when it sets none. Malformed entries are left out. */
export function builderFeesOf(schedule: Readonly<Record<string, unknown>>): Record<string, VenueBuilderFeesView> {
  const out: Record<string, VenueBuilderFeesView> = {};
  if (!rec(schedule.builderFees)) return out;
  for (const [venueId, entry] of Object.entries(schedule.builderFees)) {
    if (!rec(entry) || !str(entry.defaultGroup) || !rec(entry.groups)) continue;
    const groups: Record<string, string> = {};
    for (const [g, rate] of Object.entries(entry.groups)) if (str(rate)) groups[g] = rate;
    const marketGroups: Record<string, string> = {};
    if (rec(entry.marketGroups)) for (const [s, g] of Object.entries(entry.marketGroups)) if (str(g)) marketGroups[s] = g;
    out[venueId] = { defaultGroup: entry.defaultGroup, marketGroups, groups };
  }
  return out;
}

/** Exact decimal bps as a percent with its bps: "2" → "0.02% (2 bps)", "1.5" → "0.015% (1.5 bps)". */
export function builderRateText(bps: string | null | undefined): string {
  if (bps === null || bps === undefined || !VENUE_BPS.test(bps)) return 'not set';
  const [whole = '0', frac = ''] = bps.split('.');
  const digits = (whole + frac).padStart(frac.length + 3, '0');
  const point = digits.length - frac.length - 2;
  let percentFrac = digits.slice(point).replace(/0+$/, '');
  if (percentFrac.length < 2) percentFrac = percentFrac.padEnd(2, '0');
  return `${BigInt(digits.slice(0, point))}.${percentFrac}% (${bps} bps)`;
}

/** A decimal bps string as an 18-place scaled bigint, for an exact comparison. */
export function bpsUnits(bps: string): bigint {
  const [whole = '0', frac = ''] = bps.split('.');
  return BigInt(whole) * 10n ** 18n + BigInt(frac.padEnd(18, '0').slice(0, 18) || '0');
}

/** The same JSON, whatever the key order. */
function sameJson(a: unknown, b: unknown): boolean {
  const canonical = (v: unknown): unknown =>
    v === null || typeof v !== 'object'
      ? v
      : Array.isArray(v)
        ? v.map(canonical)
        : Object.fromEntries(
            Object.keys(v)
              .sort()
              .map((k) => [k, canonical((v as Record<string, unknown>)[k])]),
          );
  return JSON.stringify(canonical(a) ?? null) === JSON.stringify(canonical(b) ?? null);
}

// ── the venue's caps ──

export interface BuilderCaps {
  readonly venueId: string;
  readonly displayName: string;
  readonly test: boolean;
  readonly asOf: string;
  readonly markets: ReadonlyArray<{ readonly symbol: string; readonly kind: string; readonly capBps: string | null }>;
}

/** Parse `admin.fees.builderCaps`. Anything not that shape is null: the room refuses it, never half-shows it. */
export function parseBuilderCaps(raw: unknown): BuilderCaps | null {
  if (!rec(raw) || !str(raw.venueId) || !str(raw.displayName) || typeof raw.test !== 'boolean' || !str(raw.asOf)) return null;
  if (!Array.isArray(raw.markets)) return null;
  const markets = raw.markets.map((m) =>
    rec(m) && str(m.symbol) && str(m.kind) && (m.capBps === null || (str(m.capBps) && VENUE_BPS.test(m.capBps)))
      ? { symbol: m.symbol, kind: m.kind, capBps: m.capBps as string | null }
      : null,
  );
  if (markets.some((m) => m === null)) return null;
  return {
    venueId: raw.venueId,
    displayName: raw.displayName,
    test: raw.test,
    asOf: raw.asOf,
    markets: markets as Array<{ symbol: string; kind: string; capBps: string | null }>,
  };
}

// ── #1 the versions, by venue and market group ──

export interface BuilderFeeLine {
  readonly version: string;
  readonly state: VersionState;
  readonly effectiveAt: string;
  readonly rate: string;
}

export interface BuilderGroupView {
  readonly group: string;
  /** The markets the newest shown version puts in this group; null for its default group (every other market). */
  readonly markets: readonly string[] | null;
  readonly lines: readonly BuilderFeeLine[];
}

export interface BuilderVenueView {
  readonly venueId: string;
  readonly groups: readonly BuilderGroupView[];
}

/**
 * The shown versions' builder fees regrouped by venue and market group: one table per group, one line per version that
 * sets builder fees for that venue. `shown` is the room's own list (`shownVersions`), newest first.
 */
export function builderFeeViews(
  shown: ReadonlyArray<{ row: { version: string; effectiveAt: string; schedule: Readonly<Record<string, unknown>> }; state: VersionState }>,
): BuilderVenueView[] {
  const venues = new Map<string, Map<string, BuilderFeeLine[]>>();
  const newest = new Map<string, VenueBuilderFeesView>();
  for (const { row, state } of shown) {
    for (const [venueId, fees] of Object.entries(builderFeesOf(row.schedule))) {
      if (!newest.has(venueId)) newest.set(venueId, fees);
      const groups = venues.get(venueId) ?? new Map<string, BuilderFeeLine[]>();
      for (const [group, rate] of Object.entries(fees.groups)) {
        const lines = groups.get(group) ?? [];
        lines.push({ version: row.version, state, effectiveAt: row.effectiveAt, rate: builderRateText(rate) });
        groups.set(group, lines);
      }
      venues.set(venueId, groups);
    }
  }
  return [...venues.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([venueId, groups]) => {
      const latest = newest.get(venueId)!;
      return {
        venueId,
        groups: [...groups.entries()]
          .sort(([a], [b]) => (a === latest.defaultGroup ? -1 : b === latest.defaultGroup ? 1 : a.localeCompare(b)))
          .map(([group, lines]) => ({
            group,
            markets:
              group === latest.defaultGroup
                ? null
                : Object.entries(latest.marketGroups)
                    .filter(([, g]) => g === group)
                    .map(([s]) => s)
                    .sort(),
            lines,
          })),
      };
    });
}

// ── #3 the proposal's builder fees ──

export interface BuilderDraftLine {
  readonly venueId: string;
  readonly group: string;
  readonly feeBps: string;
}

/** One editable line per (venue, group) the base version sets. */
export function builderDraftFrom(schedule: Readonly<Record<string, unknown>>): BuilderDraftLine[] {
  return Object.entries(builderFeesOf(schedule)).flatMap(([venueId, fees]) =>
    Object.entries(fees.groups).map(([group, feeBps]) => ({ venueId, group, feeBps })),
  );
}

export type BuilderCheck = { readonly ok: true } | { readonly ok: false; readonly code: string; readonly message: string };

/**
 * Put the draft's builder fees into `schedule` (a copy the caller owns) and, when they differ from the base version's
 * (`baseBuilderFees`), check every venue it sets against that venue's own cap, as svc-trade does when it writes: a blank
 * or malformed rate refuses `trade.builder_fee_blank`, a rate above the cap on any market it applies to
 * `trade.builder_fee_above_venue_cap`, a cap the venue does not publish `trade.builder_fee_cap_unknown`, and a venue
 * whose caps could not be read `trade.builder_fee_venue_unknown`. Builder fees kept as they were need no venue read, so
 * an engine rate change never waits on the venue.
 */
export function applyBuilderDraft(
  schedule: Record<string, unknown>,
  lines: readonly BuilderDraftLine[],
  caps: BuilderCaps | null,
  baseBuilderFees: unknown,
): BuilderCheck {
  const book = rec(schedule.builderFees) ? schedule.builderFees : null;
  for (const line of lines) {
    const where = `${line.venueId} / ${line.group}`;
    const value = line.feeBps.trim();
    if (value === '')
      return { ok: false, code: 'trade.builder_fee_blank', message: `The builder fee of ${where} is blank. Every rate needs a value.` };
    if (!BUILDER_RATE.test(value))
      return {
        ok: false,
        code: 'trade.builder_fee_blank',
        message: `The builder fee of ${where} must be a decimal number of bps from 0 to 9999, at most four places.`,
      };
    const venue = book?.[line.venueId];
    if (!rec(venue) || !rec(venue.groups) || !(line.group in venue.groups))
      return {
        ok: false,
        code: 'trade_ops.fee_row_unknown',
        message: `The base version has no builder fee ${where}. Read the versions again.`,
      };
    venue.groups[line.group] = value;
  }
  if (sameJson(schedule.builderFees, baseBuilderFees)) return { ok: true };
  for (const [venueId, fees] of Object.entries(builderFeesOf(schedule))) {
    if (!caps || caps.venueId !== venueId)
      return {
        ok: false,
        code: 'trade.builder_fee_venue_unknown',
        message: `The cap of ${venueId} could not be read from the venue, so a builder fee there cannot be shown to be within it.`,
      };
    for (const market of caps.markets) {
      const group = fees.marketGroups[market.symbol] ?? fees.defaultGroup;
      const rate = fees.groups[group];
      if (rate === undefined || !BUILDER_RATE.test(rate))
        return { ok: false, code: 'trade.builder_fee_blank', message: `The builder fee of ${venueId} / ${group} is blank.` };
      if (market.capBps === null)
        return {
          ok: false,
          code: 'trade.builder_fee_cap_unknown',
          message: `${venueId} publishes no builder-fee cap on ${market.symbol}, so a builder fee there cannot be shown to be within it.`,
        };
      if (bpsUnits(rate) > bpsUnits(market.capBps))
        return {
          ok: false,
          code: 'trade.builder_fee_above_venue_cap',
          message: `The builder fee of ${venueId} / ${group} is ${rate} bps, above the venue's cap of ${market.capBps} bps on ${market.symbol}.`,
        };
    }
  }
  return { ok: true };
}

/** The draft's builder lines as the browser sends them; `undefined` is none. Null when the body is not that shape. */
export function parseBuilderDraft(raw: unknown): BuilderDraftLine[] | null {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > 100) return null;
  const lines = raw.map((l) =>
    rec(l) && str(l.venueId) && str(l.group) && str(l.feeBps) ? { venueId: l.venueId, group: l.group, feeBps: l.feeBps } : null,
  );
  return lines.some((l) => l === null) ? null : (lines as BuilderDraftLine[]);
}
