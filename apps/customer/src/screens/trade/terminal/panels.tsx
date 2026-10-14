/**
 * The desk's built-in panels. Each one wraps an EXISTING desk component and passes it what it needs from `useDesk()`;
 * none of their insides are rewritten here. Importing this file registers them (see the last lines).
 */
import { memo, type ReactNode } from 'react';
import { BottomTabs } from '../desk/BottomTabs';
import { ChartPanel } from '../desk/ChartPanel';
import { MarketsPanel } from '../desk/MarketsPanel';
import { OrderPanel } from '../desk/OrderForm';
import { BookView, Tape } from '../desk/OrderBook';
import { useDesk } from './desk-context';
import { registerPanel, type PanelProps } from './registry';

const Book = memo(BookView);

function Body({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={className ? `tm-body ${className}` : 'tm-body'}>{children}</div>;
}

function MarketsBody() {
  const { market } = useDesk();
  return (
    <Body>
      <MarketsPanel selected={market.symbol} />
    </Body>
  );
}

function ChartBody() {
  const { market, openOrders, fills } = useDesk();
  return (
    <Body>
      <ChartPanel market={market} openOrders={openOrders} fills={fills} />
    </Body>
  );
}

function BookBody() {
  const { market, book, ticker, onPick } = useDesk();
  return (
    <Body>
      <Book market={market} book={book} ticker={ticker} onPick={onPick} />
    </Body>
  );
}

function TradesBody({ visible }: PanelProps) {
  const { market, zone, onPickPrice } = useDesk();
  return (
    <Body>
      {/* Trades are fetched only while this tab shows, as before. */}
      <Tape market={market} zone={zone} onPickPrice={onPickPrice} active={visible} />
    </Body>
  );
}

function TicketBody() {
  const { market, reference, referenceFresh, balances, suggestion, focusSide, onPlaced } = useDesk();
  return (
    <Body className="tm-body--ticket">
      <OrderPanel
        market={market}
        reference={reference}
        referenceFresh={referenceFresh}
        balances={balances}
        suggestion={suggestion}
        focusSide={focusSide}
        onPlaced={onPlaced}
      />
    </Body>
  );
}

function OrdersBody() {
  const { market, markets, openOrders, fills, balances, bottomTab, setBottomTab } = useDesk();
  return (
    <Body>
      <BottomTabs
        market={market}
        markets={markets}
        openOrders={openOrders}
        fills={fills}
        balances={balances}
        tab={bottomTab}
        onTab={setBottomTab}
      />
    </Body>
  );
}

export const BUILT_IN_PANELS = [
  {
    type: 'markets',
    title: 'Markets',
    about: 'Every market, with search, favorites and 24h change.',
    status: 'live',
    prices: true,
    minWidth: 200,
    minHeight: 160,
    component: MarketsBody,
  },
  {
    type: 'chart',
    title: 'Chart',
    about: 'Candles or line, with your open orders and fills on it.',
    status: 'live',
    prices: true,
    minWidth: 260,
    minHeight: 180,
    component: ChartBody,
  },
  {
    type: 'orderbook',
    title: 'Order book',
    about: 'Asks and bids with depth bars. Click a row to fill the ticket.',
    status: 'live',
    prices: true,
    minWidth: 220,
    minHeight: 200,
    component: BookBody,
  },
  {
    type: 'trades',
    title: 'Last trades',
    about: 'The tape of recent trades. Click a price to fill the ticket.',
    status: 'live',
    prices: true,
    minWidth: 200,
    minHeight: 160,
    component: TradesBody,
  },
  {
    type: 'ticket',
    title: 'Order ticket',
    about: 'Buy and sell, with the review step before anything is sent.',
    status: 'live',
    minWidth: 280,
    minHeight: 200,
    component: TicketBody,
  },
  {
    type: 'orders',
    title: 'Orders',
    about: 'Open orders, order history, trade history and assets.',
    status: 'live',
    minWidth: 300,
    minHeight: 120,
    component: OrdersBody,
  },
] as const;

let registered = false;
/** Idempotent: the shell calls this once before it reads the registry. */
export function registerBuiltInPanels(): void {
  if (registered) return;
  registered = true;
  for (const definition of BUILT_IN_PANELS) registerPanel(definition);
}
