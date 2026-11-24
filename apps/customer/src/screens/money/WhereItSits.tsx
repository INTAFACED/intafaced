import type { ReactNode } from 'react';
import { displayAmount, parseAmount } from '../../shared/money';
import { networkLabel } from '../../features/protocol/blockers';
import { APP_CHAIN_ID } from '../../features/protocol/wallet/eip1193';
import { WalletProvider } from '../../features/protocol/wallet/WalletProvider';
import { useAsOfText, useOwner } from '../../features/trade/venue/VenueKit';
import { WalletBar } from '../../features/trade/permissions/venue-parts';
import type { VenueUp } from '../../features/trade/venue-api';
import { usePreferences } from '../../shared/preferences';
import { shortOrderId, type WalletRead } from './where-it-sits';
import { whereCopy } from './where-it-sits-copy';
import { moneyCopy } from './copy';
import { VALUATION_REFRESH_MS, usePartnerStanding, useStanding, venueTotals, type PartnerRead, type VenueRead } from './standing-data';
import type { ValuedPart } from './standing';
import { StandingTotal, dollars } from './StandingTotal';
import { ValuationNote } from './ValuationNote';
import { Movers } from './Movers';
import { clockTime } from './time';
import { isHiddenPath, navigate } from './deps';
import { MoneyOverview } from './MoneyRoom';
import { buyHref } from './links';
import { balanceEntriesHref } from './balance-entries-model';

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
    <div data-testid="assets-by-source">
      {owner ? <Read owner={owner} status={status} chainId={chainId} t={t} /> : <BeforeWallet t={t} />}
    </div>
  );
}

/**
 * Assets before a wallet is connected: the partner account needs no wallet to be read, so the money the partner
 * holds for this person is listed with its total, each figure as the partner reports it with its time, exactly as Home
 * shows it. The wallet and the venue account join once a wallet is connected, and the line under the total says so.
 */
function BeforeWallet({ t }: { t: T }) {
  const { displayCurrency, hideBalances } = usePreferences();
  const { partner, standing, pricesFailed, valued } = usePartnerStanding(displayCurrency === 'BTC' ? 'BTC' : 'USD');
  const held = partner.state === 'read' || partner.state === 'unread';
  return (
    <MoneyOverview
      title={t('Title')}
      description={t('Lede')}
      hero={
        <div className="lt-stack">
          {held ? (
            <section className="lt-stack" aria-labelledby="assets-total-title">
              <h2 id="assets-total-title">{t('Total title')}</h2>
              <StandingTotal
                standing={standing}
                pricesFailed={pricesFailed}
                displayCurrency={displayCurrency}
                hidden={hideBalances}
                testId="assets-total-before-wallet"
              />
            </section>
          ) : null}
          <p className="lt-hint" data-testid="assets-connect-first">
            {t('Connect first')}
          </p>
        </div>
      }
      sections={
        partner.state === 'none' ? undefined : (
          <div className="lt-stack">
            <PartnerSource read={partner} valued={valued} t={t} />
          </div>
        )
      }
      watching={<WalletBar />}
    />
  );
}

function Read({ owner, status, chainId, t }: { owner: string; status: VenueUp; chainId: number; t: T }) {
  const { displayCurrency, hideBalances, timeZone } = usePreferences();
  const money = moneyCopy.useCopy();
  const network = networkLabel(chainId).name;
  const { wallet, venue, partner, standing, pricesFailed } = useStanding(
    owner,
    chainId,
    { network, venue: status.venue.displayName, venueTest: status.test },
    displayCurrency === 'BTC' ? 'BTC' : 'USD',
  );
  const part = (id: ValuedPart['id']) => standing.parts.find((p) => p.id === id);
  const valuation = standing.prices && standing.valuation && standing.valuation.rows.length > 0 ? standing.valuation : null;
  const sinceLabel =
    valuation && valuation.windowStart !== null
      ? money.t('Movers since {time}', { time: clockTime(valuation.windowStart, timeZone) })
      : money.t('Today');
  return (
    <MoneyOverview
      title={t('Title')}
      description={t('Lede')}
      hero={
        standing.prices || pricesFailed ? (
          <section className="lt-stack" aria-labelledby="assets-total-title">
            <h2 id="assets-total-title">{t('Total title')}</h2>
            <StandingTotal
              standing={standing}
              pricesFailed={pricesFailed}
              displayCurrency={displayCurrency}
              hidden={hideBalances}
              testId="assets-total"
            />
          </section>
        ) : null
      }
      actions={<QuickActions t={t} />}
      sections={
        <div className="lt-stack">
          <WalletSource owner={owner} network={network} read={wallet} valued={part('wallet')} t={t} />
          <VenueSource status={status} read={venue} valued={part('venue')} t={t} />
          {partner.state === 'none' ? null : <PartnerSource read={partner} valued={part('partner')} t={t} />}
          {valuation && standing.prices ? (
            <ValuationNote
              view={valuation}
              copy={money}
              refreshMs={VALUATION_REFRESH_MS}
              timeZone={timeZone}
              priceSourceNote={money.t('Valuation price sources', {
                published: standing.prices.source,
                venue: status.venue.displayName,
              })}
            />
          ) : null}
          {standing.prices ? null : (
            <p className="lt-hint" data-testid="assets-no-price-note">
              {t('No price note')}
            </p>
          )}
        </div>
      }
      watching={
        <div className="lt-stack">
          <WalletBar />
          {valuation ? <Movers view={valuation} hidden={hideBalances} copy={money} sinceLabel={sinceLabel} /> : null}
        </div>
      }
    />
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

/** Where the person goes from the total (J-portfolio-01 #1): each a real room on the launch model, none a dead end. */
const ACTIONS = [
  { id: 'Trade', href: () => buyHref(null, null, false, 'pro') },
  { id: 'Fund venue', href: () => (isHiddenPath('/wallet/venue') ? null : '/wallet/venue') },
  { id: 'Activity', href: () => (isHiddenPath('/money/activity') ? null : '/money/activity') },
] as const;

function QuickActions({ t }: { t: T }) {
  const live = ACTIONS.flatMap((action) => {
    const href = action.href();
    return href ? [{ id: action.id, href }] : [];
  });
  return (
    <nav data-testid="assets-actions" className="lt-actions" aria-label={t('Actions')}>
      {live.map((action, index) => {
        const variant = index === 0 ? 'primary' : 'secondary';
        return (
          <a key={action.id} className={`lt-button lt-button-${variant}`} data-variant={variant} href={action.href}>
            {t(action.id)}
          </a>
        );
      })}
    </nav>
  );
}

/**
 * The price, value, share and source cells of `asset` in a valued part (J-portfolio-01 #1): the published price, dollars
 * to the cent, its share of the total, and the source that reports it, with a link to the records behind the figure.
 * An asset with no published price shows "No price published" for its price and value and no share, never a zero.
 */
function ValueCells({
  valued,
  asset,
  rowKey,
  source,
  t,
  entriesHref,
}: {
  valued: ValuedPart | undefined;
  asset: string;
  /** A row the source holds apart from its plain balance of `asset` (a vault position); none: the plain balance. */
  rowKey?: string;
  source: string;
  t: T;
  /** Where this row's own lines are listed, when not the sources' records page (the venue door off: the bank's list). */
  entriesHref?: string;
}) {
  const row = valued?.rows.find((r) => r.asset === asset && r.key === rowKey);
  const href = entriesHref ?? (valued ? `${balanceEntriesHref(asset)}?source=${valued.id}` : null);
  return (
    <>
      <td data-cell="price" data-label={t('Price')}>
        {row?.priceUsd ? dollars(row.priceUsd) : t('No price published')}
      </td>
      <td data-cell="value" data-label={t('Value')}>
        {row?.valueUsd ? dollars(row.valueUsd) : t('No price published')}
      </td>
      <td data-cell="share" data-label={t('Share')}>
        {row?.share ? t('Share of total', { share: row.share }) : '—'}
      </td>
      <td data-cell="source" data-label={t('Source')} data-source={valued?.id ?? ''}>
        {source}
        {href ? (
          <>
            {' · '}
            <a
              data-testid="source-entries-link"
              href={href}
              aria-label={t('Entries link label', { asset, source })}
              onClick={(event) => {
                if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
                event.preventDefault();
                navigate(href);
              }}
            >
              {t('Entries link')}
            </a>
          </>
        ) : null}
      </td>
    </>
  );
}

const VALUE_HEADERS = ['Price', 'Value', 'Share', 'Source'] as const;

/** One place the person's assets sit: its heading, then what that source reports. */
function Source({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="lt-stack">
      <h2>{title}</h2>
      {children}
    </div>
  );
}

/** A source's table in a named region that scrolls on its own: one header row, then the rows. */
function SourceTable({ headers, children, label }: { headers: readonly ReactNode[]; children: ReactNode; label: string }) {
  return (
    <div tabIndex={0} role="region" aria-label={label}>
      <table className="lt-table">
        <thead>
          <tr>
            {headers.map((head, index) => (
              <th key={index} scope="col">
                {head}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
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
    <Source title={t('Wallet title')}>
      <section data-testid="source-wallet" data-source="chain" data-address={owner} aria-label={t('Wallet title')}>
        <p>
          {t('Wallet address')}: <span data-testid="source-wallet-address">{owner}</span>
        </p>
        {!data ? (
          <p className="lt-hint">{t('Reading')}</p>
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
              <p className="lt-hint">{t('Wallet empty')}</p>
            ) : (
              <SourceTable
                label={t('Wallet network totals', { network })}
                headers={[t('Asset'), t('Amount'), ...VALUE_HEADERS.map((h) => t(h))]}
              >
                {data.rows.map((row) => (
                  <tr key={row.symbol} data-asset={row.symbol} data-token={row.token ?? 'native'}>
                    <td data-label={t('Asset')}>{row.symbol}</td>
                    <td data-cell="amount" data-label={t('Amount')}>
                      {displayAmount(row.amount)}
                    </td>
                    <ValueCells valued={valued} asset={row.symbol} source={t('Source wallet', { network, block: data.block })} t={t} />
                  </tr>
                ))}
              </SourceTable>
            )}
            {data.unread.length > 0 ? (
              <p className="lt-hint" data-testid="source-wallet-unread">
                {t('Wallet unread', { tokens: data.unread.join(', ') })}
              </p>
            ) : null}
          </>
        )}
      </section>
    </Source>
  );
}

/**
 * The venue's staking on /money (J-cex-spot-21 #8): the rewards it reports, and for its staking asset whether the parts
 * it names (free, in orders, collateral, staked, delegated, unstaking) add to the total it reports. Shown only where the
 * account holds any staking; nothing is derived beyond the sum.
 */
function StakingLines({ data, venue, t }: { data: VenueRead; venue: string; t: T }) {
  if (!data.staking.read) return null;
  const s = data.staking.account;
  const row = data.rows.find((r) => r.asset === s.asset);
  const has = row?.split?.delegated !== undefined || /[1-9]/.test(s.staked) || /[1-9]/.test(s.rewards.total);
  if (!row || !has) return null;
  const split = row.split;
  const parts = split
    ? [row.free, split.inOrders, split.collateral, split.stake, split.delegated ?? '0', split.unstaking ?? '0'].reduce(
        (sum, x) => sum + parseAmount(x),
        0n,
      )
    : null;
  const addsUp = parts !== null && parts === parseAmount(row.total);
  return (
    <div data-testid="source-venue-staking" data-asset={s.asset}>
      <p data-testid="source-venue-staking-rewards" data-value={s.rewards.total}>
        {t('Staking rewards', { venue, amount: displayAmount(s.rewards.total), asset: s.asset })}
      </p>
      {parts !== null ? (
        <p data-testid="source-venue-staking-parts" data-adds-up={addsUp ? 'true' : 'false'} data-total={row.total}>
          {addsUp
            ? t('Staking parts add up', { venue, amount: displayAmount(row.total), asset: s.asset })
            : t('Staking parts differ', { venue, amount: displayAmount(row.total), asset: s.asset })}
        </p>
      ) : null}
    </div>
  );
}

function VenueSource({ status, read, valued, t }: { status: VenueUp; read: Polled<VenueRead>; valued: ValuedPart | undefined; t: T }) {
  const data = read.data;
  const vaults = data?.vaults.read ? data.vaults.holdings.positions : [];
  const totals = data ? venueTotals(data) : null;
  const venueName = status.venue.displayName;
  return (
    <Source title={t('Venue title', { venue: status.venue.displayName })}>
      <section data-testid="source-venue" data-source="venue" aria-label={t('Venue title', { venue: status.venue.displayName })}>
        <p>
          {t('Venue source')}{' '}
          {status.test ? (
            <span className="lt-test" data-testid="source-venue-test" title={t('TEST note')}>
              {t('TEST')}
            </span>
          ) : null}{' '}
          {data ? <AsOf iso={data.asOf} /> : null}
        </p>
        {read.failure && !data ? (
          <p role="alert">{t('Venue read failed', { detail: read.failure.message ?? '' })}</p>
        ) : !data ? (
          <p className="lt-hint">{t('Reading')}</p>
        ) : data.rows.length === 0 && vaults.length === 0 ? (
          <p className="lt-hint">{t('Venue empty')}</p>
        ) : data.rows.length === 0 ? null : (
          <SourceTable
            label={t('Venue title', { venue: status.venue.displayName })}
            headers={[t('Asset'), t('Free'), t('Locked'), t('Total'), t('Can withdraw'), ...VALUE_HEADERS.map((h) => t(h))]}
          >
            {data.rows.map((row) => (
              <tr key={row.asset} data-asset={row.asset}>
                <td data-label={t('Asset')}>{row.asset}</td>
                <td data-cell="free" data-label={t('Free')}>
                  {displayAmount(row.free)}
                </td>
                <td data-cell="locked" data-label={t('Locked')} title={t('Locked note')}>
                  {displayAmount(row.locked)}
                  {row.split ? (
                    <ul data-testid="source-venue-split" className="lt-hint">
                      <li data-part="in-orders" data-amount={row.split.inOrders}>
                        {t('In orders', { amount: displayAmount(row.split.inOrders) })}
                      </li>
                      <li data-part="collateral" data-amount={row.split.collateral}>
                        {t('Collateral', { amount: displayAmount(row.split.collateral) })}
                      </li>
                      <li data-part="stake" data-amount={row.split.stake}>
                        {t('Stake', { amount: displayAmount(row.split.stake) })}
                      </li>
                      {row.split.delegated !== undefined ? (
                        <li data-part="delegated" data-amount={row.split.delegated}>
                          {t('Delegated', { amount: displayAmount(row.split.delegated) })}
                        </li>
                      ) : null}
                      {row.split.unstaking !== undefined ? (
                        <li data-part="unstaking" data-amount={row.split.unstaking}>
                          {t('Unstaking', { amount: displayAmount(row.split.unstaking) })}
                        </li>
                      ) : null}
                    </ul>
                  ) : /[1-9]/.test(row.locked) ? (
                    <p data-testid="source-venue-split-unknown" className="lt-hint">
                      {t('Split not reported')}
                    </p>
                  ) : null}
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
                <td data-cell="total" data-label={t('Total')}>
                  {displayAmount(row.total)}
                </td>
                <td data-cell="withdrawable" data-label={t('Can withdraw')}>
                  {displayAmount(row.withdrawable)}
                </td>
                <ValueCells valued={valued} asset={row.asset} source={t('Source venue', { venue: status.venue.displayName })} t={t} />
              </tr>
            ))}
          </SourceTable>
        )}
        {data && vaults.length > 0 ? (
          <div data-testid="source-venue-vaults">
            <h3>{t('Vaults title')}</h3>
            <SourceTable
              label={t('Vaults title')}
              headers={[t('Vault'), t('Asset'), t('Amount'), t('Lock-up ends'), ...VALUE_HEADERS.map((h) => t(h))]}
            >
              {vaults.map((p) => (
                <tr key={p.vault} data-vault={p.vault} data-asset={p.asset}>
                  <td data-label={t('Vault')}>{p.name}</td>
                  <td data-label={t('Asset')}>{p.asset}</td>
                  <td data-cell="amount" data-label={t('Amount')} data-value={p.equity}>
                    {displayAmount(p.equity)}
                  </td>
                  <td data-cell="ends" data-label={t('Lock-up ends')} data-value={p.lockUpEndsAt}>
                    {new Date(p.lockUpEndsAt).toLocaleString()}
                  </td>
                  <ValueCells
                    valued={valued}
                    asset={p.asset}
                    rowKey={`vault:${p.vault}`}
                    source={t('Source venue vault', { venue: venueName })}
                    t={t}
                  />
                </tr>
              ))}
            </SourceTable>
          </div>
        ) : null}
        {data ? <StakingLines data={data} venue={venueName} t={t} /> : null}
        {data && !data.vaults.read ? (
          <p className="lt-hint" data-testid="source-venue-vaults-unread">
            {t('Vaults unread', { venue: venueName, detail: data.vaults.detail })}
          </p>
        ) : null}
        {totals ? (
          <p
            data-testid="source-venue-account-value"
            data-asset={totals.asset}
            data-venue={totals.venue}
            data-parts={totals.parts}
            data-adds-up={parseAmount(totals.venue) === parseAmount(totals.parts) ? 'true' : 'false'}
          >
            {t('Account value', { venue: venueName, amount: displayAmount(totals.venue), asset: totals.asset })}{' '}
            {parseAmount(totals.venue) === parseAmount(totals.parts)
              ? t('Parts add up', { amount: displayAmount(totals.parts), asset: totals.asset })
              : t('Parts differ', { amount: displayAmount(totals.parts), asset: totals.asset, venue: venueName })}
          </p>
        ) : null}
      </section>
    </Source>
  );
}

/**
 * The partner account on Assets when no wallet or venue is read (the venue door off): the money the partner bank holds,
 * as it reports it, with its own time. Nothing when the partner holds none of this person's money.
 */
export function PartnerAccount() {
  const { t } = whereCopy.useCopy();
  const { displayCurrency } = usePreferences();
  const { partner, valued } = usePartnerStanding(displayCurrency === 'BTC' ? 'BTC' : 'USD');
  if (partner.state === 'none') return null;
  // With the venue door off the partner's lines are in the bank's own activity list, which lists them for this person.
  return (
    <PartnerSource read={partner} valued={valued} t={t} entriesHref={(asset) => `/money/activity?asset=${encodeURIComponent(asset)}`} />
  );
}

/** The partner account, when the partner holds the person's bank money: each asset as the partner reports it. */
function PartnerSource({
  read,
  valued,
  t,
  entriesHref,
}: {
  read: Exclude<PartnerRead, { state: 'none' }>;
  valued: ValuedPart | undefined;
  t: T;
  entriesHref?: (asset: string) => string;
}) {
  const title = read.state === 'read' ? t('Partner title', { partner: read.label }) : t('Partner title unnamed');
  return (
    <Source title={title}>
      <section data-testid="source-partner" data-source="partner" aria-label={title}>
        <p>
          {t('Partner source')} {read.state === 'read' ? <AsOf iso={read.asOf} /> : null}
        </p>
        {read.state === 'reading' ? (
          <p className="lt-hint">{t('Reading')}</p>
        ) : read.state === 'unread' ? (
          <p role="alert">{t('Partner read failed')}</p>
        ) : (
          <SourceTable label={title} headers={[t('Asset'), t('Amount'), ...VALUE_HEADERS.map((h) => t(h))]}>
            {read.rows.map((row) => (
              <tr key={row.asset} data-asset={row.asset}>
                <td data-label={t('Asset')}>{row.asset}</td>
                <td data-cell="amount" data-label={t('Amount')}>
                  {displayAmount(row.amount)}
                </td>
                <ValueCells
                  valued={valued}
                  asset={row.asset}
                  source={t('Source partner', { partner: read.label })}
                  t={t}
                  entriesHref={entriesHref?.(row.asset)}
                />
              </tr>
            ))}
          </SourceTable>
        )}
      </section>
    </Source>
  );
}
