import { useMemo, useState, type ReactNode } from 'react';
import { Info } from 'lucide-react';
import { AssetIcon, Button, ButtonLink, Fold, PanelHead, Tag } from '@intafaced/ui/lit';
import { Sheet } from '@intafaced/ui/lit/templates';
import { PartnerHolds } from '../../features/money';
import { displayAmount, formatAmount, parseAmount } from '../../shared/money';
import { mul } from '@intafaced/money-math';
import { useSession } from '../../features/session';
import { createVenueAccountApi } from '../../features/protocol/venue-wallet/venue-account-api';
import { useResource } from '../../shared/resource';
import { networkLabel } from '../../features/protocol/blockers';
import { APP_CHAIN_ID } from '../../features/protocol/wallet/eip1193';
import { WalletProvider } from '../../features/protocol/wallet/WalletProvider';
import { useAsOfText, useOwner } from '../../features/trade/venue/VenueKit';
import { WalletBar } from '../../features/trade/permissions/venue-parts';
import type { VenueUp } from '../../features/trade/venue-api';
import { usePreferences } from '../../shared/preferences';
import { shortOrderId, type WalletRead } from './where-it-sits';
import { whereCopy } from './where-it-sits-copy';
import { assetName, moneyCopy } from './copy';
import { VALUATION_REFRESH_MS, usePartnerStanding, useStanding, venueTotals, type PartnerRead, type VenueRead } from './standing-data';
import type { Standing, ValuedPart } from './standing';
import type { MoneyView } from './portfolio-source';
import { StandingTotal, dollars } from './StandingTotal';
import { ChangeLine, Shown, signOf } from './money-parts';
import { fmtChangeLine } from './deps';
import { WhereTiles } from './WhereTiles';
import { ValuationNote } from './ValuationNote';
import { Movers, spokenOf } from './Movers';
import { clockTime } from './time';
import { WhereAllocation } from './WhereAllocation';
import { WhereHoldingsChange } from './WhereHoldingsChange';
import { isHiddenPath, navigate } from './deps';
import { AssetsPage, MoneyRoomLinks } from './MoneyRoom';
import { buyHref } from './links';
import { balanceEntriesHref } from './balance-entries-model';
import { SourceActivity } from './SourceActivity';
import { NO_FILTERS } from './activity-filter';
import { WhereSide, type DepositsRead } from './WhereSide';

/** How many lines of activity Assets shows; the rest are on /money/activity. */
const RECENT_LINES = 5;

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
  const [withdrawOpen, setWithdrawOpen] = useState(() => new URLSearchParams(location.search).get('withdraw') === 'partner');
  const openWithdraw = () => {
    setWithdrawOpen(true);
    navigate('/money?withdraw=partner');
  };
  const closeWithdraw = () => {
    setWithdrawOpen(false);
    navigate('/money');
  };
  return (
    <div data-testid="assets-by-source" className="money-where">
      {owner ? (
        <Read owner={owner} status={status} chainId={chainId} t={t} onWithdraw={openWithdraw} />
      ) : (
        <BeforeWallet t={t} onWithdraw={openWithdraw} />
      )}
      <Sheet
        open={withdrawOpen}
        title={t('Partner withdraw')}
        onClose={closeWithdraw}
        closeLabel={t('Partner withdraw close')}
        testId="partner-withdraw-sheet"
      >
        <PartnerHolds />
      </Sheet>
    </div>
  );
}

/**
 * Assets before a wallet is connected: the partner account needs no wallet to be read, so the money the partner
 * holds for this person is listed with its total, each figure as the partner reports it with its time, exactly as Home
 * shows it. The wallet and the venue account join once a wallet is connected, and the line under the total says so.
 */
function BeforeWallet({ t, onWithdraw }: { t: T; onWithdraw: () => void }) {
  const { displayCurrency, hideBalances } = usePreferences();
  const { partner, standing, pricesFailed, valued } = usePartnerStanding(displayCurrency === 'BTC' ? 'BTC' : 'USD');
  const held = partner.state === 'read' || partner.state === 'unread';
  return (
    <AssetsPage
      title={t('Title')}
      description={t('Lede')}
      roomAction={<MoneyRoomLinks />}
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
            <PartnerSource read={partner} valued={valued} hidden={hideBalances} t={t} onWithdraw={onWithdraw} />
          </div>
        )
      }
      watching={<WalletBar />}
    />
  );
}

function Read({
  owner,
  status,
  chainId,
  t,
  onWithdraw,
}: {
  owner: string;
  status: VenueUp;
  chainId: number;
  t: T;
  onWithdraw: () => void;
}) {
  const { displayCurrency, hideBalances, timeZone } = usePreferences();
  const money = moneyCopy.useCopy();
  const network = networkLabel(chainId).name;
  const { wallet, venue, partner, standing, pricesFailed, prices } = useStanding(
    owner,
    chainId,
    { network, venue: status.venue.displayName, venueTest: status.test },
    displayCurrency === 'BTC' ? 'BTC' : 'USD',
  );
  // The venue's deposits, read once: the Moving tile, the line under the total and Moving now all show this one read.
  const { api } = useSession();
  const account = useMemo(() => createVenueAccountApi(api), [api]);
  const { resource: deposits } = useResource((signal) => account.deposits(owner, signal), `where-moving:${owner}`);
  const part = (id: ValuedPart['id']) => standing.parts.find((p) => p.id === id);
  const valuation = standing.prices && standing.valuation && standing.valuation.rows.length > 0 ? standing.valuation : null;
  const sinceLabel =
    valuation && valuation.windowStart !== null
      ? money.t('Movers since {time}', { time: clockTime(valuation.windowStart, timeZone) })
      : money.t('Today');
  return (
    <AssetsPage
      title={t('Title')}
      titleHidden
      hero={
        <div className="lt-stack">
          <div className="money-where__head">
            {standing.prices || pricesFailed ? (
              <section className="money-where__total" aria-labelledby="assets-total-title">
                <h2 id="assets-total-title" className="lt-hint">
                  {totalLine(standing, t)}
                </h2>
                <StandingTotal
                  standing={standing}
                  pricesFailed={pricesFailed}
                  displayCurrency={displayCurrency}
                  hidden={hideBalances}
                  testId="assets-total"
                  face="headline"
                  lineStart={valuation ? <TodayChange view={valuation} hidden={hideBalances} /> : undefined}
                  lineEnd={<MovingLine deposits={deposits} standing={standing} hidden={hideBalances} t={t} />}
                  foldLead={
                    <p className="lt-hint" data-testid="assets-lede">
                      {t('Lede')}
                    </p>
                  }
                  foldMore={
                    <>
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
                      {valuation ? <Movers view={valuation} hidden={hideBalances} copy={money} sinceLabel={sinceLabel} /> : null}
                    </>
                  }
                />
              </section>
            ) : (
              <span />
            )}
            <QuickActions t={t} />
          </div>
          <WhereTiles standing={standing} venue={venue} wallet={wallet} deposits={deposits} hidden={hideBalances} t={t} />
          {standing.totalUsd !== null ? (
            <Fold title={t('Allocation fold')} data-testid="assets-allocation-fold">
              <WhereAllocation standing={standing} venueRows={venue.data?.rows ?? []} />
            </Fold>
          ) : null}
        </div>
      }
      sections={
        <div className="lt-stack money-where__sections">
          <VenueSource
            status={status}
            read={venue}
            valued={part('venue')}
            hidden={hideBalances}
            t={t}
            change={<WhereHoldingsChange owner={owner} prices={prices} hidden={hideBalances} t={t} />}
          />
          <WalletSource owner={owner} network={network} read={wallet} valued={part('wallet')} hidden={hideBalances} t={t} />
          {partner.state === 'none' ? null : (
            <PartnerSource read={partner} valued={part('partner')} hidden={hideBalances} t={t} onWithdraw={onWithdraw} />
          )}
          <section className="lt-stack" aria-labelledby="assets-recent-title" data-testid="assets-recent">
            <PanelHead
              title={<span id="assets-recent-title">{t('Activity title')}</span>}
              aside={isHiddenPath('/money/activity') ? undefined : <a href="/money/activity">{t('Recent all')}</a>}
            />
            <SourceActivity status={status} filters={NO_FILTERS} asset={null} hidden={hideBalances} recent={RECENT_LINES} />
          </section>
          {standing.prices ? null : (
            <p className="lt-hint" data-testid="assets-no-price-note">
              {t('No price note')}
            </p>
          )}
        </div>
      }
      watching={
        <div className="lt-stack money-where__side">
          <WhereSide owner={owner} deposits={deposits} t={t} />
        </div>
      }
    />
  );
}

const TOTAL_PART = { wallet: 'Total part wallet', venue: 'Total part venue', partner: 'Total part partner' } as const;

/** What the total adds up, in words: each part it is made of, at the prices it is valued at. */
function totalLine(standing: Standing, t: T): string {
  const names = standing.parts.map((p) =>
    p.id === 'partner' && !p.label ? t('Total part partner unnamed') : t(TOTAL_PART[p.id], { partner: p.label }),
  );
  if (names.length === 0) return t('Total title');
  const parts =
    names.length === 1 ? (names[0] ?? '') : t('Total line and', { a: names.slice(0, -1).join(', '), b: names[names.length - 1] ?? '' });
  return t('Total line', { parts });
}

/** Today's change of what is priced, as Portfolio's headline says it: the amount and percent, then since when. */
function TodayChange({ view, hidden }: { view: MoneyView; hidden: boolean }) {
  const money = moneyCopy.useCopy();
  const { timeZone } = usePreferences();
  // A holding of cash and dollar coins only has no price moves, as on Portfolio: "$0.00 (0.00%) Today" would say nothing.
  if (view.change24hUsd === null || !/[1-9]/.test(view.cryptoUsd ?? '')) return null;
  const label =
    view.windowStart !== null
      ? money.t('Since {time}', { time: clockTime(view.windowStart, timeZone) })
      : view.source === 'derived'
        ? money.t('Today, from price moves')
        : money.t('Today');
  return (
    <span data-testid="assets-change">
      <ChangeLine
        text={fmtChangeLine(view.change24hUsd, view.change24hPct)}
        sign={signOf(view.change24hUsd)}
        hidden={hidden}
        spoken={spokenOf(money)}
      />{' '}
      {label} ·
    </span>
  );
}

/**
 * What is moving into the venue, after the parts on the line under the total: never added into the total, and said so,
 * since the venue counts it only once it credits it. Nothing while nothing is moving or the venue has not said.
 */
function MovingLine({ deposits, standing, hidden, t }: { deposits: DepositsRead; standing: Standing; hidden: boolean; t: T }) {
  if (deposits.status !== 'ready') return null;
  const moving = deposits.data.value.filter((d) => d.status === 'confirming');
  if (moving.length === 0) return null;
  const price = (asset: string) => {
    for (const p of standing.parts) for (const row of p.rows) if (row.asset === asset && row.priceUsd !== null) return row.priceUsd;
    return null;
  };
  const unpriced = [...new Set(moving.filter((d) => price(d.asset) === null).map((d) => d.asset))];
  if (unpriced.length > 0)
    return <span data-testid="assets-moving-line"> · {t('Line moving unpriced', { assets: unpriced.join(', ') })}</span>;
  const total = moving.reduce((sum, d) => sum + mul(parseAmount(d.amount), parseAmount(price(d.asset) ?? '0'), 'half-up'), 0n);
  return (
    <span data-testid="assets-moving-line" data-value-usd={formatAmount(total)}>
      {' · '}
      {t('Line moving')} <Shown text={dollars(formatAmount(total))} hidden={hidden} />, {t('Line moving note')}
    </span>
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

/** "4 s ago", "3 min ago": how long ago a source's figures were read, at this drawing (each poll draws it again). */
function agoText(iso: string, t: T): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return '';
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 2) return t('Ago now');
  if (seconds < 60) return t('Ago seconds', { n: String(seconds) });
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return t('Ago minutes', { n: String(minutes) });
  return t('Ago hours', { n: String(Math.floor(minutes / 60)) });
}

/** A source's read time on its panel's face, relative; the exact time is its title and is in the panel's fold. */
function ReadAgo({ iso, words, t }: { iso: string; words: 'Read venue' | 'Read chain' | 'Read partner'; t: T }) {
  const exact = useAsOfText();
  return (
    <span className="lt-hint" title={exact(iso)} data-testid="source-read-ago">
      {t(words, { ago: agoText(iso, t) })}
    </span>
  );
}

/** Where the person goes from the total (J-portfolio-01 #1): each a real room on the launch model, none a dead end. */
const ACTIONS = [
  { id: 'Fund venue', href: () => (isHiddenPath('/wallet/venue') ? null : '/wallet/venue') },
  { id: 'Withdraw venue', href: () => (isHiddenPath('/wallet/venue') ? null : '/wallet/venue#withdraw') },
  { id: 'Convert', href: () => (isHiddenPath('/trade/convert') ? null : '/trade/convert') },
  { id: 'Trade', href: () => buyHref(null, null, false, 'pro') },
] as const;

/** The action keys beside the total: money in first, the one lit key; the rest secondary (owner's pick A). */
function QuickActions({ t }: { t: T }) {
  const live = ACTIONS.flatMap((action) => {
    const href = action.href();
    return href ? [{ id: action.id, href }] : [];
  });
  return (
    <nav data-testid="assets-actions" className="lt-actions money-where__actions" aria-label={t('Actions')}>
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
 * The link to the records behind one row's figure (J-portfolio-01 #6): the row's info mark beside the asset's name.
 * Its name says what it opens for this asset and source; its title says it to a pointer.
 */
function EntriesLink({ href, asset, source, t }: { href: string; asset: string; source: string; t: T }) {
  return (
    <a
      data-testid="source-entries-link"
      className="lt-hint money-where__entries"
      href={href}
      title={t('Entries link')}
      aria-label={t('Entries link label', { asset, source })}
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
        event.preventDefault();
        navigate(href);
      }}
    >
      <Info size={14} aria-hidden="true" />
    </a>
  );
}

/** Where a row's records are listed: the given room (the venue door off: the bank's list), else the sources' records. */
function entriesHrefOf(valued: ValuedPart | undefined, asset: string, entriesHref?: string): string | null {
  return entriesHref ?? (valued ? `${balanceEntriesHref(asset)}?source=${valued.id}` : null);
}

/** The asset cell: its mark, its symbol with the info mark to what makes the row's figure, and under it its full name. */
function AssetCell({
  asset,
  label,
  entries,
  t,
}: {
  asset: string;
  label?: string;
  entries: { href: string; source: string } | null;
  t: T;
}) {
  const money = moneyCopy.useCopy();
  const name = assetName(asset, money);
  return (
    <td data-label={t('Asset')}>
      <span className="lt-cell-name">
        <AssetIcon asset={asset} />
        <span>
          <span className="money-where__asset">
            <strong>{label ?? asset}</strong>
            {entries ? <EntriesLink href={entries.href} asset={asset} source={entries.source} t={t} /> : null}
          </span>
          {name && name !== (label ?? asset) ? <span className="lt-hint">{name}</span> : null}
        </span>
      </span>
    </td>
  );
}

/**
 * The price, value, share and source cells of `asset` in a valued part (J-portfolio-01 #1): the published price, dollars
 * to the cent, its share of the total, and the source that reports it. An asset with no published price shows "No price
 * published" for its price and value and no share, never a zero. The face shows the value; price, share and source stay
 * in the row for assistive tech and the journeys, visually hidden (owner's pick A: Asset, amounts, Value, one action).
 */
function ValueCells({
  valued,
  asset,
  rowKey,
  source,
  t,
}: {
  valued: ValuedPart | undefined;
  asset: string;
  /** A row the source holds apart from its plain balance of `asset` (a vault position); none: the plain balance. */
  rowKey?: string;
  source: string;
  t: T;
}) {
  const row = valued?.rows.find((r) => r.asset === asset && r.key === rowKey);
  return (
    <>
      <td data-cell="price" data-label={t('Price')} data-align="end" className="lt-num">
        {row?.priceUsd ? dollars(row.priceUsd) : t('No price published')}
      </td>
      <td data-cell="value" data-label={t('Value')} data-align="end" className="lt-num">
        {row?.valueUsd ? dollars(row.valueUsd) : t('No price published')}
      </td>
      <td data-cell="share" data-label={t('Share')} data-align="end" className="lt-num">
        {row?.share ? t('Share of total', { share: row.share }) : '—'}
      </td>
      <td data-cell="source" data-label={t('Source')} data-source={valued?.id ?? ''} className="lt-hint">
        {source}
      </td>
    </>
  );
}

/** One table header cell; `hidden` ones name a column kept for assistive tech only. */
type Head = { text: string; hidden?: boolean; end?: boolean; action?: boolean };

const valueHeads = (t: T): Head[] => [
  { text: t('Price'), end: true },
  { text: t('Value'), end: true },
  { text: t('Share'), end: true },
  { text: t('Source') },
];

/** A source's table in a named region: one header row, then the rows. */
function SourceTable({ headers, children, label }: { headers: readonly Head[]; children: ReactNode; label: string }) {
  return (
    <div tabIndex={0} role="region" aria-label={label} className="money-where__table">
      <table className="lt-table">
        <thead>
          <tr>
            {headers.map((head, index) => (
              <th
                key={index}
                scope="col"
                className={head.hidden && !head.action ? 'lt-sr' : undefined}
                data-align={head.end ? 'end' : undefined}
              >
                {head.action ? <span className="lt-sr">{head.text}</span> : head.text}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

/**
 * The head of one source's section (the owner's Money target, 25 Nov): its name and the value of what is priced in it
 * across one row; under them its place as a chip, one line on what it is, and when it was read (relative; the exact time
 * is the title). Anything else the source says goes in the section's fold.
 */
function PanelTop({
  chip,
  title,
  mark,
  line,
  read,
  valueUsd,
  hidden,
  action,
  t,
}: {
  chip: string;
  title: string;
  mark?: ReactNode;
  line?: string;
  read: ReactNode;
  valueUsd: string | null | undefined;
  hidden: boolean;
  action?: ReactNode;
  t: T;
}) {
  return (
    <div className="lt-stack lt-stack-tight">
      <div className="lt-panel-head money-where__panel-head">
        <span className="lt-row">
          <h2 className="lt-panel-title">{title}</h2>
          {mark}
        </span>
        <span className="lt-row">
          {valueUsd ? (
            <strong className="lt-num" title={t('Panel total')}>
              <span className="lt-sr">{t('Panel total')} </span>
              <Shown text={dollars(valueUsd)} hidden={hidden} />
            </strong>
          ) : null}
          {action}
        </span>
      </div>
      <span className="lt-row lt-hint">
        <Tag tone="neutral">{chip}</Tag>
        <span>
          {line}
          {line && read ? ' · ' : null}
          {read}
        </span>
      </span>
    </div>
  );
}

type Polled<D> = { data: D | null; failure: { message?: string } | null };

function WalletSource({
  owner,
  network,
  read,
  valued,
  hidden,
  t,
}: {
  owner: string;
  network: string;
  read: Polled<WalletRead>;
  valued: ValuedPart | undefined;
  hidden: boolean;
  t: T;
}) {
  const data = read.data;
  const move = isHiddenPath('/wallet/venue') ? null : '/wallet/venue';
  return (
    <section className="lt-stack" data-testid="source-wallet" data-source="chain" data-address={owner} aria-label={t('Wallet title')}>
      <PanelTop
        chip={network}
        title={t('Wallet title')}
        line={t('Wallet line')}
        read={data?.ok ? <ReadAgo iso={data.asOf} words="Read chain" t={t} /> : null}
        valueUsd={data?.ok ? valued?.valueUsd : null}
        hidden={hidden}
        t={t}
      />
      {!data ? (
        <p className="lt-hint">{t('Reading')}</p>
      ) : !data.ok ? (
        <p role="alert">{t('Wallet read failed')}</p>
      ) : data.rows.length === 0 ? (
        <p className="lt-hint">{t('Wallet empty')}</p>
      ) : (
        <SourceTable
          label={t('Wallet network totals', { network })}
          headers={[{ text: t('Asset') }, { text: t('Amount'), end: true }, ...valueHeads(t), { text: t('Row action'), action: true }]}
        >
          {data.rows.map((row) => {
            const source = t('Source wallet', { network, block: data.block });
            const href = entriesHrefOf(valued, row.symbol);
            return (
              <tr key={row.symbol} data-asset={row.symbol} data-token={row.token ?? 'native'}>
                <AssetCell asset={row.symbol} entries={href ? { href, source } : null} t={t} />
                <td data-cell="amount" data-label={t('Amount')} data-align="end" className="lt-num">
                  {displayAmount(row.amount)}
                </td>
                <ValueCells valued={valued} asset={row.symbol} source={source} t={t} />
                <td data-label={t('Row action')} data-align="end">
                  {move ? (
                    <ButtonLink tone="secondary" size="sm" href={move}>
                      {t('Move to venue')}
                    </ButtonLink>
                  ) : null}
                </td>
              </tr>
            );
          })}
        </SourceTable>
      )}
      <Fold title={t('Worked out')}>
        <div className="lt-stack lt-stack-tight">
          <p className="lt-hint">
            {t('Wallet address')}:{' '}
            <span data-testid="source-wallet-address" className="lt-mono">
              {owner}
            </span>
          </p>
          {data?.ok ? (
            <>
              <p className="lt-hint" data-testid="source-wallet-block" data-block={data.block}>
                {t('Wallet source', { block: data.block })} <AsOf iso={data.asOf} />
              </p>
              <h3 className="lt-hint" data-testid="source-wallet-network" data-chain-id={String(data.chainId)}>
                {t('Wallet network', { network, chainId: String(data.chainId) })}
              </h3>
              {data.unread.length > 0 ? (
                <p className="lt-hint" data-testid="source-wallet-unread">
                  {t('Wallet unread', { tokens: data.unread.join(', ') })}
                </p>
              ) : null}
            </>
          ) : null}
        </div>
      </Fold>
    </section>
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

const nonZero = (amount: string) => /[1-9]/.test(amount);

function VenueSource({
  status,
  read,
  valued,
  hidden,
  t,
  change,
}: {
  status: VenueUp;
  read: Polled<VenueRead>;
  valued: ValuedPart | undefined;
  hidden: boolean;
  t: T;
  /** What the venue account held then and now (J-portfolio-06 #3), kept in the panel's fold, off its face. */
  change?: ReactNode;
}) {
  const data = read.data;
  const vaults = data?.vaults.read ? data.vaults.holdings.positions : [];
  const totals = data ? venueTotals(data) : null;
  const venueName = status.venue.displayName;
  const title = t('Venue title', { venue: venueName });
  return (
    <section className="lt-stack" data-testid="source-venue" data-source="venue" aria-label={title}>
      <PanelTop
        chip={venueName}
        title={title}
        line={t('Venue line')}
        mark={
          status.test ? (
            <span className="lt-test" data-testid="source-venue-test" title={t('TEST note')}>
              {t('TEST')}
            </span>
          ) : null
        }
        read={data ? <ReadAgo iso={data.asOf} words="Read venue" t={t} /> : null}
        valueUsd={data ? valued?.valueUsd : null}
        hidden={hidden}
        t={t}
      />
      {read.failure && !data ? (
        <p role="alert">{t('Venue read failed', { detail: read.failure.message ?? '' })}</p>
      ) : !data ? (
        <p className="lt-hint">{t('Reading')}</p>
      ) : data.rows.length === 0 && vaults.length === 0 ? (
        <p className="lt-hint">{t('Venue empty')}</p>
      ) : data.rows.length === 0 ? null : (
        <SourceTable
          label={title}
          headers={[
            { text: t('Asset') },
            { text: t('Free'), end: true },
            { text: t('Locked'), end: true },
            { text: t('Total'), hidden: true },
            { text: t('Can withdraw'), hidden: true },
            ...valueHeads(t),
            { text: t('Row action'), action: true },
          ]}
        >
          {data.rows.map((row) => {
            const source = t('Source venue', { venue: venueName });
            const href = entriesHrefOf(valued, row.asset);
            const trade = buyHref(row.asset, null, false);
            return (
              <tr key={row.asset} data-asset={row.asset}>
                <AssetCell asset={row.asset} entries={href ? { href, source } : null} t={t} />
                <td data-cell="free" data-label={t('Free')} data-align="end" className="lt-num">
                  {displayAmount(row.free)}
                </td>
                <td data-cell="locked" data-label={t('Locked')} title={t('Locked note')} data-align="end" className="lt-num">
                  {displayAmount(row.locked)}
                  {row.split ? (
                    // Each part of the lock as the venue names it; a part at zero stays for assistive tech, off the face.
                    <ul data-testid="source-venue-split" className="lt-hint money-where__cell-notes">
                      <li
                        data-part="in-orders"
                        data-amount={row.split.inOrders}
                        className={nonZero(row.split.inOrders) ? undefined : 'lt-sr'}
                      >
                        {t('In orders', { amount: displayAmount(row.split.inOrders) })}
                      </li>
                      <li
                        data-part="collateral"
                        data-amount={row.split.collateral}
                        className={nonZero(row.split.collateral) ? undefined : 'lt-sr'}
                      >
                        {t('Collateral', { amount: displayAmount(row.split.collateral) })}
                      </li>
                      <li data-part="stake" data-amount={row.split.stake} className={nonZero(row.split.stake) ? undefined : 'lt-sr'}>
                        {t('Stake', { amount: displayAmount(row.split.stake) })}
                      </li>
                      {row.split.delegated !== undefined ? (
                        <li
                          data-part="delegated"
                          data-amount={row.split.delegated}
                          className={nonZero(row.split.delegated) ? undefined : 'lt-sr'}
                        >
                          {t('Delegated', { amount: displayAmount(row.split.delegated) })}
                        </li>
                      ) : null}
                      {row.split.unstaking !== undefined ? (
                        <li
                          data-part="unstaking"
                          data-amount={row.split.unstaking}
                          className={nonZero(row.split.unstaking) ? undefined : 'lt-sr'}
                        >
                          {t('Unstaking', { amount: displayAmount(row.split.unstaking) })}
                        </li>
                      ) : null}
                    </ul>
                  ) : nonZero(row.locked) ? (
                    <p data-testid="source-venue-split-unknown" className="lt-hint">
                      {t('Split not reported')}
                    </p>
                  ) : null}
                  {row.orders.length > 0 ? (
                    <ul data-testid="source-venue-locks" className="lt-hint money-where__cell-notes">
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
                <td data-cell="total" data-label={t('Total')} className="lt-sr">
                  {displayAmount(row.total)}
                </td>
                <td data-cell="withdrawable" data-label={t('Can withdraw')} className="lt-sr">
                  {displayAmount(row.withdrawable)}
                </td>
                <ValueCells valued={valued} asset={row.asset} source={source} t={t} />
                <td data-label={t('Row action')} data-align="end">
                  {trade ? (
                    <ButtonLink tone="secondary" size="sm" href={trade}>
                      {t('Trade')}
                    </ButtonLink>
                  ) : null}
                </td>
              </tr>
            );
          })}
        </SourceTable>
      )}
      {data && vaults.length > 0 ? (
        <div data-testid="source-venue-vaults" className="lt-stack lt-stack-tight">
          <h3 className="lt-panel-title">{t('Vaults title')}</h3>
          <SourceTable
            label={t('Vaults title')}
            headers={[
              { text: t('Vault') },
              { text: t('Asset') },
              { text: t('Amount'), end: true },
              { text: t('Lock-up ends') },
              ...valueHeads(t),
            ]}
          >
            {vaults.map((p) => (
              <tr key={p.vault} data-vault={p.vault} data-asset={p.asset}>
                <td data-label={t('Vault')}>{p.name}</td>
                <AssetCell asset={p.asset} entries={null} t={t} />
                <td data-cell="amount" data-label={t('Amount')} data-value={p.equity} data-align="end" className="lt-num">
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
      {/* J-cex-spot-21 #8 and J-derivatives-31 #3 name these on the face: staking rewards and how the staked parts add
          up, where the account holds any staking; and with vaults held, that the parts add to the venue's total. */}
      {data ? <StakingLines data={data} venue={venueName} t={t} /> : null}
      {data && totals && vaults.length > 0 ? <AccountValue totals={totals} venueName={venueName} t={t} /> : null}
      {data || change ? (
        <Fold title={t('Worked out')} data-testid="source-venue-worked-out">
          <div className="lt-stack">
            {data ? <VenueLines data={data} totals={vaults.length > 0 ? null : totals} venueName={venueName} t={t} /> : null}
            {change}
          </div>
        </Fold>
      ) : null}
    </section>
  );
}

/** The venue panel's own lines in its fold: where its figures come from, its staking, its vaults, its account value. */
function VenueLines({
  data,
  totals,
  venueName,
  t,
}: {
  data: VenueRead;
  totals: ReturnType<typeof venueTotals> | null;
  venueName: string;
  t: T;
}) {
  return (
    <div className="lt-stack lt-stack-tight">
      <p className="lt-hint">
        {t('Venue source')} <AsOf iso={data.asOf} />
      </p>
      {!data.vaults.read ? (
        <p className="lt-hint" data-testid="source-venue-vaults-unread">
          {t('Vaults unread', { venue: venueName, detail: data.vaults.detail })}
        </p>
      ) : null}
      {totals ? <AccountValue totals={totals} venueName={venueName} t={t} /> : null}
    </div>
  );
}

/** What the venue counts the account at, and whether the balances and vault positions shown add up to it. */
function AccountValue({ totals, venueName, t }: { totals: NonNullable<ReturnType<typeof venueTotals>>; venueName: string; t: T }) {
  const addsUp = parseAmount(totals.venue) === parseAmount(totals.parts);
  return (
    <p
      className="lt-hint"
      data-testid="source-venue-account-value"
      data-asset={totals.asset}
      data-venue={totals.venue}
      data-parts={totals.parts}
      data-adds-up={addsUp ? 'true' : 'false'}
    >
      {t('Account value', { venue: venueName, amount: displayAmount(totals.venue), asset: totals.asset })}{' '}
      {addsUp
        ? t('Parts add up', { amount: displayAmount(totals.parts), asset: totals.asset })
        : t('Parts differ', { amount: displayAmount(totals.parts), asset: totals.asset, venue: venueName })}
    </p>
  );
}

/**
 * The partner account on Assets when no wallet or venue is read (the venue door off): the money the partner bank holds,
 * as it reports it, with its own time. Nothing when the partner holds none of this person's money.
 */
export function PartnerAccount() {
  const { t } = whereCopy.useCopy();
  const { displayCurrency, hideBalances } = usePreferences();
  const { partner, valued } = usePartnerStanding(displayCurrency === 'BTC' ? 'BTC' : 'USD');
  if (partner.state === 'none') return null;
  // With the venue door off the partner's lines are in the bank's own activity list, which lists them for this person.
  return (
    <PartnerSource
      read={partner}
      valued={valued}
      hidden={hideBalances}
      t={t}
      entriesHref={(asset) => `/money/activity?asset=${encodeURIComponent(asset)}`}
    />
  );
}

/** The partner account, when the partner holds the person's bank money: each asset as the partner reports it. */
function PartnerSource({
  read,
  valued,
  hidden,
  t,
  entriesHref,
  onWithdraw,
}: {
  read: Exclude<PartnerRead, { state: 'none' }>;
  valued: ValuedPart | undefined;
  hidden: boolean;
  t: T;
  entriesHref?: (asset: string) => string;
  onWithdraw?: () => void;
}) {
  const title = read.state === 'read' ? t('Partner title', { partner: read.label }) : t('Partner title unnamed');
  return (
    <section className="lt-stack" data-testid="source-partner" data-source="partner" aria-label={title}>
      <PanelTop
        chip={t('Chip partner')}
        title={title}
        read={read.state === 'read' ? <ReadAgo iso={read.asOf} words="Read partner" t={t} /> : null}
        valueUsd={read.state === 'read' ? valued?.valueUsd : null}
        hidden={hidden}
        action={
          onWithdraw && read.state === 'read' ? (
            <Button tone="secondary" onClick={onWithdraw}>
              {t('Partner withdraw')}
            </Button>
          ) : undefined
        }
        t={t}
      />
      {read.state === 'reading' ? (
        <p className="lt-hint">{t('Reading')}</p>
      ) : read.state === 'unread' ? (
        <p role="alert">{t('Partner read failed')}</p>
      ) : (
        <>
          <SourceTable label={title} headers={[{ text: t('Asset') }, { text: t('Amount'), end: true }, ...valueHeads(t)]}>
            {read.rows.map((row) => {
              const source = t('Source partner', { partner: read.label });
              const href = entriesHrefOf(valued, row.asset, entriesHref?.(row.asset));
              return (
                <tr key={row.asset} data-asset={row.asset}>
                  <AssetCell asset={row.asset} entries={href ? { href, source } : null} t={t} />
                  <td data-cell="amount" data-label={t('Amount')} data-align="end" className="lt-num">
                    {displayAmount(row.amount)}
                  </td>
                  <ValueCells valued={valued} asset={row.asset} source={source} t={t} />
                </tr>
              );
            })}
          </SourceTable>
          <Fold title={t('Worked out')}>
            <p className="lt-hint">
              {t('Partner source')} <AsOf iso={read.asOf} />
            </p>
          </Fold>
        </>
      )}
    </section>
  );
}
