import { useEffect, useMemo, useState } from 'react';
import { canAddToWallet, NETWORK_PARAMS_UNSET, routerIsSunset, type NetworkEntry } from '@intafaced/contracts/protocol-networks';
import { useApi } from '../session/session';
import { useResource } from '../../shared/resource';
import type { ApiResult } from '../../shared/api';
import { Button, DataTable, EmptyState, Failure, Loading, Panel } from '../../shared/ui';
import { createProtocolApi, type Deployments, type ProtocolApi } from './api';
import { protocolCopy as copy } from './copy';
import { discoverWallets, toHexChainId, type DiscoveredWallet } from './wallet/eip1193';

type Translate = ReturnType<typeof copy.forLocale>['t'];

/** Only an https address is ever rendered as a link; anything else is shown as plain text. */
const isHttps = (url: string) => url.startsWith('https://');
function ExternalLink({ url, label }: { url: string; label: string }) {
  return isHttps(url) ? (
    <a href={url} target="_blank" rel="noopener noreferrer">
      {label}
    </a>
  ) : (
    <span>{label}</span>
  );
}

/** The configured chain as the room knows it: still being read, not readable, or known. Never guessed from a null. */
export type ChainRef =
  | { status: 'loading' }
  | { status: 'failed'; failure: Extract<ApiResult<unknown>, { ok: false }>; reload: () => void }
  | { status: 'ready'; chainId: number };

function ChainPending({ chain, t }: { chain: ChainRef; t: Translate }) {
  if (chain.status === 'failed') return <Failure result={chain.failure} retry={chain.reload} />;
  return <Loading label={t('checking', { source: t('src_chain') })} />;
}

const UNKNOWN_CHAIN = 'protocol.deployments_unknown_chain';
const nothingRecorded = (failure: { code?: string; message: string }) =>
  failure.code === UNKNOWN_CHAIN || failure.message.includes(UNKNOWN_CHAIN);

function usePublishedApi(): ProtocolApi {
  const transport = useApi();
  return useMemo(() => createProtocolApi(transport), [transport]);
}

/** The EIP-3085 request a wallet needs to add this network. Only built from published fields. */
export function addChainParams(network: NetworkEntry) {
  if (!canAddToWallet(network)) return null;
  return {
    chainId: toHexChainId(network.chainId),
    chainName: network.name as string,
    nativeCurrency: network.nativeCurrency,
    rpcUrls: network.rpcUrls,
    ...(network.explorerUrls ? { blockExplorerUrls: network.explorerUrls } : {}),
  };
}

function useWallets(): DiscoveredWallet[] {
  const [wallets, setWallets] = useState<DiscoveredWallet[]>([]);
  useEffect(() => discoverWallets(window, setWallets), []);
  return wallets;
}

function NoneListed({ t }: { t: Translate }) {
  return <p className="muted">{t('noneListed')}</p>;
}

function NetworkCard({ network, t }: { network: NetworkEntry; t: Translate }) {
  const wallets = useWallets();
  const [state, setState] = useState<'idle' | 'added' | 'declined' | 'failed'>('idle');
  const params = addChainParams(network);
  const provider = wallets[0]?.provider;
  const disabledReason = params === null ? t('addToWalletUnset', { code: NETWORK_PARAMS_UNSET }) : !provider ? t('noWalletFound') : null;
  const add = async () => {
    if (!params || !provider) return;
    try {
      await provider.request({ method: 'wallet_addEthereumChain', params: [params] });
      setState('added');
    } catch (err) {
      setState((err as { code?: unknown } | null)?.code === 4001 ? 'declined' : 'failed');
    }
  };
  return (
    <>
      <dl className="protocol-facts">
        {(
          [
            [t('netName'), network.name ?? t('notPublished')],
            [t('netKind'), t(`kind_${network.kind}` as 'kind_testnet')],
            [t('netChainId'), String(network.chainId)],
            [
              t('netCurrency'),
              network.nativeCurrency ? `${network.nativeCurrency.symbol} (${network.nativeCurrency.decimals})` : t('notPublished'),
            ],
            [t('netRpc'), network.rpcUrls ? network.rpcUrls.join(', ') : t('notPublished')],
            [t('netBlockTime'), network.blockTimeSeconds === null ? t('notPublished') : `${network.blockTimeSeconds} s`],
          ] as const
        ).map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd className="numeric">{value}</dd>
          </div>
        ))}
        <div>
          <dt>{t('netExplorer')}</dt>
          <dd>
            {network.explorerUrls ? network.explorerUrls.map((url) => <ExternalLink key={url} url={url} label={url} />) : t('notPublished')}
          </dd>
        </div>
      </dl>
      <Button
        variant="secondary"
        disabled={disabledReason !== null}
        aria-disabled={disabledReason !== null}
        title={disabledReason ?? undefined}
        onClick={() => void add()}
      >
        {t('addToWallet')}
      </Button>
      {disabledReason && (
        <p className="protocol-actions__reason" role="note">
          {t('blockedBy', { reason: disabledReason })}
        </p>
      )}
      {state !== 'idle' && (
        <p role="status" className="muted">
          {t(state === 'added' ? 'addToWalletDone' : state === 'declined' ? 'addToWalletDeclined' : 'addToWalletFailed')}
        </p>
      )}
      <h3>{t('gasTitle')}</h3>
      <p className="muted">{t('gasNote')}</p>
      <NoneListed t={t} />
      <h3>{t('faucetsTitle')}</h3>
      <p className="muted">{t('faucetsNote')}</p>
      {network.faucets ? (
        <ul>
          {network.faucets.map((entry) => (
            <li key={entry.url}>
              <ExternalLink url={entry.url} label={entry.name} />
            </li>
          ))}
        </ul>
      ) : (
        <NoneListed t={t} />
      )}
      <h3>{t('ecosystemTitle')}</h3>
      {network.ecosystem ? (
        <ul>
          {network.ecosystem.map((entry) => (
            <li key={entry.url}>
              <ExternalLink url={entry.url} label={`${entry.name} · ${entry.kind}`} />
            </li>
          ))}
        </ul>
      ) : (
        <NoneListed t={t} />
      )}
    </>
  );
}

/** The Network card on the /chain Status tab: the owner-published entry for the configured chain, nothing filled in. */
export function NetworkPanel({ chain, t }: { chain: ChainRef; t: Translate }) {
  const api = usePublishedApi();
  const { resource, reload } = useResource((signal) => api.networksList(signal), 'protocol-room:networks');
  return (
    <Panel title={t('netCardTitle')}>
      {chain.status !== 'ready' ? (
        <ChainPending chain={chain} t={t} />
      ) : resource.status === 'loading' ? (
        <Loading label={t('checking', { source: t('src_networks') })} />
      ) : resource.status === 'failed' ? (
        <Failure result={resource.failure} retry={reload} />
      ) : (
        (() => {
          const entry = resource.data.networks.find((network) => network.chainId === chain.chainId);
          return entry ? <NetworkCard network={entry} t={t} /> : <EmptyState title={t('netNone')} />;
        })()
      )}
    </Panel>
  );
}

function ContractsTable({ chainId, t }: { chainId: number; t: Translate }) {
  const api = usePublishedApi();
  const { resource, reload } = useResource((signal) => api.deploymentsList(chainId, signal), `protocol-room:deployments:${chainId}`);
  if (resource.status === 'loading') return <Loading label={t('checking', { source: t('src_deployments') })} />;
  if (resource.status === 'failed')
    return nothingRecorded(resource.failure) ? (
      <EmptyState title={t('noDeployment')} />
    ) : (
      <Failure result={resource.failure} retry={reload} />
    );
  const { contracts } = resource.data;
  return (
    <DataTable label={t('contractsTitle')} headers={[t('hdr_contract'), t('hdr_suite'), t('hdr_address'), t('hdr_verified')]}>
      {contracts.length === 0 ? (
        <tr>
          <td colSpan={4}>
            <EmptyState title={t('noDeployment')} />
          </td>
        </tr>
      ) : (
        contracts.map((contract) => (
          <tr key={contract.address}>
            <td>{contract.name}</td>
            <td>{contract.suite}</td>
            <td className="numeric">
              {contract.explorerUrl ? <ExternalLink url={contract.explorerUrl} label={contract.address} /> : contract.address}
            </td>
            <td>{contract.verified ? t('yes') : t('no')}</td>
          </tr>
        ))
      )}
    </DataTable>
  );
}

/** The Deployed contracts table for the configured chain, read from the service. There is no built-in copy to fall back on. */
export function ContractsPanel({ chain, t }: { chain: ChainRef; t: Translate }) {
  return (
    <Panel title={t('contractsTitle')}>
      <p className="muted">{t('contractsNote')}</p>
      {chain.status === 'ready' ? <ContractsTable chainId={chain.chainId} t={t} /> : <ChainPending chain={chain} t={t} />}
    </Panel>
  );
}

/** The fast-confirmation row, from the service's probe: "not offered" only when the node answered; otherwise not confirmed. */
type FastConfirmations = 'not_offered' | 'unknown' | 'unreadable';
type SupportedRow = {
  chainId: number;
  name: string | null;
  deployments: Deployments | 'unrecorded' | 'unreadable';
  fast: FastConfirmations;
};

/**
 * Every published network with its recorded router versions and its fast-confirmation status. A chain with nothing recorded
 * gets one honest row.
 */
export function SupportedNetworksPanel({ t, now = new Date() }: { t: Translate; now?: Date }) {
  const api = usePublishedApi();
  const { resource, reload } = useResource(async (signal) => {
    const list = await api.networksList(signal);
    if (!list.ok) return list;
    const rows: SupportedRow[] = await Promise.all(
      list.data.networks.map(async (network) => {
        const [found, capabilities] = await Promise.all([
          api.deploymentsList(network.chainId, signal),
          api.capabilities(network.chainId, signal),
        ]);
        return {
          chainId: network.chainId,
          name: network.name,
          deployments: found.ok ? found.data : nothingRecorded(found) ? ('unrecorded' as const) : ('unreadable' as const),
          fast: capabilities.ok ? capabilities.data.preconfirmations : ('unreadable' as const),
        };
      }),
    );
    return { ok: true as const, data: rows };
  }, 'protocol-room:supported-networks');
  return (
    <Panel title={t('supportedTitle')}>
      <p className="muted">{t('supportedNote')}</p>
      {resource.status === 'loading' ? (
        <Loading label={t('checking', { source: t('src_networks') })} />
      ) : resource.status === 'failed' ? (
        <Failure result={resource.failure} retry={reload} />
      ) : (
        <DataTable
          label={t('supportedTitle')}
          headers={[t('hdr_chain'), t('hdr_router'), t('hdr_version'), t('hdr_sunset'), t('hdr_verified'), t('hdr_fast')]}
        >
          {resource.data.length === 0 ? (
            <tr>
              <td colSpan={6}>
                <EmptyState title={t('netNone')} />
              </td>
            </tr>
          ) : (
            resource.data.flatMap((row) => {
              const chain = `${row.name ?? t('notPublished')} (${row.chainId})`;
              const fast = <td data-fast={row.fast}>{t(`fast_${row.fast}`)}</td>;
              if (row.deployments === 'unreadable')
                return [
                  <tr key={row.chainId}>
                    <td>{chain}</td>
                    <td colSpan={4}>{t('routerUnreadable')}</td>
                    {fast}
                  </tr>,
                ];
              const routers = row.deployments === 'unrecorded' ? [] : row.deployments.routers;
              if (routers.length === 0)
                return [
                  <tr key={row.chainId}>
                    <td>{chain}</td>
                    <td colSpan={4}>{t('noRouter')}</td>
                    {fast}
                  </tr>,
                ];
              return routers.map((router) => (
                <tr key={`${row.chainId}:${router.address}`}>
                  <td>{chain}</td>
                  <td className="numeric">{router.address}</td>
                  <td>{router.version}</td>
                  <td>{routerIsSunset(router, now) ? t('sunsetNow') : (router.sunsetAt ?? t('noSunset'))}</td>
                  <td>{router.verified ? t('yes') : t('no')}</td>
                  {fast}
                </tr>
              ));
            })
          )}
        </DataTable>
      )}
    </Panel>
  );
}
