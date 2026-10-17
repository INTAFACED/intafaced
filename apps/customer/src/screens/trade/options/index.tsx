import { useMemo, useState } from 'react';
import type { ScreenProps } from '../../../app/screen-types';
import { RoomFrame } from '../rooms/RoomFrame';
import { Freshness, WriteNotice } from '../rooms/RoomNotices';
import { asOfOf } from '../rooms/read';
import { useRoomWriter } from '../rooms/write';
import { Badge, Tabs, TabsList, TabsPanel, TabsTab } from '../rooms/ui';
import { ChainTab } from './ChainTab';
import { OrdersTab } from './OrdersTab';
import { PositionsTab } from './PositionsTab';
import { RulesTab } from './RulesTab';
import { SettlementTab } from './SettlementTab';
import { StrategyTab } from './StrategyTab';
import { Ticket } from './Ticket';
import { useCheckStatus } from './check';
import { optionsCopy } from './copy';
import { useOptionMarkets, useOptionOrders, useOptionsPolicy } from './data';

type TabId = 'chain' | 'strategy' | 'orders' | 'positions' | 'settlement' | 'rules';
const TABS: readonly TabId[] = ['chain', 'strategy', 'orders', 'positions', 'settlement', 'rules'];

export default function Screen(_props: ScreenProps) {
  const { t } = optionsCopy.useCopy();
  const policy = useOptionsPolicy();
  const markets = useOptionMarkets();
  const writer = useRoomWriter();
  const [tab, setTab] = useState<TabId>('chain');
  const [symbol, setSymbol] = useState<string | null>(null);
  const [greeksLinked, setGreeksLinked] = useState<boolean | null>(null);

  const list = markets.status === 'ready' ? markets.data : null;
  const bySymbol = useMemo(() => new Map((list ?? []).map((m) => [m.symbol, m])), [list]);
  const symbols = useMemo(() => new Set(bySymbol.keys()), [bySymbol]);
  const selected = symbol ? (bySymbol.get(symbol) ?? null) : null;
  const orders = useOptionOrders(symbols, tab === 'orders');
  const { check, note } = useCheckStatus(writer, selected?.symbol ?? null);

  const allowed = policy.status === 'ready' ? policy.data.allowed : null;
  const chips = (
    <>
      <Freshness asOf={asOfOf(markets)} refused={markets.status === 'refused'} />
      <Badge variant="outline">
        {allowed ? (allowed.liveOptionsOrders ? t('Live orders allowed') : t('Live orders blocked')) : t('Live orders unknown')}
      </Badge>
      <Badge variant="outline">
        {!allowed || !allowed.paperOptionsOrders
          ? t('Paper orders blocked')
          : list && list.some((m) => m.paper)
            ? t('Paper orders allowed')
            : t('No paper contract listed')}
      </Badge>
      <Badge variant="outline">
        {greeksLinked === null ? t('Greeks not tried') : greeksLinked ? t('Greeks available') : t('Greeks not linked here')}
      </Badge>
    </>
  );

  return (
    <RoomFrame mode="Options" title={t('Options')} description={t('Options description')} meta={chips}>
      <div className="flex flex-col gap-3">
        <WriteNotice writer={writer} onCheck={(id) => void check(id)} done={t('Request done')} />
        {note ? (
          <p role="status" className="m-0 text-sm text-fg-2">
            {note}
          </p>
        ) : null}
        <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
          <Tabs value={tab} onValueChange={(v) => setTab(v as TabId)}>
            <TabsList divider className="overflow-x-auto">
              {TABS.map((id) => (
                <TabsTab key={id} value={id}>
                  {t(`Tab ${id}`)}
                </TabsTab>
              ))}
            </TabsList>
            <TabsPanel value="chain" className="pt-3">
              <ChainTab markets={markets} policy={policy} selected={symbol} onSelect={setSymbol} />
            </TabsPanel>
            <TabsPanel value="strategy" className="pt-3">
              <StrategyTab selected={selected} onGreeksLinked={setGreeksLinked} />
            </TabsPanel>
            <TabsPanel value="orders" className="pt-3">
              <OrdersTab open={orders.open} closed={orders.closed} markets={bySymbol} writer={writer} />
            </TabsPanel>
            <TabsPanel value="positions" className="pt-3">
              <PositionsTab />
            </TabsPanel>
            <TabsPanel value="settlement" className="pt-3">
              <SettlementTab policy={policy} />
            </TabsPanel>
            <TabsPanel value="rules" className="pt-3">
              <RulesTab />
            </TabsPanel>
          </Tabs>
          <Ticket market={selected} policy={policy} writer={writer} />
        </div>
      </div>
    </RoomFrame>
  );
}
