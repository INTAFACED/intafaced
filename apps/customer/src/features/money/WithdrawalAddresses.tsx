import { useState } from 'react';
import { EmptyState, Failure, Loading, Page } from '../../shared/ui';
import { DepthPanel, DisabledAction } from './DepthParts';
import { useHoldings } from './holdings';
import { shortenAddress, type SavedAddress } from './withdraw-model';
import { withdrawalCopy } from './withdrawal-copy';
import './bank-depth.css';

/**
 * The address book as a table. The columns always show; with no rows the body says why it is empty. Each row gives a short
 * form of the address and a Details control that opens the full address, so a long address never breaks the row.
 */
export function AddressTable({ rows }: { rows: readonly SavedAddress[] }) {
  const { t } = withdrawalCopy.useCopy();
  return (
    <>
      <div className="withdrawal-address-scroll">
        <table className="bd-table" data-testid="address-table">
          <thead>
            <tr>
              <th scope="col">{t('aColLabel')}</th>
              <th scope="col">{t('aColAsset')}</th>
              <th scope="col">{t('aColNetwork')}</th>
              <th scope="col">{t('aColAddress')}</th>
              <th scope="col">{t('aColDetails')}</th>
            </tr>
          </thead>
          {rows.length > 0 && (
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td>{row.label}</td>
                  <td lang="und">{row.asset}</td>
                  <td lang="und">{row.network}</td>
                  <td className="numeric" lang="und" data-withdrawal-private>
                    {shortenAddress(row.address)}
                  </td>
                  <td>
                    <details>
                      <summary>{t('aDetails')}</summary>
                      <p>
                        {t('aFullAddress')}:{' '}
                        <span lang="und" data-withdrawal-private className="withdrawal-address-full">
                          {row.address}
                        </span>
                      </p>
                    </details>
                  </td>
                </tr>
              ))}
            </tbody>
          )}
        </table>
      </div>
      {rows.length === 0 && <EmptyState title={t('aEmptyTitle')}>{t('aEmptyBody')}</EmptyState>}
    </>
  );
}

/**
 * `/uc/withdraw/address`: the address book and the form to add to it. No read or save for withdrawal addresses exists in
 * the services yet, so the book is empty and says so, and the save button is off with its reason beside it. Nothing is
 * invented: no sample rows, no networks.
 */
export function WithdrawalAddresses() {
  const { t } = withdrawalCopy.useCopy();
  const held = useHoldings();
  const assets = held.resource.status === 'ready' ? held.resource.data.assets.map((entry) => entry.assetId) : [];
  const [label, setLabel] = useState('');
  const [asset, setAsset] = useState('');
  const [address, setAddress] = useState('');
  return (
    <Page eyebrow={t('aEyebrow')} title={t('aTitle')} description={t('aLead')}>
      <div className="withdrawal-page bd-stack">
        <div className="bd-address" role="status">
          <strong>{t('aUnavailable')}</strong>
          <p>{t('aUnavailableNote')}</p>
        </div>
        <DepthPanel title={t('aTableTitle')}>
          <AddressTable rows={[]} />
        </DepthPanel>
        <DepthPanel title={t('aAddTitle')}>
          <form className="bd-stack" onSubmit={(event) => event.preventDefault()} noValidate>
            <label className="field">
              <span>{t('aLabel')}</span>
              <input
                value={label}
                onChange={(event) => setLabel(event.target.value)}
                autoComplete="off"
                aria-describedby="address-label-hint"
              />
              <small id="address-label-hint">{t('aLabelHint')}</small>
            </label>
            {held.resource.status === 'loading' ? (
              <Loading />
            ) : held.resource.status === 'failed' ? (
              <Failure result={held.resource.failure} retry={held.reload} />
            ) : (
              <label className="field">
                <span>{t('aAsset')}</span>
                <select value={asset} onChange={(event) => setAsset(event.target.value)}>
                  <option value="">{t('aAssetAny')}</option>
                  {assets.map((id) => (
                    <option key={id} value={id}>
                      {id}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className="field">
              <span>{t('aNetwork')}</span>
              <select disabled aria-describedby="address-network-why">
                <option>{t('fNetworkNone')}</option>
              </select>
              <small id="address-network-why">{t('fNetworkWhy')}</small>
            </label>
            <label className="field">
              <span>{t('aAddress')}</span>
              <input
                value={address}
                onChange={(event) => setAddress(event.target.value)}
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                aria-describedby="address-hint"
              />
              <small id="address-hint">{t('fNewHint')}</small>
            </label>
            <DisabledAction variant="primary" label={t('aSave')} reason={t('aSaveReason')} />
          </form>
        </DepthPanel>
        <p>
          <a className="text-link" href="/uc/withdraw">
            {t('aBack')} ↗
          </a>
        </p>
      </div>
    </Page>
  );
}
