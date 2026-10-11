/**
 * OTC reference mid port (trade.otc / SPEC-OTC-RFQ-AND-EARN Part A).
 *
 * The mid a quote is priced off is **server-sourced**. It is never read from
 * the caller.
 *
 * "Never invent a mid" is a rule about where a price may come from, not only
 * about refusing to make one up: a desk that prices at a number the taker
 * chose has not avoided inventing a price, it has outsourced the invention to
 * the one party with a reason to get it wrong. The taker names the size and
 * the side; the desk names the price, or there is no quote.
 *
 * Null → `trade.otc_no_reference_price`. A dark feed is a refusal, never a
 * fallback and never a stale number.
 *
 * Every usable mid carries `asOf` — when the price was OBSERVED, not when it
 * was read. The desk law's owner-published `maxMidAgeSeconds` decides when an
 * observation is still a price rather than a memory (DIRECTION §8 — never
 * invented here).
 *
 * This deliberately does NOT reuse `mm/mid-source.ts`, whose config source is
 * the same handful of lines: that module reaches `venue-contracts` and
 * `futures/mark-source`, and importing it here would pull the venue fabric and
 * the futures graph into a desk that needs neither. When a published desk
 * wants live venue mids, chain a second source in front of this one rather
 * than widening the import.
 */

import { parseAmount, ZERO } from '@intafaced/ledger-client';

/** Keyed by pair, not by market id — the OTC desk quotes assets, not listings. */
export interface OtcQuotedMid {
  readonly mid: string;
  /** Observation time — not read time. A read-time stamp defeats age gates. */
  readonly asOf: Date;
}

export type OtcMidSource = (pairKey: string) => OtcQuotedMid | null | Promise<OtcQuotedMid | null>;

/**
 * The one normalisation, used for BOTH the lookup key and the assets that reach
 * the ledger. Ledger asset ids are upper-case (`BTC`, `USDT`), so a desk that
 * looks a mid up under one spelling and settles under another has promised a
 * quote it cannot honour.
 *
 * `/` is refused rather than normalised: it is the pair separator, so allowing
 * it inside an asset lets `('BTC', 'USDT/X')` and `('BTC/USDT', 'X')` collide
 * onto one published mid.
 */
export function normalizeOtcAsset(asset: string): string | null {
  const a = asset.trim().toUpperCase();
  if (!a || a.includes('/')) return null;
  return a;
}

/**
 * `BASE/QUOTE`, upper-cased — the same shape as `trade.markets.symbol`, so one
 * ops entry reads the same whether it names a listing or an OTC pair.
 * Null when either side is not a usable asset id.
 */
export function otcPairKey(baseAsset: string, quoteAsset: string): string | null {
  const base = normalizeOtcAsset(baseAsset);
  const quote = normalizeOtcAsset(quoteAsset);
  if (base == null || quote == null) return null;
  return `${base}/${quote}`;
}

/** Production default: nothing published → every quote refuses. */
export const NO_OTC_MIDS: OtcMidSource = () => null;

/**
 * Ops-published map: `BASE/QUOTE:mid,BASE/QUOTE:mid`.
 *
 * A malformed entry is dropped, including a pair side that is not exactly
 * `BASE/QUOTE` and a price that is not a positive ledger decimal. `otcPairKey`
 * reads only the first two assets, so spreading `BTC/USDT/X` would store the
 * mid under `BTC/USDT` and overwrite a real reference. A pair with no usable
 * mid must reach the desk as ABSENT, so it refuses
 * `trade.otc_no_reference_price` at boot-time cost rather than surfacing an
 * ops typo to a customer as `trade.otc_invalid_price`.
 *
 * Positivity is `parseAmount` vs `ZERO`. A JS Number on a money string
 * rounds past `MAX_SAFE_INTEGER`.
 */
export function parseOtcMids(raw: string | null | undefined): Map<string, string> {
  const map = new Map<string, string>();
  for (const part of (raw ?? '').split(',')) {
    const idx = part.indexOf(':');
    if (idx <= 0) continue;
    const [base, quote, extra] = part.slice(0, idx).split('/');
    if (extra !== undefined || base == null || quote == null) continue;
    const pair = otcPairKey(base, quote);
    const mid = part.slice(idx + 1).trim();
    if (pair == null || !isPositiveLedgerMid(mid)) continue;
    map.set(pair, mid);
  }
  return map;
}

function isPositiveLedgerMid(mid: string): boolean {
  try {
    return parseAmount(mid) > ZERO;
  } catch {
    return false;
  }
}

/**
 * Ops-published map stamped at boot.
 *
 * ── SOCKET §13 · `socket.otc-mid-feed` (see mid-feed.ts) ─────────────────────
 *
 * This is a FIXED price read once at boot. `asOf` is the boot stamp, so the
 * desk law's `maxMidAgeSeconds` makes the map go dark after that window —
 * which is the point. Publish `BTC/USDT:65000`, let the market move, and the
 * age gate refuses rather than keeping the desk open on a memory.
 *
 * A live OTC desk needs a feed that refreshes `asOf` on each observation
 * (`createObservedOtcMidSource` or `createVenueOtcMidSource` in venue-mid-source.ts).
 * The max-age number itself is owner law on the desk (DIRECTION §8), never a default here.
 * Public posture: `otc.deskStatus.midFeed` — published=false until that feed is installed.
 */
export function createConfigOtcMidSource(raw: string | null | undefined, bootAsOf: Date = new Date()): OtcMidSource {
  const mids = parseOtcMids(raw);
  return (pairKey) => {
    const mid = mids.get(pairKey);
    if (mid == null) return null;
    return { mid, asOf: bootAsOf };
  };
}

/**
 * Observed mid map — `asOf` comes from the caller (feed clock), not read time.
 * Used by tests and by any live adapter that already has an observation time.
 */
export function createObservedOtcMidSource(raw: string | null | undefined, asOf: () => Date): OtcMidSource {
  const mids = parseOtcMids(raw);
  return (pairKey) => {
    const mid = mids.get(pairKey);
    if (mid == null) return null;
    return { mid, asOf: asOf() };
  };
}
