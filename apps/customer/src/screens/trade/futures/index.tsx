import { useMemo, useState } from 'react';
import { StateBlock } from '@intafaced/ui/lit';
import { DeskTemplate, Skeleton, TabPanel, Tabs, type Notice } from '@intafaced/ui/lit/templates';
import type { Position } from '@intafaced/exchange-contract/schemas';
import type { ScreenProps } from '../../../app/screen-types';
import { navigate } from '../../../app/location';
import { useSession } from '../../../features/session/session';
import { useBalances } from '../desk/data';
import { useNow } from '../desk/hooks';
import { AccessPanel } from './AccessPanel';
import { AccountMetrics } from './AccountMetrics';
import { AdlTab } from './AdlTab';
import { CalculatorTab } from './CalculatorTab';
import { CollateralTab } from './CollateralTab';
import { ContractStrip } from './ContractStrip';
import { EmptyDesk } from './EmptyDesk';
import { FundingTab } from './FundingTab';
import { FuturesChart } from './FuturesChart';
import { HistoryTab } from './HistoryTab';
import { MarginCallsTab } from './MarginCallsTab';
import { ModeStrip } from './ModeStrip';
import { OrdersTab } from './OrdersTab';
import { TriggersTable } from './TriggersTable';
import { PositionDetail } from './PositionDetail';
import { ReverseDialog } from './PositionDialogs';
import { PositionsTable } from './PositionsTable';
import { RiskSummary, freeOf } from './RiskSummary';
import { TiersTab } from './TiersTab';
import { Ticket } from './Ticket';
import {
  useAdlDisclosure,
  useAdlEvents,
  useClosedPositions,
  useFundingRate,
  useFuturesMarkets,
  useConditionalOrders,
  useEntryProtections,
  useFuturesOrders,
  useFuturesRefresh,
  useMarginCalls,
  useRefreshRiskStops,
  useRiskStops,
  useOpenPositions,
  useCollateral,
  useRiskTiers,
  useTickerStrip,
} from './data';
import { deskCopy } from './desk-copy';
import { isPlaneOff } from './refusals';
import { useVenueMode } from '../../../features/trade/use-venue-mode';
import { VenueFuturesDesk } from './VenueFuturesDesk';
import { RegionNote } from './notes';

type Tab = 'positions' | 'orders' | 'history' | 'funding' | 'adl' | 'calls' | 'tiers' | 'calculator' | 'collateral';

/**
 * Futures desk. In venue mode (B1: `/api/v1/venue/status` says the user-venue door is on) the desk trades the venue's
 * perpetuals on the customer's own venue account (VenueFuturesDesk.tsx); with the door off it is today's desk unchanged.
 */
export default function FuturesScreen(props: ScreenProps) {
  const venue = useVenueMode();
  // While venue mode is still being read, a neutral skeleton: never today's desk, which could take an order in that window.
  if (venue.mode === 'checking') {
    return (
      <div role="status" aria-busy="true">
        <Skeleton shape="chart" />
      </div>
    );
  }
  if (venue.mode === 'on') return <VenueFuturesDesk mode={venue} symbol={new URLSearchParams(props.search).get('symbol')} />;
  return <TodayFuturesScreen {...props} />;
}

/** Futures desk (TRFUT-SPEC §2): contract strip, chart, ticket with all-in cost, risk, and the positions blotter with its tabs. */
function TodayFuturesScreen({ search }: ScreenProps) {
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
  // Held here, not in the row: a reverse closes the row's position, and its outcome must outlive the row.
  const [reversing, setReversing] = useState<Position | null>(null);
  const strip = useTickerStrip(symbol);
  const funding = useFundingRate(symbol);
  const positions = useOpenPositions();
  const closed = useClosedPositions(tab === 'history' || tab === 'adl');
  const calls = useMarginCalls(positions.status === 'ready' ? positions.data : [], positions.status === 'ready');
  const riskStops = useRiskStops(positions.status === 'ready' ? positions.data : [], positions.status === 'ready' && tab === 'positions');
  const refreshRiskStops = useRefreshRiskStops(positions.status === 'ready' ? positions.data : []);
  const balances = useBalances();
  const disclosure = useAdlDisclosure();
  const events = useAdlEvents(tab === 'adl');
  const openOrders = useFuturesOrders('open', tab === 'orders');
  const allOrders = useFuturesOrders('all', tab === 'orders');
  const triggers = useConditionalOrders(tab === 'orders');
  const entries = useEntryProtections(tab === 'orders');
  const tiers = useRiskTiers(symbol, tab === 'tiers');
  const collateral = useCollateral(tab === 'collateral');

  const planeOff = (positions.status === 'refused' && isPlaneOff(positions.code)) || (strip.status === 'refused' && isPlaneOff(strip.code));
  const selected: Position | null = useMemo(
    () => (positions.status === 'ready' ? (positions.data.find((p) => p.id === selectedId) ?? null) : null),
    [positions, selectedId],
  );
  const quote = market?.settle ?? market?.quote ?? 'USDT';

  let top: React.ReactNode;
  let chart: React.ReactNode = null;
  let side: React.ReactNode = null;
  if (markets.status === 'loading') top = <Skeleton shape="figure" />;
  else if (markets.status === 'error')
    top = <StateBlock kind="error" title={t('Markets error title')} onRetry={markets.retry} retryLabel={t('Try again')} />;
  else if (markets.status === 'refused') top = <RegionNote variant="refused" title={t('Markets error title')} reason={markets.code} />;
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
      <div className="lt-stack">
        <FuturesChart market={market} positions={positions} />
        <RiskSummary asset={quote} positions={positions} balances={balances} calls={calls} now={now} />
        {userId ? <AccountMetrics asset={quote} /> : null}
      </div>
    );
    side = (
      <div className="lt-stack">
        {userId ? <AccessPanel symbol={market.symbol} /> : null}
        <Ticket
          market={market}
          strip={strip}
          balances={balances}
          planeOff={planeOff}
          now={now}
          onOpened={(order) => {
            refresh();
            // An order that rests (or rests in part) is found under Orders; a filled one opened a position.
            setTab(order && order.status === 'open' ? 'orders' : 'positions');
          }}
        />
      </div>
    );
  }

  const panels: { value: Tab; label: string }[] = [
    { value: 'positions', label: t('Positions') },
    { value: 'orders', label: t('Orders') },
    { value: 'history', label: t('Position history') },
    { value: 'funding', label: t('Funding') },
    { value: 'adl', label: t('ADL and liquidations') },
    { value: 'calls', label: t('Margin calls') },
    { value: 'tiers', label: t('Margin tiers') },
    { value: 'calculator', label: t('Calculator') },
    { value: 'collateral', label: t('Collateral') },
  ];
  const notices: Notice[] = userId
    ? []
    : [
        {
          id: 'sign-in',
          refusal: {
            variant: 'refused',
            title: t('Sign in title'),
            body: t('Sign in body'),
            action: { label: t('Sign in'), href: `/login?redirect=${encodeURIComponent('/trade/futures')}` },
          },
        },
      ];

  return (
    <div data-screen="futures">
      <ModeStrip active="Futures" />
      <DeskTemplate
        title={t('Futures desk')}
        mode="pro"
        state={{ kind: 'ready' }}
        notices={notices}
        instrument={top}
        chart={chart}
        ticket={side}
        orders={
          <div className="lt-stack">
            <Tabs id="futures-desk" label={t('Desk panels')} items={panels} value={tab} onChange={(value) => setTab(value as Tab)} />
            <TabPanel id="futures-desk" value="positions" current={tab}>
              <PositionsTable
                positions={positions}
                marginCalls={calls}
                riskStops={riskStops}
                freeBalances={balances}
                planeOff={planeOff}
                now={now}
                onOpen={(p) => setSelectedId(p.id)}
                onChanged={() => {
                  refresh();
                  refreshRiskStops();
                }}
                onReverse={setReversing}
              />
            </TabPanel>
            <TabPanel id="futures-desk" value="orders" current={tab} className="lt-stack">
              <OrdersTab open={openOrders} all={allOrders} onChanged={refresh} />
              <TriggersTable triggers={triggers} entries={entries} positions={positions} onChanged={refresh} />
            </TabPanel>
            <TabPanel id="futures-desk" value="history" current={tab}>
              <HistoryTab closed={closed} />
            </TabPanel>
            <TabPanel id="futures-desk" value="funding" current={tab}>
              <FundingTab symbol={symbol} funding={funding} strip={strip} positions={positions} now={now} />
            </TabPanel>
            <TabPanel id="futures-desk" value="adl" current={tab}>
              <AdlTab disclosure={disclosure} events={events} closed={closed} />
            </TabPanel>
            <TabPanel id="futures-desk" value="calls" current={tab}>
              <MarginCallsTab positions={positions} calls={calls} />
            </TabPanel>
            <TabPanel id="futures-desk" value="tiers" current={tab}>
              <TiersTab tiers={tiers} quote={quote} />
            </TabPanel>
            <TabPanel id="futures-desk" value="collateral" current={tab}>
              <CollateralTab collateral={collateral} />
            </TabPanel>
            <TabPanel id="futures-desk" value="calculator" current={tab}>
              {/* Keyed by contract: a figure on screen always belongs to the contract and the numbers above it. */}
              <CalculatorTab key={market?.symbol ?? 'none'} market={market} />
            </TabPanel>
          </div>
        }
      />
      {selected ? (
        <PositionDetail
          position={selected}
          marginCall={calls.status === 'ready' && selected.id ? calls.data[selected.id] : undefined}
          free={freeOf(balances, selected.symbol.split(':')[1] ?? quote)}
          leverageCap={null}
          planeOff={planeOff}
          onClose={() => setSelectedId(null)}
          onChanged={refresh}
          onReverse={(p) => {
            setSelectedId(null);
            setReversing(p);
          }}
        />
      ) : null}
      {reversing ? <ReverseDialog position={reversing} onClose={() => setReversing(null)} /> : null}
    </div>
  );
}
