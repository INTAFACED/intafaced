import { Badge } from '@intafaced/ui';
import { DataTable, Page, Panel } from '../../shared/ui';
import { displayAmount } from '../../shared/money';
import { networkLabel } from '../../features/protocol/blockers';
import { APP_CHAIN_ID } from '../../features/protocol/wallet/eip1193';
import { WalletProvider } from '../../features/protocol/wallet/WalletProvider';
import { WalletBar, useAsOfText, useOwner } from '../../features/trade/venue/VenueKit';
import type { VenueUp } from '../../features/trade/venue-api';
import { usePreferences } from '../../shared/preferences';
import { shortOrderId, type VenueRow, type WalletRead } from './where-it-sits';
import { whereCopy } from './where-it-sits-copy';
import { useStanding, type PartnerRead } from './standing-data';
import type { ValuedPart } from './standing';
import { StandingTotal, dollars } from './StandingTotal';

type T = ReturnType<typeof whereCopy.useCopy>['t'];

/**
 * Assets with the user-venue door on (J-wallet-01): the connected wallet, read from the chain, the venue account, read
 * from the venue, and the partner account when the partner holds the person's bank money, each grouped by where it sits
 * with its own as-of time. The ledger is never read here. An asset is valued only at a published price
 * (`valuation.prices`); with none published nothing is valued and there is no total. With prices published, the total is
 * the sum of what is priced, every part named (`StandingTotal`, the same figures Home shows), never an INTAFACED balance.
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
        {owner ? <Read owner={owner} status={status} chainId={chainId} t={t} /> : <p className="muted">{t('Connect first')}</p>}
      </div>
    </Page>
  );
}

function Read({ owner, status, chainId, t }: { owner: string; status: VenueUp; chainId: number; t: T }) {
  const { displayCurrency, hideBalances } = usePreferences();
  const network = networkLabel(chainId).name;
  const { wallet, venue, partner, standing, pricesFailed } = useStanding(
    owner,
    chainId,
    { network, venue: status.venue.displayName, venueTest: status.test },
    displayCurrency === 'BTC' ? 'BTC' : 'USD',
  );
  const part = (id: ValuedPart['id']) => standing.parts.find((p) => p.id === id);
  return (
    <>
      {standing.prices || pricesFailed ? (
        <Panel title={t('Total title')}>
          <StandingTotal
            standing={standing}
            pricesFailed={pricesFailed}
            displayCurrency={displayCurrency}
            hidden={hideBalances}
            testId="assets-total"
          />
        </Panel>
      ) : null}
      <WalletSource owner={owner} network={network} read={wallet} valued={part('wallet')} t={t} />
      <VenueSource status={status} read={venue} valued={part('venue')} t={t} />
      {partner.state === 'none' ? null : <PartnerSource read={partner} valued={part('partner')} t={t} />}
      {standing.prices ? null : (
        <p className="muted" data-testid="assets-no-price-note">
          {t('No price note')}
        </p>
      )}
    </>
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

/** The value cell of `asset` in a valued part: dollars to the cent at the published price, or "No price published". */
function valueOf(valued: ValuedPart | undefined, asset: string, t: T): string {
  const value = valued?.rows.find((row) => row.asset === asset)?.valueUsd ?? null;
  return value === null ? t('No price published') : dollars(value);
}

type Polled<D> = { data: D | null; failure: { message?: string } | null };

function WalletSource({
  owner,
  network,
  read,
  valued,
  t,
}: {
  owner: string;
  network: string;
  read: Polled<WalletRead>;
  valued: ValuedPart | undefined;
  t: T;
}) {
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
                    <td data-cell="value">{valueOf(valued, row.symbol, t)}</td>
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

function VenueSource({
  status,
  read,
  valued,
  t,
}: {
  status: VenueUp;
  read: Polled<{ asOf: string; rows: VenueRow[] }>;
  valued: ValuedPart | undefined;
  t: T;
}) {
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
          <p role="alert">{t('Venue read failed', { detail: read.failure.message ?? '' })}</p>
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
                <td data-cell="value">{valueOf(valued, row.asset, t)}</td>
              </tr>
            ))}
          </DataTable>
        )}
      </section>
    </Panel>
  );
}

/** The partner account, when the partner holds the person's bank money: each asset as the partner reports it. */
function PartnerSource({ read, valued, t }: { read: Exclude<PartnerRead, { state: 'none' }>; valued: ValuedPart | undefined; t: T }) {
  const title = read.state === 'read' ? t('Partner title', { partner: read.label }) : t('Partner title unnamed');
  return (
    <Panel title={title}>
      <section data-testid="source-partner" data-source="partner" aria-label={title}>
        <p>
          {t('Partner source')} {read.state === 'read' ? <AsOf iso={read.asOf} /> : null}
        </p>
        {read.state === 'reading' ? (
          <p className="muted">{t('Reading')}</p>
        ) : read.state === 'unread' ? (
          <p role="alert">{t('Partner read failed')}</p>
        ) : (
          <DataTable label={title} headers={[t('Asset'), t('Amount'), t('Value')]}>
            {read.rows.map((row) => (
              <tr key={row.asset} data-asset={row.asset}>
                <td>{row.asset}</td>
                <td data-cell="amount">{displayAmount(row.amount)}</td>
                <td data-cell="value">{valueOf(valued, row.asset, t)}</td>
              </tr>
            ))}
          </DataTable>
        )}
      </section>
    </Panel>
  );
}
