import { EmptyState, Failure, Loading, Page } from '../../shared/ui';
import type { Resource } from '../../shared/resource';
import { balanceEntriesHref } from '../../screens/money/balance-entries-model';
import { DepthPanel } from './DepthParts';
import { supportedAssetsCopy } from './supported-assets-copy';
import {
  useSupportedAssets,
  type SupportedAsset,
  type SupportedAssetAction,
  type SupportedAssetState,
  type SupportedAssets as SupportedAssetsData,
} from './supported-assets-reads';
import './bank-depth.css';

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
  return (
    <Page
      eyebrow={t('eyebrow')}
      title={t('title')}
      description={t('lead')}
      actions={
        <>
          <a className="button button--secondary" href="/uc/recharge">
            {t('toDeposit')}
          </a>
          <a className="button button--secondary" href="/uc/withdraw">
            {t('toWithdraw')}
          </a>
        </>
      }
    >
      <DepthPanel title={t('title')}>
        {resource.status === 'loading' ? (
          <Loading />
        ) : resource.status === 'failed' ? (
          <Failure result={resource.failure} retry={reload} />
        ) : resource.data.assets.length === 0 ? (
          <EmptyState title={t('emptyTitle')}>{t('emptyBody')}</EmptyState>
        ) : (
          <AssetTable assets={resource.data.assets} />
        )}
      </DepthPanel>
    </Page>
  );
}

function AssetTable({ assets }: { assets: readonly SupportedAsset[] }) {
  const { t } = supportedAssetsCopy.useCopy();
  return (
    <>
      <p className="money-caption" data-testid="supported-assets-count">
        {t('count', { count: assets.length, retired: assets.filter((a) => a.state === 'retired').length })}
      </p>
      <table className="bd-table" data-testid="supported-assets">
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
              <td className="numeric" data-col="precision">
                {asset.precision}
              </td>
              <td data-col="networks">
                {asset.networks.length === 0 ? (
                  t('noNetwork')
                ) : (
                  <ul className="bd-list">
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
                    <span className="money-caption">{t(asset.state === 'retired' ? 'retiredNote' : 'haltedNote')}</span>
                  </>
                )}
              </td>
              <td data-col="history">
                <a className="text-link" href={balanceEntriesHref(asset.assetId)}>
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
