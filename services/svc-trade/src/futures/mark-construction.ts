/**
 * MARK CONSTRUCTIONS (D-instruments-01, derivatives-instruments-pricing-004).
 *
 * Two owner-selected ways to build a mark, next to the ones that exist (mid of the matching book, mid of a venue
 * book, picked by `markSourcePrefer`):
 *
 *  - `index_plus_basis`: the index plus a basis (the recent gap between the book mid and the index).
 *  - `median_of_three`: the middle of index-plus-basis, the book mid and the last print.
 *
 * Both are pure functions on scaled bigint. The selection is the owner's: a blank selection (`null`) keeps today's
 * behaviour, and `markSourceWithConstruction` then hands back the source it was given, unchanged. A selected
 * construction that is missing an input answers null, never a guess and never zero.
 *
 * The result is labelled `index` quality because each construction needs an index term, so one printed trade cannot
 * move it alone. That is a statement about these formulas, and `mark-policy.ts` still decides what an `index` mark
 * may be used for.
 */
import { formatAmount, type Amount } from '@intafaced/ledger-client';
import type { MarkRequest, MarkSource, QuotedMarkSource } from './liquidation-tick.js';
import { DEFAULT_FUTURES_MARK_POLICY, acceptableForLiquidation, type FuturesQuotedMark, type MarkPolicy } from './mark-policy.js';

export const MARK_CONSTRUCTIONS = ['index_plus_basis', 'median_of_three'] as const;
export type MarkConstruction = (typeof MARK_CONSTRUCTIONS)[number];

/**
 * Parse an owner selection. Blank (undefined, null, empty) is `null`: keep today's mark. Anything else that is not a
 * known construction throws, so a typo cannot silently fall back to a different mark.
 */
export function parseMarkConstruction(raw: string | null | undefined): MarkConstruction | null {
  const text = (raw ?? '').trim();
  if (text === '') return null;
  if ((MARK_CONSTRUCTIONS as readonly string[]).includes(text)) return text as MarkConstruction;
  throw new Error(`mark construction must be one of ${MARK_CONSTRUCTIONS.join(', ')} or blank, got "${raw}"`);
}

/** Index plus basis. `basis` is signed. A non-positive result is not a price and is null. */
export function indexPlusBasis(index: Amount, basis: Amount): Amount | null {
  const mark = index + basis;
  return mark > 0n ? mark : null;
}

/** The middle of three prices. */
export function medianOfThree(a: Amount, b: Amount, c: Amount): Amount {
  const sorted = [a, b, c].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
  return sorted[1]!;
}

/** What a construction is built from. Null is "not available", never zero. */
export interface MarkConstructionInputs {
  readonly index: Amount | null;
  /** Signed gap between the book mid and the index, averaged by the caller over its window. */
  readonly basis: Amount | null;
  readonly mid: Amount | null;
  readonly last: Amount | null;
  /** When the OLDEST input was observed. The staleness gates read this, so it is never a read time. */
  readonly observedAt: Date;
}

/** Build one mark. Null when the selected construction is missing an input. */
export function constructMark(selection: MarkConstruction, inputs: MarkConstructionInputs): Amount | null {
  if (inputs.index == null || inputs.basis == null || inputs.index <= 0n) return null;
  const anchored = indexPlusBasis(inputs.index, inputs.basis);
  if (anchored == null) return null;
  if (selection === 'index_plus_basis') return anchored;
  if (inputs.mid == null || inputs.last == null || inputs.mid <= 0n || inputs.last <= 0n) return null;
  return medianOfThree(anchored, inputs.mid, inputs.last);
}

/**
 * Put the owner's construction behind a mark source. Blank selection returns `base` itself.
 *
 * `inputs` reads the parts. On main nothing supplies an index (NotConnected `feed.market`), so a selected
 * construction answers null there and the position is not valued rather than valued on a guess.
 */
export function markSourceWithConstruction(
  base: MarkSource,
  selection: MarkConstruction | null,
  inputs: (request: MarkRequest) => Promise<MarkConstructionInputs | null>,
  policy: MarkPolicy = DEFAULT_FUTURES_MARK_POLICY,
): MarkSource {
  if (selection === null) return base;
  const quote = async (request: MarkRequest): Promise<FuturesQuotedMark | null> => {
    const parts = await inputs(request);
    if (!parts) return null;
    const price = constructMark(selection, parts);
    if (price == null) return null;
    return {
      marketId: request.marketId,
      ...(request.symbol ? { symbol: request.symbol } : {}),
      price,
      asOf: parts.observedAt,
      quality: 'index',
    };
  };
  const constructed: QuotedMarkSource = {
    quote,
    async markPrice(request) {
      const q = await quote(request);
      // Same bar the other sources apply to the bare-string door: the liquidation gate.
      if (!q || !acceptableForLiquidation(q, null, request.at, policy).ok) return null;
      return formatAmount(q.price);
    },
  };
  return constructed;
}
