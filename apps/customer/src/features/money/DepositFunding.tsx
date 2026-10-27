import { useId, useState, type ReactNode } from 'react';
import { Button } from '../../shared/ui';
import { classifyRefusal } from '../../data/refusal-codes';
import { refusalCopy } from '../../data/refusals';
import { displayAmount } from '../../shared/money';
import { useSession } from '../session/session';
import { CopyButton } from '../../screens/account/CopyButton';
import { QrCode } from '../../screens/pay/QrCode';
import type { Resource } from '../../shared/resource';
import { depositCopy } from './deposit-copy';
import { DepthPanel, Fact } from './DepthParts';
import { DepositAddresses } from './DepositAddresses';
import { FundingNoticesBanner } from './FundingNotices';
import './deposit-methods.css';
import {
  createDepositReads,
  type DepositAddressView,
  type DepositCatalogue,
  type DepositHaltedView,
  type DepositNetworkView,
} from './deposit-reads';

/** The networks custody published for one asset. Empty when the asset is not published at all. */
export function networksFor(catalogue: DepositCatalogue | null, asset: string): readonly DepositNetworkView[] {
  return catalogue?.assets.find((row) => row.assetId === asset)?.networks ?? [];
}

/** The networks of one asset the owner switched off. */
export function haltedFor(catalogue: DepositCatalogue | null, asset: string): readonly DepositHaltedView[] {
  return catalogue?.halted?.filter((row) => row.assetId === asset) ?? [];
}

/** The bank refuses its reads to a person who has not finished verification (any code the app reads as "verify first"). */
const needsVerification = (catalogue: Resource<DepositCatalogue>) =>
  catalogue.status === 'failed' && classifyRefusal(catalogue.failure.code) === 'verify';

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
  const halted = catalogue.status === 'ready' ? haltedFor(catalogue.data, asset) : [];
  const reason =
    catalogue.status === 'loading'
      ? '…'
      : catalogue.status === 'failed'
        ? catalogue.failure.code === 'bank.deposit_custody_unset'
          ? t('networkReason')
          : catalogue.failure.code === 'bank.asset_registry_unavailable'
            ? t('registryUnavailable')
            : needsVerification(catalogue)
              ? t('networkVerify')
              : t('networkLoadFailed')
        : networks.length === 0
          ? halted.length > 0
            ? t('allNetworksOff', { asset })
            : asset
              ? t('noNetworksPublished', { asset })
              : t('networkReason')
          : null;
  const choices = networks.length + halted.length;
  return (
    <label className="field">
      <span>{t('network')}</span>
      <select value={networkId} onChange={(event) => onNetwork(event.target.value)} disabled={choices === 0} aria-describedby={why}>
        {choices === 0 ? (
          <option value="">{t('networkNone')}</option>
        ) : (
          <>
            <option value="">{t('networkPick')}</option>
            {networks.map((network) => (
              <option key={network.id} value={network.id}>
                {network.label}
              </option>
            ))}
            {halted.map((row) => (
              <option key={row.networkId} value={row.networkId} data-halted="true">
                {t('networkOffOption', { network: row.label })}
              </option>
            ))}
          </>
        )}
      </select>
      <small id={why}>{reason}</small>
      {catalogue.status === 'failed' && catalogue.failure.code !== 'bank.deposit_custody_unset' && !needsVerification(catalogue) && (
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
  const off = catalogue.status === 'ready' ? haltedFor(catalogue.data, asset).find((row) => row.networkId === networkId) : undefined;
  return (
    <DepthPanel title={t('addressTitle')}>
      {(network || off) && (
        <FundingNoticesBanner
          key={`notices:${asset}:${networkId}`}
          asset={asset}
          networkId={networkId}
          networkLabel={network?.label ?? off!.label}
        />
      )}
      {off ? (
        <div className="bd-address" role="alert" data-testid="deposit-halted">
          <strong>{t('haltedTitle', { asset, network: off.label })}</strong>
          {off.blockedBy === 'registry' ? (
            <>
              <p data-testid="deposit-registry-off">
                {off.assetState === 'retired'
                  ? t('registryRetired', { asset })
                  : off.assetState === 'halted'
                    ? t('registryHalted', { asset })
                    : t('registryNotAllowed', { asset, network: off.label })}
              </p>
              <a className="text-link" href="/uc/assets">
                {t('registryLink')} ↗
              </a>
            </>
          ) : (
            <>
              {off.haltNote && <p lang="und">{off.haltNote}</p>}
              <p>{t('haltedBody')}</p>
              <p>{t('haltedKept')}</p>
            </>
          )}
        </div>
      ) : !network ? (
        needsVerification(catalogue) ? (
          <VerifyFirst code={catalogue.status === 'failed' ? (catalogue.failure.code ?? '') : ''} />
        ) : catalogue.status === 'failed' && catalogue.failure.code === 'bank.deposit_custody_unset' ? (
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
          after={<DepositAddresses asset={asset} network={network} />}
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

/** The app's own "verify first" words and link, so this room says what every other room says. */
function VerifyFirst({ code }: { code: string }) {
  const words = refusalCopy(code);
  return (
    <div className="bd-address" role="status" data-testid="deposit-verify">
      <strong>{words.title}</strong>
      <p>{words.body}</p>
      {words.action && (
        <a className="text-link" href={words.action.href}>
          {words.action.label}
        </a>
      )}
    </div>
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
  after,
}: {
  asset: string;
  network: DepositNetworkView;
  issue: () => Promise<{ ok: true; data: DepositAddressView } | { ok: false }>;
  /** Shown under the address once it is on screen: the person's other addresses for this pair. */
  after?: ReactNode;
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
      <>
        <div className="bd-address" data-testid="deposit-address">
          <p>{t('addressLead', { asset, network: network.label })}</p>
          <p>
            <strong data-testid="numeric" className="numeric" style={{ overflowWrap: 'anywhere' }}>
              {address}
            </strong>
          </p>
          <CopyButton value={address} label={t('copyAddress')} />
          {memo && (
            <div role="note">
              <strong>{t('memoTitle')}</strong>
              <p>{t('memoNote')}</p>
              <p data-testid="numeric" className="numeric">
                {memo}
              </p>
              <CopyButton value={memo} label={t('copyMemo')} />
            </div>
          )}
          <QrCode value={qrPayload ?? address} />
        </div>
        {after}
      </>
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
