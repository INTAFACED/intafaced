import { useMemo, useState } from 'react';
import { Tag, TabSet } from '@intafaced/ui/lit';
import { DeskTemplate } from '@intafaced/ui/lit/templates';
import type { ScreenProps } from '../../../app/screen-types';
import { asOfOf } from '../rooms/read';
import { useRoomWriter } from '../rooms/write';
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
import { Freshness, TradeRoomsNav, WriteNotice } from './notices';

type TabId = 'chain' | 'strategy' | 'orders' | 'positions' | 'settlement' | 'rules';

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
    <div className="lt-toolbar">
      <Freshness asOf={asOfOf(markets)} refused={markets.status === 'refused'} />
      <Tag tone="neutral">
        {allowed ? (allowed.liveOptionsOrders ? t('Live orders allowed') : t('Live orders blocked')) : t('Live orders unknown')}
      </Tag>
      <Tag tone="neutral">
        {!allowed || !allowed.paperOptionsOrders
          ? t('Paper orders blocked')
          : list && list.some((m) => m.paper)
            ? t('Paper orders allowed')
            : t('No paper contract listed')}
      </Tag>
      <Tag tone="neutral">
        {greeksLinked === null ? t('Greeks not tried') : greeksLinked ? t('Greeks available') : t('Greeks not linked here')}
      </Tag>
    </div>
  );

  return (
    <DeskTemplate
      title={t('Options')}
      description={t('Options description')}
      mode="pro"
      state={{ kind: 'ready' }}
      instrument={
        <div className="lt-stack">
          <TradeRoomsNav active="options" />
          {chips}
          <WriteNotice writer={writer} onCheck={(id) => void check(id)} done={t('Request done')} />
          {note ? (
            <p role="status" className="lt-hint">
              {note}
            </p>
          ) : null}
        </div>
      }
      chart={
        <TabSet
          label={t('Options')}
          value={tab}
          onChange={setTab}
          tabs={[
            {
              value: 'chain',
              label: t('Tab chain'),
              panel: <ChainTab markets={markets} policy={policy} selected={symbol} onSelect={setSymbol} />,
            },
            { value: 'strategy', label: t('Tab strategy'), panel: <StrategyTab selected={selected} onGreeksLinked={setGreeksLinked} /> },
            {
              value: 'orders',
              label: t('Tab orders'),
              panel: <OrdersTab open={orders.open} closed={orders.closed} markets={bySymbol} writer={writer} />,
            },
            { value: 'positions', label: t('Tab positions'), panel: <PositionsTab /> },
            { value: 'settlement', label: t('Tab settlement'), panel: <SettlementTab policy={policy} /> },
            { value: 'rules', label: t('Tab rules'), panel: <RulesTab /> },
          ]}
        />
      }
      ticket={<Ticket market={selected} policy={policy} writer={writer} />}
    />
  );
}
