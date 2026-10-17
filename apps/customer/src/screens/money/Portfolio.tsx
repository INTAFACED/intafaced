import { useEffect, useMemo } from 'react';
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
import { InfoTip } from './InfoTip';
import { buyHref } from './links';
import { clockTime } from './time';
import {
  useAssetBalances,
  useMoneyPortfolio,
  useNamedAccounts,
  type MoneyRow,
  type MoneyView,
  type NamedAccount,
} from './portfolio-source';
import { DerivedTotalNote } from './total-note';
import { savePreferences, usePreferences } from '../../shared/preferences';

type Copy = ReturnType<typeof moneyCopy.useCopy>;

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
    <nav className="money-actions" aria-label={t('Actions')}>
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

function Headline({ view, hidden, copy, pro }: { view: MoneyView; hidden: boolean; copy: Copy; pro: boolean }) {
  const { t } = copy;
  const { timeZone } = usePreferences();
  const since = view.windowStart;
  const changeLabel =
    since !== null
      ? t('Since {time}', { time: clockTime(since, timeZone) })
      : view.source === 'derived'
        ? t('Today, from price moves')
        : t('Today');
  const unpriced = view.unpriced.length;
  // A cash-only account has no price moves: "$0.00 (0.00%) Today" would say nothing.
  const hasCrypto = (dec(view.cryptoUsd) ?? 0n) > 0n;
  return (
    <>
      <div className="money-total">
        <HeroNumber value={cents(view.totalUsd)} decimals={2} prefix="$" size={pro ? 'hero-pro' : 'hero'} hidden={hidden} />
      </div>
      {view.change24hUsd !== null && hasCrypto ? (
        <p className="money-change">
          <ChangeText value={fmtChangeLine(view.change24hUsd, view.change24hPct)} hidden={hidden} suffix={changeLabel} />
          <InfoTip text={t('Today change rule')} label={t('Today change rule label')} />
        </p>
      ) : null}
      <DerivedTotalNote source={view.source} className="money-note" />
      {unpriced > 0 ? (
        <p className="money-note">
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
      <col className="money-col--value" />
      <col className="money-col--today money-cell--today" />
      {pro ? <col className="money-col--free money-cell--pro" /> : null}
      {pro ? <col className="money-col--used money-cell--pro" /> : null}
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
  const items = [
    { id: 'Buy', href: buy, label: t('Buy {asset}', { asset: row.asset }) },
    { id: 'Sell', href: sell, label: t('Sell {asset}', { asset: row.asset }) },
    { id: 'Send', href: send, label: t('Send {asset}', { asset: row.asset }) },
  ] as const;
  return (
    <div className="money-row__actions">
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

/** Pro columns: what can be spent now (Available) and what is set aside for open orders (In orders), as the balance call says. */
function HeldCells({ asset, balances, hidden }: { asset: string; balances: Balances; hidden: boolean }) {
  const entry = balances.status === 'ready' ? balances.data[asset] : undefined;
  const show = (value: string | undefined) => (value === undefined ? '—' : fmtAmount(value, { round: 'down' }));
  return (
    <>
      <td className="money-num money-cell--pro" data-col="available">
        <Amount value={show(entry?.free)} hidden={hidden} />
      </td>
      <td className="money-num money-cell--pro" data-col="in-orders">
        <Amount value={show(entry?.used)} hidden={hidden} />
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
  balances,
}: {
  row: MoneyRow;
  hidden: boolean;
  markets: Loadable<MarketRow[]>;
  copy: Copy;
  layout: Mode;
  balances: Balances;
}) {
  const name = assetName(row.asset, copy);
  const cash = row.class === 'cash';
  const today = row.usdChange24h === null || cash ? null : fmtChangeLine(row.usdChange24h, row.changeRatio);
  return (
    <tr className="money-row" data-asset={row.asset}>
      <td>
        {/* No link: the coin page is M3. The Buy, Sell and Send buttons on the row are the way on. */}
        <div className="money-coin">
          <CoinIcon asset={row.asset} size={32} />
          <span className="money-coin__text">
            <span className="money-coin__top">
              <span className="money-coin__ticker">{row.asset}</span>
              {row.share !== null ? <span className="money-coin__share">· {fmtPct(row.share, { signed: false, places: 1 })}</span> : null}
            </span>
            {name ? <span className="money-coin__name">{name}</span> : null}
          </span>
        </div>
      </td>
      <td className="money-num">
        <Amount value={`${fmtAmount(row.amount, { round: 'down' })} ${row.asset}`} hidden={hidden} />
      </td>
      <td className="money-num">
        <Money value={row.usdValue === null ? null : fmtUsd(row.usdValue)} hidden={hidden} />
      </td>
      <td className="money-num money-cell--today">
        <ChangeText value={today} hidden={hidden} className="money-today" />
      </td>
      {layout === 'pro' ? <HeldCells asset={row.asset} balances={balances} hidden={hidden} /> : null}
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
  balances,
}: {
  rows: MoneyRow[];
  hidden: boolean;
  markets: Loadable<MarketRow[]>;
  copy: Copy;
  head: boolean;
  layout: Mode;
  balances: Balances;
}) {
  const { t } = copy;
  const pro = layout === 'pro';
  return (
    <table className="money-table">
      <Colgroup pro={pro} />
      {head ? (
        <thead>
          <tr>
            <th scope="col">{t('Coin')}</th>
            <th scope="col" className="money-num">
              {t('Amount')}
            </th>
            <th scope="col" className="money-num">
              {t('Value')}
            </th>
            <th scope="col" className="money-num money-cell--today">
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
          <CoinRow key={row.asset} row={row} hidden={hidden} markets={markets} copy={copy} layout={layout} balances={balances} />
        ))}
      </tbody>
    </table>
  );
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
  balances,
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
  balances: Balances;
}) {
  const { t } = copy;
  // Small balances fold away only when there is something bigger to show above them.
  const small = collapseSmall ? rows.filter(isSmall) : [];
  const main = small.length > 0 && small.length < rows.length ? rows.filter((row) => !isSmall(row)) : rows;
  const folded = main === rows ? [] : small;
  return (
    <section id={id} className="money-card" aria-labelledby={`money-${id}-title`}>
      <header className="money-card__head">
        <h2 id={`money-${id}-title`}>{title}</h2>
        <Money value={total === null ? null : fmtUsd(total)} hidden={hidden} className="money-card__total" />
      </header>
      <CoinTable rows={main} hidden={hidden} markets={markets} copy={copy} head layout={layout} balances={balances} />
      {folded.length > 0 ? (
        <Collapsible className="money-small">
          <CollapsibleTrigger className="money-small__trigger">
            <span>{t('Small balances')}</span>
            <span className="money-small__count">
              {folded.length === 1 ? t('1 coin under $1') : t('{count} coins under $1', { count: folded.length })}
            </span>
            <ChevronDown size={20} aria-hidden="true" className="money-small__chev" />
          </CollapsibleTrigger>
          <CollapsiblePanel>
            <CoinTable rows={folded} hidden={hidden} markets={markets} copy={copy} head={false} layout={layout} balances={balances} />
          </CollapsiblePanel>
        </Collapsible>
      ) : null}
    </section>
  );
}

function CardSkeleton({ rows }: { rows: number }) {
  return (
    <section className="money-card" aria-hidden="true">
      <header className="money-card__head">
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
    <section id="accounts" className="money-card" aria-labelledby="money-accounts-title">
      <header className="money-card__head">
        <h2 id="money-accounts-title">{t('Your accounts')}</h2>
      </header>
      <p className="money-card__note">{t('Your accounts note')}</p>
      <ul className="money-accounts">
        {accounts.map((account) => (
          <li key={account.id} className="money-accounts__row">
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
  const { hideBalances, layoutMode } = usePreferences();
  const layout: Mode = layoutMode === 'pro' ? 'pro' : 'simple';
  const portfolio = useMoneyPortfolio();
  const balances = useAssetBalances(layout === 'pro');
  const markets = useMarkets();
  const accounts = useNamedAccounts();

  const view = portfolio.status === 'ready' ? portfolio.data : null;
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
        className="money-state"
        title={words.title}
        body={words.body}
        code={words.reference}
        action={words.action}
      />
    );
  } else if (portfolio.status === 'empty' || !view) {
    body = (
      <StateBlock
        kind="empty"
        className="money-state"
        title={t('Nothing held')}
        body={t('Nothing held body')}
        action={buyTarget ? { label: t('Buy crypto'), href: buyTarget } : undefined}
      />
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
            balances={balances}
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
            balances={balances}
          />
        ) : null}
        {accounts.status === 'ready' && accounts.data.some((account) => (dec(account.balance) ?? 0n) > 0n) ? (
          <Accounts accounts={accounts.data} hidden={hideBalances} copy={copy} />
        ) : null}
      </>
    );
  }

  return (
    <div className="if-money" data-source={view?.source ?? undefined} data-density={layout === 'pro' ? 'pro' : undefined}>
      <h1 className="if-sr">{t('Money')}</h1>
      <div className="money-head">
        <div className="money-head__main">
          <div className="money-label">
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
              <div className="money-total">
                <Skeleton width={240} height={56} />
              </div>
              <div className="money-change">
                <Skeleton width={180} height={20} />
              </div>
            </div>
          ) : view ? (
            <Headline view={view} hidden={hideBalances} copy={copy} pro={layout === 'pro'} />
          ) : portfolio.status === 'empty' ? (
            <div className="money-total">
              {/* The balance call answered with no assets, so zero is correct here and only here. */}
              <HeroNumber value="0.00" decimals={2} prefix="$" size={layout === 'pro' ? 'hero-pro' : 'hero'} hidden={hideBalances} />
            </div>
          ) : null}
        </div>
        <ActionPills loading={portfolio.status === 'loading'} mode={mode} layout={layout} />
      </div>
      {body}
    </div>
  );
}
