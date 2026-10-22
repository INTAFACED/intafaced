import { useId, useState } from 'react';
import { Button } from '../../shared/ui';
import { displayAmount } from '../../shared/money';
import { useSession } from '../session/session';
import { CopyButton } from '../../screens/account/CopyButton';
import { QrCode } from '../../screens/pay/QrCode';
import type { Resource } from '../../shared/resource';
import { depositCopy } from './deposit-copy';
import { DepthPanel, Fact } from './DepthParts';
import './deposit-methods.css';
import { createDepositReads, type DepositAddressView, type DepositCatalogue, type DepositNetworkView } from './deposit-reads';

/** The networks custody published for one asset. Empty when the asset is not published at all. */
export function networksFor(catalogue: DepositCatalogue | null, asset: string): readonly DepositNetworkView[] {
  return catalogue?.assets.find((row) => row.assetId === asset)?.networks ?? [];
}

type Props = {
  asset: string;
  catalogue: Resource<DepositCatalogue>;
  networkId: string;
  onNetwork: (id: string) => void;
  reload: () => void;
};

/** The network chooser. An asset with several networks shows none chosen until the person picks one. */
export function DepositNetworkPicker({ asset, catalogue, networkId, onNetwork, reload }: Props) {
  const { t } = depositCopy.useCopy();
  const why = useId();
  const networks = catalogue.status === 'ready' ? networksFor(catalogue.data, asset) : [];
  const reason =
    catalogue.status === 'loading'
      ? '…'
      : catalogue.status === 'failed'
        ? catalogue.failure.code === 'bank.deposit_custody_unset'
          ? t('networkReason')
          : t('networkLoadFailed')
        : networks.length === 0
          ? asset
            ? t('noNetworksPublished', { asset })
            : t('networkReason')
          : null;
  return (
    <label className="field">
      <span>{t('network')}</span>
      <select value={networkId} onChange={(event) => onNetwork(event.target.value)} disabled={networks.length === 0} aria-describedby={why}>
        {networks.length === 0 ? (
          <option value="">{t('networkNone')}</option>
        ) : (
          <>
            <option value="">{t('networkPick')}</option>
            {networks.map((network) => (
              <option key={network.id} value={network.id}>
                {network.label}
              </option>
            ))}
          </>
        )}
      </select>
      <small id={why}>{reason}</small>
      {catalogue.status === 'failed' && catalogue.failure.code !== 'bank.deposit_custody_unset' && (
        <Button variant="ghost" onClick={reload}>
          {t('networkRetry')}
        </Button>
      )}
    </label>
  );
}

/**
 * The address panel. Nothing is requested until a network is chosen and the loss warning is confirmed, so no address is issued
 * for a pair the person did not pick. The address is the one the bank stores for this person, asset and network.
 */
export function DepositAddressPanel({ asset, catalogue, networkId }: Omit<Props, 'onNetwork' | 'reload'>) {
  const { t } = depositCopy.useCopy();
  const { api } = useSession();
  const network = catalogue.status === 'ready' ? networksFor(catalogue.data, asset).find((row) => row.id === networkId) : undefined;
  return (
    <DepthPanel title={t('addressTitle')}>
      {!network ? (
        catalogue.status === 'failed' && catalogue.failure.code === 'bank.deposit_custody_unset' ? (
          <div className="bd-address" role="status">
            <strong>{t('addressBlockedTitle')}</strong>
            <p>{t('addressBlocked')}</p>
          </div>
        ) : (
          <div className="bd-address" role="status">
            <p>{t('pickFirst')}</p>
          </div>
        )
      ) : (
        <IssuedAddress
          key={`${asset}:${network.id}`}
          asset={asset}
          network={network}
          issue={() => createDepositReads(api).address(asset, network.id)}
        />
      )}
      <dl className="bd-facts">
        <Fact label={t('minimum')}>
          {network ? t('minimumValue', { amount: displayAmount(network.minimumDeposit), asset }) : t('notPublished')}
        </Fact>
        <Fact label={t('confirmations')}>{network ? String(network.confirmationsRequired) : t('notPublished')}</Fact>
        <Fact label={t('arrival')}>{network ? t('arrivalValue', { minutes: network.estimatedArrivalMinutes }) : t('notPublished')}</Fact>
      </dl>
    </DepthPanel>
  );
}

/** What the service published about one network, as written, plus the standard wrong-network line. Empty lists add nothing. */
export function NetworkNotes({ asset, network }: { asset: string; network: DepositNetworkView }) {
  const { t } = depositCopy.useCopy();
  const groups = [
    { key: 'requirements', title: t('notesRequirements'), items: network.requirements ?? [] },
    { key: 'unsupported', title: t('notesUnsupported'), items: network.unsupported ?? [] },
    { key: 'warnings', title: t('notesWarnings'), items: network.warnings ?? [] },
  ].filter((group) => group.items.length > 0);
  return (
    <div className="bd-notes" role="note" data-testid="deposit-notes">
      <p>{t('wrongNetwork', { asset, network: network.label })}</p>
      {groups.map((group) => (
        <section key={group.key} data-notes={group.key}>
          <h4>{group.title}</h4>
          <ul>
            {group.items.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

type Issue = { kind: 'idle' } | { kind: 'loading' } | { kind: 'failed' } | { kind: 'issued'; value: DepositAddressView };

export function IssuedAddress({
  asset,
  network,
  issue,
}: {
  asset: string;
  network: DepositNetworkView;
  issue: () => Promise<{ ok: true; data: DepositAddressView } | { ok: false }>;
}) {
  const { t } = depositCopy.useCopy();
  const [acknowledged, setAcknowledged] = useState(false);
  const [state, setState] = useState<Issue>({ kind: 'idle' });
  async function show() {
    if (state.kind === 'loading') return;
    setState({ kind: 'loading' });
    try {
      const result = await issue();
      setState(result.ok ? { kind: 'issued', value: result.data } : { kind: 'failed' });
    } catch {
      setState({ kind: 'failed' });
    }
  }
  if (state.kind === 'issued') {
    const { address, memo, qrPayload } = state.value;
    return (
      <div className="bd-address" data-testid="deposit-address">
        <p>{t('addressLead', { asset, network: network.label })}</p>
        <p>
          <strong className="numeric" style={{ overflowWrap: 'anywhere' }}>
            {address}
          </strong>
        </p>
        <CopyButton value={address} label={t('copyAddress')} />
        {memo && (
          <div role="note">
            <strong>{t('memoTitle')}</strong>
            <p>{t('memoNote')}</p>
            <p className="numeric">{memo}</p>
            <CopyButton value={memo} label={t('copyMemo')} />
          </div>
        )}
        <QrCode value={qrPayload ?? address} />
      </div>
    );
  }
  const hasNotes = [network.requirements, network.unsupported, network.warnings].some((list) => (list?.length ?? 0) > 0);
  return (
    <div className="bd-address">
      <NetworkNotes asset={asset} network={network} />
      <label className="field">
        <input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} />
        <span>{t(hasNotes ? 'ackLabelNotes' : 'ackLabel', { asset, network: network.label })}</span>
      </label>
      <Button variant="primary" disabled={!acknowledged || state.kind === 'loading'} onClick={() => void show()}>
        {t('showAddress')}
      </Button>
      {state.kind === 'failed' && <p role="alert">{t('addressFailed')}</p>}
    </div>
  );
}
