import { useMemo } from 'react';
import { Badge } from '@intafaced/ui';
import { DataTable, Page, Panel } from '../../shared/ui';
import { displayAmount } from '../../shared/money';
import { useApi } from '../../features/session/session';
import { createProtocolApi } from '../../features/protocol/api';
import { networkLabel } from '../../features/protocol/blockers';
import { nativeCurrency } from '../../features/protocol/wallet/transfer';
import { APP_CHAIN_ID } from '../../features/protocol/wallet/eip1193';
import { WalletProvider, useWallet } from '../../features/protocol/wallet/WalletProvider';
import { usePolled } from '../../features/protocol/wallet/use-polled';
import { useResource } from '../../shared/resource';
import { WalletBar, useAsOfText, useOwner, useVenueApi } from '../../features/trade/venue/VenueKit';
import type { VenueUp } from '../../features/trade/venue-api';
import { readWallet, shortOrderId, venueRows, type NodeRead, type WalletRead, type WalletToken } from './where-it-sits';
import { whereCopy } from './where-it-sits-copy';

type T = ReturnType<typeof whereCopy.useCopy>['t'];

/** How often the wallet and the venue are read again while Assets is open. */
const READ_EVERY_MS = 3_000;

/**
 * Assets with the user-venue door on (J-wallet-01): the connected wallet, read from the chain, and the venue account, read
 * from the venue, each grouped by where it sits with its own as-of time. The ledger is never read here, nothing is valued
 * without a published price, and no INTAFACED total exists.
 */
export function WhereItSits({ status }: { status: VenueUp }) {
  const chainId = status.chainId ?? APP_CHAIN_ID;
  return (
    <WalletProvider chainId={chainId} scope="assets">
      <Sources status={status} chainId={chainId} />
    </WalletProvider>
  );
}

function Sources({ status, chainId }: { status: VenueUp; chainId: number }) {
  const { t } = whereCopy.useCopy();
  const owner = useOwner();
  return (
    <Page title={t('Title')} description={t('Lede')}>
      <div data-testid="assets-by-source" className="form-stack">
        <WalletBar />
        {owner ? (
          <>
            <WalletSource owner={owner} chainId={chainId} t={t} />
            <VenueSource owner={owner} status={status} t={t} />
            <Panel title={t('Partner title')}>
              <p data-testid="source-partner" data-source="partner" data-reported="false">
                {t('Partner holds')}
              </p>
            </Panel>
            <p className="muted" data-testid="assets-no-price-note">
              {t('No price note')}
            </p>
          </>
        ) : (
          <p className="muted">{t('Connect first')}</p>
        )}
      </div>
    </Page>
  );
}

function AsOf({ iso }: { iso: string }) {
  const text = useAsOfText();
  return (
    <time dateTime={iso} data-testid="source-as-of">
      {text(iso)}
    </time>
  );
}

function WalletSource({ owner, chainId, t }: { owner: string; chainId: number; t: T }) {
  const wallet = useWallet();
  const transport = useApi();
  const protocol = useMemo(() => createProtocolApi(transport), [transport]);
  const pairs = useResource((signal) => protocol.ammPairs(signal), 'assets:pairs');
  // The network's own currency, then every token its pools list: the tokens a wallet on this network is read for.
  const tokens = useMemo<WalletToken[]>(() => {
    const native = nativeCurrency(chainId);
    const listed = pairs.resource.status === 'ready' ? pairs.resource.data.tokens : [];
    return [
      ...(native ? [{ address: null, symbol: native.symbol, decimals: native.decimals }] : []),
      ...listed.map((token) => ({ address: token.address, symbol: token.symbol, decimals: token.decimals })),
    ];
  }, [pairs.resource, chainId]);
  const node: NodeRead = (method, params) => wallet.read(method, params);
  const key = `${owner}:${chainId}:${tokens.map((token) => token.symbol).join(',')}`;
  const read = usePolled<WalletRead>(
    async () => ({ ok: true as const, data: await readWallet(node, chainId, owner, tokens) }),
    key,
    READ_EVERY_MS,
  );
  const network = networkLabel(chainId).name;
  const data = read.data;
  return (
    <Panel title={t('Wallet title')}>
      <section data-testid="source-wallet" data-source="chain" data-address={owner} aria-label={t('Wallet title')}>
        <p>
          {t('Wallet address')}: <span data-testid="source-wallet-address">{owner}</span>
        </p>
        {!data ? (
          <p className="muted">{t('Reading')}</p>
        ) : !data.ok ? (
          <p role="alert">{t('Wallet read failed')}</p>
        ) : (
          <>
            <p data-testid="source-wallet-block" data-block={data.block}>
              {t('Wallet source', { block: data.block })} <AsOf iso={data.asOf} />
            </p>
            <h3 data-testid="source-wallet-network" data-chain-id={String(data.chainId)}>
              {t('Wallet network', { network, chainId: String(data.chainId) })}
            </h3>
            {data.rows.length === 0 ? (
              <p className="muted">{t('Wallet empty')}</p>
            ) : (
              <DataTable label={t('Wallet network totals', { network })} headers={[t('Asset'), t('Amount'), t('Value')]}>
                {data.rows.map((row) => (
                  <tr key={row.symbol} data-asset={row.symbol} data-token={row.token ?? 'native'}>
                    <td>{row.symbol}</td>
                    <td data-cell="amount">{displayAmount(row.amount)}</td>
                    <td data-cell="value">{t('No price published')}</td>
                  </tr>
                ))}
              </DataTable>
            )}
            {data.unread.length > 0 ? (
              <p className="muted" data-testid="source-wallet-unread">
                {t('Wallet unread', { tokens: data.unread.join(', ') })}
              </p>
            ) : null}
          </>
        )}
      </section>
    </Panel>
  );
}

function VenueSource({ owner, status, t }: { owner: string; status: VenueUp; t: T }) {
  const venue = useVenueApi();
  const read = usePolled(
    async (signal) => {
      const [balances, orders] = await Promise.all([venue.balances(owner, signal), venue.openOrders(owner, signal)]);
      if (!balances.ok) return balances;
      if (!orders.ok) return orders;
      return {
        ok: true as const,
        data: { asOf: balances.data.asOf, rows: venueRows(balances.data.value, orders.data.value) },
      };
    },
    `assets:venue:${owner}`,
    READ_EVERY_MS,
  );
  const data = read.data;
  return (
    <Panel title={t('Venue title', { venue: status.venue.displayName })}>
      <section data-testid="source-venue" data-source="venue" aria-label={t('Venue title', { venue: status.venue.displayName })}>
        <p>
          {t('Venue source')}{' '}
          {status.test ? (
            <Badge tone="warn" data-testid="source-venue-test" title={t('TEST note')}>
              {t('TEST')}
            </Badge>
          ) : null}{' '}
          {data ? <AsOf iso={data.asOf} /> : null}
        </p>
        {read.failure && !data ? (
          <p role="alert">{t('Venue read failed', { detail: read.failure.message })}</p>
        ) : !data ? (
          <p className="muted">{t('Reading')}</p>
        ) : data.rows.length === 0 ? (
          <p className="muted">{t('Venue empty')}</p>
        ) : (
          <DataTable
            label={t('Venue title', { venue: status.venue.displayName })}
            headers={[t('Asset'), t('Free'), t('Locked'), t('Total'), t('Can withdraw'), t('Value')]}
          >
            {data.rows.map((row) => (
              <tr key={row.asset} data-asset={row.asset}>
                <td>{row.asset}</td>
                <td data-cell="free">{displayAmount(row.free)}</td>
                <td data-cell="locked" title={t('Locked note')}>
                  {displayAmount(row.locked)}
                  {row.orders.length > 0 ? (
                    <ul data-testid="source-venue-locks">
                      {row.orders.map((order) => (
                        <li key={order.id} data-order={order.id} title={order.id}>
                          {t('Order lock', {
                            id: shortOrderId(order.id),
                            side: t(order.side),
                            symbol: order.symbol,
                            amount: displayAmount(order.locked),
                            asset: row.asset,
                          })}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </td>
                <td data-cell="total">{displayAmount(row.total)}</td>
                <td data-cell="withdrawable">{displayAmount(row.withdrawable)}</td>
                <td data-cell="value">{t('No price published')}</td>
              </tr>
            ))}
          </DataTable>
        )}
      </section>
    </Panel>
  );
}
