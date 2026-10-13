import { useState } from 'react';
import type { Trade } from '@intafaced/exchange-contract/schemas';
import type { BalanceEntry } from '../../../data/derive';
import { useDataEnv } from '../../../data/hooks';
import { useSession } from '../../../features/session/session';
import { isTerminalOrder, type Order, type TradeApi } from '../../../features/trade/trade-api';
import { usePreferences } from '../../../shared/preferences';
import { deskCopy } from './copy';
import { useClosedOrders, useRefreshPrivate } from './data';
import {
  Amount,
  Button,
  fmtAmount,
  fmtPrice,
  isHiddenPath,
  refusalCopy,
  Skeleton,
  StateBlock,
  StatusTag,
  Tabs,
  TabsList,
  TabsPanel,
  TabsTab,
  type Loadable,
} from './deps';
import type { DeskMarket } from './market';
import { dayTime } from './time';
import { placesOf } from './text';

type Tab = 'open' | 'history' | 'trades' | 'assets';

interface Props {
  market: DeskMarket;
  markets: readonly DeskMarket[];
  api: TradeApi;
  openOrders: Loadable<Order[]>;
  fills: Loadable<Trade[]>;
  balances: Loadable<Record<string, BalanceEntry>>;
  /** Controlled so a placed order can send the person to Open orders. */
  tab: Tab;
  onTab: (tab: Tab) => void;
}
export type { Tab as BottomTab };

const byNewest = <T extends { timestamp: number }>(rows: readonly T[]): T[] => [...rows].sort((a, b) => b.timestamp - a.timestamp);

function Side({ side }: { side: 'buy' | 'sell' }) {
  const { t } = deskCopy.useCopy();
  return (
    <span className="dk-side" data-side={side}>
      {side === 'buy' ? t('Side buy') : t('Side sell')}
    </span>
  );
}

function orderStatus(order: Order, t: ReturnType<typeof deskCopy.useCopy>['t']) {
  if (order.status === 'open') {
    const partly = order.filled !== '0' && order.remaining !== '0';
    return <StatusTag status="working" label={partly ? t('Order status partly') : t('Order status open')} />;
  }
  if (order.status === 'closed') return <StatusTag status="filled" label={t('Order status closed')} />;
  if (order.status === 'canceled') return <StatusTag status="cancelled" label={t('Order status canceled')} />;
  if (order.status === 'expired') return <StatusTag status="cancelled" label={t('Order status expired')} />;
  return <StatusTag status="failed" label={t('Order status rejected')} />;
}

function State<T>({
  load,
  thing,
  children,
}: {
  load: Loadable<T>;
  thing: 'orders' | 'trades' | 'assets';
  children: (data: T) => React.ReactNode;
}) {
  const { t } = deskCopy.useCopy();
  const { userId } = useSession();
  if (load.status === 'loading' || load.status === 'empty')
    return (
      <div className="dk-bt-skeleton" role="status" aria-busy="true">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} height={32} className="bg-field" />
        ))}
      </div>
    );
  if (load.status === 'error')
    return (
      <StateBlock
        kind="error"
        title={
          thing === 'orders' ? t('Couldn’t load orders') : thing === 'trades' ? t('Couldn’t load trade history') : t('Couldn’t load assets')
        }
        onRetry={load.retry}
        retryLabel={t('Try again')}
      />
    );
  if (load.status === 'refused') {
    if (!userId)
      return (
        <StateBlock
          kind="empty"
          title={t('Log in to see your orders')}
          action={{ label: t('Log in'), href: `/login?redirect=${encodeURIComponent(`${location.pathname}${location.search}`)}` }}
        />
      );
    const words = refusalCopy(load.code);
    return <StateBlock kind="refused" title={words.title} body={words.body} action={words.action} />;
  }
  return <>{children(load.data)}</>;
}

function CancelButton({ order, api, onDone }: { order: Order; api: TradeApi; onDone: () => void }) {
  const { t } = deskCopy.useCopy();
  const env = useDataEnv();
  const [state, setState] = useState<'idle' | 'busy' | 'done' | 'uncertain' | 'refused'>('idle');
  const asset = order.symbol.split('/')[0] ?? '';
  async function cancel() {
    if (state === 'busy') return;
    setState('busy');
    env.poller.recordExternalRequest();
    // One DELETE per click. Nothing here retries it: on a doubtful answer the person checks Open orders.
    const result = await api.cancel({ id: order.id, symbol: order.symbol });
    if (result.ok) setState('done');
    else if (result.reason === 'uncertain') setState('uncertain');
    else setState('refused');
    onDone();
  }
  if (state === 'done') return <span className="dk-bt-note">{t('Cancel done')}</span>;
  if (state === 'uncertain') return <span className="dk-bt-note dk-bt-note--bad">{t('Cancel uncertain')}</span>;
  return (
    <span className="dk-bt-cancel">
      <Button
        variant="secondary"
        size={28}
        loading={state === 'busy'}
        onClick={() => void cancel()}
        aria-label={t('Cancel order label', {
          side: order.side === 'buy' ? t('Order placed side buy') : t('Order placed side sell'),
          amount: fmtAmount(order.amount, { places: 8 }),
          asset,
        })}
      >
        {state === 'busy' ? t('Cancelling') : t('Cancel order')}
      </Button>
      {state === 'refused' ? <span className="dk-bt-note dk-bt-note--bad">{t('Cancel refused')}</span> : null}
    </span>
  );
}

/** Bottom strip (UI-SPEC 5.7): Open orders, Order history, Trade history and Assets, Pro density (40 px rows). */
export function BottomTabs({ market, markets, api, openOrders, fills, balances, tab, onTab }: Props) {
  const { t } = deskCopy.useCopy();
  const { timeZone } = usePreferences();
  const { userId } = useSession();
  const refresh = useRefreshPrivate();
  const closed = useClosedOrders(tab === 'history');
  const tickOf = (symbol: string) => markets.find((m) => m.symbol === symbol)?.tickSize ?? market.tickSize;
  const lotOf = (symbol: string) => placesOf(markets.find((m) => m.symbol === symbol)?.lotSize ?? market.lotSize);
  const showAll = !isHiddenPath('/money/activity');

  const orderTable = (rows: Order[], withAction: boolean) => (
    <table className="dk-table">
      <thead>
        <tr>
          <th>{t('Time')}</th>
          <th>{t('Pair')}</th>
          <th>{t('Type')}</th>
          <th>{t('Side')}</th>
          <th className="dk-num">{t('Price')}</th>
          <th className="dk-num">{t('Amount')}</th>
          <th className="dk-num">{t('Filled')}</th>
          <th>{withAction ? t('Action') : t('Status')}</th>
        </tr>
      </thead>
      <tbody>
        {byNewest(rows).map((order) => (
          <tr key={order.id}>
            <td className="if-num">{dayTime(order.timestamp, timeZone)}</td>
            <td>{order.symbol}</td>
            <td>{order.type === 'limit' ? t('Order type limit') : order.type === 'market' ? t('Order type market') : order.type}</td>
            <td>
              <Side side={order.side} />
            </td>
            <td className="dk-num if-num">{order.price === null ? t('Market price word') : fmtPrice(order.price, tickOf(order.symbol))}</td>
            <td className="dk-num if-num">{fmtAmount(order.amount, { places: lotOf(order.symbol) })}</td>
            <td className="dk-num if-num">{fmtAmount(order.filled, { places: lotOf(order.symbol) })}</td>
            <td>
              {withAction && !isTerminalOrder(order) ? <CancelButton order={order} api={api} onDone={refresh} /> : orderStatus(order, t)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );

  return (
    <Tabs value={tab} onValueChange={(value) => onTab(value as Tab)} className="dk-panel dk-bottom">
      <div className="dk-bottom-head">
        <TabsList divider className="dk-tabs dk-tabs--grow" aria-label={t('Orders and trades')}>
          <TabsTab value="open">{t('Open orders')}</TabsTab>
          <TabsTab value="history">{t('Order history')}</TabsTab>
          <TabsTab value="trades">{t('Trade history')}</TabsTab>
          <TabsTab value="assets">{t('Assets')}</TabsTab>
        </TabsList>
        {showAll && userId ? (
          <a className="dk-viewall" href="/money/activity">
            {t('View all')}
          </a>
        ) : null}
      </div>
      <TabsPanel value="open" className="dk-bottom-body">
        <State load={openOrders} thing="orders">
          {(rows) => (rows.length === 0 ? <StateBlock kind="empty" title={t('No open orders')} /> : orderTable(rows, true))}
        </State>
      </TabsPanel>
      <TabsPanel value="history" className="dk-bottom-body">
        <State load={closed} thing="orders">
          {(rows) => (rows.length === 0 ? <StateBlock kind="empty" title={t('No order history')} /> : orderTable(rows, false))}
        </State>
      </TabsPanel>
      <TabsPanel value="trades" className="dk-bottom-body">
        <State load={fills} thing="trades">
          {(rows) =>
            rows.length === 0 ? (
              <StateBlock kind="empty" title={t('No trade history')} />
            ) : (
              <table className="dk-table">
                <thead>
                  <tr>
                    <th>{t('Time')}</th>
                    <th>{t('Pair')}</th>
                    <th>{t('Side')}</th>
                    <th className="dk-num">{t('Price')}</th>
                    <th className="dk-num">{t('Amount')}</th>
                    <th className="dk-num">{t('Total')}</th>
                    <th className="dk-num">{t('Fee')}</th>
                  </tr>
                </thead>
                <tbody>
                  {byNewest(rows).map((fill) => (
                    <tr key={fill.id}>
                      <td className="if-num">{dayTime(fill.timestamp, timeZone)}</td>
                      <td>{fill.symbol}</td>
                      <td>
                        <Side side={fill.side} />
                      </td>
                      <td className="dk-num if-num">{fmtPrice(fill.price, tickOf(fill.symbol))}</td>
                      <td className="dk-num if-num">{fmtAmount(fill.amount, { places: lotOf(fill.symbol) })}</td>
                      <td className="dk-num if-num">{fmtAmount(fill.cost, { places: 8 })}</td>
                      <td className="dk-num if-num">
                        {fill.fee ? `${fmtAmount(fill.fee.cost, { places: 8 })} ${fill.fee.currency}` : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          }
        </State>
      </TabsPanel>
      <TabsPanel value="assets" className="dk-bottom-body">
        <State load={balances} thing="assets">
          {(held) => {
            const assets = [market.base, market.quote];
            return (
              <table className="dk-table">
                <thead>
                  <tr>
                    <th>{t('Asset')}</th>
                    <th className="dk-num">{t('Total held')}</th>
                    <th className="dk-num">{t('Available2')}</th>
                    <th className="dk-num">{t('In orders')}</th>
                  </tr>
                </thead>
                <tbody>
                  {assets.map((asset) => {
                    const entry = held[asset];
                    return (
                      <tr key={asset}>
                        <td>{asset}</td>
                        <td className="dk-num if-num">
                          <Amount value={fmtAmount(entry?.total ?? '0', { places: 8 })} />
                        </td>
                        <td className="dk-num if-num">
                          <Amount value={fmtAmount(entry?.free ?? '0', { places: 8 })} />
                        </td>
                        <td className="dk-num if-num">
                          <Amount value={fmtAmount(entry?.used ?? '0', { places: 8 })} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            );
          }}
        </State>
      </TabsPanel>
    </Tabs>
  );
}
