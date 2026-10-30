import { useContext, useEffect, useMemo, useState } from 'react';
import { ChevronDown, Eye, EyeOff } from 'lucide-react';
import { AllocationBar } from './allocation-chart';
import { assetName, moneyCopy } from './copy';
import {
  Amount,
  Button,
  ChangeText,
  CoinIcon,
  Collapsible,
  CollapsiblePanel,
  CollapsibleTrigger,
  dec,
  decOrNull,
  fmtAmount,
  fmtChangeLine,
  fmtPct,
  fmtUsd,
  HeroNumber,
  isHiddenPath,
  Money,
  primarySymbolFor,
  refusalCopy,
  roundScaled,
  SCALE,
  Skeleton,
  StateBlock,
  toFixedString,
  useMarkets,
  type BalanceEntry,
  type Loadable,
  type MarketRow,
} from './deps';
import { balanceEntriesHref } from './balance-entries-model';
import { allAdd, heldFor, spacesFor, type Held, type Spaces } from './held-breakdown';
import { setAsideWhat } from './set-aside';
import { setAsideLabel } from './SetAside';
import { InfoTip } from './InfoTip';
import { buyHref } from './links';
import { clockTime } from './time';
import {
  SUMMARY_INTERVAL,
  useAssetBalances,
  useLockSplits,
  moneyUnitOf,
  useDisplayRate,
  type DisplayRate,
  useMoneyPortfolio,
  useNamedAccounts,
  type MoneyRow,
  type MoneyView,
  type NamedAccount,
} from './portfolio-source';
import { DerivedTotalNote } from './total-note';
import { USD_UNIT, UnitContext, changeText, useValueText, type ValueUnit } from './display-unit';
import { Movers } from './Movers';
import { fmtCoinPrice } from './price-text';
import { ValuationNote } from './ValuationNote';
import { HoldingsChange } from './HoldingsChange';
import { savePreferences, usePreferences } from '../../shared/preferences';

type Copy = ReturnType<typeof moneyCopy.useCopy>;

/** A change line (amount and percent) in the chosen unit. */
function useChangeText(): (usd: string | null, pct: string | null) => string {
  const unit = useContext(UnitContext);
  return (usd, pct) =>
    changeText(
      unit,
      usd,
      pct,
      (u, p) => fmtChangeLine(u, p),
      (p) => fmtPct(p),
    );
}

// ── where the buttons go ─────────────────────────────────────────────────────

type Mode = 'simple' | 'pro';
const PILLS = [
  { id: 'Buy', href: (mode: Mode) => buyHref(null, null, false, mode) },
  { id: 'Sell', href: (mode: Mode) => buyHref(null, null, true, mode) },
  { id: 'Convert', href: () => (isHiddenPath('/trade/convert') ? null : '/trade/convert') },
  { id: 'Send', href: () => (isHiddenPath('/pay/send') ? null : '/pay/send') },
  { id: 'Receive', href: () => (isHiddenPath('/pay/receive') ? null : '/pay/receive') },
] as const;
type PillId = (typeof PILLS)[number]['id'];
type PillMode = 'normal' | 'empty' | 'refused';
const PILLS_FOR: Record<PillMode, readonly PillId[] | null> = { normal: null, empty: ['Receive'], refused: ['Receive'] };
/** Real pill widths, so the skeletons are the final size. */
const PILL_WIDTH: Record<PillId, number> = { Buy: 64, Sell: 60, Convert: 88, Send: 72, Receive: 88 };

function livePills(mode: PillMode, layout: Mode) {
  const wanted = PILLS_FOR[mode];
  // A short list keeps its own order, so the first pill (the primary one) is the most useful: Receive, then Buy.
  const ordered = wanted ? wanted.map((id) => PILLS.find((pill) => pill.id === id)!) : PILLS;
  return ordered.flatMap((pill) => {
    const href = pill.href(layout);
    return href ? [{ id: pill.id, href }] : [];
  });
}

function ActionPills({ loading, mode, layout }: { loading: boolean; mode: PillMode; layout: Mode }) {
  const { t } = moneyCopy.useCopy();
  const pills = livePills(mode, layout);
  return (
    <nav data-testid="money-actions" className="money-actions" aria-label={t('Actions')}>
      {pills.map((pill, index) =>
        loading ? (
          <Skeleton key={pill.id} width={PILL_WIDTH[pill.id]} height={40} circle />
        ) : (
          <Button
            key={pill.id}
            variant={index === 0 && mode !== 'empty' ? 'primary' : 'secondary'}
            size={40}
            nativeButton={false}
            render={<a href={pill.href} />}
          >
            {t(pill.id)}
          </Button>
        ),
      )}
    </nav>
  );
}

// ── the headline ─────────────────────────────────────────────────────────────

/** A USD decimal rounded half-up to cents, as the string HeroNumber animates. Unknown stays null. */
function cents(value: string | null): string | null {
  const parsed = dec(value);
  return parsed === null ? null : toFixedString(roundScaled(parsed, 2), 2);
}

function satoshis(value: string | null): string | null {
  const parsed = dec(value);
  return parsed === null ? null : toFixedString(roundScaled(parsed, 8), 8);
}

function Headline({ view, hidden, copy, pro }: { view: MoneyView; hidden: boolean; copy: Copy; pro: boolean }) {
  const { t } = copy;
  const { timeZone, displayCurrency } = usePreferences();
  // The bank sends the BTC total and its price when asked; with no BTC price it says why and the dollar total stays on screen.
  const inBtc = useContext(UnitContext).code === 'BTC';
  const btcMissing = displayCurrency === 'BTC' && view.source === 'server' && !inBtc;
  const since = view.windowStart;
  const changeLabel =
    since !== null
      ? t('Since {time}', { time: clockTime(since, timeZone) })
      : view.source === 'derived'
        ? t('Today, from price moves')
        : t('Today');
  const unpriced = view.unpriced.length;
  const value = useValueText();
  const change = useChangeText();
  // A cash-only account has no price moves: "$0.00 (0.00%) Today" would say nothing.
  const hasCrypto = (dec(view.cryptoUsd) ?? 0n) > 0n;
  return (
    <>
      <div data-testid="money-total" className="money-total">
        {inBtc ? (
          <HeroNumber value={satoshis(view.btc!.total)} decimals={8} prefix="₿" size={pro ? 'hero-pro' : 'hero'} hidden={hidden} />
        ) : (
          <HeroNumber value={cents(view.totalUsd)} decimals={2} prefix="$" size={pro ? 'hero-pro' : 'hero'} hidden={hidden} />
        )}
      </div>
      {inBtc ? (
        <p data-testid="money-note" className="money-note">
          {/* The dollar figure is a balance too: it stays out of the note while balances are hidden. */}
          {hidden ? t('Shown in BTC hidden') : t('Shown in BTC', { usd: view.totalUsd ? `$${cents(view.totalUsd)}` : '—' })}
        </p>
      ) : null}
      {btcMissing ? (
        <p data-testid="money-note" className="money-note">
          {t('BTC price missing')}
        </p>
      ) : null}
      {view.cashUsd !== null && view.cryptoUsd !== null ? (
        <p className="money-split" data-testid="total-split">
          <span data-part="cash">
            {t('Cash')} <Money value={value(view.cashUsd)} hidden={hidden} />
          </span>
          {' · '}
          <span data-part="crypto">
            {t('Crypto')} <Money value={value(view.cryptoUsd)} hidden={hidden} />
          </span>
        </p>
      ) : null}
      {view.change24hUsd !== null && hasCrypto ? (
        <p data-testid="money-change" className="money-change">
          <ChangeText value={change(view.change24hUsd, view.change24hPct)} hidden={hidden} suffix={changeLabel} />
          <InfoTip text={t('Today change rule')} label={t('Today change rule label')} />
        </p>
      ) : null}
      <DerivedTotalNote source={view.source} className="money-note" />
      {unpriced > 0 ? (
        <p data-testid="money-note" className="money-note">
          {unpriced === 1 ? t('Asset not counted') : t('Assets not counted', { count: unpriced })}
          <InfoTip text={t('Not counted list', { assets: view.unpriced.join(', ') })} label={t('Not counted label')} />
        </p>
      ) : null}
    </>
  );
}

// ── the coin table ───────────────────────────────────────────────────────────

/** Under one dollar counts as a small balance. Unpriced coins are never small: their worth is unknown. */
export function isSmall(row: MoneyRow): boolean {
  const value = dec(row.usdValue);
  return value !== null && value < SCALE;
}

type Balances = Loadable<Record<string, BalanceEntry>>;

function Colgroup({ pro }: { pro: boolean }) {
  return (
    <colgroup>
      <col className="money-col--coin" />
      <col className="money-col--amount" />
      <col className="money-col--price money-cell--price" />
      <col data-testid="money-cell--value" className="money-col--value money-cell--value" />
      <col data-testid="money-cell--today" className="money-col--today money-cell--today" />
      {pro ? <col className="money-col--free money-cell--pro" /> : null}
      {pro ? <col className="money-col--used money-cell--pro" /> : null}
      {pro ? <col className="money-col--locked money-cell--pro" /> : null}
      {pro ? <col className="money-col--spaces money-cell--pro" /> : null}
      <col className="money-col--actions money-cell--actions" />
    </colgroup>
  );
}

function RowActions({ row, markets, copy, layout }: { row: MoneyRow; markets: Loadable<MarketRow[]>; copy: Copy; layout: Mode }) {
  const { t } = copy;
  const symbol = markets.status === 'ready' ? primarySymbolFor(row.asset, markets.data) : null;
  const buy = symbol ? buyHref(row.asset, symbol, false, layout) : null;
  const sell = symbol ? buyHref(row.asset, symbol, true, layout) : null;
  const send = isHiddenPath('/pay/send') ? null : `/pay/send?asset=${encodeURIComponent(row.asset)}`;
  // A cash row opens the convert page with this coin as the one to give; nothing is posted until the quote is accepted there.
  const convert = row.class === 'cash' && !isHiddenPath('/trade/convert') ? `/trade/convert?from=${encodeURIComponent(row.asset)}` : null;
  const items = [
    { id: 'Convert', href: convert, label: t('Convert {asset}', { asset: row.asset }) },
    { id: 'Buy', href: buy, label: t('Buy {asset}', { asset: row.asset }) },
    { id: 'Sell', href: sell, label: t('Sell {asset}', { asset: row.asset }) },
    { id: 'Send', href: send, label: t('Send {asset}', { asset: row.asset }) },
  ] as const;
  return (
    <div data-testid="money-row__actions" className="money-row__actions">
      {items.map((item) =>
        item.href ? (
          <Button key={item.id} variant="ghost" size={28} nativeButton={false} render={<a href={item.href} aria-label={item.label} />}>
            {t(item.id)}
          </Button>
        ) : null,
      )}
    </div>
  );
}

/**
 * Hover detail for the In orders cell (holds) or the Locked cell (every other lock): what each claim is for, in the
 * balance page's words. Nothing when balances are hidden.
 */
function claimsTitle(held: Held, copy: Copy, holds: boolean, hidden: boolean): string | undefined {
  const claims = held.claims.filter((claim) => (claim.kind === 'hold') === holds);
  return hidden || claims.length === 0
    ? undefined
    : claims.map((claim) => `${setAsideLabel(setAsideWhat(claim.kind, claim.purpose), copy)}: ${claim.amount}`).join('\n');
}

/**
 * Pro columns: what can be spent now (Available), what is set aside for open orders (In orders) and what sits in named
 * spaces (In spaces), as the bank returned them. A figure the bank did not return shows a dash.
 */
function HeldCells({ held, hidden }: { held: Held; hidden: boolean }) {
  const copy = moneyCopy.useCopy();
  const show = (value: string | null) => (value === null ? '—' : fmtAmount(value, { round: 'down' }));
  return (
    <>
      <td className="money-num money-cell--pro" data-col="available">
        <Amount value={show(held.available)} hidden={hidden} />
      </td>
      <td className="money-num money-cell--pro" data-col="in-orders" title={claimsTitle(held, copy, true, hidden)}>
        <Amount value={show(held.inOrders)} hidden={hidden} />
      </td>
      <td className="money-num money-cell--pro" data-col="locked" title={claimsTitle(held, copy, false, hidden)}>
        <Amount value={show(held.locked)} hidden={hidden} />
      </td>
      <td className="money-num money-cell--pro" data-col="in-spaces">
        <Amount value={show(held.inSpaces)} hidden={hidden} />
      </td>
    </>
  );
}

function CoinRow({
  row,
  hidden,
  markets,
  copy,
  layout,
  held,
}: {
  row: MoneyRow;
  hidden: boolean;
  markets: Loadable<MarketRow[]>;
  copy: Copy;
  layout: Mode;
  held: Held;
}) {
  const name = assetName(row.asset, copy);
  const cash = row.class === 'cash';
  const value = useValueText();
  const change = useChangeText();
  const today = row.usdChange24h === null || cash ? null : change(row.usdChange24h, row.changeRatio);
  return (
    <tr data-testid="money-row" className="money-row" data-asset={row.asset}>
      <td>
        {/* No link: the coin page is M3. The Buy, Sell and Send buttons on the row are the way on. */}
        <div className="money-coin">
          <CoinIcon asset={row.asset} size={32} />
          <span data-testid="money-coin__text" className="money-coin__text">
            <span className="money-coin__top">
              <span className="money-coin__ticker">{row.asset}</span>
              {row.share !== null ? (
                <span className="money-coin__share" data-col="share">
                  · {fmtPct(row.share, { signed: false, places: 1 })}
                </span>
              ) : null}
            </span>
            {name ? <span className="money-coin__name">{name}</span> : null}
          </span>
        </div>
      </td>
      <td className="money-num">
        {/* The amount itself opens the entries behind it, so the cell shows nothing but the figure. */}
        <a
          data-testid="money-num__entries"
          className="money-num__entries"
          href={balanceEntriesHref(row.asset)}
          title={copy.t('See the entries', { asset: row.asset })}
          aria-label={
            hidden
              ? copy.t('See the entries', { asset: row.asset })
              : copy.t('Amount, see the entries', { amount: `${fmtAmount(row.amount, { round: 'down' })} ${row.asset}`, asset: row.asset })
          }
        >
          <Amount value={`${fmtAmount(row.amount, { round: 'down' })} ${row.asset}`} hidden={hidden} />
        </a>
        {/* On a phone the Value column folds under the Amount so the two never run into each other. */}
        <span className="money-num__value" title={row.usdValue === null ? copy.t('No price published') : undefined}>
          <Money value={value(row.usdValue)} hidden={hidden} />
        </span>
      </td>
      {/* The price the total used; a coin with no published price shows a dash that says so, never a zero. */}
      <td className="money-num money-cell--price" data-col="price" title={row.priceUsd === null ? copy.t('No price published') : undefined}>
        {row.priceUsd === null ? '—' : fmtCoinPrice(row.priceUsd)}
      </td>
      <td
        data-testid="money-cell--value"
        className="money-num money-cell--value"
        data-col="value"
        title={row.usdValue === null ? copy.t('No price published') : undefined}
      >
        <Money value={value(row.usdValue)} hidden={hidden} />
      </td>
      <td data-testid="money-cell--today" className="money-num money-cell--today">
        <ChangeText value={today} hidden={hidden} className="money-today" />
      </td>
      {layout === 'pro' ? <HeldCells held={held} hidden={hidden} /> : null}
      <td className="money-cell--actions">
        <RowActions row={row} markets={markets} copy={copy} layout={layout} />
      </td>
    </tr>
  );
}

function CoinTable({
  rows,
  hidden,
  markets,
  copy,
  head,
  layout,
  helds,
}: {
  rows: MoneyRow[];
  hidden: boolean;
  markets: Loadable<MarketRow[]>;
  copy: Copy;
  head: boolean;
  layout: Mode;
  helds: ReadonlyMap<string, Held>;
}) {
  const { t } = copy;
  const pro = layout === 'pro';
  return (
    <table data-testid="money-table" className="money-table">
      <Colgroup pro={pro} />
      {head ? (
        <thead>
          <tr>
            <th scope="col">{t('Coin')}</th>
            <th scope="col" className="money-num">
              {t('Amount')}
              <span className="money-num__value"> · {t('Value')}</span>
            </th>
            <th scope="col" className="money-num money-cell--price">
              {t('Price')}
            </th>
            <th scope="col" data-testid="money-cell--value" className="money-num money-cell--value">
              {t('Value')}
            </th>
            <th scope="col" data-testid="money-cell--today" className="money-num money-cell--today">
              {t('Today')}
            </th>
            {pro ? (
              <>
                <th scope="col" className="money-num money-cell--pro">
                  {t('Available')}
                </th>
                <th scope="col" className="money-num money-cell--pro">
                  {t('In orders')}
                </th>
                <th scope="col" className="money-num money-cell--pro">
                  {t('Locked')}
                </th>
                <th scope="col" className="money-num money-cell--pro">
                  {t('In spaces')}
                </th>
              </>
            ) : null}
            <th scope="col" className="money-cell--actions">
              <span className="if-sr">{t('Actions')}</span>
            </th>
          </tr>
        </thead>
      ) : null}
      <tbody>
        {rows.map((row) => (
          <CoinRow key={row.asset} row={row} hidden={hidden} markets={markets} copy={copy} layout={layout} held={helds.get(row.asset)!} />
        ))}
      </tbody>
    </table>
  );
}

/** One plain line under a Pro table when its columns cannot be added up, and why. Nothing when they do. */
function heldNote(spaces: Spaces, adds: boolean | null, t: Copy['t']): string | null {
  if (spaces.state === 'unavailable') return t('Spaces figure missing');
  if (spaces.state === 'not-in-amount') return t('Spaces left out of amount');
  if (adds === false) return t('Held read apart');
  return null;
}

function HoldingsCard({
  id,
  title,
  total,
  rows,
  hidden,
  markets,
  copy,
  collapseSmall,
  layout,
  helds,
  note,
}: {
  id: 'cash' | 'crypto';
  title: string;
  total: string | null;
  rows: MoneyRow[];
  hidden: boolean;
  markets: Loadable<MarketRow[]>;
  copy: Copy;
  collapseSmall?: boolean;
  layout: Mode;
  helds: ReadonlyMap<string, Held>;
  /** The one line about the Pro columns; only the first card carries it. */
  note: string | null;
}) {
  const { t } = copy;
  // Small balances fold away only when there is something bigger to show above them.
  const small = collapseSmall ? rows.filter(isSmall) : [];
  const main = small.length > 0 && small.length < rows.length ? rows.filter((row) => !isSmall(row)) : rows;
  const folded = main === rows ? [] : small;
  const value = useValueText();
  return (
    <section id={id} data-testid="money-card" className="money-card" aria-labelledby={`money-${id}-title`}>
      <header data-testid="money-card__head" className="money-card__head">
        <h2 id={`money-${id}-title`}>{title}</h2>
        <Money value={value(total)} hidden={hidden} data-testid="money-card__total" className="money-card__total" />
      </header>
      <CoinTable rows={main} hidden={hidden} markets={markets} copy={copy} head layout={layout} helds={helds} />
      {folded.length > 0 ? (
        <Collapsible className="money-small">
          <CollapsibleTrigger data-testid="money-small__trigger" className="money-small__trigger">
            <span>{t('Small balances')}</span>
            <span className="money-small__count">
              {folded.length === 1 ? t('1 coin under $1') : t('{count} coins under $1', { count: folded.length })}
            </span>
            <ChevronDown size={20} aria-hidden="true" className="money-small__chev" />
          </CollapsibleTrigger>
          <CollapsiblePanel>
            <CoinTable rows={folded} hidden={hidden} markets={markets} copy={copy} head={false} layout={layout} helds={helds} />
          </CollapsiblePanel>
        </Collapsible>
      ) : null}
      {note ? (
        <p className="money-card__foot" data-testid="held-note">
          {note}
        </p>
      ) : null}
    </section>
  );
}

function CardSkeleton({ rows }: { rows: number }) {
  return (
    <section data-testid="money-card" className="money-card" aria-hidden="true">
      <header data-testid="money-card__head" className="money-card__head">
        <Skeleton width={72} height={28} className="bg-field" />
        <Skeleton width={112} height={28} className="bg-field" />
      </header>
      {Array.from({ length: rows }, (_, index) => (
        <div className="money-skeleton-row" key={index}>
          <Skeleton width={32} height={32} circle className="bg-field" />
          <Skeleton width={120} height={36} className="bg-field" />
          <span className="money-skeleton-gap" />
          <Skeleton width={96} height={20} className="bg-field" />
          <Skeleton width={96} height={20} className="bg-field" />
          <Skeleton width={120} height={20} className="bg-field" />
        </div>
      ))}
    </section>
  );
}

// ── named accounts ───────────────────────────────────────────────────────────

function Accounts({ accounts, hidden, copy }: { accounts: NamedAccount[]; hidden: boolean; copy: Copy }) {
  const { t } = copy;
  return (
    <section id="accounts" data-testid="money-card" className="money-card" aria-labelledby="money-accounts-title">
      <header data-testid="money-card__head" className="money-card__head">
        <h2 id="money-accounts-title">{t('Your accounts')}</h2>
      </header>
      <p className="money-card__note">{t('Your accounts note')}</p>
      <ul className="money-accounts">
        {accounts.map((account) => (
          <li key={account.id} data-testid="money-accounts__row" className="money-accounts__row">
            <CoinIcon asset={account.asset} size={32} />
            <span className="money-accounts__name">{account.name}</span>
            <Amount value={`${fmtAmount(decOrNull(dec(account.balance)), { round: 'down' })} ${account.asset}`} hidden={hidden} />
          </li>
        ))}
      </ul>
    </section>
  );
}

// ── the screen ───────────────────────────────────────────────────────────────

export default function Portfolio() {
  const copy = moneyCopy.useCopy();
  const { t } = copy;
  const { hideBalances, layoutMode, displayCurrency, timeZone } = usePreferences();
  const layout: Mode = layoutMode === 'pro' ? 'pro' : 'simple';
  const [scope, setScope] = useState('combined');
  // Only this screen shows BTC; Home and P&L ask for USD, so a missing BTC price never takes their dollar total away.
  const portfolio = useMoneyPortfolio(scope, moneyUnitOf(displayCurrency));
  const scoped = scope !== 'combined';
  const balances = useAssetBalances(layout === 'pro');
  const lockSplit = useLockSplits(layout === 'pro');
  const markets = useMarkets();
  const accounts = useNamedAccounts();

  const view = portfolio.status === 'ready' ? portfolio.data : null;
  // BTC only when the bank gave both its BTC total and the price behind it; otherwise every value stays in USD.
  const btc = displayCurrency === 'BTC' ? view?.btc : null;
  const unit: ValueUnit = btc?.total != null && btc.priceUsd != null ? { code: 'BTC', priceUsd: btc.priceUsd } : USD_UNIT;
  const rate = useDisplayRate(displayCurrency);
  const cashRows = useMemo(() => view?.rows.filter((row) => row.class === 'cash') ?? [], [view]);
  const cryptoRows = useMemo(() => view?.rows.filter((row) => row.class === 'crypto') ?? [], [view]);

  // `/money#cash` and `/money#crypto` scroll to their card once the cards exist.
  useEffect(() => {
    if (!view) return;
    const scroll = () => {
      const id = decodeURIComponent(location.hash.slice(1));
      if (id) document.getElementById(id)?.scrollIntoView({ block: 'start' });
    };
    scroll();
    window.addEventListener('hashchange', scroll);
    return () => window.removeEventListener('hashchange', scroll);
  }, [view !== null]);

  const spaces = useMemo(() => spacesFor(accounts, view?.source ?? 'server'), [accounts, view?.source]);
  const heldAccounts = useMemo(
    () => (accounts.status === 'ready' ? accounts.data.filter((account) => (dec(account.balance) ?? 0n) > 0n) : []),
    [accounts],
  );
  // Available / In orders / In spaces next to Amount, for every row; one note for the whole table pair.
  const helds = useMemo(
    () =>
      new Map(
        (view?.rows ?? []).map((row) => [
          row.asset,
          // The breakdown reads cover the whole account and the spaces list covers every space, so for one account
          // they would sit next to an Amount they do not belong to: those columns show a dash instead.
          scoped
            ? heldFor(row.asset, row.amount, undefined, { state: 'unavailable', byAsset: new Map() }, undefined)
            : heldFor(
                row.asset,
                row.amount,
                // A coin missing from a balance read that did arrive is a coin with nothing free and nothing in orders.
                balances.status === 'ready' ? (balances.data[row.asset] ?? { free: '0', used: '0', total: '0' }) : undefined,
                spaces,
                lockSplit.status === 'ready' ? lockSplit.data : lockSplit.status === 'empty' ? {} : undefined,
              ),
        ]),
      ),
    [view, balances, spaces, lockSplit, scoped],
  );
  const note = layout === 'pro' && !scoped ? heldNote(spaces, allAdd([...helds.values()]), t) : null;
  const noteFirst = cashRows.length > 0 ? 'cash' : 'crypto';
  const mode: PillMode = portfolio.status === 'refused' ? 'refused' : portfolio.status === 'empty' ? 'empty' : 'normal';
  const buyTarget = buyHref(null, null, false, layout);

  let body;
  if (portfolio.status === 'loading') {
    body = (
      <>
        <CardSkeleton rows={2} />
        <CardSkeleton rows={3} />
      </>
    );
  } else if (portfolio.status === 'error') {
    body = (
      <StateBlock
        kind="error"
        testId="money-state"
        className="money-state"
        title={t('Couldn’t load your balance')}
        onRetry={portfolio.retry}
        retryLabel={t('Try again')}
      />
    );
  } else if (portfolio.status === 'refused') {
    // The raw service code never reaches the screen: only a short reference a customer can quote to support.
    const words = refusalCopy(portfolio.code);
    body = (
      <StateBlock
        kind="refused"
        testId="money-state"
        className="money-state"
        title={words.title}
        body={words.body}
        code={words.reference}
        action={words.action}
      />
    );
  } else if (portfolio.status === 'empty' || !view) {
    body = (
      <>
        <StateBlock
          kind="empty"
          testId="money-state"
          className="money-state"
          title={t('Nothing held')}
          body={t('Nothing held body')}
          action={buyTarget ? { label: t('Buy crypto'), href: buyTarget } : undefined}
        />
        {/* Nothing held now can still have been held at the start of the range. */}
        {!scoped && portfolio.status === 'empty' ? <HoldingsChange hidden={hideBalances} /> : null}
      </>
    );
  } else {
    body = (
      <>
        <AllocationBar rows={view.rows} />
        {cashRows.length > 0 ? (
          <HoldingsCard
            id="cash"
            title={t('Cash')}
            total={view.cashUsd}
            rows={cashRows}
            hidden={hideBalances}
            markets={markets}
            copy={copy}
            layout={layout}
            helds={helds}
            note={noteFirst === 'cash' ? note : null}
          />
        ) : null}
        {cryptoRows.length > 0 ? (
          <HoldingsCard
            id="crypto"
            title={t('Crypto')}
            total={view.cryptoUsd}
            rows={cryptoRows}
            hidden={hideBalances}
            markets={markets}
            copy={copy}
            collapseSmall
            layout={layout}
            helds={helds}
            note={noteFirst === 'crypto' ? note : null}
          />
        ) : null}
        <Movers
          view={view}
          hidden={hideBalances}
          copy={copy}
          sinceLabel={
            view.windowStart !== null
              ? t('Movers since {time}', { time: clockTime(view.windowStart, timeZone) })
              : view.source === 'derived'
                ? t('Today, from price moves')
                : t('Today')
          }
        />
        <ValuationNote view={view} copy={copy} refreshMs={SUMMARY_INTERVAL} timeZone={timeZone} />
        {/* Main account and spaces together, so it is shown for all accounts only. */}
        {!scoped ? <HoldingsChange hidden={hideBalances} /> : null}
        {/* A named account is listed here only while it holds something (J-portfolio-06 #5); the picker above offers them all. */}
        {!scoped && heldAccounts.length > 0 ? <Accounts accounts={heldAccounts} hidden={hideBalances} copy={copy} /> : null}
        {isHiddenPath('/money/pnl') ? null : (
          <a data-testid="money-pnl-link" className="money-pnl-link" href="/money/pnl">
            <span>{t('Profit and loss')}</span>
            <span className="money-pnl-link__hint">{t('Profit and loss hint')}</span>
          </a>
        )}
      </>
    );
  }

  return (
    <UnitContext.Provider value={unit}>
      <div
        data-testid="if-money"
        className="if-money"
        data-source={view?.source ?? undefined}
        data-density={layout === 'pro' ? 'pro' : undefined}
        data-unit={unit.code}
      >
        <h1 className="if-sr">{t('Money')}</h1>
        <div data-testid="money-head" className="money-head">
          <div className="money-head__main">
            <div data-testid="money-label" className="money-label">
              <span>{t('Est. total value')}</span>
              <button
                type="button"
                className="money-eye"
                onClick={() => savePreferences({ hideBalances: !hideBalances })}
                aria-label={hideBalances ? t('Show balances') : t('Hide balances')}
              >
                {hideBalances ? <EyeOff size={16} aria-hidden="true" /> : <Eye size={16} aria-hidden="true" />}
              </button>
              <InfoTip text={t('Total value rule')} label={t('How the total is worked out')} side="right" />
            </div>
            {portfolio.status === 'loading' ? (
              <div aria-busy="true" aria-label={t('Est. total value')}>
                <div data-testid="money-total" className="money-total">
                  <Skeleton width={240} height={56} />
                </div>
                <div data-testid="money-change" className="money-change">
                  <Skeleton width={180} height={20} />
                </div>
              </div>
            ) : view ? (
              <Headline view={view} hidden={hideBalances} copy={copy} pro={layout === 'pro'} />
            ) : portfolio.status === 'empty' ? (
              <div data-testid="money-total" className="money-total">
                {/* The balance call answered with no assets, so zero is correct here and only here. */}
                <HeroNumber value="0.00" decimals={2} prefix="$" size={layout === 'pro' ? 'hero-pro' : 'hero'} hidden={hideBalances} />
              </div>
            ) : null}
          </div>
          <ActionPills loading={portfolio.status === 'loading'} mode={mode} layout={layout} />
        </div>
        {scoped || (accounts.status === 'ready' && accounts.data.length > 0) ? (
          <label className="money-scope">
            <span>{t('Accounts shown')}</span>
            <select value={scope} onChange={(event) => setScope(event.target.value)} aria-label={t('Accounts shown')}>
              <option value="combined">{t('All accounts')}</option>
              <option value="main">{t('Main account')}</option>
              {scope !== 'combined' && scope !== 'main' && !(accounts.status === 'ready' && accounts.data.some((a) => a.id === scope)) ? (
                <option value={scope}>{t('This account')}</option>
              ) : null}
              {(accounts.status === 'ready' ? accounts.data : []).map((account) => (
                <option key={account.id} value={account.id}>
                  {account.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <NoRateNote currency={displayCurrency} rate={rate} copy={copy} />
        {body}
      </div>
    </UnitContext.Provider>
  );
}

/**
 * The chosen display currency is not USD or BTC: every value stays in USD and this says why. The bank refused it by name
 * (no rate), or it could not be asked, which is said as that and never as a missing rate.
 */
function NoRateNote({ currency, rate, copy }: { currency: string; rate: DisplayRate; copy: Copy }) {
  if (rate.state === 'no_rate') {
    const words = refusalCopy(rate.code);
    return (
      <p data-testid="money-note" className="money-note" role="status" data-refusal={rate.code}>
        {copy.t('No rate for display currency', { currency })}
        {words.reference ? <span className="money-note__ref"> {words.reference}</span> : null}
      </p>
    );
  }
  if (rate.state === 'unchecked')
    return (
      <p data-testid="money-note" className="money-note" role="status">
        {copy.t('Display currency not checked', { currency })}
      </p>
    );
  return null;
}
