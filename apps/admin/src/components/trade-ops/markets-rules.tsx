import { KeyValue, type KeyValueItem } from '@intafaced/ui';
import type { MarketRow } from '@/lib/trade-ops/reads';
import { RecordStatusBadge } from './markets-lifecycle-badge';

/** The market's trading rules and fees as a plain list. Quantities are the exact decimal strings the service sent. */
export function MarketRules({ market, asOf }: { market: MarketRow; asOf: string }) {
  const items: KeyValueItem[] = [
    { label: 'Symbol', value: market.symbol, mono: true },
    { label: 'Base / quote', value: `${market.base} / ${market.quote}` },
    { label: 'Kind', value: market.kind },
    { label: 'Tick size (price step)', value: market.tickSize },
    { label: 'Lot size (quantity step)', value: market.lotSize },
    { label: 'Min quantity', value: market.minQty },
    { label: 'Max quantity', value: market.maxQty },
    { label: 'Min notional', value: market.minNotional },
    { label: 'Maker fee (bps)', value: String(market.makerBps) },
    { label: 'Taker fee (bps)', value: String(market.takerBps) },
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
