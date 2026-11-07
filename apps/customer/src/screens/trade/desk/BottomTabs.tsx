import { memo, useCallback, useState } from 'react';
import type { Trade } from '@intafaced/exchange-contract/schemas';
import type { BalanceEntry } from '../../../data/derive';
import { useSession } from '../../../features/session/session';
import { type Order } from '../../../features/trade/trade-api';
import { deskCopy } from './copy';
import { useClosedOrders, useRefreshPrivate } from './data';
import { HistoryFilters } from './HistoryFilters';
import { filterHistory, NO_HISTORY_FILTER, type HistoryFilter } from './history-filter';
import { Amount, fmtAmount, isHiddenPath, StateBlock, Tabs, TabsList, TabsPanel, TabsTab, type Loadable } from './deps';
import { floorToLot } from './order-math';
import type { DeskMarket } from './market';
import { CancelAll } from './CancelAll';
import { CancelMany } from './CancelMany';
import { DeadMan } from './DeadMan';
import { LedgerTab } from './LedgerTab';
import { EditOrder } from './EditOrder';
import { StopEdit } from './StopEdit';
import { FillsTable, LoadState, OrdersTable, precisionOf } from './OrderTables';

type Tab = 'open' | 'history' | 'trades' | 'assets' | 'ledger' | 'positions';

interface Props {
  market: DeskMarket;
  markets: readonly DeskMarket[];
  openOrders: Loadable<Order[]>;
  fills: Loadable<Trade[]>;
  balances: Loadable<Record<string, BalanceEntry>>;
  /** Controlled so a placed order can send the person to Open orders. */
  tab: Tab;
  onTab: (tab: Tab) => void;
  /** Flatten a held coin: hand the order form a market sell of everything free in it, to review. */
  onFlatten: (amount: string) => void;
  /** The current pair's last trade price, from the ticker; null while not known. */
  lastPrice: string | null;
}
export type { Tab as BottomTab };

/** Bottom strip (UI-SPEC 5.7): Open orders, Order history, Trade history, Assets, Ledger (signed in) and Positions (not applicable on cash spot), Pro density (40 px rows). */
export const BottomTabs = memo(function BottomTabs({
  market,
  markets,
  openOrders,
  fills,
  balances,
  tab,
  onTab,
  onFlatten,
  lastPrice,
}: Props) {
  const { t } = deskCopy.useCopy();
  const { userId } = useSession();
  const refresh = useRefreshPrivate();
  const closed = useClosedOrders(tab === 'history');
  const [historyFilter, setHistoryFilter] = useState<HistoryFilter>(NO_HISTORY_FILTER);
  const precision = precisionOf(markets, market);
  const lastPriceOf = useCallback((symbol: string) => (symbol === market.symbol ? lastPrice : null), [market.symbol, lastPrice]);
  const showAll = !isHiddenPath('/money/activity');
  // The edit dialog is hosted here, above the lists: a replacement removes the old row (and may empty the list), and the
  // answer must stay on screen either way.
  const [editing, setEditing] = useState<Order | null>(null);
  const editingMarket = editing ? precision.marketOf(editing.symbol) : undefined;
  // Orders ticked for a batch cancel. An id no longer in Open orders is never sent.
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set());
  const listed = openOrders.status === 'ready' ? new Set(openOrders.data.map((order) => order.id)) : null;
  const selected = listed ? new Set([...ticked].filter((id) => listed.has(id))) : ticked;
  const onSelect = (id: string, on: boolean) =>
    setTicked((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const orderTable = (rows: Order[], withAction: boolean) => (
    <OrdersTable
      rows={rows}
      withAction={withAction}
      precision={precision}
      onChanged={refresh}
      desk
      onEdit={setEditing}
      lastPriceOf={lastPriceOf}
      {...(withAction ? { selected, onSelect } : {})}
    />
  );

  return (
    <Tabs value={tab} onValueChange={(value) => onTab(value as Tab)} className="dk-panel dk-bottom">
      <div data-testid="dk-bottom-head" className="dk-bottom-head">
        <TabsList divider className="dk-tabs dk-tabs--grow" aria-label={t('Orders and trades')}>
          <TabsTab value="open">{t('Open orders')}</TabsTab>
          <TabsTab value="history">{t('Order history')}</TabsTab>
          <TabsTab value="trades">{t('Trade history')}</TabsTab>
          <TabsTab value="assets">{t('Assets')}</TabsTab>
          {userId ? <TabsTab value="ledger">{t('Ledger tab')}</TabsTab> : null}
          <TabsTab value="positions">{t('Positions')}</TabsTab>
        </TabsList>
        {tab === 'open' && openOrders.status === 'ready' ? (
          <>
            <CancelAll symbol={market.symbol} orders={openOrders.data} onDone={refresh} />
            <CancelMany
              orders={openOrders.data}
              selected={selected}
              onDone={() => {
                setTicked(new Set());
                refresh();
              }}
            />
          </>
        ) : null}
        {userId ? <DeadMan onChanged={refresh} /> : null}
        {showAll && userId ? (
          <a className="dk-viewall" href={tab === 'trades' ? '/money/activity?tab=trades' : '/money/activity?tab=orders'}>
            {t('View all')}
          </a>
        ) : null}
      </div>
      <TabsPanel value="open" data-testid="dk-bottom-body" className="dk-bottom-body">
        <LoadState load={openOrders} thing="orders">
          {(rows) => (rows.length === 0 ? <StateBlock kind="empty" title={t('No open orders')} /> : orderTable(rows, true))}
        </LoadState>
      </TabsPanel>
      <TabsPanel value="history" data-testid="dk-bottom-body" className="dk-bottom-body">
        <LoadState load={closed} thing="orders">
          {(rows) => {
            if (rows.length === 0) return <StateBlock kind="empty" title={t('No order history')} />;
            const shown = filterHistory(rows, historyFilter);
            return (
              <>
                <HistoryFilters filter={historyFilter} onFilter={setHistoryFilter} />
                {shown.length === 0 ? <StateBlock kind="empty" title={t('History filter none match')} /> : orderTable(shown, false)}
              </>
            );
          }}
        </LoadState>
      </TabsPanel>
      <TabsPanel value="trades" data-testid="dk-bottom-body" className="dk-bottom-body">
        <LoadState load={fills} thing="trades">
          {(rows) =>
            rows.length === 0 ? <StateBlock kind="empty" title={t('No trade history')} /> : <FillsTable rows={rows} precision={precision} />
          }
        </LoadState>
      </TabsPanel>
      <TabsPanel value="assets" data-testid="dk-bottom-body" className="dk-bottom-body">
        <LoadState load={balances} thing="assets">
          {(held) => {
            const assets = [market.base, market.quote];
            return (
              <table data-testid="dk-table" className="dk-table">
                <thead>
                  <tr>
                    <th>{t('Asset')}</th>
                    <th className="dk-num">{t('Total held')}</th>
                    <th className="dk-num">{t('Available2')}</th>
                    <th className="dk-num">{t('In orders')}</th>
                    <th>{t('Action')}</th>
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
                        <td>
                          {asset === market.base && userId && market.open && floorToLot(entry?.free ?? '0', market.lotSize) !== null ? (
                            <button
                              type="button"
                              className="dk-cancel-all"
                              onClick={() => onFlatten(entry?.free ?? '0')}
                              aria-label={t('Flatten label', {
                                asset,
                                amount: fmtAmount(entry?.free ?? '0', { places: 8 }),
                                pair: market.symbol,
                              })}
                            >
                              {t('Flatten')}
                            </button>
                          ) : null}
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
      {userId ? (
        <TabsPanel value="ledger" data-testid="dk-bottom-body" className="dk-bottom-body">
          {tab === 'ledger' ? <LedgerTab balances={balances} /> : null}
        </TabsPanel>
      ) : null}
      <TabsPanel value="positions" data-testid="dk-bottom-body" className="dk-bottom-body">
        <StateBlock kind="empty" title={t('Positions not applicable')} body={t('Positions not applicable note')} />
      </TabsPanel>
      {editing && editingMarket ? (
        editing.type === 'stop_limit' || editing.type === 'stop' ? (
          <StopEdit order={editing} market={editingMarket} onDone={refresh} onClose={() => setEditing(null)} />
        ) : (
          <EditOrder order={editing} market={editingMarket} onDone={refresh} onClose={() => setEditing(null)} />
        )
      ) : null}
    </Tabs>
  );
});
