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
  'trade' | 'convert' | 'deposit' | 'withdrawal' | 'transfer_in' | 'transfer_out' | 'space_move' | 'fee' | 'earn' | 'other';

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
  other: 'other',
};

export const typeOf = (kind: LineKind): LineType => TYPE_OF[kind];
export type LineState = 'completed' | 'confirming' | 'not_credited' | 'failed';

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
  /** The source's own reference: a transaction hash, a fill id, a deposit reference, a partner move id. */
  ref: string;
  state: LineState;
  /** What else the line carries, in figures: the other side of a trade, its fee, a deposit's confirmations. */
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

/**
 * The venue's lines: one per fill (what was bought or sold, with what was paid or got and the fee, as the venue records
 * them), and one per deposit the venue has seen (credited, still confirming, or not credited and why). A fill of an
 * order a conversion placed (its client id is the conversion's) is a convert, not a trade.
 */
export function venueLines(
  fills: readonly VenueFillRead[],
  deposits: readonly VenueDepositRead[],
  venue: string,
  conversions: readonly VenueConversionRead[] = [],
): SourceLine[] {
  const converts = new Map(conversions.flatMap((c) => (c.venueClientOrderId ? [[c.venueClientOrderId, c] as const] : [])));
  const out: SourceLine[] = [];
  for (const fill of fills) {
    const { base, quote } = sides(fill.symbol, fill.feeAsset);
    const fee = parseAmount(fill.venueFee) + parseAmount(fill.builderFee);
    const order = fill.venueClientOrderId ?? null;
    const conversion = order ? converts.get(order) : undefined;
    out.push({
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
    });
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
  if (asset && line.asset !== asset && !(line.detail?.kind === 'trade' && line.detail.quote.asset === asset)) return false;
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
}

/** An order the venue kept on its book: it held funds for it until it filled or was cancelled. */
const RESTED = new Set(['open', 'partially_filled', 'canceled', 'cancelled']);
const CANCELLED = new Set(['canceled', 'cancelled']);

/**
 * The parts of one venue order, as one group (J-portfolio-03 #4 on the launch model): each of its fills' legs and fees,
 * and, for an order the venue kept on its book, what it held for the order and what it released when the order was
 * cancelled, every figure from the venue's own fill and order records. A buy holds its quote at the limit price for the
 * whole amount and a sell its base, as the venue locks them; the fills spend that hold, so a rested order's leg in the
 * held asset is the hold and its release, never counted twice as a payment too. An order the venue never kept (filled at
 * once, or not read) lists its fills' two legs. `fills` are the order's own venue trade lines.
 */
export function fillParts(fills: readonly SourceLine[], order: VenueOrderRead | null): FillPart[] {
  const rested = order !== null && RESTED.has(order.status);
  const out: FillPart[] = [];
  for (const line of fills) {
    if (line.detail?.kind !== 'trade') continue;
    const buy = line.detail.side === 'buy';
    const base: FillPart = { part: buy ? 'received' : 'sold', up: buy, asset: line.asset, amount: line.amount, fill: line.ref };
    const quote: FillPart = {
      part: buy ? 'paid' : 'got',
      up: !buy,
      asset: line.detail.quote.asset,
      amount: line.detail.quote.amount,
      fill: line.ref,
    };
    // A rested order's leg in the held asset (a buy's quote, a sell's base) is spent from the hold listed below.
    if (!rested) out.push(base, quote);
    else out.push(buy ? base : quote);
    const fee = line.detail.fee;
    if (fee) out.push({ part: fee.rebate ? 'rebate' : 'fee', up: fee.rebate, asset: fee.asset, amount: fee.amount, fill: line.ref });
  }
  if (rested && order) {
    const buy = order.side === 'buy';
    const asset = order.lockedAsset || (fills[0]?.detail?.kind === 'trade' ? (buy ? fills[0].detail.quote.asset : fills[0].asset) : '');
    out.push({ part: 'held', up: false, asset, amount: buy ? product(order.price, order.amount) : order.amount, fill: null });
    if (CANCELLED.has(order.status) && parseAmount(order.remaining) > 0n)
      out.push({ part: 'released', up: true, asset, amount: buy ? product(order.price, order.remaining) : order.remaining, fill: null });
  }
  return out;
}

/** The venue trade lines of `line`'s order (the venue's client order id), `line` included; a line of no order is alone. */
export function orderLines(lines: readonly SourceLine[], line: SourceLine): SourceLine[] {
  const order = line.detail?.kind === 'trade' ? line.detail.order : null;
  if (line.source !== 'venue' || !order) return [line];
  return lines.filter((l) => l.source === 'venue' && l.detail?.kind === 'trade' && l.detail.order === order);
}
