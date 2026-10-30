import { formatUnits, parseUnits, type Address, type Hex } from 'viem';
import {
  ORGANIC_SCORE_UNSET,
  TOKEN_WINDOW_SECONDS,
  TOKENS_HOLDERS_INCONSISTENT,
  TOKENS_READ_TOO_LARGE,
  TOKEN_NOT_LISTED,
  TOKEN_UNSUPPORTED,
  TRUST_CRITERIA_UNSET,
  type TokenBasics,
  type TokenListRow,
  type TokenPageData,
  type TokensLeaderboard,
  type TokensList,
  type TokenWindowId,
} from '@intafaced/contracts';

/**
 * The token pages, worked out from the pool factory's own pools and their logs (D-portfolio-wallet-06, -07,
 * D-launch-listing-02, -04, D-explorer-05). Every figure is a sum or a ratio of what the chain recorded: reserves from
 * `Sync`, trades from `Swap`, holders from `Transfer`, listing time from `PoolCreated`. Nothing is read from config but
 * the quote token, an owner setting with no default. Amounts stay bigint; a price is a decimal string scaled by 1e18.
 *
 * This reads logs straight from the node, so it is sized for the TEST chain: past `MAX_LOGS` it refuses
 * `protocol.tokens_read_too_large` rather than answer from a part of the history.
 */
export const MAX_LOGS = 20_000;
export const MAX_HOLDERS = 1_000;
/** Prices and figures here are on-chain 18-place fixed point; viem owns the unit conversion. */
const PLACES = 18;
const SCALE = parseUnits('1', PLACES);
const ZERO = '0x0000000000000000000000000000000000000000';
const DEAD = '0x000000000000000000000000000000000000dead';

export interface PoolRecord {
  pool: Address;
  token0: Address;
  token1: Address;
  feeBps: number;
  reserve0: bigint;
  reserve1: bigint;
  /** Unix seconds of the block that created it. */
  createdAt: number;
  /** The factory's index: the order pools were created in. */
  index: number;
}
export interface SyncLog {
  pool: Address;
  tx: Hex;
  logIndex: number;
  block: bigint;
  time: number;
  reserve0: bigint;
  reserve1: bigint;
}
export interface SwapLog {
  pool: Address;
  tx: Hex;
  logIndex: number;
  block: bigint;
  time: number;
  /** The account that signed the transaction. */
  wallet: Address;
  amount0In: bigint;
  amount1In: bigint;
  amount0Out: bigint;
  amount1Out: bigint;
}
export interface TransferLog {
  from: Address;
  to: Address;
  value: bigint;
}

/** Everything the list, the page and the leaderboard need, read at one block. */
export interface MarketSnapshot {
  blockNumber: bigint;
  asOf: number;
  tokens: TokenBasics[];
  /** Tokens in the factory's pools left out because they claim more decimals than the wire takes, lowercased. */
  unsupported?: string[];
  pools: PoolRecord[];
  syncs: SyncLog[];
  swaps: SwapLog[];
}

export class TokensReadError extends Error {
  constructor(
    readonly code: typeof TOKENS_READ_TOO_LARGE | typeof TOKENS_HOLDERS_INCONSISTENT | typeof TOKEN_NOT_LISTED | typeof TOKEN_UNSUPPORTED,
    message: string,
  ) {
    super(`${code}: ${message}`);
  }
}

const lower = (a: string) => a.toLowerCase();
const same = (a: string, b: string) => lower(a) === lower(b);

/** A 1e18-scaled bigint as a decimal string, trailing zeros trimmed. */
export function formatScaled(value: bigint): string {
  return formatUnits(value, PLACES);
}
/** Base units with `decimals` places as a 1e18-scaled bigint (exact up to 18 places; more are cut toward zero). */
export function toScaled(amount: bigint, decimals: number): bigint {
  return decimals <= 18 ? amount * 10n ** BigInt(18 - decimals) : amount / 10n ** BigInt(decimals - 18);
}
/** Price of `base` in `quote` (1e18-scaled) from two reserves; null when either side is empty. */
export function reservePrice(baseReserve: bigint, baseDecimals: number, quoteReserve: bigint, quoteDecimals: number): bigint | null {
  if (baseReserve <= 0n || quoteReserve <= 0n) return null;
  return (quoteReserve * 10n ** BigInt(18 + baseDecimals)) / (baseReserve * 10n ** BigInt(quoteDecimals));
}

/**
 * Cyrillic and Greek letters drawn like a Latin one, after case folding. Not the full Unicode confusables table: the
 * letters a copied ticker or name is most often made of: Cyrillic а в с ԁ е һ н і ј к ӏ м о р ԛ ѕ т у х, then Greek
 * α β ε η ι κ ν ο ρ τ υ χ ω. A Greek letter is read by its capital, since tickers are written in capitals: Η as H,
 * Ν as N, Υ as Y.
 */
const LOOKALIKE_LETTERS =
  '\u0430\u0432\u0441\u0501\u0435\u04bb\u043d\u0456\u0458\u043a\u04cf\u043c\u043e\u0440\u051b\u0455\u0442\u0443\u0445\u03b1\u03b2\u03b5\u03b7\u03b9\u03ba\u03bd\u03bf\u03c1\u03c4\u03c5\u03c7\u03c9';
const AS_LATIN = 'abcdehhijklmopqstyxabehiknoptyxw';
const CONFUSABLE = new Map([...LOOKALIKE_LETTERS].map((ch, i) => [ch, AS_LATIN[i]!]));

/** Name or symbol as a reader sees it: NFKC, invisible characters and spaces dropped, case folded, lookalike letters read as Latin. */
export function normaliseName(text: string): string {
  return [
    ...text
      .normalize('NFKC')
      .replace(/[\p{Cf}\p{Zs}\s]/gu, '')
      .toLowerCase(),
  ]
    .map((ch) => CONFUSABLE.get(ch) ?? ch)
    .join('');
}

class Market {
  readonly byAddress = new Map<string, TokenBasics>();
  readonly poolsOf = new Map<string, PoolRecord[]>();
  readonly syncsOf = new Map<string, SyncLog[]>();
  readonly poolAt = new Map<string, PoolRecord>();
  private readonly priceNow = new Map<string, bigint | null>();

  constructor(
    readonly snap: MarketSnapshot,
    readonly quote: TokenBasics,
  ) {
    for (const t of snap.tokens) this.byAddress.set(lower(t.address), t);
    for (const p of snap.pools) this.poolAt.set(lower(p.pool), p);
    for (const p of snap.pools)
      for (const side of [p.token0, p.token1]) {
        const list = this.poolsOf.get(lower(side)) ?? [];
        list.push(p);
        this.poolsOf.set(lower(side), list);
      }
    const ordered = [...snap.syncs].sort((a, b) => (a.block === b.block ? a.logIndex - b.logIndex : a.block < b.block ? -1 : 1));
    for (const s of ordered) {
      const list = this.syncsOf.get(lower(s.pool)) ?? [];
      list.push(s);
      this.syncsOf.set(lower(s.pool), list);
    }
  }

  decimals(token: string): number {
    return this.byAddress.get(lower(token))?.decimals ?? 18;
  }

  /** The pool's reserves at `time`: the last Sync at or before it, else its first Sync (it was listed later). */
  reservesAt(pool: PoolRecord, time: number | null): [bigint, bigint] {
    if (time === null) return [pool.reserve0, pool.reserve1];
    const syncs = this.syncsOf.get(lower(pool.pool)) ?? [];
    let found: SyncLog | undefined;
    for (const s of syncs) if (s.time <= time) found = s;
    found ??= syncs[0];
    return found ? [found.reserve0, found.reserve1] : [pool.reserve0, pool.reserve1];
  }

  /** `token` priced in `other` through one pool, at `time` (null: now). */
  pairPrice(pool: PoolRecord, token: string, time: number | null): bigint | null {
    const [r0, r1] = this.reservesAt(pool, time);
    const isToken0 = same(pool.token0, token);
    const other = isToken0 ? pool.token1 : pool.token0;
    return isToken0
      ? reservePrice(r0, this.decimals(token), r1, this.decimals(other))
      : reservePrice(r1, this.decimals(token), r0, this.decimals(other));
  }

  /** The deepest pool pairing `token` with `other`, by `token`'s reserve now. */
  deepest(token: string, other: string): PoolRecord | null {
    const pools = (this.poolsOf.get(lower(token)) ?? []).filter((p) => same(p.token0, other) || same(p.token1, other));
    const reserve = (p: PoolRecord) => (same(p.token0, token) ? p.reserve0 : p.reserve1);
    return pools.reduce<PoolRecord | null>((best, p) => (best === null || reserve(p) > reserve(best) ? p : best), null);
  }

  /**
   * `token` in the quote token at `time`: through its deepest pool with the quote token, else through one other token
   * that has a pool with the quote token. The pools are chosen by today's depth, so a window compares like with like.
   */
  price(token: string, time: number | null = null): bigint | null {
    if (time !== null) return this.priceAt(token, time);
    if (!this.priceNow.has(lower(token))) this.priceNow.set(lower(token), this.priceAt(token, null));
    return this.priceNow.get(lower(token))!;
  }

  private priceAt(token: string, time: number | null): bigint | null {
    if (same(token, this.quote.address)) return SCALE;
    const direct = this.deepest(token, this.quote.address);
    if (direct) return this.pairPrice(direct, token, time);
    let best: { pool: PoolRecord; via: PoolRecord; depth: bigint } | null = null;
    for (const pool of this.poolsOf.get(lower(token)) ?? []) {
      const via = same(pool.token0, token) ? pool.token1 : pool.token0;
      const hop = this.deepest(via, this.quote.address);
      if (!hop) continue;
      const depth = same(pool.token0, token) ? pool.reserve0 : pool.reserve1;
      if (!best || depth > best.depth) best = { pool, via: hop, depth };
    }
    if (!best) return null;
    const leg = this.pairPrice(best.pool, token, time);
    const viaToken = same(best.pool.token0, token) ? best.pool.token1 : best.pool.token0;
    const hop = this.pairPrice(best.via, viaToken, time);
    return leg === null || hop === null ? null : (leg * hop) / SCALE;
  }

  growthBps(token: string, seconds: number): number | null {
    const now = this.price(token);
    const then = this.price(token, this.snap.asOf - seconds);
    if (now === null || then === null || then === 0n) return null;
    return Number(((now - then) * 10_000n) / then);
  }

  /** `amount` base units of `token` in the quote token's base units, at today's price; null with no price. */
  valueInQuote(token: string, amount: bigint): bigint | null {
    const price = this.price(token);
    if (price === null) return null;
    const scaled = (toScaled(amount, this.decimals(token)) * price) / SCALE;
    return this.quote.decimals <= 18 ? scaled / 10n ** BigInt(18 - this.quote.decimals) : scaled * 10n ** BigInt(this.quote.decimals - 18);
  }

  /** This token's side of one swap: how much of it moved, and whether the trader bought it (it left the pool). */
  side(swap: SwapLog, token: string): { side: 'buy' | 'sell'; amount: bigint; other: Address; amountOther: bigint } | null {
    const pool = this.poolAt.get(lower(swap.pool));
    if (!pool) return null;
    const isToken0 = same(pool.token0, token);
    if (!isToken0 && !same(pool.token1, token)) return null;
    const tokenIn = isToken0 ? swap.amount0In : swap.amount1In;
    const tokenOut = isToken0 ? swap.amount0Out : swap.amount1Out;
    const otherIn = isToken0 ? swap.amount1In : swap.amount0In;
    const otherOut = isToken0 ? swap.amount1Out : swap.amount0Out;
    const other = isToken0 ? pool.token1 : pool.token0;
    return tokenOut > 0n
      ? { side: 'buy', amount: tokenOut, other, amountOther: otherIn }
      : { side: 'sell', amount: tokenIn, other, amountOther: otherOut };
  }

  swapsOf(token: string): SwapLog[] {
    const pools = new Set((this.poolsOf.get(lower(token)) ?? []).map((p) => lower(p.pool)));
    return this.snap.swaps.filter((s) => pools.has(lower(s.pool)));
  }

  listedAt(token: string): number {
    return Math.min(...(this.poolsOf.get(lower(token)) ?? []).map((p) => p.createdAt));
  }
  firstIndex(token: string): number {
    return Math.min(...(this.poolsOf.get(lower(token)) ?? []).map((p) => p.index));
  }

  /** The earlier-listed token whose name or symbol this one reads the same as, if any. */
  lookalikeOf(token: TokenBasics): { address: string; name: string; symbol: string } | null {
    const name = normaliseName(token.name);
    const symbol = normaliseName(token.symbol);
    const mine = this.firstIndex(token.address);
    for (const other of this.snap.tokens) {
      if (same(other.address, token.address)) continue;
      const copies = (name !== '' && normaliseName(other.name) === name) || (symbol !== '' && normaliseName(other.symbol) === symbol);
      if (copies && this.firstIndex(other.address) < mine) return { address: other.address, name: other.name, symbol: other.symbol };
    }
    return null;
  }
}

export function tokensList(snap: MarketSnapshot, quote: TokenBasics, window: TokenWindowId): TokensList {
  const market = new Market(snap, quote);
  const seconds = TOKEN_WINDOW_SECONDS[window];
  const since = snap.asOf - seconds;
  const tokens: TokenListRow[] = snap.tokens.map((token) => {
    const recent = market.swapsOf(token.address).filter((s) => s.time > since);
    let volume = 0n;
    for (const swap of recent) {
      const leg = market.side(swap, token.address);
      if (leg) volume += market.valueInQuote(token.address, leg.amount) ?? 0n;
    }
    const price = market.price(token.address);
    return {
      token,
      price: price === null ? null : formatScaled(price),
      growthBps: market.growthBps(token.address, seconds),
      volume: formatScaled(toScaled(volume, quote.decimals)),
      trades: recent.length,
      listedAt: market.listedAt(token.address),
      lookalikeOf: market.lookalikeOf(token),
    };
  });
  return { blockNumber: snap.blockNumber.toString(), asOf: snap.asOf, quote, window, tokens };
}

/**
 * Every Transfer of the token folded into balances. Mints come from the zero address and debit nobody. `burned` is what
 * the burn addresses hold on the chain at the same block, so holders sum to `totalSupply - burned`.
 */
export function holdersFrom(transfers: TransferLog[], totalSupply: bigint, burned: bigint): TokenPageData['holders'] {
  const balances = new Map<string, bigint>();
  for (const t of transfers) {
    if (!same(t.from, ZERO)) balances.set(lower(t.from), (balances.get(lower(t.from)) ?? 0n) - t.value);
    balances.set(lower(t.to), (balances.get(lower(t.to)) ?? 0n) + t.value);
  }
  const list = [...balances.entries()]
    .filter(([holder, amount]) => amount > 0n && holder !== ZERO && holder !== DEAD)
    .sort((a, b) => (a[1] === b[1] ? 0 : a[1] > b[1] ? -1 : 1));
  // Anyone can emit a Transfer log, so the fold is shown only when it agrees with the chain's own figures: no holder
  // below zero, and the holders together hold the supply less what is burned.
  const negative = [...balances.entries()].some(([holder, amount]) => amount < 0n && holder !== ZERO && holder !== DEAD);
  const held = list.reduce((a, [, amount]) => a + amount, 0n);
  if (negative || held !== totalSupply - burned)
    throw new TokensReadError(
      TOKENS_HOLDERS_INCONSISTENT,
      `the token's Transfer logs hold ${held}, its supply less burned is ${totalSupply - burned}; no holder list is shown.`,
    );
  if (list.length > MAX_HOLDERS)
    throw new TokensReadError(TOKENS_READ_TOO_LARGE, `more than ${MAX_HOLDERS} holders; this read lists every one or none.`);
  return {
    totalSupply: totalSupply.toString(),
    burned: burned.toString(),
    supplyLessBurned: (totalSupply - burned).toString(),
    list: list.map(([holder, amount]) => ({ address: holder, amount: amount.toString() })),
  };
}

export function tokenPage(snap: MarketSnapshot, quote: TokenBasics, token: TokenBasics, holders: TokenPageData['holders']): TokenPageData {
  const market = new Market(snap, quote);
  const listed = (market.poolsOf.get(lower(token.address)) ?? []).length > 0;
  const swaps = market.swapsOf(token.address);
  const price = listed ? market.price(token.address) : null;
  let fees = 0n;
  const pairs = (market.poolsOf.get(lower(token.address)) ?? []).map((pool) => {
    const isToken0 = same(pool.token0, token.address);
    const other = market.byAddress.get(lower(isToken0 ? pool.token1 : pool.token0))!;
    const mine = swaps.filter((s) => same(s.pool, pool.pool));
    let volume = 0n;
    const buckets = new Map<number, { time: number; prices: bigint[] }>();
    for (const swap of mine) {
      const leg = market.side(swap, token.address)!;
      volume += leg.amount;
      const input = swap.amount0In > 0n ? { token: pool.token0, amount: swap.amount0In } : { token: pool.token1, amount: swap.amount1In };
      fees += market.valueInQuote(input.token, (input.amount * BigInt(pool.feeBps)) / 10_000n) ?? 0n;
      const executed = reservePrice(leg.amount, token.decimals, leg.amountOther, other.decimals);
      if (executed === null) continue;
      const minute = Math.floor(swap.time / 60);
      const bucket = buckets.get(minute) ?? { time: swap.time, prices: [] };
      bucket.prices.push(executed);
      buckets.set(minute, bucket);
    }
    const candles = [...buckets.values()]
      .sort((a, b) => a.time - b.time)
      .map(({ time, prices }) => ({
        time,
        open: formatScaled(prices[0]!),
        close: formatScaled(prices[prices.length - 1]!),
        high: formatScaled(prices.reduce((a, b) => (b > a ? b : a))),
        low: formatScaled(prices.reduce((a, b) => (b < a ? b : a))),
      }));
    return {
      pool: pool.pool,
      other,
      feeBps: pool.feeBps,
      reserve: (isToken0 ? pool.reserve0 : pool.reserve1).toString(),
      reserveOther: (isToken0 ? pool.reserve1 : pool.reserve0).toString(),
      volume: volume.toString(),
      candles,
    };
  });
  const trades = swaps
    .map((swap) => {
      const leg = market.side(swap, token.address)!;
      return {
        tx: swap.tx,
        logIndex: swap.logIndex,
        time: swap.time,
        pool: swap.pool,
        wallet: swap.wallet,
        side: leg.side,
        amount: leg.amount.toString(),
        other: market.byAddress.get(lower(leg.other))!,
        amountOther: leg.amountOther.toString(),
      };
    })
    .sort((a, b) => b.time - a.time || b.logIndex - a.logIndex);
  const lookalikeOf = listed ? market.lookalikeOf(token) : null;
  const flags: TokenPageData['trust']['flags'] = ['no_lp_lock', 'no_vesting'];
  if (lookalikeOf) flags.push('lookalike');
  if (swaps.length === 0) flags.push('no_history');
  return {
    blockNumber: snap.blockNumber.toString(),
    asOf: snap.asOf,
    token,
    quote,
    listed,
    price: price === null ? null : formatScaled(price),
    growthBps24h: listed ? market.growthBps(token.address, TOKEN_WINDOW_SECONDS['24h']) : null,
    feesPaid: formatScaled(toScaled(fees, quote.decimals)),
    trust: {
      // With no trade on record nothing can be judged, so the tier is "unknown". Any other tier needs the owner's
      // criteria, which are blank: then it refuses by name instead of guessing.
      tier: swaps.length === 0 ? 'unknown' : null,
      tierRefusal: swaps.length === 0 ? null : TRUST_CRITERIA_UNSET,
      organicScore: null,
      organicRefusal: ORGANIC_SCORE_UNSET,
      flags,
      lookalikeOf,
    },
    pairs,
    trades,
    holders,
  };
}

/**
 * Wallets ranked by realised result in the quote token, over the pools that trade a token against it. A sell realises
 * its proceeds less the average cost of what the wallet bought before it; the part of a sell beyond what it bought here
 * has no cost on record, so it realises nothing rather than a guess. Each row is the sum of its trades' results.
 */
export function leaderboard(snap: MarketSnapshot, quote: TokenBasics): TokensLeaderboard {
  const market = new Market(snap, quote);
  const ordered = [...snap.swaps].sort((a, b) => (a.block === b.block ? a.logIndex - b.logIndex : a.block < b.block ? -1 : 1));
  const book = new Map<string, { position: bigint; cost: bigint }>();
  const rows = new Map<string, { wallet: Address; realised: bigint; trades: TokensLeaderboard['rows'][number]['trades'] }>();
  for (const swap of ordered) {
    const pool = snap.pools.find((p) => same(p.pool, swap.pool));
    if (!pool || (!same(pool.token0, quote.address) && !same(pool.token1, quote.address))) continue;
    const tokenAddress = same(pool.token0, quote.address) ? pool.token1 : pool.token0;
    const token = market.byAddress.get(lower(tokenAddress));
    const leg = market.side(swap, tokenAddress);
    if (!token || !leg) continue;
    const key = `${lower(swap.wallet)}:${lower(tokenAddress)}`;
    const held = book.get(key) ?? { position: 0n, cost: 0n };
    let realised: bigint | null = null;
    if (leg.side === 'buy') {
      held.position += leg.amount;
      held.cost += leg.amountOther;
    } else if (held.position > 0n && leg.amount > 0n) {
      const covered = leg.amount < held.position ? leg.amount : held.position;
      const basis = (held.cost * covered) / held.position;
      realised = (leg.amountOther * covered) / leg.amount - basis;
      held.position -= covered;
      held.cost -= basis;
    }
    book.set(key, held);
    const row = rows.get(lower(swap.wallet)) ?? { wallet: swap.wallet, realised: 0n, trades: [] };
    if (realised !== null) row.realised += realised;
    row.trades.push({
      tx: swap.tx,
      logIndex: swap.logIndex,
      time: swap.time,
      token,
      side: leg.side,
      amount: leg.amount.toString(),
      quoteAmount: leg.amountOther.toString(),
      realised: realised === null ? null : formatScaled(toScaled(realised, quote.decimals)),
    });
    rows.set(lower(swap.wallet), row);
  }
  return {
    blockNumber: snap.blockNumber.toString(),
    asOf: snap.asOf,
    quote,
    rows: [...rows.values()]
      .sort((a, b) => (a.realised === b.realised ? 0 : a.realised > b.realised ? -1 : 1))
      .map((row) => ({ wallet: row.wallet, realised: formatScaled(toScaled(row.realised, quote.decimals)), trades: row.trades })),
  };
}
