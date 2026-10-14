import { useState } from 'react';
import { StatusTag, Tabs, TabsList, TabsPanel, TabsTab } from '@intafaced/ui';
import { PreviewActionButton, PreviewChip } from '../../../preview';
import type { FuturesRows, PerpContract, PerpId } from '../../../preview/fixtures/futures';
import { futuresCopy } from './copy';
import { d, liquidationPrice, positionValue, returnOnMargin, unrealisedPnl } from './math';
import { pct, price, priceCell, signedUsd, size, tone, usd, when } from './show';
import { ratio } from '../../../data/decimal';

type TabId = 'positions' | 'orders' | 'history' | 'funding';

export function Positions({ rows, onPick }: { rows: FuturesRows; onPick: (id: PerpId) => void }) {
  const { t } = futuresCopy.useCopy();
  const [tab, setTab] = useState<TabId>('positions');
  const byId = new Map<PerpId, PerpContract>(rows.contracts.map((c) => [c.id, c]));
  const wallet = d(rows.available);
  const sideWord = (side: 'long' | 'short') => t(side === 'long' ? 'Long' : 'Short');

  return (
    <section className="fx-panel fx-positions" aria-labelledby="fx-pos-title">
      <header className="fx-panel__head">
        <h2 className="fx-panel__title" id="fx-pos-title">
          {t('Positions')} <PreviewChip />
        </h2>
        <span className="fx-sample">{t('Sample rows')}</span>
      </header>
      <Tabs value={tab} onValueChange={(next) => setTab(next as TabId)}>
        <div className="fx-tabbar">
          <TabsList divider aria-label={t('Positions tabs')}>
            <TabsTab value="positions">{t('Positions tab', { count: rows.positions.length })}</TabsTab>
            <TabsTab value="orders">{t('Open orders tab', { count: rows.openOrders.length })}</TabsTab>
            <TabsTab value="history">{t('Order history')}</TabsTab>
            <TabsTab value="funding">{t('Funding history')}</TabsTab>
          </TabsList>
          {tab === 'positions' ? (
            <PreviewActionButton product="futures" variant="secondary" size={28}>
              {t('Close all')}
            </PreviewActionButton>
          ) : null}
        </div>

        <TabsPanel value="positions">
          <div className="fx-scroll">
            <table className="fx-table" data-testid="fx-positions">
              <caption className="fx-sr">{t('Positions caption')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('Contract')}</th>
                  <th scope="col">{t('Size col')}</th>
                  <th scope="col">{t('Entry price')}</th>
                  <th scope="col">{t('Mark price')}</th>
                  <th scope="col">{t('Liquidation price (estimate)')}</th>
                  <th scope="col">{t('Margin')}</th>
                  <th scope="col">{t('Unrealised profit or loss')}</th>
                  <th scope="col">{t('Take profit / stop loss')}</th>
                  <th scope="col">
                    <span className="fx-sr">{t('Actions')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.positions.map((position) => {
                  const contract = byId.get(position.contract)!;
                  const amount = d(position.size);
                  const entry = d(position.entry);
                  const mark = d(contract.mark);
                  const margin = d(position.margin);
                  const pnl = unrealisedPnl(position.side, amount, entry, mark);
                  const roe = returnOnMargin(pnl, margin);
                  const liq = liquidationPrice({
                    side: position.side,
                    size: amount,
                    entry,
                    margin,
                    maintenanceMargin: d(contract.maintenanceMargin),
                    extra: position.mode === 'cross' ? wallet : 0n,
                  });
                  const away = liq === null || mark === 0n ? null : ratio(liq - mark, mark);
                  return (
                    <tr key={position.id}>
                      <th scope="row">
                        <button type="button" className="fx-link" onClick={() => onPick(position.contract)}>
                          {position.contract}
                        </button>
                        <span className="fx-sub">
                          <span className={position.side === 'long' ? 'fx-up' : 'fx-down'}>{sideWord(position.side)}</span>
                          {` · ${position.leverage}x · ${t(position.mode === 'isolated' ? 'Isolated' : 'Cross')}`}
                        </span>
                      </th>
                      <td>
                        {size(amount, contract.lot)} {contract.base}
                        <span className="fx-sub">{usd(positionValue(amount, mark))}</span>
                      </td>
                      <td>{priceCell(entry, contract.tick)}</td>
                      <td>{priceCell(mark, contract.tick)}</td>
                      <td>
                        {liq === null ? t('None') : priceCell(liq, contract.tick)}
                        {away === null ? null : <span className="fx-sub">{t('Away from mark', { away: pct(away, 1) })}</span>}
                      </td>
                      <td>{usd(margin)}</td>
                      <td className={`fx-${tone(pnl)}`}>
                        {signedUsd(pnl)}
                        {roe === null ? null : <span className="fx-sub">{pct(roe, 1)}</span>}
                      </td>
                      <td>
                        {position.takeProfit ? priceCell(position.takeProfit, contract.tick) : t('None')} /{' '}
                        {position.stopLoss ? priceCell(position.stopLoss, contract.tick) : t('None')}
                      </td>
                      <td className="fx-row-actions">
                        <PreviewActionButton
                          product="futures"
                          variant="secondary"
                          size={28}
                          aria-label={t('Close at market', { contract: position.contract })}
                        >
                          {t('Market')}
                        </PreviewActionButton>
                        <PreviewActionButton
                          product="futures"
                          variant="ghost"
                          size={28}
                          aria-label={t('Close at limit', { contract: position.contract })}
                        >
                          {t('Limit')}
                        </PreviewActionButton>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </TabsPanel>

        <TabsPanel value="orders">
          <div className="fx-scroll">
            <table className="fx-table">
              <caption className="fx-sr">{t('Open orders caption')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('Contract')}</th>
                  <th scope="col">{t('Type')}</th>
                  <th scope="col">{t('Price')}</th>
                  <th scope="col">{t('Size col')}</th>
                  <th scope="col">{t('Placed')}</th>
                  <th scope="col">
                    <span className="fx-sr">{t('Actions')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.openOrders.map((order) => {
                  const contract = byId.get(order.contract)!;
                  return (
                    <tr key={order.id}>
                      <th scope="row">
                        {order.contract}
                        <span className="fx-sub">
                          <span className={order.side === 'long' ? 'fx-up' : 'fx-down'}>{sideWord(order.side)}</span>
                          {order.reduceOnly ? ` · ${t('Reduce only')}` : ''}
                        </span>
                      </th>
                      <td>{order.kind === 'Limit' ? t('Limit') : t('Stop-limit')}</td>
                      <td>{price(order.price, contract.tick)}</td>
                      <td>
                        {size(order.size, contract.lot)} {contract.base}
                      </td>
                      <td>{when(order.placedAt)}</td>
                      <td className="fx-row-actions">
                        <PreviewActionButton
                          product="futures"
                          variant="secondary"
                          size={28}
                          aria-label={t('Cancel order', { contract: order.contract })}
                        >
                          {t('Cancel')}
                        </PreviewActionButton>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </TabsPanel>

        <TabsPanel value="history">
          <div className="fx-scroll">
            <table className="fx-table">
              <caption className="fx-sr">{t('Order history caption')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('Contract')}</th>
                  <th scope="col">{t('Price')}</th>
                  <th scope="col">{t('Size col')}</th>
                  <th scope="col">{t('Status')}</th>
                  <th scope="col">{t('Time')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.orderHistory.map((order) => {
                  const contract = byId.get(order.contract)!;
                  return (
                    <tr key={order.id}>
                      <th scope="row">
                        {order.contract}
                        <span className="fx-sub">
                          <span className={order.side === 'long' ? 'fx-up' : 'fx-down'}>{sideWord(order.side)}</span>
                        </span>
                      </th>
                      <td>{price(order.price, contract.tick)}</td>
                      <td>
                        {size(order.size, contract.lot)} {contract.base}
                      </td>
                      <td>
                        <StatusTag status={order.status} label={t(order.status === 'filled' ? 'Filled' : 'Cancelled')} />
                      </td>
                      <td>{when(order.closedAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </TabsPanel>

        <TabsPanel value="funding">
          <div className="fx-scroll">
            <table className="fx-table">
              <caption className="fx-sr">{t('Funding caption')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('Contract')}</th>
                  <th scope="col">{t('Funding rate')}</th>
                  <th scope="col">{t('Paid or received')}</th>
                  <th scope="col">{t('Time')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.fundingHistory.map((payment) => {
                  const amount = d(payment.amount);
                  return (
                    <tr key={payment.id}>
                      <th scope="row">{payment.contract}</th>
                      <td>{pct(payment.rate, 4)}</td>
                      <td className={`fx-${tone(amount)}`}>{signedUsd(amount)}</td>
                      <td>{when(payment.paidAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </TabsPanel>
      </Tabs>
    </section>
  );
}
