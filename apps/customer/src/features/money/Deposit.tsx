import { AccountDetailsPanel } from './AccountDetails';
import { useMemo, useState } from 'react';
import { DepositPendingPanel, DepositRecordsPanel } from './DepositRecords';
import { DepositAddressPanel, DepositNetworkPicker } from './DepositFunding';
import { useDepositCatalogue } from './deposit-reads';
import { Button, EmptyState, Page } from '../../shared/ui';
import { displayAmount } from '../../shared/money';
import { useActivity } from '../../data/activity';
import { useMarkets } from '../../data/hooks';
import { str } from '../../data/decimal';
import { ReportedTime } from './bank-context';
import { depositAssets, depositHistory, depositTotal } from './deposit-model';
import { depositCopy } from './deposit-copy';
import { DepthPanel } from './DepthParts';
import { useHoldings } from './holdings';
import './bank-depth.css';

/** `/uc/recharge`: the whole deposit room. The address panel names why it is empty instead of replacing the page. */
export function Deposit() {
  const { t, Copy } = depositCopy.useCopy();
  const held = useHoldings();
  const markets = useMarkets();
  const activity = useActivity({ pageSize: 100 });
  const catalogue = useDepositCatalogue();
  const [picked, setPicked] = useState('');
  const [networkId, setNetworkId] = useState('');
  const [onlyAsset, setOnlyAsset] = useState(true);
  const heldIds = held.resource.status === 'ready' ? held.resource.data.assets.map((asset) => asset.assetId) : [];
  const listed = markets.status === 'ready' ? markets.data.map((row) => row.base) : [];
  // Only what custody publishes can be paid in. While the list is unavailable the person still sees the coins they know.
  const published = catalogue.resource.status === 'ready' ? catalogue.resource.data.assets.map((row) => row.assetId) : null;
  const assets = useMemo(() => published ?? depositAssets(heldIds, listed), [published?.join(','), heldIds.join(','), listed.join(',')]);
  const asset = picked || assets[0] || '';
  const items = activity.status === 'ready' ? activity.data.items : [];
  const rows = depositHistory(items, onlyAsset && asset ? asset : null);
  const total = onlyAsset && asset ? depositTotal(rows) : null;
  return (
    <Page eyebrow={t('eyebrow')} title={t('title')} description={t('lead')}>
      <div className="bd-columns">
        <div className="bd-stack">
          <DepthPanel title={t('asset')}>
            <label className="field">
              <span>{t('asset')}</span>
              <select
                value={asset}
                onChange={(event) => {
                  setPicked(event.target.value);
                  setNetworkId('');
                }}
                disabled={assets.length === 0}
              >
                {assets.length === 0 && <option value="">—</option>}
                {assets.map((id) => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))}
              </select>
              <small>{assets.length === 0 ? t('noAssets') : t('assetHint')}</small>
            </label>
            <DepositNetworkPicker
              asset={asset}
              catalogue={catalogue.resource}
              networkId={networkId}
              onNetwork={setNetworkId}
              reload={catalogue.reload}
            />
          </DepthPanel>
          <DepositAddressPanel asset={asset} catalogue={catalogue.resource} networkId={networkId} />
          <AccountDetailsPanel />
          <DepthPanel title={t('warningTitle')}>
            <ul className="bd-list">
              <li>{t('warning1')}</li>
              <li>{t('warning2')}</li>
              <li>{t('warning3')}</li>
            </ul>
          </DepthPanel>
        </div>
        <div className="bd-stack">
          <DepositPendingPanel />
          <DepositRecordsPanel assets={assets} />
          <DepthPanel title={t('historyTitle')} lead={t('historyLead')}>
            {asset && (
              <div className="bd-filter">
                <span className="money-caption">{onlyAsset ? t('historyFilter', { asset }) : t('historyAll')}</span>
                <Button variant="ghost" onClick={() => setOnlyAsset(!onlyAsset)}>
                  {onlyAsset ? t('historyAll') : t('historyFilter', { asset })}
                </Button>
              </div>
            )}
            {activity.status === 'loading' ? (
              <p className="money-caption" role="status">
                …
              </p>
            ) : activity.status === 'error' ? (
              <EmptyState
                title={t('historyLoadFailed')}
                action={
                  <Button variant="secondary" onClick={activity.retry}>
                    {t('historyRetry')}
                  </Button>
                }
              />
            ) : activity.status === 'refused' ? (
              <EmptyState title={t('historyLoadFailed')} />
            ) : rows.length === 0 ? (
              <EmptyState title={onlyAsset && asset ? t('historyEmptyAsset', { asset }) : t('historyEmpty')}>
                {t('historyEmptyBody')}
              </EmptyState>
            ) : (
              <>
                <table className="bd-table">
                  <thead>
                    <tr>
                      <th scope="col">{t('colWhen')}</th>
                      <th scope="col">{t('colWhat')}</th>
                      <th scope="col" className="bd-num">
                        {t('colAmount')}
                      </th>
                      <th scope="col">{t('colStatus')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <tr key={row.id}>
                        <td>
                          <ReportedTime value={row.postedAt} />
                        </td>
                        <td>
                          <a className="text-link" href={`/money/activity/${encodeURIComponent(row.id)}`}>
                            {row.kind === 'welcome_funds' ? t('kindWelcome') : t('kindDeposit')}
                          </a>
                        </td>
                        <td className="bd-num numeric">
                          +{displayAmount(row.amount)} {row.asset}
                        </td>
                        <td>{t('statusDone')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {total && (
                  <p className="money-caption">
                    <Copy k="total" params={{ amount: displayAmount(str(total.amount)), asset: total.asset }} />
                  </p>
                )}
                {activity.status === 'ready' && activity.data.hasMore && (
                  <Button variant="secondary" onClick={activity.data.loadMore} disabled={activity.data.loadingMore}>
                    {t('historyMore')}
                  </Button>
                )}
              </>
            )}
          </DepthPanel>
          <DepthPanel title={t('otherTitle')}>
            <ul className="bd-links">
              <li>
                <a className="text-link" href="/bank/ramps">
                  {t('otherCard')}
                </a>
                <span className="money-caption">{t('otherCardNote')}</span>
              </li>
              <li>
                <a className="text-link" href="/pay/receive">
                  {t('otherReceive')}
                </a>
                <span className="money-caption">{t('otherReceiveNote')}</span>
              </li>
            </ul>
          </DepthPanel>
        </div>
      </div>
    </Page>
  );
}
