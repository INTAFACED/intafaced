import { useState } from 'react';
import { EmptyState, Failure, Loading, Page } from '../../shared/ui';
import type { Resource } from '../../shared/resource';
import { date, useBankRead } from './components';
import type { Destination } from './contracts';
import { DepthPanel, DisabledAction } from './DepthParts';
import { useHoldings } from './holdings';
import { coolingOf, shortenAddress } from './withdraw-model';
import { withdrawalCopy } from './withdrawal-copy';
import './bank-depth.css';

/**
 * The address book as a table. The columns always show; with no rows the body says why it is empty. Each row gives a short
 * form of the address and a Details control that opens the full address, so a long address never breaks the row. Every
 * cell comes from the bank's saved-destination read: a label (when one was set), the kind, the address, when it was added
 * and the cooling-off the bank returned. The read has no asset or network, so none is shown.
 */
export function AddressTable({ rows, now = Date.now() }: { rows: readonly Destination[]; now?: number }) {
  const { t } = withdrawalCopy.useCopy();
  return (
    <>
      <div className="withdrawal-address-scroll">
        <table className="bd-table" data-testid="address-table">
          <thead>
            <tr>
              <th scope="col">{t('aColLabel')}</th>
              <th scope="col">{t('aColKind')}</th>
              <th scope="col">{t('aColAddress')}</th>
              <th scope="col">{t('aColAdded')}</th>
              <th scope="col">{t('aColCooling')}</th>
              <th scope="col">{t('aColDetails')}</th>
            </tr>
          </thead>
          {rows.length > 0 && (
            <tbody>
              {rows.map((row) => {
                const cooling = coolingOf(row, now);
                return (
                  <tr key={row.destinationId}>
                    <td lang={row.label ? 'und' : undefined}>{row.label ?? t('aNoLabel')}</td>
                    <td>{row.kind === 'bank' ? t('aKindBank') : t('aKindCrypto')}</td>
                    <td className="numeric" lang="und" data-withdrawal-private>
                      {shortenAddress(row.ref)}
                    </td>
                    <td>{date(row.addedAt)}</td>
                    <td>
                      {cooling.state === 'unset'
                        ? t('aCoolingUnset')
                        : t(cooling.state === 'ends' ? 'aCoolingEnds' : 'aCoolingEnded', { time: date(cooling.at) })}
                    </td>
                    <td>
                      <details>
                        <summary>{t('aDetails')}</summary>
                        <p>
                          {t('aFullAddress')}:{' '}
                          <span lang="und" data-withdrawal-private className="withdrawal-address-full">
                            {row.ref}
                          </span>
                        </p>
                      </details>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          )}
        </table>
      </div>
      {rows.length === 0 && <EmptyState title={t('aEmptyTitle')}>{t('aEmptyBody')}</EmptyState>}
    </>
  );
}

/** The saved-destination read in its three states. A refusal goes through the shared refusal copy; no row is invented. */
export function AddressBook({ resource, reload, now }: { resource: Resource<readonly Destination[]>; reload: () => void; now?: number }) {
  if (resource.status === 'loading') return <Loading />;
  if (resource.status === 'failed') return <Failure result={resource.failure} retry={reload} />;
  return <AddressTable rows={resource.data} now={now} />;
}

/**
 * `/uc/withdraw/address`: the address book and the form to add to it. The book is the bank's own saved-destination read
 * (`bank.ramps.destinations.list`). Saving is off with its reason beside it. Nothing is invented: no sample rows, no networks.
 */
export function WithdrawalAddresses() {
  const { t } = withdrawalCopy.useCopy();
  const held = useHoldings();
  const assets = held.resource.status === 'ready' ? held.resource.data.assets.map((entry) => entry.assetId) : [];
  const book = useBankRead('ramps.destinations.list', undefined);
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
          <AddressBook resource={book.resource} reload={book.reload} />
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
