import { earnedBuilderFeeKey, venueBuilderFeeReceivable, type LedgerClient, type LedgerTx } from '@intafaced/ledger-client';
import { div, formatAmount, mul, parseAmount, type Amount } from '@intafaced/ledger-client/money';
import { isTestVenue, VenueRefusalError, type UserVenue, type UserVenueFill } from '@intafaced/venue-contracts';
import type { BuilderFeeStore, LoggedBuilderFee } from './builder-fee-store.js';

/**
 * THE BUILDER-FEE RECON (J-derivatives-17 #1 #2; D-venue-07, D-ops-02). For one period, the builder fees the venue
 * reports on our users' fills against the builder fees the ledger records as earned (`builder-fee:<venueId>:<fillId>`),
 * matched fill by fill. Read only: a break is a row for a person, never an entry to make the two agree; a correction is
 * a separate approved ledger action.
 *
 * - The venue's side is the venue's own fills, read now, each with its builder fee.
 * - The ledger's side is the ledger's own transaction under each key: for every fill the venue reports, and for every
 *   fill the poster recorded in the period (so a fee the ledger holds and the venue no longer reports is listed too).
 * - A venue that can't be read is `unknown` with its reason, never a zero; a ledger that can't be read fails the read.
 *
 * Alongside (J-derivatives-17 #3 #4 #5):
 * - `owed`: what the venue owes us now, the ledger's own balance of `venueBuilderFeeReceivable` for the venue: every builder
 *   fee earned there less every payout received (`builderFeeReceive`). It is the whole book, not the period.
 * - `volume` and `volumeGaps`: the routed volume, the notional of the period's fills on orders we sent with our builder
 *   fee, against the builder fee the venue charged on them. The fee each fill should carry is its order's rate on the
 *   venue's fee basis; a fill whose charged fee differs, or a fee charged on a fill of no routed order, is a gap, named.
 * - `ledgerRecords`: the ledger's builder-fee transactions for the period's fills, as the export file lists them.
 */
export type BuilderFeeLineStatus =
  'matched' | 'not_in_ledger' | 'not_reported_by_venue' | 'amounts_differ' | 'ledger_refused' | 'ledger_missing';

export interface BuilderFeeReconLine {
  readonly fillId: string;
  readonly userId: string | null;
  readonly assetId: string;
  /** The venue's builder fee on the fill, or null when the venue doesn't report the fill. */
  readonly venueAmount: string | null;
  /** The fee the ledger records as earned under the fill's key, or null when it records none. */
  readonly ledgerAmount: string | null;
  /** The asset of the ledger's transaction, or null when it records none. A different asset than the venue's is a break. */
  readonly ledgerAssetId: string | null;
  readonly filledAt: string;
  readonly status: BuilderFeeLineStatus;
  /** The ledger's refusal, for a fill the poster could not post. */
  readonly refusalCode: string | null;
}

export interface BuilderFeeReconTotal {
  readonly assetId: string;
  readonly venueTotal: string;
  readonly ledgerTotal: string;
  readonly matched: boolean;
}

/**
 * What a venue owes us in builder fees now, per asset: the receivable's balance, negated. `owed` while fees are earned
 * and not received; `overpaid` when the ledger records more received than earned, a break for a person (never netted).
 */
export interface BuilderFeeOwed {
  readonly assetId: string;
  readonly amount: string;
  readonly state: 'owed' | 'overpaid';
}

/** The routed volume and its builder fees, per fee asset and quote asset. */
export interface BuilderFeeVolumeRow {
  readonly assetId: string;
  readonly quoteAsset: string;
  readonly fills: number;
  /** The notional of the routed fills, in the quote asset. */
  readonly volume: string;
  /** The builder fee the routed fills should carry at their orders' rates. */
  readonly expectedFee: string;
  /** The builder fee the venue charged on those fills. */
  readonly chargedFee: string;
  /** Charged less expected over the row. */
  readonly gap: string;
  /** True only when every routed fill in the row carries exactly its order rate (offsetting gaps never net to green). */
  readonly matched: boolean;
}

export type BuilderFeeVolumeGapReason = 'fee_differs' | 'not_a_routed_order' | 'fee_asset_unknown' | 'market_unknown';

export interface BuilderFeeVolumeGap {
  readonly fillId: string;
  readonly symbol: string;
  readonly assetId: string;
  readonly volume: string;
  /** The rate on the order we sent, or null for a fill of no order of ours. */
  readonly feeBps: string | null;
  /** The fee at the order rate, or null when it can't be worked out (an unknown market, a fee in a third asset). */
  readonly expectedFee: string | null;
  readonly chargedFee: string;
  /** Charged less expected, or null when there is no expected fee to compare. */
  readonly gap: string | null;
  readonly reason: BuilderFeeVolumeGapReason;
}

/** One ledger builder-fee transaction, as the export file lists it. */
export interface BuilderFeeLedgerRecord {
  readonly ledgerTxId: string;
  readonly idempotencyKey: string;
  readonly fillId: string;
  readonly userId: string | null;
  readonly assetId: string;
  readonly amount: string;
  readonly postedAt: string;
}

export type BuilderFeeReconVenue =
  | {
      readonly venueId: string;
      readonly displayName: string;
      readonly test: boolean;
      readonly state: 'read';
      readonly asOf: string;
      readonly matched: boolean;
      readonly totals: readonly BuilderFeeReconTotal[];
      readonly lines: readonly BuilderFeeReconLine[];
      readonly owed: readonly BuilderFeeOwed[];
      readonly volume: readonly BuilderFeeVolumeRow[];
      readonly volumeGaps: readonly BuilderFeeVolumeGap[];
      readonly ledgerRecords: readonly BuilderFeeLedgerRecord[];
    }
  | {
      readonly venueId: string | null;
      readonly displayName: string | null;
      readonly test: boolean | null;
      readonly state: 'unknown';
      readonly code: string;
      readonly message: string;
    };

export interface BuilderFeeRecon {
  readonly from: string;
  readonly to: string;
  /** True when the period hasn't ended: fills may still arrive, so a green row can still change. */
  readonly periodOpen: boolean;
  readonly venues: readonly BuilderFeeReconVenue[];
}

export interface BuilderFeeReconDeps {
  /** The venues we route to. Today one, through the user-venue door; null when the door is off. */
  readonly venue: (() => Promise<UserVenue>) | null;
  readonly ledger: Pick<LedgerClient, 'getTxByKey' | 'balances'>;
  readonly store: BuilderFeeStore;
  /** The orders we sent with our builder fee, among these venue client order ids, each with its rate (prepared-action-store.ts). */
  readonly routedOrders: (venueId: string, venueClientOrderIds: readonly string[]) => Promise<ReadonlyMap<string, Amount>>;
  readonly now: () => Date;
}

export class BuilderFeeReconError extends Error {
  constructor(
    message: string,
    readonly code: 'trade.builder_fee_recon_period_invalid' | 'trade.builder_fee_recon_venue_not_connected',
  ) {
    super(message);
    this.name = 'BuilderFeeReconError';
  }
}

/** How many ledger reads the recon has in flight at once. */
const LEDGER_READS_AT_ONCE = 8;

/** The longest period one read covers, so a read stays bounded. */
export const BUILDER_FEE_RECON_MAX_DAYS = 31;

/** The fee the ledger records as earned in a `builderFeeEarn` transaction: its one debit, to house builder-fee revenue. */
export function earnedAmount(tx: LedgerTx): Amount {
  return tx.entries.filter((e) => e.direction === 'debit').reduce((sum, e) => sum + e.amount, 0n);
}

/** The asset of a `builderFeeEarn` transaction: its debit's. */
export function earnedAsset(tx: LedgerTx): string | null {
  return tx.entries.find((e) => e.direction === 'debit')?.assetId ?? null;
}

const BPS = parseAmount('10000');

/** The base and quote asset of a market, from the venue's own market list. */
export interface FeeMarket {
  readonly baseAsset: string;
  readonly quoteAsset: string;
}

/**
 * The builder fee a fill should carry at `feeBps`, on the venue's fee basis: the quantity when the fee is charged in the
 * market's base asset (a spot buy pays in what it receives), the notional when it is charged in the quote asset. Rounded
 * up, as a fee is. Null when the fee is in neither asset: the two can't be compared, and the recon names that gap.
 */
export function expectedBuilderFee(fill: UserVenueFill, market: FeeMarket, feeBps: Amount): Amount | null {
  const basis = fill.feeAsset === market.baseAsset ? fill.amount : fill.feeAsset === market.quoteAsset ? notional(fill) : null;
  return basis === null ? null : div(mul(basis, feeBps, 'ceil'), BPS, 'ceil');
}

const notional = (fill: UserVenueFill) => mul(fill.price, fill.amount, 'ceil');

export function assertReconPeriod(from: Date, to: Date): void {
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) {
    throw new BuilderFeeReconError('The period must start before it ends', 'trade.builder_fee_recon_period_invalid');
  }
  if (to.getTime() - from.getTime() > BUILDER_FEE_RECON_MAX_DAYS * 86_400_000) {
    throw new BuilderFeeReconError(`A recon covers at most ${BUILDER_FEE_RECON_MAX_DAYS} days`, 'trade.builder_fee_recon_period_invalid');
  }
}

interface Side {
  venue: (UserVenueFill & { userId: string }) | null;
  logged: LoggedBuilderFee | null;
}

export async function builderFeeRecon(deps: BuilderFeeReconDeps, from: Date, to: Date): Promise<BuilderFeeRecon> {
  assertReconPeriod(from, to);
  const now = deps.now();
  const head = { from: from.toISOString(), to: to.toISOString(), periodOpen: to > now };
  if (!deps.venue) {
    throw new BuilderFeeReconError(
      'No venue is connected, so there is nothing to reconcile',
      'trade.builder_fee_recon_venue_not_connected',
    );
  }

  let venue: UserVenue;
  let reported: (UserVenueFill & { userId: string })[] = [];
  const inPeriod: UserVenueFill[] = [];
  let asOf = now;
  let markets: ReadonlyMap<string, FeeMarket>;
  try {
    venue = await deps.venue();
    markets = new Map((await venue.markets(null)).value.map((m) => [m.symbol, m]));
    for (const { userId, account } of await deps.store.accounts(venue.venue.id)) {
      const fills = await venue.fills(account, from);
      if (fills.asOf < asOf) asOf = fills.asOf;
      for (const fill of fills.value) {
        if (fill.filledAt < from || fill.filledAt >= to) continue;
        inPeriod.push(fill);
        if (fill.builderFee > 0n) reported.push({ ...fill, userId });
      }
    }
  } catch (error) {
    if (!(error instanceof VenueRefusalError)) throw error;
    return {
      ...head,
      venues: [
        { venueId: null, displayName: null, test: null, state: 'unknown', code: `venue.${error.refusal.code}`, message: error.message },
      ],
    };
  }

  const venueId = venue.venue.id;
  const sides = new Map<string, Side>();
  for (const fill of reported) sides.set(fill.fillId, { venue: fill, logged: null });
  for (const logged of await deps.store.inPeriod(venueId, from, to)) {
    const side = sides.get(logged.fillId);
    if (side) side.logged = logged;
    else sides.set(logged.fillId, { venue: null, logged });
  }

  const lines: BuilderFeeReconLine[] = [];
  const ledgerRecords: BuilderFeeLedgerRecord[] = [];
  const totals = new Map<string, { venue: Amount; ledger: Amount }>();
  // The ledger's transaction under each fill's key, read a few at a time so a long period stays bounded.
  const entries = [...sides.entries()];
  const txs = new Map<string, LedgerTx | null>();
  for (let i = 0; i < entries.length; i += LEDGER_READS_AT_ONCE) {
    const batch = entries.slice(i, i + LEDGER_READS_AT_ONCE);
    const read = await Promise.all(batch.map(([fillId]) => deps.ledger.getTxByKey(earnedBuilderFeeKey(venueId, fillId))));
    batch.forEach(([fillId], j) => txs.set(fillId, read[j] ?? null));
  }
  const add = (assetId: string, venue: Amount, ledger: Amount) => {
    const sum = totals.get(assetId) ?? { venue: 0n, ledger: 0n };
    totals.set(assetId, { venue: sum.venue + venue, ledger: sum.ledger + ledger });
  };
  for (const [fillId, side] of entries) {
    const tx = txs.get(fillId) ?? null;
    const ledgerAmount = tx ? earnedAmount(tx) : null;
    const ledgerAsset = tx ? earnedAsset(tx) : null;
    const venueAmount = side.venue ? side.venue.builderFee : null;
    const assetId = side.venue?.feeAsset ?? ledgerAsset ?? side.logged!.assetId;
    let status: BuilderFeeLineStatus;
    if (venueAmount === null && ledgerAmount === null) {
      // Neither side has it. A refused fill the venue no longer reports is nothing on either side; a fill recorded as
      // posted whose transaction the ledger no longer has is a break in our own records, listed, never hidden.
      if (side.logged?.status !== 'posted') continue;
      status = 'ledger_missing';
    } else if (venueAmount === null) status = 'not_reported_by_venue';
    else if (ledgerAmount === null) status = side.logged?.status === 'refused' ? 'ledger_refused' : 'not_in_ledger';
    else status = ledgerAmount === venueAmount && ledgerAsset === side.venue!.feeAsset ? 'matched' : 'amounts_differ';
    // Each side's amount counts in its own asset, so two assets never net against each other.
    if (venueAmount !== null) add(side.venue!.feeAsset, venueAmount, 0n);
    if (ledgerAmount !== null) add(ledgerAsset ?? assetId, 0n, ledgerAmount);
    if (tx && ledgerAmount !== null) {
      ledgerRecords.push({
        ledgerTxId: tx.id,
        idempotencyKey: tx.idempotencyKey,
        fillId,
        userId: typeof tx.meta.userId === 'string' ? tx.meta.userId : null,
        assetId: ledgerAsset ?? assetId,
        amount: formatAmount(ledgerAmount),
        postedAt: tx.postedAt.toISOString(),
      });
    }
    lines.push({
      fillId,
      userId: side.venue?.userId ?? side.logged?.userId ?? null,
      assetId,
      venueAmount: venueAmount === null ? null : formatAmount(venueAmount),
      ledgerAmount: ledgerAmount === null ? null : formatAmount(ledgerAmount),
      ledgerAssetId: ledgerAsset,
      filledAt: (side.venue?.filledAt ?? side.logged!.filledAt).toISOString(),
      status,
      refusalCode: status === 'ledger_refused' ? (side.logged?.refusalCode ?? null) : null,
    });
  }
  lines.sort((a, b) => a.filledAt.localeCompare(b.filledAt) || a.fillId.localeCompare(b.fillId));
  ledgerRecords.sort((a, b) => a.postedAt.localeCompare(b.postedAt) || a.fillId.localeCompare(b.fillId));

  // What the venue owes us now (the receivable's own balance, negative while fees are earned and not yet paid out), and
  // the orders we routed among the period's fills: two reads that share nothing, run together.
  const ids = [...new Set(inPeriod.map((f) => f.venueClientOrderId).filter((id): id is string => id !== null))];
  const [balances, rates] = await Promise.all([
    deps.ledger.balances('treasury', venueBuilderFeeReceivable(venueId, '').ownerId),
    deps.routedOrders(venueId, ids),
  ]);
  const owed: BuilderFeeOwed[] = balances
    .filter((b) => b.account.kind === 'available' && b.amount !== 0n)
    .map((b) => ({
      assetId: b.account.assetId,
      amount: formatAmount(-b.amount),
      state: b.amount < 0n ? ('owed' as const) : ('overpaid' as const),
    }))
    .sort((a, b) => a.assetId.localeCompare(b.assetId));

  // The routed volume: fills of the orders we sent with our builder fee, against the fee charged on them. A fill the venue
  // charged our fee on with no routed order of ours is not routed volume: it is listed as a gap only.
  const volumeSums = new Map<
    string,
    { assetId: string; quoteAsset: string; fills: number; volume: Amount; expected: Amount; charged: Amount; gaps: number }
  >();
  const volumeGaps: BuilderFeeVolumeGap[] = [];
  for (const fill of [...inPeriod].sort((a, b) => a.filledAt.getTime() - b.filledAt.getTime() || a.fillId.localeCompare(b.fillId))) {
    const rate = fill.venueClientOrderId === null ? undefined : rates.get(fill.venueClientOrderId);
    if (rate === undefined && fill.builderFee <= 0n) continue;
    const market = markets.get(fill.symbol);
    const expected = rate === undefined ? 0n : market ? expectedBuilderFee(fill, market, rate) : null;
    const reason: BuilderFeeVolumeGapReason | null =
      rate === undefined
        ? 'not_a_routed_order'
        : !market
          ? 'market_unknown'
          : expected === null
            ? 'fee_asset_unknown'
            : fill.builderFee !== expected
              ? 'fee_differs'
              : null;
    if (rate !== undefined) {
      const quote = market?.quoteAsset ?? fill.feeAsset;
      const id = `${fill.feeAsset}\u0000${quote}`;
      const sum = volumeSums.get(id) ?? {
        assetId: fill.feeAsset,
        quoteAsset: quote,
        fills: 0,
        volume: 0n,
        expected: 0n,
        charged: 0n,
        gaps: 0,
      };
      volumeSums.set(id, {
        ...sum,
        fills: sum.fills + 1,
        volume: sum.volume + notional(fill),
        expected: sum.expected + (expected ?? 0n),
        charged: sum.charged + fill.builderFee,
        gaps: sum.gaps + (reason === null ? 0 : 1),
      });
    }
    if (reason !== null) {
      volumeGaps.push({
        fillId: fill.fillId,
        symbol: fill.symbol,
        assetId: fill.feeAsset,
        volume: formatAmount(notional(fill)),
        feeBps: rate === undefined ? null : formatAmount(rate),
        expectedFee: expected === null ? null : formatAmount(expected),
        chargedFee: formatAmount(fill.builderFee),
        gap: expected === null ? null : formatAmount(fill.builderFee - expected),
        reason,
      });
    }
  }
  const volume = [...volumeSums.values()]
    .sort((a, b) => a.assetId.localeCompare(b.assetId) || a.quoteAsset.localeCompare(b.quoteAsset))
    .map((v) => ({
      assetId: v.assetId,
      quoteAsset: v.quoteAsset,
      fills: v.fills,
      volume: formatAmount(v.volume),
      expectedFee: formatAmount(v.expected),
      chargedFee: formatAmount(v.charged),
      gap: formatAmount(v.charged - v.expected),
      matched: v.gaps === 0,
    }));

  const totalRows = [...totals.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([assetId, t]) => ({
      assetId,
      venueTotal: formatAmount(t.venue),
      ledgerTotal: formatAmount(t.ledger),
      matched: t.venue === t.ledger,
    }));
  return {
    ...head,
    venues: [
      {
        venueId,
        displayName: venue.venue.displayName,
        test: isTestVenue(venue.venue),
        state: 'read',
        asOf: asOf.toISOString(),
        matched: lines.every((l) => l.status === 'matched'),
        totals: totalRows,
        lines,
        owed,
        volume,
        volumeGaps,
        ledgerRecords,
      },
    ],
  };
}
