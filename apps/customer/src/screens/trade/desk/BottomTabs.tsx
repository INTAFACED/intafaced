import { memo } from 'react';
import type { Trade } from '@intafaced/exchange-contract/schemas';
import type { BalanceEntry } from '../../../data/derive';
import { useSession } from '../../../features/session/session';
import { type Order } from '../../../features/trade/trade-api';
import { deskCopy } from './copy';
import { useClosedOrders, useRefreshPrivate } from './data';
import { Amount, fmtAmount, isHiddenPath, StateBlock, Tabs, TabsList, TabsPanel, TabsTab, type Loadable } from './deps';
import type { DeskMarket } from './market';
import { FillsTable, LoadState, OrdersTable, precisionOf } from './OrderTables';
import { CancelAll } from './ticket/CancelAll';

type Tab = 'open' | 'history' | 'trades' | 'assets';

interface Props {
  market: DeskMarket;
  markets: readonly DeskMarket[];
  openOrders: Loadable<Order[]>;
  fills: Loadable<Trade[]>;
  balances: Loadable<Record<string, BalanceEntry>>;
  /** Controlled so a placed order can send the person to Open orders. */
  tab: Tab;
  onTab: (tab: Tab) => void;
}
export type { Tab as BottomTab };

/** Bottom strip (UI-SPEC 5.7): Open orders, Order history, Trade history and Assets, Pro density (40 px rows). */
export const BottomTabs = memo(function BottomTabs({ market, markets, openOrders, fills, balances, tab, onTab }: Props) {
  const { t } = deskCopy.useCopy();
  const { userId } = useSession();
  const refresh = useRefreshPrivate();
  const closed = useClosedOrders(tab === 'history');
  const precision = precisionOf(markets, market);
  const showAll = !isHiddenPath('/money/activity');

  const orderTable = (rows: Order[], withAction: boolean) => (
    <OrdersTable rows={rows} withAction={withAction} precision={precision} onChanged={refresh} />
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
          <a className="dk-viewall" href={tab === 'trades' ? '/money/activity?tab=trades' : '/money/activity?tab=orders'}>
            {t('View all')}
          </a>
        ) : null}
      </div>
      <TabsPanel value="open" className="dk-bottom-body">
        <LoadState load={openOrders} thing="orders">
          {(rows) => (
            <>
              <CancelAll rows={rows} market={market} onDone={refresh} />
              {rows.length === 0 ? <StateBlock kind="empty" title={t('No open orders')} /> : orderTable(rows, true)}
            </>
          )}
        </LoadState>
      </TabsPanel>
      <TabsPanel value="history" className="dk-bottom-body">
        <LoadState load={closed} thing="orders">
          {(rows) => (rows.length === 0 ? <StateBlock kind="empty" title={t('No order history')} /> : orderTable(rows, false))}
        </LoadState>
      </TabsPanel>
      <TabsPanel value="trades" className="dk-bottom-body">
        <LoadState load={fills} thing="trades">
          {(rows) =>
            rows.length === 0 ? <StateBlock kind="empty" title={t('No trade history')} /> : <FillsTable rows={rows} precision={precision} />
          }
        </LoadState>
      </TabsPanel>
      <TabsPanel value="assets" className="dk-bottom-body">
        <LoadState load={balances} thing="assets">
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
        </LoadState>
      </TabsPanel>
    </Tabs>
  );
});
