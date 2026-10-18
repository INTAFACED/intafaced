'use client';

import { KeyValue, type KeyValueItem } from '@intafaced/ui';
import { bpsToPercent, feeCellFor, type EffectiveFees } from '@/lib/trade-ops/fees-model';
import type { Outcome } from '@/lib/trade-ops/outcome';
import type { MarketRow } from '@/lib/trade-ops/reads';
import { RecordStatusBadge } from './markets-lifecycle-badge';

/**
 * The market's trading rules and fees as a plain list. Quantities are the exact decimal strings the service sent.
 * Fees charged come from the owner schedule; the listing-row bps are shown only as metadata, labelled not charged.
 */
export function MarketRules({ market, asOf, fees }: { market: MarketRow; asOf: string; fees: Outcome<EffectiveFees> }) {
  const cell = feeCellFor(fees, market.symbol);
  const charged: KeyValueItem[] =
    cell.kind === 'charged'
      ? [
          { label: 'Maker fee charged', value: `${bpsToPercent(cell.makerBps)} (${cell.makerBps} bps)` },
          { label: 'Taker fee charged', value: `${bpsToPercent(cell.takerBps)} (${cell.takerBps} bps)` },
          { label: 'Charged from', value: `${cell.product} block of the owner fee schedule` },
        ]
      : cell.kind === 'refused'
        ? [
            { label: 'Fee charged', value: 'Refused' },
            { label: 'Refusal code', value: cell.code, mono: true },
          ]
        : [{ label: 'Fee charged', value: null }];
  const items: KeyValueItem[] = [
    { label: 'Symbol', value: market.symbol, mono: true },
    { label: 'Base / quote', value: `${market.base} / ${market.quote}` },
    { label: 'Kind', value: market.kind },
    { label: 'Tick size (price step)', value: market.tickSize },
    { label: 'Lot size (quantity step)', value: market.lotSize },
    { label: 'Min quantity', value: market.minQty },
    { label: 'Max quantity', value: market.maxQty },
    { label: 'Min notional', value: market.minNotional },
    ...charged,
    { label: 'Listing maker fee (bps), not charged', value: String(market.makerBps) },
    { label: 'Listing taker fee (bps), not charged', value: String(market.takerBps) },
    { label: 'Listed at', value: market.listedAt, mono: true },
    { label: 'Market id', value: market.id, mono: true, asOf },
  ];
  return (
    <div className="flex flex-col gap-2">
      <p className="flex items-center gap-2 text-sm text-fg-2">
        Record status: <RecordStatusBadge status={market.status} />
      </p>
      <KeyValue items={items} density="dense" />
    </div>
  );
}
