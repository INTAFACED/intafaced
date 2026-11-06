/**
 * DOM: a labelled preview (CB-order-controls-05, LD-1). One-click trading from a depth ladder needs a dealing engine we
 * have not built, so the card names that engine and the list under it is sample data: every row says TEST, the table is
 * named "Preview · sample data", and no row is a price. The live book is on the spot desk, linked here.
 * The figures are illustrative round numbers, chosen so they can never be read as a market.
 */
import { Badge, Table, type TableColumn } from '../rooms/ui';
import { terminalCopy } from './copy';

/** The contract's preview banner (`PREVIEW_LABEL` in packages/contracts, pinned by dom.test.ts), kept here so the browser bundle does not load the contracts package. */
export const PREVIEW_LABEL = 'Preview · sample data';

interface SampleLevel {
  id: string;
  price: string;
  bid: string | null;
  ask: string | null;
}

/** TEST sample levels: illustrative only, never read from or sent to a book. */
export const SAMPLE: readonly SampleLevel[] = [
  { id: 's5', price: '105.00', bid: null, ask: '5.0' },
  { id: 's4', price: '104.00', bid: null, ask: '4.0' },
  { id: 's3', price: '103.00', bid: null, ask: '3.0' },
  { id: 's2', price: '102.00', bid: null, ask: '2.0' },
  { id: 's1', price: '101.00', bid: null, ask: '1.0' },
  { id: 'b1', price: '100.00', bid: '1.0', ask: null },
  { id: 'b2', price: '99.00', bid: '2.0', ask: null },
  { id: 'b3', price: '98.00', bid: '3.0', ask: null },
  { id: 'b4', price: '97.00', bid: '4.0', ask: null },
  { id: 'b5', price: '96.00', bid: '5.0', ask: null },
];

export function DomTab() {
  const { t } = terminalCopy.useCopy();
  const columns: TableColumn<SampleLevel>[] = [
    { id: 'test', header: '', headerLabel: 'TEST', width: 72, cell: () => <Badge tone="warn">TEST</Badge> },
    { id: 'bid', header: t('Bid size'), numeric: true, value: (r) => r.bid },
    { id: 'price', header: t('Price'), numeric: true, value: (r) => r.price },
    { id: 'ask', header: t('Ask size'), numeric: true, value: (r) => r.ask },
  ];
  return (
    <section aria-label={t('Depth of market')} className="flex flex-col gap-3">
      <div className="flex flex-col gap-2 rounded-md border border-line bg-panel p-3">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="m-0 text-base font-semibold text-fg">{t('DOM title')}</h2>
          <Badge tone="warn">{PREVIEW_LABEL}</Badge>
          <Badge variant="outline">TEST</Badge>
        </div>
        <p className="m-0 font-mono text-xs text-fg-2">{t('DOM engine')}</p>
        <p className="m-0 text-sm text-fg">{t('DOM body')}</p>
        <p className="m-0 text-sm text-fg-2">
          {t('DOM live book')}{' '}
          <a href="/trade/spot/BTC-USDT" className="underline">
            {t('Open the spot desk')}
          </a>
        </p>
      </div>
      <Table label={PREVIEW_LABEL} density="dense" columns={columns} rows={SAMPLE} getRowId={(r) => r.id} minWidth={420} />
    </section>
  );
}
