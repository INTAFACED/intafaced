import { useContext, useEffect, useMemo, useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { AssetIcon, Button, EmptyState, Fold, RefusalBox, Select } from '@intafaced/ui/lit';
import { AllocationBar } from './allocation-chart';
import { assetName, moneyCopy } from './copy';
import {
  dec,
  decOrNull,
  fmtAmount,
  fmtChangeLine,
  fmtPct,
  isHiddenPath,
  primarySymbolFor,
  refusalCopy,
  roundScaled,
  SCALE,
  toFixedString,
  useMarkets,
  type Loadable,
  type MarketRow,
} from './deps';
import { balanceEntriesHref } from './balance-entries-model';
import { allAdd, heldFor, spacesFor, type Held, type Spaces } from './held-breakdown';
import { setAsideLabel, setAsideWhat } from './set-aside';
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
import { Movers, spokenOf } from './Movers';
import { fmtCoinPrice } from './price-text';
import { ValuationNote } from './ValuationNote';
import { HoldingsChange } from './HoldingsChange';
import { ChangeLine, HeroTotal, Shown, btcParts, signOf, usdParts } from './money-parts';
import { MoneyOverview } from './MoneyRoom';
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

function livePills(mode: PillMode, layout: Mode) {
  const wanted = PILLS_FOR[mode];
  // A short list keeps its own order, so the first pill (the primary one) is the most useful: Receive, then Buy.
  const ordered = wanted ? wanted.map((id) => PILLS.find((pill) => pill.id === id)!) : PILLS;
  return ordered.flatMap((pill) => {
    const href = pill.href(layout);
    return href ? [{ id: pill.id, href }] : [];
  });
}

function ActionPills({ mode, layout }: { mode: PillMode; layout: Mode }) {
  const { t } = moneyCopy.useCopy();
  const pills = livePills(mode, layout);
  return (
    <nav data-testid="money-actions" className="lt-actions" aria-label={t('Actions')}>
      {pills.map((pill, index) => {
        const variant = index === 0 && mode !== 'empty' ? 'primary' : 'secondary';
        return (
          <a key={pill.id} className={`lt-button lt-button-${variant}`} data-variant={variant} href={pill.href}>
            {t(pill.id)}
          </a>
        );
      })}
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

function Headline({ view, hidden, copy }: { view: MoneyView; hidden: boolean; copy: Copy }) {
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
  const btcTotal = inBtc ? satoshis(view.btc!.total) : null;
  const usdTotal = cents(view.totalUsd);
  return (
    <>
      <div data-testid="money-total">
        <HeroTotal
          parts={btcTotal !== null ? btcParts(btcTotal) : usdTotal !== null ? usdParts(usdTotal) : null}
          hidden={hidden}
          unknownLabel={t('Total unknown')}
        />
      </div>
      {inBtc ? (
        <p data-testid="money-note" className="lt-hint">
          {/* The dollar figure is a balance too: it stays out of the note while balances are hidden. */}
          {hidden ? t('Shown in BTC hidden') : t('Shown in BTC', { usd: view.totalUsd ? `$${cents(view.totalUsd)}` : '—' })}
        </p>
      ) : null}
      {btcMissing ? (
        <p data-testid="money-note" className="lt-hint">
          {t('BTC price missing')}
        </p>
      ) : null}
      {view.cashUsd !== null && view.cryptoUsd !== null ? (
        <p className="lt-hint" data-testid="total-split">
          <span data-part="cash">
            {t('Cash')} <Shown text={value(view.cashUsd)} hidden={hidden} />
          </span>
          {' · '}
          <span data-part="crypto">
            {t('Crypto')} <Shown text={value(view.cryptoUsd)} hidden={hidden} />
          </span>
        </p>
      ) : null}
      {view.change24hUsd !== null && hasCrypto ? (
        <p data-testid="money-change" className="lt-actions">
          <ChangeLine
            text={change(view.change24hUsd, view.change24hPct)}
            sign={signOf(view.change24hUsd)}
            hidden={hidden}
            spoken={spokenOf(copy)}
          />
          <span className="lt-hint">{changeLabel}</span>
          <InfoTip text={t('Today change rule')} label={t('Today change rule label')} />
        </p>
      ) : null}
      <DerivedTotalNote source={view.source} className="lt-hint" />
      {unpriced > 0 ? (
        <p data-testid="money-note" className="lt-hint">
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
    <div data-testid="money-row__actions" className="lt-actions">
      {items.map((item) =>
        item.href ? (
          <a key={item.id} className="lt-row-link" href={item.href} aria-label={item.label}>
            {t(item.id)}
          </a>
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
  const show = (value: string | null) => (value === null ? null : fmtAmount(value, { round: 'down' }));
  return (
    <>
      <td data-align="end" data-col="available" data-label={copy.t('Available')}>
        <Shown slot="amount" text={show(held.available)} hidden={hidden} />
      </td>
      <td data-align="end" data-col="in-orders" data-label={copy.t('In orders')} title={claimsTitle(held, copy, true, hidden)}>
        <Shown slot="amount" text={show(held.inOrders)} hidden={hidden} />
      </td>
      <td data-align="end" data-col="locked" data-label={copy.t('Locked')} title={claimsTitle(held, copy, false, hidden)}>
        <Shown slot="amount" text={show(held.locked)} hidden={hidden} />
      </td>
      <td data-align="end" data-col="in-spaces" data-label={copy.t('In spaces')}>
        <Shown slot="amount" text={show(held.inSpaces)} hidden={hidden} />
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
  const amount = `${fmtAmount(row.amount, { round: 'down' })} ${row.asset}`;
  return (
    <tr data-testid="money-row" data-asset={row.asset}>
      <td data-label={copy.t('Coin')}>
        {/* No link: the coin page is M3. The Buy, Sell and Send links on the row are the way on. */}
        <span className="lt-cell-name">
          <AssetIcon asset={row.asset} />
          <span data-testid="money-coin__text">
            <span>
              <span>{row.asset}</span>
              {row.share !== null ? <span data-col="share">· {fmtPct(row.share, { signed: false, places: 1 })}</span> : null}
            </span>
            {name ? <span className="lt-hint">{name}</span> : null}
          </span>
        </span>
      </td>
      <td data-align="end" data-label={copy.t('Amount')}>
        {/* The amount itself opens the entries behind it, so the cell shows nothing but the figure. */}
        <a
          data-testid="money-num__entries"
          className="lt-row-link"
          href={balanceEntriesHref(row.asset)}
          title={copy.t('See the entries', { asset: row.asset })}
          aria-label={
            hidden ? copy.t('See the entries', { asset: row.asset }) : copy.t('Amount, see the entries', { amount, asset: row.asset })
          }
        >
          <Shown slot="amount" text={amount} hidden={hidden} />
        </a>
      </td>
      {/* The price the total used; a coin with no published price shows a dash that says so, never a zero. */}
      <td
        data-align="end"
        data-col="price"
        data-label={copy.t('Price')}
        title={row.priceUsd === null ? copy.t('No price published') : undefined}
      >
        {row.priceUsd === null ? '—' : fmtCoinPrice(row.priceUsd)}
      </td>
      <td
        data-testid="money-cell--value"
        data-align="end"
        data-col="value"
        data-label={copy.t('Value')}
        title={row.usdValue === null ? copy.t('No price published') : undefined}
      >
        <Shown text={value(row.usdValue)} hidden={hidden} />
      </td>
      <td data-testid="money-cell--today" data-align="end" data-label={copy.t('Today')}>
        <ChangeLine text={today} sign={signOf(row.usdChange24h)} hidden={hidden} spoken={spokenOf(copy)} />
      </td>
      {layout === 'pro' ? <HeldCells held={held} hidden={hidden} /> : null}
      <td>
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
  label,
}: {
  rows: MoneyRow[];
  hidden: boolean;
  markets: Loadable<MarketRow[]>;
  copy: Copy;
  head: boolean;
  layout: Mode;
  helds: ReadonlyMap<string, Held>;
  /** The region's name: the card's title. */
  label: string;
}) {
  const { t } = copy;
  const pro = layout === 'pro';
  return (
    <div data-testid="money-table" className="lt-table-scroll" role="region" tabIndex={0} aria-label={label}>
      <table className="lt-table">
        {head ? (
          <thead>
            <tr>
              <th scope="col">{t('Coin')}</th>
              <th scope="col" data-align="end">
                {t('Amount')}
              </th>
              <th scope="col" data-align="end">
                {t('Price')}
              </th>
              <th scope="col" data-testid="money-cell--value" data-align="end">
                {t('Value')}
              </th>
              <th scope="col" data-testid="money-cell--today" data-align="end">
                {t('Today')}
              </th>
              {pro ? (
                <>
                  <th scope="col" data-align="end">
                    {t('Available')}
                  </th>
                  <th scope="col" data-align="end">
                    {t('In orders')}
                  </th>
                  <th scope="col" data-align="end">
                    {t('Locked')}
                  </th>
                  <th scope="col" data-align="end">
                    {t('In spaces')}
                  </th>
                </>
              ) : null}
              <th scope="col">
                <span className="lt-sr">{t('Actions')}</span>
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
    </div>
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
    <section id={id} data-testid="money-card" className="lt-stack" aria-labelledby={`money-${id}-title`}>
      <header data-testid="money-card__head" className="lt-title-row">
        <h2 id={`money-${id}-title`}>{title}</h2>
        <Shown testId="money-card__total" text={value(total)} hidden={hidden} />
      </header>
      <CoinTable rows={main} hidden={hidden} markets={markets} copy={copy} head layout={layout} helds={helds} label={title} />
      {folded.length > 0 ? (
        <Fold
          data-testid="money-small"
          title={
            <>
              {t('Small balances')}{' '}
              <span className="lt-hint">
                {folded.length === 1 ? t('1 coin under $1') : t('{count} coins under $1', { count: folded.length })}
              </span>
            </>
          }
        >
          <CoinTable
            rows={folded}
            hidden={hidden}
            markets={markets}
            copy={copy}
            head={false}
            layout={layout}
            helds={helds}
            label={t('Small balances')}
          />
        </Fold>
      ) : null}
      {note ? (
        <p className="lt-hint" data-testid="held-note">
          {note}
        </p>
      ) : null}
    </section>
  );
}

// ── named accounts ───────────────────────────────────────────────────────────

function Accounts({ accounts, hidden, copy }: { accounts: NamedAccount[]; hidden: boolean; copy: Copy }) {
  const { t } = copy;
  return (
    <section id="accounts" data-testid="money-card" className="lt-stack" aria-labelledby="money-accounts-title">
      <header data-testid="money-card__head" className="lt-title-row">
        <h2 id="money-accounts-title">{t('Your accounts')}</h2>
      </header>
      <p className="lt-hint">{t('Your accounts note')}</p>
      <ul className="lt-rows">
        {accounts.map((account) => (
          <li key={account.id} data-testid="money-accounts__row">
            <span className="lt-actions">
              <AssetIcon asset={account.asset} />
              <span>{account.name}</span>
              <Shown
                slot="amount"
                text={`${fmtAmount(decOrNull(dec(account.balance)), { round: 'down' })} ${account.asset}`}
                hidden={hidden}
              />
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ── the screen ───────────────────────────────────────────────────────────────

/** `/money` with the user-venue door off: the portfolio, on the overview template (MoneyRoom.tsx). */
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
    () =>
      accounts.status === 'ready'
        ? accounts.data.filter((account) => {
            // A balance that cannot be read stays listed (it shows as unknown); only a known zero is left out.
            const held = dec(account.balance);
            return held === null || held > 0n;
          })
        : [],
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

  const loading = portfolio.status === 'loading';
  const label = (
    <div data-testid="money-label" className="lt-actions">
      <span className="lt-hint">{t('Est. total value')}</span>
      <Button
        tone="quiet"
        onClick={() => savePreferences({ hideBalances: !hideBalances })}
        aria-label={hideBalances ? t('Show balances') : t('Hide balances')}
      >
        {hideBalances ? <EyeOff size={16} aria-hidden="true" /> : <Eye size={16} aria-hidden="true" />}
      </Button>
      <InfoTip text={t('Total value rule')} label={t('How the total is worked out')} side="right" />
    </div>
  );
  const hero = loading ? null : (
    <div data-testid="money-head" className="lt-stack">
      {label}
      {view ? (
        <Headline view={view} hidden={hideBalances} copy={copy} />
      ) : portfolio.status === 'empty' ? (
        <div data-testid="money-total">
          {/* The balance call answered with no assets, so zero is correct here and only here. */}
          <HeroTotal parts={usdParts('0')} hidden={hideBalances} unknownLabel={t('Total unknown')} />
        </div>
      ) : null}
      <NoRateNote currency={displayCurrency} rate={rate} copy={copy} />
    </div>
  );

  let body;
  if (portfolio.status === 'loading') {
    body = null;
  } else if (portfolio.status === 'error') {
    body = (
      <div data-testid="money-state" data-slot="state-block" data-kind="error" className="lt-stack">
        <RefusalBox refusal={{ variant: 'unreachable', title: t('Couldn’t load your balance'), body: '' }} />
        <div className="lt-actions">
          <Button tone="secondary" onClick={portfolio.retry}>
            {t('Try again')}
          </Button>
        </div>
      </div>
    );
  } else if (portfolio.status === 'refused') {
    // The raw service code never reaches the screen: only a short reference a customer can quote to support.
    const words = refusalCopy(portfolio.code);
    body = (
      <div data-testid="money-state" data-slot="state-block" data-kind="refused">
        <RefusalBox
          refusal={{ variant: 'refused', title: words.title, body: words.body ?? '', reference: words.reference, action: words.action }}
        />
      </div>
    );
  } else if (portfolio.status === 'empty' || !view) {
    body = (
      <>
        <div data-testid="money-state" data-slot="state-block" data-kind="empty">
          <EmptyState
            title={t('Nothing held')}
            body={t('Nothing held body')}
            action={
              buyTarget ? (
                <a className="lt-button lt-button-primary" href={buyTarget}>
                  {t('Buy crypto')}
                </a>
              ) : undefined
            }
          />
        </div>
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
        <ValuationNote view={view} copy={copy} refreshMs={SUMMARY_INTERVAL} timeZone={timeZone} />
        {/* Main account and spaces together, so it is shown for all accounts only. */}
        {!scoped ? <HoldingsChange hidden={hideBalances} /> : null}
        {/* A named account is listed here only while it holds something (J-portfolio-06 #5); the picker above offers them all. */}
        {!scoped && heldAccounts.length > 0 ? <Accounts accounts={heldAccounts} hidden={hideBalances} copy={copy} /> : null}
        {isHiddenPath('/money/pnl') ? null : (
          <a data-testid="money-pnl-link" className="lt-row-link" href="/money/pnl">
            <span className="lt-stack">
              <span>{t('Profit and loss')}</span>
              <span className="lt-hint">{t('Profit and loss hint')}</span>
            </span>
          </a>
        )}
      </>
    );
  }

  // What the person watches beside the holdings: today's best and worst movers.
  const watching =
    view && !loading && portfolio.status !== 'empty' ? (
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
    ) : undefined;

  const scopeOptions = [
    { value: 'combined', label: t('All accounts') },
    { value: 'main', label: t('Main account') },
    ...(scope !== 'combined' && scope !== 'main' && !(accounts.status === 'ready' && accounts.data.some((a) => a.id === scope))
      ? [{ value: scope, label: t('This account') }]
      : []),
    ...(accounts.status === 'ready' ? accounts.data : []).map((account) => ({ value: account.id, label: account.name })),
  ];

  return (
    <UnitContext.Provider value={unit}>
      <div
        data-testid="if-money"
        data-source={view?.source ?? undefined}
        data-density={layout === 'pro' ? 'pro' : undefined}
        data-unit={unit.code}
      >
        <MoneyOverview
          title={t('Money')}
          state={loading ? { kind: 'loading' } : { kind: 'ready' }}
          hero={hero}
          // The label row, the figure and three lines under it (the split, the day's change, a note): one height
          // while loading and once loaded.
          heroReserve={3}
          actions={loading ? null : <ActionPills mode={mode} layout={layout} />}
          sections={
            loading ? null : (
              <div className="lt-stack">
                {scoped || (accounts.status === 'ready' && accounts.data.length > 0) ? (
                  <Select label={t('Accounts shown')} value={scope} onChange={setScope} options={scopeOptions} />
                ) : null}
                {body}
              </div>
            )
          }
          watching={watching}
        />
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
      <p data-testid="money-note" className="lt-hint" role="status" data-refusal={rate.code}>
        {copy.t('No rate for display currency', { currency })}
        {words.reference ? <span className="lt-ref"> {words.reference}</span> : null}
      </p>
    );
  }
  if (rate.state === 'unchecked')
    return (
      <p data-testid="money-note" className="lt-hint" role="status">
        {copy.t('Display currency not checked', { currency })}
      </p>
    );
  return null;
}
