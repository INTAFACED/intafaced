import { useMemo, useState } from 'react';
import { EmptyState, Skeleton, StateBlock, Tabs, TabsList, TabsPanel, TabsTab } from '@intafaced/ui';
import type { Position } from '@intafaced/exchange-contract/schemas';
import type { ScreenProps } from '../../../app/screen-types';
import { navigate } from '../../../app/location';
import { useSession } from '../../../features/session/session';
import { useBalances } from '../desk/data';
import { useNow } from '../desk/hooks';
import { AccessPanel } from './AccessPanel';
import { AdlTab } from './AdlTab';
import { ContractStrip } from './ContractStrip';
import { EmptyDesk } from './EmptyDesk';
import { FundingTab } from './FundingTab';
import { FuturesChart } from './FuturesChart';
import { HistoryTab } from './HistoryTab';
import { MarginCallsTab } from './MarginCallsTab';
import { ModeStrip } from './ModeStrip';
import { OrdersTab } from './OrdersTab';
import { PositionDetail } from './PositionDetail';
import { PositionsTable } from './PositionsTable';
import { RiskSummary, freeOf } from './RiskSummary';
import { Ticket } from './Ticket';
import {
  useAdlDisclosure,
  useAdlEvents,
  useClosedPositions,
  useFundingRate,
  useFuturesMarkets,
  useFuturesOrders,
  useFuturesRefresh,
  useMarginCalls,
  useOpenPositions,
  useTickerStrip,
} from './data';
import { deskCopy } from './desk-copy';
import { isPlaneOff } from './refusals';

type Tab = 'positions' | 'orders' | 'history' | 'funding' | 'adl' | 'calls';

/** Futures desk (TRFUT-SPEC §2): contract strip, chart, ticket with all-in cost, risk, and the positions blotter with its tabs. */
export default function FuturesScreen({ search }: ScreenProps) {
  const { t } = deskCopy.useCopy();
  const { userId } = useSession();
  const now = useNow(5_000);
  const refresh = useFuturesRefresh();
  const markets = useFuturesMarkets();
  const requested = new URLSearchParams(search).get('symbol');
  const list = markets.status === 'ready' ? markets.data : [];
  const market = list.find((m) => m.symbol === requested) ?? list[0] ?? null;
  const symbol = market?.symbol ?? null;

  const [tab, setTab] = useState<Tab>('positions');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const strip = useTickerStrip(symbol);
  const funding = useFundingRate(symbol);
  const positions = useOpenPositions();
  const closed = useClosedPositions(tab === 'history' || tab === 'adl');
  const calls = useMarginCalls(positions.status === 'ready' ? positions.data : [], positions.status === 'ready');
  const balances = useBalances();
  const disclosure = useAdlDisclosure();
  const events = useAdlEvents(tab === 'adl');
  const openOrders = useFuturesOrders('open', tab === 'orders');
  const allOrders = useFuturesOrders('all', tab === 'orders');

  const planeOff = (positions.status === 'refused' && isPlaneOff(positions.code)) || (strip.status === 'refused' && isPlaneOff(strip.code));
  const selected: Position | null = useMemo(
    () => (positions.status === 'ready' ? (positions.data.find((p) => p.id === selectedId) ?? null) : null),
    [positions, selectedId],
  );
  const quote = market?.settle ?? market?.quote ?? 'USDT';

  let top: React.ReactNode;
  let chart: React.ReactNode = null;
  let side: React.ReactNode = null;
  if (markets.status === 'loading') top = <Skeleton className="m-4 h-96 bg-field" />;
  else if (markets.status === 'error')
    top = <StateBlock kind="error" title={t('Markets error title')} onRetry={markets.retry} retryLabel={t('Try again')} />;
  else if (markets.status === 'refused') top = <EmptyState variant="refused" title={t('Markets error title')} reason={markets.code} />;
  else if (!market) top = <EmptyDesk />;
  else {
    top = (
      <ContractStrip
        markets={list}
        market={market}
        strip={strip}
        funding={funding}
        now={now}
        onChoose={(s) => navigate(`/trade/futures?symbol=${encodeURIComponent(s)}`)}
      />
    );
    chart = (
      <>
        <FuturesChart market={market} positions={positions} />
        <RiskSummary asset={quote} positions={positions} balances={balances} calls={calls} now={now} />
      </>
    );
    side = (
      <>
        {userId ? <AccessPanel symbol={market.symbol} onChanged={refresh} /> : null}
        <Ticket
          market={market}
          strip={strip}
          balances={balances}
          disclosure={disclosure}
          planeOff={planeOff}
          now={now}
          onOpened={(order) => {
            refresh();
            // An order that rests (or rests in part) is found under Orders; a filled one opened a position.
            setTab(order && order.status === 'open' ? 'orders' : 'positions');
          }}
        />
      </>
    );
  }

  return (
    <div className="flex min-w-0 flex-col" data-screen="futures">
      <ModeStrip active="Futures" />
      {!userId ? (
        <EmptyState
          variant="refused"
          size="inline"
          title={t('Sign in title')}
          reason={t('Sign in body')}
          action={{ label: t('Sign in'), href: `/login?redirect=${encodeURIComponent('/trade/futures')}` }}
        />
      ) : null}
      {top}
      {market ? (
        <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_360px]">
          <div className="flex min-w-0 flex-col">{chart}</div>
          {side ? <aside className="border-line lg:border-l">{side}</aside> : null}
        </div>
      ) : null}
      <Tabs value={tab} onValueChange={(value) => setTab(value as Tab)} className="border-t border-line">
        <TabsList divider aria-label={t('Desk panels')} className="overflow-x-auto px-4">
          <TabsTab value="positions">{t('Positions')}</TabsTab>
          <TabsTab value="orders">{t('Orders')}</TabsTab>
          <TabsTab value="history">{t('Position history')}</TabsTab>
          <TabsTab value="funding">{t('Funding')}</TabsTab>
          <TabsTab value="adl">{t('ADL and liquidations')}</TabsTab>
          <TabsTab value="calls">{t('Margin calls')}</TabsTab>
        </TabsList>
        <TabsPanel value="positions">
          <PositionsTable
            positions={positions}
            marginCalls={calls}
            freeBalances={balances}
            planeOff={planeOff}
            now={now}
            onOpen={(p) => setSelectedId(p.id)}
            onChanged={refresh}
          />
        </TabsPanel>
        <TabsPanel value="orders">
          <OrdersTab open={openOrders} all={allOrders} onChanged={refresh} />
        </TabsPanel>
        <TabsPanel value="history">
          <HistoryTab closed={closed} />
        </TabsPanel>
        <TabsPanel value="funding">
          <FundingTab symbol={symbol} funding={funding} strip={strip} positions={positions} now={now} />
        </TabsPanel>
        <TabsPanel value="adl">
          <AdlTab disclosure={disclosure} events={events} closed={closed} />
        </TabsPanel>
        <TabsPanel value="calls">
          <MarginCallsTab positions={positions} calls={calls} />
        </TabsPanel>
      </Tabs>
      {selected ? (
        <PositionDetail
          position={selected}
          marginCall={calls.status === 'ready' && selected.id ? calls.data[selected.id] : undefined}
          free={freeOf(balances, selected.symbol.split(':')[1] ?? quote)}
          leverageCap={null}
          planeOff={planeOff}
          onClose={() => setSelectedId(null)}
          onChanged={refresh}
        />
      ) : null}
    </div>
  );
}
