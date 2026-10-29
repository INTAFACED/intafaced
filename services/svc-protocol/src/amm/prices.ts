import type { ProtocolSwapPairs, ProtocolTokenPrice } from '@intafaced/contracts';

/** USD prices are carried as 18-decimal fixed point in memory and as decimal strings on the wire. */
const USD_SCALE = 10n ** 18n;

export interface PriceSetting {
  /** The owner's reference tokens: each counts as one US dollar. Lower-case addresses. */
  usdTokens: ReadonlySet<string>;
  /** The least a pool must hold on its priced side, in whole US dollars, for its price to be used. */
  minReserveUsd: bigint;
}

type Pool = ProtocolSwapPairs['pools'][number];

/** Reserves oriented as (this token, the other token). */
function sides(pool: Pool, token: string): { mine: bigint; other: bigint; otherToken: string } | null {
  const t0 = pool.token0.toLowerCase();
  const t1 = pool.token1.toLowerCase();
  if (token === t0) return { mine: BigInt(pool.reserve0), other: BigInt(pool.reserve1), otherToken: t1 };
  if (token === t1) return { mine: BigInt(pool.reserve1), other: BigInt(pool.reserve0), otherToken: t0 };
  return null;
}

/** 18-decimal USD fixed point as a decimal string, trailing zeros dropped. */
export function usdText(value: bigint): string {
  const whole = value / USD_SCALE;
  const fraction = (value % USD_SCALE).toString().padStart(18, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

/**
 * Each listed token's USD price (D-swap-11), read from the pools at one block, with a reliability filter: a price comes
 * only from a pool whose other side is worth at least the owner's minimum reserve. A token with a reference token on the
 * other side is priced from its deepest such pool; failing that, through one token that is itself priced directly.
 * A token whose pools all fall under the minimum has no price and says so (`thin_reserve`); one with no path at all
 * reads `no_route`. Nothing is averaged, defaulted or carried over from another block.
 */
export function priceTokens(pairs: ProtocolSwapPairs, setting: PriceSetting): ProtocolTokenPrice[] {
  const decimals = new Map(pairs.tokens.map((token) => [token.address.toLowerCase(), token.decimals]));
  const minReserve = setting.minReserveUsd * USD_SCALE;
  const direct = new Map<string, bigint>();
  const thin = new Set<string>();

  /** The USD value (18 dp) of `units` of `token` at `price` (18 dp per whole token). */
  const valueOf = (units: bigint, token: string, price: bigint) => (units * price) / 10n ** BigInt(decimals.get(token) ?? 0);
  /** The price (18 dp per whole token) of `token` from a pool holding `mine` of it against `other` of `otherToken`. */
  const priceFrom = (token: string, mine: bigint, otherToken: string, other: bigint, otherPrice: bigint) =>
    mine === 0n
      ? 0n
      : (other * otherPrice * 10n ** BigInt(decimals.get(token) ?? 0)) / (mine * 10n ** BigInt(decimals.get(otherToken) ?? 0));

  const best = (token: string, priced: ReadonlyMap<string, bigint>): bigint | null => {
    let chosen: { price: bigint; depth: bigint } | null = null;
    for (const pool of pairs.pools) {
      const side = sides(pool, token);
      if (!side) continue;
      const otherPrice = priced.get(side.otherToken);
      if (otherPrice === undefined) continue;
      const depth = valueOf(side.other, side.otherToken, otherPrice);
      if (depth < minReserve) {
        thin.add(token);
        continue;
      }
      if (!chosen || depth > chosen.depth) chosen = { price: priceFrom(token, side.mine, side.otherToken, side.other, otherPrice), depth };
    }
    return chosen?.price ?? null;
  };

  const references = new Map([...setting.usdTokens].filter((token) => decimals.has(token)).map((token) => [token, USD_SCALE]));
  for (const token of decimals.keys()) {
    if (references.has(token)) continue;
    const price = best(token, references);
    if (price !== null) direct.set(token, price);
  }
  const firstHop = new Map([...references, ...direct]);
  return pairs.tokens.map((entry) => {
    const token = entry.address.toLowerCase();
    if (references.has(token)) return { address: entry.address, usd: '1', basis: 'reference' as const, reason: null };
    const price = direct.get(token) ?? best(token, firstHop);
    if (price !== null && price > 0n)
      return {
        address: entry.address,
        usd: usdText(price),
        basis: direct.has(token) ? ('pool' as const) : ('one_hop' as const),
        reason: null,
      };
    return { address: entry.address, usd: null, basis: null, reason: thin.has(token) ? ('thin_reserve' as const) : ('no_route' as const) };
  });
}

/** `PROTOCOL_PRICE_USD_TOKENS`: comma-separated addresses. Blank or any malformed entry is null; never a default list. */
export function parseUsdTokens(raw: string): ReadonlySet<string> | null {
  const entries = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (entries.length === 0 || entries.some((entry) => !/^0x[0-9a-fA-F]{40}$/.test(entry))) return null;
  return new Set(entries.map((entry) => entry.toLowerCase()));
}

/** `PROTOCOL_PRICE_MIN_RESERVE_USD`: whole US dollars, above 0. Blank is null; never a default. */
export function parseMinReserveUsd(raw: string): bigint | null {
  const text = raw.trim();
  return /^[1-9]\d{0,17}$/.test(text) ? BigInt(text) : null;
}
