import type { VenueBuilderFeeRow, VenueFill, VenueFundingPayment, VenueLiquidation } from '../../../features/trade/venue-api';

/**
 * The bills log of the venue futures desk (J-derivatives-12 #4): every money line on the person's venue account, each as
 * the venue reports it with the venue's own id, and our builder fee on each fill with the ledger transaction we posted it
 * under. Nothing here is recomputed: an amount is the venue's figure digit for digit, signed as the venue signs it.
 *
 *   funding      a funding payment the venue booked on a position (its payment id); positive received, negative paid
 *   close        a fill that closed a position (its fill id), with the result the venue realised on it
 *   liquidation  one part of a liquidation the venue carried out (its part id, under its liquidation id), with its fee
 *   builder_fee  our builder fee on one fill (the venue's fill id): the venue's figure, and our ledger's transaction, or
 *                null while it is not posted
 */
export type VenueBill =
  | {
      readonly kind: 'funding';
      readonly venueRef: string;
      readonly symbol: string;
      readonly amount: string;
      readonly asset: string;
      readonly at: string;
    }
  | {
      readonly kind: 'close';
      readonly venueRef: string;
      readonly symbol: string;
      readonly amount: string;
      readonly asset: string;
      readonly at: string;
    }
  | {
      readonly kind: 'liquidation';
      readonly venueRef: string;
      readonly liquidationId: string;
      readonly symbol: string;
      readonly amount: string;
      readonly asset: string;
      readonly at: string;
    }
  | {
      readonly kind: 'builder_fee';
      readonly venueRef: string;
      readonly symbol: string;
      readonly amount: string;
      readonly asset: string;
      readonly at: string;
      readonly ledgerTxId: string | null;
      readonly ledgerStatus: VenueBuilderFeeRow['status'] | null;
    };

const isZero = (amount: string) => /^-?0*(\.0*)?$/.test(amount.trim());

/** Every bill line, oldest first; on one instant the venue's own line comes before our builder fee on it. */
export function billsOf(input: {
  readonly funding: readonly VenueFundingPayment[];
  readonly fills: readonly VenueFill[];
  readonly liquidations: readonly VenueLiquidation[];
  readonly builderFees: readonly VenueBuilderFeeRow[];
}): VenueBill[] {
  const ours = new Map(input.builderFees.map((r) => [r.fillId, r]));
  const bills: VenueBill[] = [];
  for (const p of input.funding)
    bills.push({ kind: 'funding', venueRef: p.paymentId, symbol: p.symbol, amount: p.amount, asset: p.asset, at: p.periodAt });
  for (const f of input.fills) {
    if (f.realisedPnl !== null)
      bills.push({ kind: 'close', venueRef: f.fillId, symbol: f.symbol, amount: f.realisedPnl, asset: f.feeAsset, at: f.filledAt });
    if (isZero(f.builderFee)) continue;
    const row = ours.get(f.fillId) ?? null;
    bills.push({
      kind: 'builder_fee',
      venueRef: f.fillId,
      symbol: f.symbol,
      amount: f.builderFee,
      asset: f.feeAsset,
      at: f.filledAt,
      ledgerTxId: row?.ledgerTxId ?? null,
      ledgerStatus: row?.status ?? null,
    });
  }
  for (const l of input.liquidations)
    for (const part of l.parts)
      bills.push({
        kind: 'liquidation',
        venueRef: part.partId,
        liquidationId: l.liquidationId,
        symbol: l.symbol,
        amount: part.fee,
        asset: part.feeAsset,
        at: part.liquidatedAt,
      });
  const order: Record<VenueBill['kind'], number> = { funding: 0, close: 1, liquidation: 2, builder_fee: 3 };
  return bills.sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || order[a.kind] - order[b.kind]);
}
