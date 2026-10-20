import { AccountDetailsPanel } from './AccountDetails';
import { useEffect, useMemo, useRef, useState } from 'react';
import { DepositAddressPanel, DepositNetworkPicker } from './DepositFunding';
import { DepositAssetPicker } from './DepositAssetPicker';
import { DepositMethods } from './DepositMethods';
import { readDepositLink, resolveDepositLink, type DepositLinkResult } from './deposit-link';
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
  // `?asset=&network=` chooses once, when custody's list is known. An unpublished asset or network chooses nothing and says so.
  const [link] = useState(() => readDepositLink(location.search));
  const [refused, setRefused] = useState<Extract<DepositLinkResult, { status: 'refused' }> | null>(null);
  const linked = useRef(false);
  useEffect(() => {
    if (linked.current || catalogue.resource.status !== 'ready') return;
    linked.current = true;
    const result = resolveDepositLink(link, catalogue.resource.data);
    if (result.status === 'ok') {
      setPicked(result.asset);
      setNetworkId(result.network);
    } else if (result.status === 'refused') {
      if (result.code === 'bank.deposit_network_unpublished') setPicked(result.asset);
      setRefused(result);
    }
  }, [catalogue.resource, link]);
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
      <DepositMethods />
      <div className="bd-columns">
        <div className="bd-stack">
          <DepthPanel title={t('asset')}>
            <DepositAssetPicker
              assets={assets}
              asset={asset}
              onAsset={(id) => {
                setPicked(id);
                setNetworkId('');
              }}
            />
            {refused && (
              <p role="alert" data-code={refused.code}>
                {refused.code === 'bank.deposit_asset_unpublished'
                  ? t('linkAssetUnpublished', { asset: refused.asset })
                  : t('linkNetworkUnpublished', { asset: refused.asset, network: refused.network ?? '' })}
              </p>
            )}
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
          <DepthPanel title={t('pendingTitle')}>
            <p className="money-caption">{t('pendingBody')}</p>
          </DepthPanel>
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
        </div>
      </div>
    </Page>
  );
}
