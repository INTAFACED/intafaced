/**
 * What one follow actually produced. Money is exact decimal strings, grouped
 * by quote asset. Nothing is summed across assets. This read does not charge
 * and does not link a fee to P&L.
 *
 * P&L method (D-138): weighted average cost, per market, then added within
 * one quote asset. Opening buys set
 *   average = (old quantity × old average + fill quantity × fill price) / new quantity
 * with half-up division, the ledger's explicit rounding. A reducing sell
 * realises (fill price − average) × quantity, then subtracts that fill's fee
 * when the fee is already in the quote asset. The fee lines stay separate;
 * the subtraction is the stated rule, so the room does not net them again.
 * Unrealised = (mark − average) × open quantity, summed across markets that
 * share the quote asset. Each mark has to pass `acceptableForAlgo`
 * (algo/mark-gate.ts). A missing or stale mark nulls only that quote asset's
 * unrealised figure, reason `trade.mark_unavailable`.
 */
import type { Sql } from 'postgres';
import { add, div, formatAmount, mul, parseAmount, sub, type Amount } from '@intafaced/ledger-client';
import { acceptableForAlgo, DEFAULT_ALGO_MARK_POLICY, type AlgoMarkPolicy } from '../algo/mark-gate.js';
import type { AlgoQuotedMark } from '../algo/types.js';
import type { CopyFollow } from './follows.js';

export const TRADE_MARK_UNAVAILABLE = 'trade.mark_unavailable' as const;
export const FEE_LOOKUP_UNWIRED = 'fee_lookup_unwired' as const;
export const PNL_NO_POSITION = 'pnl_no_position' as const;
export const PNL_PER_QUOTE_ASSET = 'per_quote_asset' as const;
export const LEADER_SHARE_UNSET = 'leader_share_unset' as const;
export const FEE_ROW_MISSING = 'fee_row_missing' as const;
export const FEE_ASSET_NOT_QUOTE = 'fee_asset_not_quote' as const;
export const PNL_FEE_ASSET_UNCONVERTED = 'pnl_fee_asset_unconverted' as const;
export const PNL_SHORT_UNSET = 'pnl_short_unset' as const;
export const QUOTE_ASSET_UNSET = 'quote_asset_unset' as const;

export type FollowerFillFeeLookup = (fillId: string) => Promise<{ feeAsset: string; feeAmount: Amount } | null>;

export interface FollowResultAsset {
  readonly quoteAsset: string;
  readonly tradingFee: string | null;
  readonly tradingFeeReason: string | null;
  readonly leaderShare: string | null;
  readonly leaderShareReason: string | null;
  readonly leaderShareSkippedReasons: string[];
  readonly mirroredOrders: number;
  readonly fills: number;
  readonly realisedPnl: string | null;
  readonly realisedPnlReason: string | null;
  readonly unrealisedPnl: string | null;
  readonly unrealisedPnlReason: string | null;
}

export interface FollowResult {
  readonly followId: string;
  readonly mirroredOrders: number;
  readonly fills: number;
  readonly rejects: number;
  readonly tradingFee: string | null;
  readonly tradingFeeReason: string | null;
  readonly leaderShare: string | null;
  readonly leaderShareReason: string | null;
  readonly realisedPnl: string | null;
  readonly realisedPnlReason: string | null;
  readonly unrealisedPnl: string | null;
  readonly unrealisedPnlReason: string | null;
  readonly assets: FollowResultAsset[];
}

export interface FollowResultPorts {
  readonly lookupFollowerFillFee: FollowerFillFeeLookup | null;
  readonly lookupMark: ((marketId: string) => Promise<AlgoQuotedMark | null>) | null;
  readonly now: Date;
  readonly markPolicy?: AlgoMarkPolicy;
}

interface PlanRow {
  fill_id: string;
  market_id: string;
}

interface PlaceRow {
  fill_id: string;
  order_id: string;
}

interface FillRow {
  id: string;
  order_id: string;
  side: 'buy' | 'sell';
  price: string;
  qty: string;
  ts: Date;
}

interface ShareRow {
  asset_id: string;
  capped_leader_share: string;
  skipped_reason: string | null;
  settled: boolean;
}

interface MarketPosition {
  qty: Amount;
  avg: Amount;
  realised: Amount;
  reason: string | null;
}

const EMPTY_MONEY = {
  tradingFee: '0' as string | null,
  tradingFeeReason: null as string | null,
  leaderShare: '0' as string | null,
  leaderShareReason: null as string | null,
  realisedPnl: null as string | null,
  realisedPnlReason: PNL_NO_POSITION,
  unrealisedPnl: null as string | null,
  unrealisedPnlReason: PNL_NO_POSITION,
};

export interface FollowResultFigure {
  /** Realised plus unrealised inside the one quote asset, or `0` when there is no position. */
  readonly figure: string | null;
  /** The input that is missing when `figure` is null. Never a guessed number. */
  readonly missing: string | null;
}

/**
 * One result figure for the drawdown stop.
 *
 * No mirrors: `0` (there is no P&L yet, and that is not a missing method).
 * One quote asset with both realised and unrealised: their exact sum.
 * A null leg (no fresh mark, unwired fee, more than one quote asset) stays
 * null and names the reason. Assets are not added together.
 */
export function followResultFigure(result: FollowResult): FollowResultFigure {
  if (result.assets.length === 0) {
    return { figure: '0', missing: null };
  }
  if (result.assets.length !== 1) {
    return { figure: null, missing: result.realisedPnlReason ?? PNL_PER_QUOTE_ASSET };
  }
  const asset = result.assets[0]!;
  if (asset.realisedPnl === null) {
    return { figure: null, missing: asset.realisedPnlReason ?? 'realisedPnl' };
  }
  if (asset.unrealisedPnl === null) {
    return { figure: null, missing: asset.unrealisedPnlReason ?? TRADE_MARK_UNAVAILABLE };
  }
  return {
    figure: formatAmount(add(parseAmount(asset.realisedPnl), parseAmount(asset.unrealisedPnl))),
    missing: null,
  };
}

export async function readFollowResult(sql: Sql, follow: CopyFollow, ports: FollowResultPorts): Promise<FollowResult> {
  const followId = follow.followId;
  const plans = await sql<PlanRow[]>`
    SELECT fill_id, market_id FROM copy_mirrored_fills WHERE follow_id = ${followId}
  `;
  const placed = await sql<PlaceRow[]>`
    SELECT fill_id, order_id FROM copy_placed_mirrors WHERE follow_id = ${followId}
  `;
  const fills = await sql<FillRow[]>`
    SELECT f.id, f.order_id::text AS order_id, f.side, f.price::text AS price, f.qty::text AS qty, f.ts
      FROM trade.fills f
      INNER JOIN copy_placed_mirrors p ON p.order_id = f.order_id::text
     WHERE p.follow_id = ${followId}
     ORDER BY f.ts ASC, f.id ASC
  `;
  const shares = await sql<ShareRow[]>`
    SELECT asset_id, capped_leader_share::text AS capped_leader_share, skipped_reason, settled
      FROM copy_settled_fee_shares
     WHERE follow_id = ${followId}
  `;
  const rejected = await sql<Array<{ n: number }>>`
    SELECT count(*)::int AS n FROM copy_mirror_events WHERE follow_id = ${followId} AND kind = 'rejected'
  `;
  const rejects = Number(rejected[0]?.n ?? 0);

  if (plans.length === 0 && placed.length === 0 && fills.length === 0) {
    return { followId, mirroredOrders: 0, fills: 0, rejects, ...EMPTY_MONEY, assets: [] };
  }

  const marketByLeaderFill = new Map(plans.map((plan) => [plan.fill_id, plan.market_id]));
  const leaderFillByOrder = new Map(placed.map((row) => [row.order_id, row.fill_id]));
  const quoteByMarket = new Map<string, string | null>();
  for (const marketId of new Set(plans.map((plan) => plan.market_id))) {
    const found = await sql<Array<{ quote_asset: string }>>`
      SELECT quote_asset FROM trade.markets WHERE symbol = ${marketId} LIMIT 1
    `;
    quoteByMarket.set(marketId, found[0]?.quote_asset ?? null);
  }

  const marketOfFill = (fill: FillRow): string | null => {
    const leaderFill = leaderFillByOrder.get(fill.order_id);
    return leaderFill ? (marketByLeaderFill.get(leaderFill) ?? null) : null;
  };

  const ordersByQuote = new Map<string, number>();
  let quoteUnset = false;
  for (const row of placed) {
    const market = marketByLeaderFill.get(row.fill_id);
    const quote = market ? quoteByMarket.get(market) : null;
    if (!quote) {
      quoteUnset = true;
      continue;
    }
    ordersByQuote.set(quote, (ordersByQuote.get(quote) ?? 0) + 1);
  }

  const fillsByMarket = new Map<string, FillRow[]>();
  for (const fill of fills) {
    const market = marketOfFill(fill);
    const quote = market ? quoteByMarket.get(market) : null;
    if (!market || !quote) {
      quoteUnset = true;
      continue;
    }
    const list = fillsByMarket.get(market) ?? [];
    list.push(fill);
    fillsByMarket.set(market, list);
  }

  const feeByFill = new Map<string, { asset: string; amount: Amount } | null>();
  if (ports.lookupFollowerFillFee) {
    for (const fill of fills) {
      const looked = await ports.lookupFollowerFillFee(fill.id);
      feeByFill.set(fill.id, looked ? { asset: looked.feeAsset, amount: looked.feeAmount } : null);
    }
  }

  const sharesByAsset = new Map<string, { amount: Amount; skipped: string[]; any: boolean }>();
  for (const share of shares) {
    const bucket = sharesByAsset.get(share.asset_id) ?? { amount: 0n, skipped: [], any: false };
    bucket.any = true;
    if (share.settled) bucket.amount = add(bucket.amount, parseAmount(share.capped_leader_share));
    if (share.skipped_reason) bucket.skipped.push(share.skipped_reason);
    sharesByAsset.set(share.asset_id, bucket);
  }

  const quotes = new Set<string>();
  for (const [market, quote] of quoteByMarket) {
    if (quote) quotes.add(quote);
    else if (plans.some((plan) => plan.market_id === market)) quoteUnset = true;
  }
  for (const asset of sharesByAsset.keys()) quotes.add(asset);

  const assets: FollowResultAsset[] = [];
  for (const quoteAsset of [...quotes].sort()) {
    const markets = [...quoteByMarket.entries()].filter(([, quote]) => quote === quoteAsset).map(([market]) => market);
    assets.push(
      await assetLine({
        quoteAsset,
        markets,
        fillsByMarket,
        feeByFill,
        feePortWired: ports.lookupFollowerFillFee !== null,
        mirroredOrders: ordersByQuote.get(quoteAsset) ?? 0,
        share: sharesByAsset.get(quoteAsset) ?? null,
        ports,
        quoteUnset,
      }),
    );
  }

  return {
    followId,
    mirroredOrders: placed.length,
    fills: fills.length,
    rejects,
    tradingFee: null,
    tradingFeeReason: PNL_PER_QUOTE_ASSET,
    leaderShare: null,
    leaderShareReason: PNL_PER_QUOTE_ASSET,
    realisedPnl: null,
    realisedPnlReason: quoteUnset ? QUOTE_ASSET_UNSET : PNL_PER_QUOTE_ASSET,
    unrealisedPnl: null,
    unrealisedPnlReason: quoteUnset ? QUOTE_ASSET_UNSET : PNL_PER_QUOTE_ASSET,
    assets,
  };
}

async function assetLine(input: {
  quoteAsset: string;
  markets: readonly string[];
  fillsByMarket: ReadonlyMap<string, readonly FillRow[]>;
  feeByFill: ReadonlyMap<string, { asset: string; amount: Amount } | null>;
  feePortWired: boolean;
  mirroredOrders: number;
  share: { amount: Amount; skipped: string[]; any: boolean } | null;
  ports: FollowResultPorts;
  quoteUnset: boolean;
}): Promise<FollowResultAsset> {
  const fills = input.markets.flatMap((market) => input.fillsByMarket.get(market) ?? []);
  let tradingFee: string | null = fills.length === 0 ? '0' : null;
  let tradingFeeReason: string | null = fills.length === 0 ? null : null;
  if (!input.feePortWired) {
    tradingFee = null;
    tradingFeeReason = FEE_LOOKUP_UNWIRED;
  } else if (fills.length > 0) {
    let sum = 0n;
    let reason: string | null = null;
    for (const fill of fills) {
      const fee = input.feeByFill.get(fill.id);
      if (!fee) {
        reason = FEE_ROW_MISSING;
        break;
      }
      if (fee.asset !== input.quoteAsset) {
        reason = FEE_ASSET_NOT_QUOTE;
        break;
      }
      sum = add(sum, fee.amount);
    }
    tradingFee = reason ? null : formatAmount(sum);
    tradingFeeReason = reason;
  }

  let realised = 0n;
  let realisedReason: string | null = null;
  let unrealised = 0n;
  let unrealisedReason: string | null = null;
  let open = false;
  for (const market of input.markets) {
    const position = walkMarket(input.fillsByMarket.get(market) ?? [], input.feeByFill, input.quoteAsset, input.feePortWired);
    if (position.reason) realisedReason = position.reason;
    else realised = add(realised, position.realised);
    if (position.qty === 0n) continue;
    open = true;
    if (unrealisedReason) continue;
    if (!input.ports.lookupMark) {
      unrealisedReason = TRADE_MARK_UNAVAILABLE;
      continue;
    }
    const mark = await input.ports.lookupMark(market);
    const gate = mark
      ? acceptableForAlgo(mark, input.ports.now, input.ports.markPolicy ?? DEFAULT_ALGO_MARK_POLICY)
      : { ok: false as const };
    if (!mark || !gate.ok) {
      unrealisedReason = TRADE_MARK_UNAVAILABLE;
      continue;
    }
    unrealised = add(unrealised, mul(sub(mark.price, position.avg), position.qty, 'half-up'));
  }

  return {
    quoteAsset: input.quoteAsset,
    tradingFee,
    tradingFeeReason,
    leaderShare: input.share?.any ? formatAmount(input.share.amount) : null,
    leaderShareReason: input.share?.any ? null : LEADER_SHARE_UNSET,
    leaderShareSkippedReasons: [...new Set(input.share?.skipped ?? [])].sort(),
    mirroredOrders: input.mirroredOrders,
    fills: fills.length,
    realisedPnl: realisedReason ? null : formatAmount(realised),
    realisedPnlReason: realisedReason ?? (input.quoteUnset && fills.length === 0 ? QUOTE_ASSET_UNSET : null),
    unrealisedPnl: !open ? '0' : unrealisedReason ? null : formatAmount(unrealised),
    unrealisedPnlReason: open ? unrealisedReason : null,
  };
}

function walkMarket(
  fills: readonly FillRow[],
  feeByFill: ReadonlyMap<string, { asset: string; amount: Amount } | null>,
  quoteAsset: string,
  feePortWired: boolean,
): MarketPosition {
  let qty = 0n;
  let avg = 0n;
  let realised = 0n;
  for (const fill of fills) {
    const price = parseAmount(fill.price);
    const size = parseAmount(fill.qty);
    if (fill.side === 'buy') {
      const cost = add(mul(qty, avg, 'half-up'), mul(size, price, 'half-up'));
      qty = add(qty, size);
      avg = qty === 0n ? 0n : div(cost, qty, 'half-up');
      continue;
    }
    if (size > qty) return { qty, avg, realised, reason: PNL_SHORT_UNSET };
    const gross = mul(sub(price, avg), size, 'half-up');
    qty = sub(qty, size);
    const flat = qty === 0n;
    if (flat) avg = 0n;
    if (!feePortWired) return { qty, avg, realised, reason: FEE_LOOKUP_UNWIRED };
    const fee = feeByFill.get(fill.id);
    if (!fee) return { qty, avg, realised, reason: FEE_ROW_MISSING };
    if (fee.amount > 0n && fee.asset !== quoteAsset) return { qty, avg, realised, reason: PNL_FEE_ASSET_UNCONVERTED };
    realised = sub(add(realised, gross), fee.amount);
    if (flat) avg = 0n;
  }
  return { qty, avg, realised, reason: null };
}
