// volt-room: /uc/assets
import { useId } from 'react';
import { EmptyState } from '@intafaced/ui/lit';
import { RecordListTemplate } from '@intafaced/ui/lit/templates';
import type { Resource } from '../../shared/resource';
import { balanceEntriesHref } from '../../screens/money/balance-entries-model';
import { FailureBox, LoadingLine } from '../../shared/record/record-parts';
import { supportedAssetsCopy } from './supported-assets-copy';
import {
  useSupportedAssets,
  type SupportedAsset,
  type SupportedAssetAction,
  type SupportedAssetState,
  type SupportedAssets as SupportedAssetsData,
} from './supported-assets-reads';

const ACTION_KEY = {
  deposit: 'actionDeposit',
  withdraw: 'actionWithdraw',
  trade: 'actionTrade',
  transfer: 'actionTransfer',
} as const satisfies Record<SupportedAssetAction, string>;
const STATE_KEY = { active: 'stateActive', halted: 'stateHalted', retired: 'stateRetired' } as const satisfies Record<
  SupportedAssetState,
  string
>;

/**
 * The supported asset and network list (W-balances-05, J-wallet-01 #5): svc-ledger's registry as svc-bank hands it on, the
 * rows Deposit and Withdraw read. Every state is listed; a retired asset keeps its row and a link to its history.
 */
export function SupportedAssets() {
  const { resource, reload } = useSupportedAssets();
  return <SupportedAssetsView resource={resource} reload={reload} />;
}

export function SupportedAssetsView({ resource, reload }: { resource: Resource<SupportedAssetsData>; reload: () => void }) {
  const { t } = supportedAssetsCopy.useCopy();
  const heading = useId();
  return (
    <RecordListTemplate
      title={t('title')}
      description={t('lead')}
      state={{ kind: 'ready' }}
      roomAction={
        <div className="lt-actions">
          <a className="lt-button lt-button-secondary" href="/uc/recharge">
            {t('toDeposit')}
          </a>
          <a className="lt-button lt-button-secondary" href="/uc/withdraw">
            {t('toWithdraw')}
          </a>
        </div>
      }
      summary={<p className="lt-hint">{t('eyebrow')}</p>}
      list={
        <section aria-labelledby={heading}>
          <h3 id={heading}>{t('title')}</h3>
          {resource.status === 'loading' ? (
            <LoadingLine />
          ) : resource.status === 'failed' ? (
            <FailureBox result={resource.failure} retry={reload} />
          ) : resource.data.assets.length === 0 ? (
            <EmptyState title={t('emptyTitle')} body={t('emptyBody')} />
          ) : (
            <AssetTable assets={resource.data.assets} />
          )}
        </section>
      }
    />
  );
}

function AssetTable({ assets }: { assets: readonly SupportedAsset[] }) {
  const { t } = supportedAssetsCopy.useCopy();
  return (
    <>
      <p className="lt-hint" data-testid="supported-assets-count">
        {t('count', { count: assets.length, retired: assets.filter((a) => a.state === 'retired').length })}
      </p>
      <table className="lt-table" data-testid="supported-assets">
        <thead>
          <tr>
            <th scope="col">{t('colAsset')}</th>
            <th scope="col">{t('colPrecision')}</th>
            <th scope="col">{t('colNetworks')}</th>
            <th scope="col">{t('colActions')}</th>
            <th scope="col">{t('colState')}</th>
            <th scope="col">{t('colHistory')}</th>
          </tr>
        </thead>
        <tbody>
          {assets.map((asset) => (
            <tr key={asset.assetId} data-asset={asset.assetId} data-state={asset.state}>
              <th scope="row">{asset.assetId}</th>
              <td className="lt-mono" data-col="precision">
                {asset.precision}
              </td>
              <td data-col="networks">
                {asset.networks.length === 0 ? (
                  t('noNetwork')
                ) : (
                  <ul>
                    {asset.networks.map((network) => (
                      <li key={network.networkId} data-network={network.networkId}>
                        {network.networkId === asset.defaultNetworkId ? t('defaultNetwork', { network: network.label }) : network.label}
                      </li>
                    ))}
                  </ul>
                )}
              </td>
              <td data-col="actions">
                {asset.allowedActions.length === 0 || asset.state !== 'active'
                  ? t('noActions')
                  : asset.allowedActions.map((action) => t(ACTION_KEY[action])).join(', ')}
              </td>
              <td data-col="state">
                <strong>{t(STATE_KEY[asset.state])}</strong>
                {asset.state !== 'active' && (
                  <>
                    <br />
                    <span className="lt-hint">{t(asset.state === 'retired' ? 'retiredNote' : 'haltedNote')}</span>
                  </>
                )}
              </td>
              <td data-col="history">
                <a className="lt-link" href={balanceEntriesHref(asset.assetId)}>
                  {t('history', { asset: asset.assetId })}
                </a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
