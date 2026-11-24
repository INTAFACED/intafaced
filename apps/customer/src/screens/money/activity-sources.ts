import { formatUnits } from 'viem';
import { formatAmount, parseAmount } from '../../shared/money';
import type { ActivityItem } from '../../data/activity';
import type { Preferences } from '../../shared/preferences';
import { inRange, type ActivityFilters } from './activity-filter';

type Zone = Preferences['timeZone'];

/**
 * ACTIVITY BY SOURCE (J-portfolio-03 #1, the launch model, OWNER 226).
 *
 * With svc-trade's user-venue door on, INTAFACED holds none of the person's money, so their history is not a ledger
 * feed: it is what each place that holds their money reports, in one list, each line named with the place it came from.
 * - The wallet: the token transfers the chain's indexer has for the connected address (`explorer.address.txs`).
 * - The venue: the venue's own fills and the deposits it has seen for the account the wallet owns.
 * - The partner: the partner bank's own record of the moves it made (svc-bank `activity.list`, lines with `heldAt`).
 * A bank line with no `heldAt` is a line of our own ledger (the custodial layer) and is not a source here, as Assets reads
 * no ledger either (WhereItSits). Nothing is netted or invented: one line per thing a source reports.
 */

export type SourceKind = 'wallet' | 'venue' | 'partner';
export type LineKind =
  | 'trade'
  | 'convert'
  | 'deposit'
  | 'withdrawal'
  | 'transfer_in'
  | 'transfer_out'
  | 'space_move'
  | 'fee'
  | 'earn'
  | 'order_hold'
  | 'order_cancelled'
  | 'other';

/** The type a line is filed under (J-portfolio-03 #1: trade, deposit, withdrawal, convert, transfer, other). */
export type LineType = 'trade' | 'deposit' | 'withdrawal' | 'convert' | 'transfer' | 'other';

const TYPE_OF: Record<LineKind, LineType> = {
  trade: 'trade',
  convert: 'convert',
  deposit: 'deposit',
  withdrawal: 'withdrawal',
  transfer_in: 'transfer',
  transfer_out: 'transfer',
  space_move: 'transfer',
  fee: 'other',
  earn: 'other',
  order_hold: 'trade',
  order_cancelled: 'trade',
  other: 'other',
};

export const typeOf = (kind: LineKind): LineType => TYPE_OF[kind];
export type LineState = 'completed' | 'confirming' | 'not_credited' | 'failed' | 'set_aside' | 'cancelled';

/** One individual fill inside a grouped multi-fill venue trade line (J-portfolio-03 #3 #4). */
export interface VenueFillLeg {
  fillId: string;
  amount: string;
  quoteAmount: string;
  fee: { asset: string; amount: string; rebate: boolean } | null;
}

export interface SourceLine {
  /** Unique across sources: the source's kind and its own reference. */
  id: string;
  source: SourceKind;
  /** The name the source gives itself (the network, the venue, the partner). */
  sourceName: string;
  kind: LineKind;
  direction: 'in' | 'out';
  asset: string;
  /** Unsigned decimal string. */
  amount: string;
  /** ISO time the source gives the movement. */
  at: string;
  /** The source's own reference: a transaction hash, a fill id, an order id, a deposit reference, a partner move id. */
  ref: string;
  state: LineState;
  /** What else the line carries, in figures: the other side of a trade, its fee, an order's terms, a deposit's confirmations. */
  detail:
    | {
        kind: 'trade';
        side: 'buy' | 'sell';
        /** The venue's client id of the order the fill belongs to, as the venue reports it (null when it names none). */
        order: string | null;
        /** A fill of a conversion (J-cex-spot-11): what it converted from and to, as the venue's conversion record names. */
        convert: { from: string; to: string } | null;
        quote: { asset: string; amount: string };
        fee: { asset: string; amount: string; rebate: boolean } | null;
        /** Present when multiple fills of one order were grouped into this single row (J-portfolio-03 #3). */
        fills?: readonly VenueFillLeg[];
      }
    | {
        kind: 'order';
        side: 'buy' | 'sell';
        base: string;
        quote: string;
        orderAmount: string;
        price: string;
        order: string | null;
        status: 'open' | 'cancelled';
      }
    | { kind: 'confirming'; confirmations: number; required: number }
    | { kind: 'space'; name: string }
    | null;
}

export interface IndexedTx {
  hash: string;
  timestamp: number;
  from: string;
  to: string | null;
  status: 'success' | 'failed';
  transfers: readonly {
    token: { address: string; symbol: string | null; decimals: number | null };
    amount: string;
    direction: 'in' | 'out' | 'self';
  }[];
}

export const shortAddress = (address: string) => (address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address);

/**
 * The wallet's lines: one per token transfer in or out of the address. A transfer to itself moves nothing and a
 * transaction with no token transfer (a call that only spent gas) is not a movement of what the person holds; both are
 * left out, and the list says the wallet's lines are its token transfers. A token with no decimals published shows its
 * raw amount and a token with no symbol its address, as the indexer reports them.
 */
export function walletLines(rows: readonly IndexedTx[], network: string): SourceLine[] {
  const out: SourceLine[] = [];
  for (const row of rows) {
    row.transfers.forEach((transfer, index) => {
      if (transfer.direction === 'self') return;
      const amount =
        transfer.token.decimals === null ? transfer.amount : trimZeros(formatUnits(BigInt(transfer.amount), transfer.token.decimals));
      const incoming = transfer.direction === 'in';
      out.push({
        id: `wallet:${row.hash.toLowerCase()}:${index}`,
        source: 'wallet',
        sourceName: network,
        kind: incoming ? 'transfer_in' : 'transfer_out',
        direction: incoming ? 'in' : 'out',
        asset: transfer.token.symbol ?? shortAddress(transfer.token.address),
        amount,
        at: new Date(row.timestamp * 1000).toISOString(),
        ref: row.hash.toLowerCase(),
        state: row.status === 'success' ? 'completed' : 'failed',
        // The indexer's transfer names no other party (a token transfer's transaction is sent to the token's contract), so
        // none is shown rather than the contract's address.
        detail: null,
      });
    });
  }
  return out;
}

export interface VenueFillRead {
  fillId: string;
  venueClientOrderId?: string | null;
  symbol: string;
  side: 'buy' | 'sell';
  price: string;
  amount: string;
  venueFee: string;
  builderFee: string;
  feeAsset: string;
  filledAt: string;
}

export interface VenueDepositRead {
  depositRef: string;
  txHash: string;
  asset: string;
  amount: string;
  status: 'confirming' | 'credited' | 'not_credited';
  confirmations: number;
  required: number;
  seenAt: string;
}

const SCALE = 10n ** 18n;

/** `a × b` of two decimal strings, exact to 18 places (rounded up at the 18th, as a cost is never understated). */
export function product(a: string, b: string): string {
  const raw = parseAmount(a) * parseAmount(b);
  return formatAmount((raw + SCALE - 1n) / SCALE);
}

function trimZeros(decimal: string): string {
  return decimal.includes('.') ? decimal.replace(/0+$/, '').replace(/\.$/, '') : decimal;
}

/** Base and quote of a venue market symbol ("BTC-USDC"); a perpetual ("BTC-PERP") is quoted in the fee asset. */
function sides(symbol: string, feeAsset: string): { base: string; quote: string } {
  const [base, quote] = symbol.split('-');
  if (!base) return { base: symbol, quote: feeAsset };
  return { base, quote: !quote || quote === 'PERP' ? feeAsset : quote };
}

/** A conversion as the venue's convert history records it: the order it placed, and what it converted from and to. */
export interface VenueConversionRead {
  venueClientOrderId: string | null;
  from: string;
  to: string;
}

/** One order from the venue's order history, as Activity reads it for resting and cancelled rows (J-portfolio-03 #3). */
export interface VenueOrderHistoryRead {
  order: VenueOrderRead & {
    venueOrderId?: string | null;
    venueClientOrderId: string | null;
    symbol: string;
    filled: string;
  };
  placedAt: string;
}

export interface VenueLinesOptions {
  /** Group fills by order and include resting (Set aside) and cancelled (nothing spent) orders. */
  includeOrders?: boolean;
}

function singleFillLine(fill: VenueFillRead, venue: string, converts: ReadonlyMap<string, VenueConversionRead>): SourceLine {
  const { base, quote } = sides(fill.symbol, fill.feeAsset);
  const fee = parseAmount(fill.venueFee) + parseAmount(fill.builderFee);
  const order = fill.venueClientOrderId ?? null;
  const conversion = order ? converts.get(order.toLowerCase()) : undefined;
  return {
    id: `venue:fill:${fill.fillId}`,
    source: 'venue',
    sourceName: venue,
    kind: conversion ? 'convert' : 'trade',
    direction: fill.side === 'buy' ? 'in' : 'out',
    asset: base,
    amount: fill.amount,
    at: fill.filledAt,
    ref: fill.fillId,
    state: 'completed',
    detail: {
      kind: 'trade',
      side: fill.side,
      order,
      convert: conversion ? { from: conversion.from, to: conversion.to } : null,
      quote: { asset: quote, amount: product(fill.price, fill.amount) },
      fee: fee === 0n ? null : { asset: fill.feeAsset, amount: formatAmount(fee < 0n ? -fee : fee), rebate: fee < 0n },
    },
  };
}

function fillLeg(fill: VenueFillRead): VenueFillLeg {
  const fee = parseAmount(fill.venueFee) + parseAmount(fill.builderFee);
  return {
    fillId: fill.fillId,
    amount: fill.amount,
    quoteAmount: product(fill.price, fill.amount),
    fee: fee === 0n ? null : { asset: fill.feeAsset, amount: formatAmount(fee < 0n ? -fee : fee), rebate: fee < 0n },
  };
}

/**
 * The venue's lines: fills (one per fill, or grouped by order when `includeOrders` is true so every line of a traded
 * order shares one row), deposits, and when `includeOrders` is true each unfilled resting order ("Set aside") and
 * cancelled order ("Order cancelled · nothing spent") as one row (J-portfolio-03 #1 #3).
 */
export function venueLines(
  fills: readonly VenueFillRead[],
  deposits: readonly VenueDepositRead[],
  venue: string,
  conversions: readonly VenueConversionRead[] = [],
  orders: readonly VenueOrderHistoryRead[] = [],
  options: VenueLinesOptions = {},
): SourceLine[] {
  const converts = new Map(conversions.flatMap((c) => (c.venueClientOrderId ? [[c.venueClientOrderId.toLowerCase(), c] as const] : [])));
  const out: SourceLine[] = [];
  const filledOrderIds = new Set<string>();
  if (options.includeOrders) {
    const byOrder = new Map<string, VenueFillRead[]>();
    const ungrouped: VenueFillRead[] = [];
    for (const fill of fills) {
      const order = fill.venueClientOrderId ?? null;
      if (!order) {
        ungrouped.push(fill);
        continue;
      }
      const key = order.toLowerCase();
      filledOrderIds.add(key);
      const list = byOrder.get(key);
      if (list) list.push(fill);
      else byOrder.set(key, [fill]);
    }
    for (const fill of ungrouped) out.push(singleFillLine(fill, venue, converts));
    for (const group of byOrder.values()) {
      if (group.length === 1) {
        out.push(singleFillLine(group[0]!, venue, converts));
        continue;
      }
      const sorted = [...group].sort((a, b) => Date.parse(b.filledAt) - Date.parse(a.filledAt) || b.fillId.localeCompare(a.fillId));
      const newest = sorted[0]!;
      const order = newest.venueClientOrderId!;
      const { base, quote } = sides(newest.symbol, newest.feeAsset);
      const conversion = converts.get(order.toLowerCase());
      const amountUnits = sorted.reduce((sum, f) => sum + parseAmount(f.amount), 0n);
      const legs = sorted.map(fillLeg);
      const quoteUnits = legs.reduce((sum, leg) => sum + parseAmount(leg.quoteAmount), 0n);
      const sameFeeAsset = sorted.every((f) => f.feeAsset === newest.feeAsset);
      const feeUnits = sameFeeAsset ? sorted.reduce((sum, f) => sum + parseAmount(f.venueFee) + parseAmount(f.builderFee), 0n) : 0n;
      out.push({
        id: `venue:order:${order}`,
        source: 'venue',
        sourceName: venue,
        kind: conversion ? 'convert' : 'trade',
        direction: newest.side === 'buy' ? 'in' : 'out',
        asset: base,
        amount: formatAmount(amountUnits),
        at: newest.filledAt,
        ref: order,
        state: 'completed',
        detail: {
          kind: 'trade',
          side: newest.side,
          order,
          convert: conversion ? { from: conversion.from, to: conversion.to } : null,
          quote: { asset: quote, amount: formatAmount(quoteUnits) },
          fee:
            sameFeeAsset && feeUnits !== 0n
              ? { asset: newest.feeAsset, amount: formatAmount(feeUnits < 0n ? -feeUnits : feeUnits), rebate: feeUnits < 0n }
              : null,
          fills: legs,
        },
      });
    }
    const seenOrders = new Set<string>();
    for (const { order, placedAt } of orders) {
      const ref = order.venueClientOrderId ?? order.venueOrderId ?? null;
      if (!ref) continue;
      const key = ref.toLowerCase();
      if (seenOrders.has(key) || filledOrderIds.has(key) || parseAmount(order.filled) > 0n) continue;
      seenOrders.add(key);
      const { base, quote } = sides(order.symbol, order.lockedAsset || '');
      const buy = order.side === 'buy';
      const holdAsset = order.lockedAsset || (buy ? quote : base);
      if (order.status === 'open') {
        const holdAmount = parseAmount(order.locked) > 0n ? order.locked : buy ? product(order.price, order.amount) : order.amount;
        out.push({
          id: `venue:order-open:${ref}`,
          source: 'venue',
          sourceName: venue,
          kind: 'order_hold',
          direction: 'out',
          asset: holdAsset,
          amount: holdAmount,
          at: placedAt,
          ref,
          state: 'set_aside',
          detail: {
            kind: 'order',
            side: order.side,
            base,
            quote,
            orderAmount: order.amount,
            price: order.price,
            order: order.venueClientOrderId,
            status: 'open',
          },
        });
      } else if (CANCELLED.has(order.status)) {
        const heldAmount = buy ? product(order.price, order.amount) : order.amount;
        out.push({
          id: `venue:order-cancelled:${ref}`,
          source: 'venue',
          sourceName: venue,
          kind: 'order_cancelled',
          direction: 'in',
          asset: holdAsset,
          amount: heldAmount,
          at: placedAt,
          ref,
          state: 'cancelled',
          detail: {
            kind: 'order',
            side: order.side,
            base,
            quote,
            orderAmount: order.amount,
            price: order.price,
            order: order.venueClientOrderId,
            status: 'cancelled',
          },
        });
      }
    }
  } else {
    for (const fill of fills) out.push(singleFillLine(fill, venue, converts));
  }
  for (const deposit of deposits) {
    out.push({
      id: `venue:deposit:${deposit.depositRef}`,
      source: 'venue',
      sourceName: venue,
      kind: 'deposit',
      direction: 'in',
      asset: deposit.asset,
      amount: deposit.amount,
      at: deposit.seenAt,
      ref: deposit.txHash.toLowerCase(),
      state: deposit.status === 'credited' ? 'completed' : deposit.status,
      detail:
        deposit.status === 'confirming' ? { kind: 'confirming', confirmations: deposit.confirmations, required: deposit.required } : null,
    });
  }
  return out;
}

const PARTNER_KIND: Partial<Record<ActivityItem['kind'], LineKind>> = {
  deposit: 'deposit',
  withdrawal: 'withdrawal',
  transfer_in: 'transfer_in',
  transfer_out: 'transfer_out',
  space_move: 'space_move',
  fee: 'fee',
  earn: 'earn',
};

/** The partner's lines: the bank's lines that carry the partner's own name (`heldAt`); our own ledger's lines are not. */
export function partnerLines(items: readonly ActivityItem[]): SourceLine[] {
  return items.flatMap((item) =>
    item.heldAt
      ? [
          {
            id: `partner:${item.id}`,
            source: 'partner' as const,
            sourceName: item.heldAt.label,
            kind: PARTNER_KIND[item.kind] ?? 'other',
            direction: item.direction,
            asset: item.asset,
            amount: item.amount,
            at: item.postedAt,
            ref: item.txId,
            state: 'completed' as const,
            detail: item.spaceName ? { kind: 'space' as const, name: item.spaceName } : null,
          },
        ]
      : [],
  );
}

/** Every source's lines in one list, newest first (or oldest first); a tie keeps a stable order by id. */
export function oneList(lines: readonly SourceLine[], sort: 'desc' | 'asc' = 'desc'): SourceLine[] {
  const sign = sort === 'asc' ? 1 : -1;
  return [...lines].sort((a, b) => sign * (Date.parse(a.at) - Date.parse(b.at)) || a.id.localeCompare(b.id));
}

/**
 * The filters every source's line can answer: words, direction, dates (in the viewer's clock, as the bank's list reads
 * them) and the coin. `words` is the row's own text, so what is searched is what is read.
 */
export function keepLine(line: SourceLine, f: ActivityFilters, zone: Zone, asset: string | null, words: string): boolean {
  if (
    asset &&
    line.asset !== asset &&
    !(line.detail?.kind === 'trade' && line.detail.quote.asset === asset) &&
    !(line.detail?.kind === 'order' && (line.detail.base === asset || line.detail.quote === asset))
  )
    return false;
  if (f.dir !== 'all' && line.direction !== f.dir) return false;
  if (!inRange(line.at, f, zone)) return false;
  const needle = f.q.trim().toLowerCase();
  if (!needle) return true;
  const hay = [words, line.asset, line.amount, line.ref, line.sourceName, line.detail?.kind === 'space' ? line.detail.name : '']
    .join(' ')
    .toLowerCase();
  return needle.split(/\s+/).every((word) => hay.includes(word));
}

/**
 * The filters no source's own record can answer here: a note is ours, and an account, a UTC year and a withdrawal
 * address are fields of our own ledger's lines. With any of them set the list says so and lists nothing, rather than a
 * list that silently ignored it.
 */
export function unanswerable(f: ActivityFilters): Array<'note' | 'account' | 'year' | 'address'> {
  return [
    ...(f.hasNote ? (['note'] as const) : []),
    ...(f.accountId ? (['account'] as const) : []),
    ...(f.year ? (['year'] as const) : []),
    ...(f.address.trim() ? (['address'] as const) : []),
  ];
}

/** The venue's own record of one order, as its by-client-id read answers it. */
export interface VenueOrderRead {
  side: 'buy' | 'sell';
  price: string;
  amount: string;
  remaining: string;
  status: string;
  locked: string;
  lockedAsset: string;
}

export type FillPartKind = 'received' | 'sold' | 'paid' | 'got' | 'fee' | 'rebate' | 'held' | 'released';
export interface FillPart {
  part: FillPartKind;
  up: boolean;
  asset: string;
  amount: string;
  /** The venue's fill reference of a fill's leg; null on the order's hold and release. */
  fill: string | null;
  /** A fill's leg in the held asset of an order the venue kept on its book: spent from that hold, not on top of it. */
  fromHold: boolean;
}

/** An order the venue kept on its book: it held funds for it until it filled or was cancelled. */
const RESTED = new Set(['open', 'partially_filled', 'canceled', 'cancelled']);
const CANCELLED = new Set(['canceled', 'cancelled']);

/**
 * The parts of one venue order, as one group (J-portfolio-03 #4 on the launch model): each of its fills' legs and fees,
 * and, for an order the venue kept on its book, what it held for the order and what it released when the order was
 * cancelled, every figure from the venue's own fill and order records. A buy holds its quote at the limit price for the
 * whole amount and a sell its base, as the venue locks them; the fills spend that hold, so a rested order's fill leg in
 * the held asset is marked as spent from it. An order the venue never kept (filled at once, or not read) lists its fills'
 * two legs alone. `fills` are the order's own venue trade lines.
 */
export function fillParts(fills: readonly SourceLine[], order: VenueOrderRead | null): FillPart[] {
  const rested = order !== null && RESTED.has(order.status);
  const out: FillPart[] = [];
  for (const line of fills) {
    if (line.detail?.kind !== 'trade') continue;
    const buy = line.detail.side === 'buy';
    const legs: readonly VenueFillLeg[] = line.detail.fills ?? [
      { fillId: line.ref, amount: line.amount, quoteAmount: line.detail.quote.amount, fee: line.detail.fee },
    ];
    // Both legs of every fill. On a rested order the leg in the held asset (a buy's quote, a sell's base) is spent from the
    // hold listed below, and says so.
    for (const leg of legs) {
      out.push(
        { part: buy ? 'received' : 'sold', up: buy, asset: line.asset, amount: leg.amount, fill: leg.fillId, fromHold: rested && !buy },
        {
          part: buy ? 'paid' : 'got',
          up: !buy,
          asset: line.detail.quote.asset,
          amount: leg.quoteAmount,
          fill: leg.fillId,
          fromHold: rested && buy,
        },
      );
      if (leg.fee)
        out.push({
          part: leg.fee.rebate ? 'rebate' : 'fee',
          up: leg.fee.rebate,
          asset: leg.fee.asset,
          amount: leg.fee.amount,
          fill: leg.fillId,
          fromHold: false,
        });
    }
  }
  if (rested && order) {
    const buy = order.side === 'buy';
    const asset = order.lockedAsset || (fills[0]?.detail?.kind === 'trade' ? (buy ? fills[0].detail.quote.asset : fills[0].asset) : '');
    out.push({
      part: 'held',
      up: false,
      asset,
      amount: buy ? product(order.price, order.amount) : order.amount,
      fill: null,
      fromHold: false,
    });
    if (CANCELLED.has(order.status) && parseAmount(order.remaining) > 0n)
      out.push({
        part: 'released',
        up: true,
        asset,
        amount: buy ? product(order.price, order.remaining) : order.remaining,
        fill: null,
        fromHold: false,
      });
  }
  return out;
}

/** The venue trade lines of `line`'s order (the venue's client order id), `line` included; a line of no order is alone. */
export function orderLines(lines: readonly SourceLine[], line: SourceLine): SourceLine[] {
  const order = line.detail?.kind === 'trade' ? line.detail.order : null;
  if (line.source !== 'venue' || !order) return [line];
  return lines.filter((l) => l.source === 'venue' && l.detail?.kind === 'trade' && l.detail.order === order);
}
