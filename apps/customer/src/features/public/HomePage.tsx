// volt-room: /
import { useMemo, useState } from 'react';
import {
  Button,
  ButtonLink,
  Display,
  Field,
  FeaturedMarket,
  LiveDot,
  MarketTable,
  MoverTile,
  PageColumn,
  PageGrid,
  PanelHead,
  SectionTitle,
  Stat,
  Surface,
  TileRow,
  TrustStrip,
  type MarketRow as KitMarketRow,
} from '@intafaced/ui/lit';
import { AreaChart, Segmented, TestTag } from '@intafaced/ui/lit/templates';
import { useDataEnv, useMarkets, useSource, useSparklines, useTickers } from '../../data/hooks';
import { compareDecimal, dec, str, sumOf, type Scaled } from '../../data/decimal';
import { fmtPct, fmtPrice, fmtUsd } from '../../data/format';
import type { Decimal, Loadable, MarketRow, TickerRow } from '../../data/types';
import { bpsAsPercent, publicFeesFetcher, type PublicFeeSchedule } from './fees';
import { landingCopy } from './landing-copy';
import './landing.css';

type T = ReturnType<typeof landingCopy.useCopy>['t'];
type Tab = 'popular' | 'gainers' | 'losers';
interface Line {
  market: MarketRow;
  ticker: TickerRow | undefined;
}

const USD_QUOTES = new Set(['USD', 'USDT', 'USDC']);
const BOARD_ROWS = 6;
const MOVERS = 5;

const pairPath = (market: MarketRow) => `/trade/spot/${encodeURIComponent(`${market.base}-${market.quote}`)}`;
const priceOf = (line: Line) => {
  const price = fmtPrice(line.ticker?.last, line.market.tickSize);
  if (price === '—' || !USD_QUOTES.has(line.market.quote)) return price;
  return `$${price}`;
};
type Traded = { ticker?: { last?: string | null; quoteVolume24h?: string | null } };
const byVolume = (a: Traded, b: Traded) => compareDecimal(b.ticker?.quoteVolume24h ?? '0', a.ticker?.quoteVolume24h ?? '0') ?? 0;
const byChange = (a: Line, b: Line) => compareDecimal(b.ticker?.changePct24h ?? '0', a.ticker?.changePct24h ?? '0') ?? 0;

/** Open markets joined to their tickers, the one list every part of the page reads. */
function useLines(): { lines: Line[]; state: Loadable<unknown> } {
  const markets = useMarkets();
  const tickers = useTickers();
  const lines = useMemo(() => {
    if (markets.status !== 'ready') return [];
    const rows = tickers.status === 'ready' ? tickers.data : {};
    return markets.data.filter((m) => m.orderable).map((market) => ({ market, ticker: rows[market.symbol] }));
  }, [markets, tickers]);
  return { lines, state: markets };
}

/** The published fee schedule's default taker rate in basis points, or null when nothing is published. */
function useTakerBps(): number | null {
  const env = useDataEnv();
  const source = useMemo(
    () => env.poller.source<PublicFeeSchedule | null>('public-fees', publicFeesFetcher(env.api), { intervalMs: 60_000 }),
    [env],
  );
  const load = useSource(source);
  if (load.status !== 'ready' || !load.data) return null;
  const group = load.data.groups.find((g) => g.isDefault) ?? load.data.groups[0];
  const rates = (group?.rows ?? []).filter((row) => !row.refusal).map((row) => (row.zeroFee ? 0 : row.takerBps));
  return rates.length ? Math.min(...rates) : null;
}

/**
 * Popular: the markets with a last trade, by 24h volume. A market with no print yet stays out of it (a row of dashes
 * tells a visitor nothing); it stays in the market count and on All markets.
 */
export function popularOf<L extends Traded>(lines: readonly L[]): L[] {
  return lines.filter((l) => !!l.ticker?.last).sort(byVolume);
}

/** The public landing page (/): the markets first, one balance behind them, and the real ticket with its fees. */
export function HomePage() {
  const { t } = landingCopy.useCopy();
  const { lines, state } = useLines();
  const takerBps = useTakerBps();
  const volume = useMemo(() => {
    const usd = lines.filter((l) => USD_QUOTES.has(l.market.quote) && l.ticker?.quoteVolume24h);
    return usd.length ? str(sumOf(usd.map((l) => dec(l.ticker!.quoteVolume24h) ?? 0n))) : null;
  }, [lines]);
  const popular = useMemo(() => popularOf(lines), [lines]);
  const featured = popular[0];
  return (
    <div className="ld" data-room="landing">
      <PageGrid layout="hero">
        <PageColumn className="ld-pitch">
          <Display second={t('heroLine2')}>{t('heroLine1')}</Display>
          <p className="ld-lead">{t('heroLead')}</p>
          {/* The email goes to sign-up, which opens with it filled in; sign-up asks for the rest. */}
          <form className="ld-signup" action="/register" method="get">
            <Field
              label={t('emailLabel')}
              name="email"
              type="email"
              autoComplete="email"
              placeholder={t('emailPlaceholder')}
              maxLength={320}
              after={
                <Button type="submit" tone="primary" size="lg">
                  {t('createShort')}
                </Button>
              }
            />
          </form>
          <div className="ld-actions">
            <ButtonLink size="sm" href="/login">
              {t('passkeySignIn')}
            </ButtonLink>
          </div>
          <p className="ld-note">{t('heroNote')}</p>
          <TileRow min="narrow" className="ld-stats">
            <Stat labelBelow label={t('statMarkets')} value={state.status === 'ready' ? String(lines.length) : null} />
            <Stat labelBelow label={t('statVolume')} value={volume === null ? null : fmtUsd(volume, { compact: true })} />
            <Stat
              labelBelow
              label={takerBps === null ? t('statFeeBlank') : t('statFee')}
              value={takerBps === null ? null : bpsAsPercent(takerBps)}
            />
          </TileRow>
        </PageColumn>
        <PageColumn>
          <MarketBoard lines={lines} popular={popular} featured={featured} state={state} t={t} />
        </PageColumn>
        <PageColumn span="all">
          <Moving lines={lines} t={t} />
          <TrustStrip
            label={t('trustFees')}
            cells={[
              { key: 'test', title: t('trustTest'), body: t('trustTestBody') },
              { key: 'fees', title: t('trustFees'), body: t('trustFeesBody') },
              { key: 'passkeys', title: t('trustSignIn'), body: t('trustSignInBody') },
              { key: 'wallet', title: t('trustWallet'), body: t('trustWalletBody') },
            ]}
          />
          <DeskSection line={featured} takerBps={takerBps} t={t} />
          <section className="ld-closing" aria-labelledby="ld-closing-title">
            <SectionTitle className="ld-closing-title">
              <span id="ld-closing-title">{t('closingTitle')}</span>
            </SectionTitle>
            <ButtonLink tone="secondary" size="lg" href="/register">
              {t('createAccount')}
            </ButtonLink>
          </section>
        </PageColumn>
      </PageGrid>
    </div>
  );
}

const rowOf = (line: Line, trend: Record<string, Decimal[]>): KitMarketRow => ({
  id: line.market.symbol,
  symbol: line.market.base,
  name: `/${line.market.quote}`,
  price: line.ticker?.last ? priceOf(line) : null,
  change: line.ticker?.changePct24h != null ? fmtPct(line.ticker.changePct24h) : null,
  trend: trend[line.market.symbol] ?? [],
  volume: line.ticker?.quoteVolume24h ? fmtUsd(line.ticker.quoteVolume24h, { compact: true }) : null,
  href: pairPath(line.market),
});

function MarketBoard({
  lines,
  popular,
  featured,
  state,
  t,
}: {
  lines: Line[];
  popular: Line[];
  featured: Line | undefined;
  state: Loadable<unknown>;
  t: T;
}) {
  const [tab, setTab] = useState<Tab>('popular');
  const rows = useMemo(() => {
    const priced = lines.filter((l) => l.ticker?.changePct24h != null);
    if (tab === 'gainers') return [...priced].sort(byChange).slice(0, BOARD_ROWS);
    if (tab === 'losers') return [...priced].sort(byChange).reverse().slice(0, BOARD_ROWS);
    return popular.slice(0, BOARD_ROWS);
  }, [lines, popular, tab]);
  const sparks = useSparklines(rows.map((r) => r.market.symbol));
  const trend = sparks.status === 'ready' ? sparks.data : {};
  return (
    <Surface className="ld-board" aria-label={t('boardLabel')}>
      <PanelHead
        title={
          <Segmented
            label={t('boardLabel')}
            value={tab}
            onChange={(value) => setTab(value as Tab)}
            options={[
              { value: 'popular', label: t('tabPopular') },
              { value: 'gainers', label: t('tabGainers') },
              { value: 'losers', label: t('tabLosers') },
            ]}
          />
        }
        aside={<LiveDot>{t('boardLive')}</LiveDot>}
      />
      {featured ? <Featured line={featured} t={t} /> : null}
      {state.status === 'error' ? (
        <p className="ld-board-note">{t('boardFailed')}</p>
      ) : (
        <MarketTable
          labels={{
            caption: t('boardLabel'),
            market: t('colMarket'),
            price: t('colPrice'),
            change: t('colChange'),
            trend: t('colTrend'),
            volume: t('colVolume'),
            trendLabel: (row) => t('trendOf', { symbol: row.symbol }),
          }}
          rows={rows.map((line) => rowOf(line, trend))}
          loadingRows={state.status === 'loading' ? BOARD_ROWS : undefined}
          empty={<p className="ld-board-note">{t('boardEmpty')}</p>}
        />
      )}
      <footer className="ld-board-foot">
        <span>{t('boardFootNote')}</span>
        <a href="/trade/markets">{t('boardAll', { count: String(lines.length) })} →</a>
      </footer>
    </Surface>
  );
}

const HOUR_MS = 3_600_000;

/**
 * A market's last day as chart points: the same hourly closes its board row draws (useSparklines), the last one in the
 * current hour. Fewer than two closes draw no line (the chart parts leave the area empty), never a line made of fill.
 */
function useTrendPoints(symbol: string | undefined): { at: string; value: Decimal }[] {
  const sparks = useSparklines(symbol ? [symbol] : []);
  const closes = symbol && sparks.status === 'ready' ? (sparks.data[symbol] ?? []) : [];
  const lastHour = Math.floor(Date.now() / HOUR_MS) * HOUR_MS;
  return closes.map((value, i) => ({ at: new Date(lastHour - (closes.length - 1 - i) * HOUR_MS).toISOString(), value }));
}

/** The busiest market, large, with its last day drawn from the same hourly closes as its board row. */
function Featured({ line, t }: { line: Line; t: T }) {
  const points = useTrendPoints(line.market.symbol);
  return (
    <FeaturedMarket
      symbol={line.market.base}
      name={`/${line.market.quote}`}
      price={line.ticker?.last ? priceOf(line) : null}
      change={line.ticker?.changePct24h != null ? fmtPct(line.ticker.changePct24h) : null}
      points={points}
      chartLabel={t('trendOf', { symbol: line.market.base })}
      asset={line.market.quote}
      href={pairPath(line.market)}
    />
  );
}

function Moving({ lines, t }: { lines: Line[]; t: T }) {
  const movers = useMemo(
    () =>
      lines
        .filter((l) => l.ticker?.changePct24h != null)
        .sort((a, b) => {
          const abs = (l: Line) => (dec(l.ticker!.changePct24h) ?? 0n) * ((dec(l.ticker!.changePct24h) ?? 0n) < 0n ? -1n : 1n);
          return abs(b) > abs(a) ? 1 : abs(b) < abs(a) ? -1 : 0;
        })
        .slice(0, MOVERS),
    [lines],
  );
  const sparks = useSparklines(movers.map((m) => m.market.symbol));
  if (movers.length === 0) return null;
  return (
    <section className="ld-moving" aria-labelledby="ld-moving-title">
      <PanelHead title={<span id="ld-moving-title">{t('movingTitle')}</span>} aside={<span className="ld-aside">{t('movingNote')}</span>} />
      <TileRow>
        {movers.map((line) => (
          <MoverTile
            key={line.market.symbol}
            symbol={`${line.market.base}/${line.market.quote}`}
            price={line.ticker?.last ? priceOf(line) : null}
            change={fmtPct(line.ticker?.changePct24h)}
            trend={sparks.status === 'ready' ? (sparks.data[line.market.symbol] ?? []) : []}
            trendLabel={t('trendOf', { symbol: line.market.base })}
            href={pairPath(line.market)}
          />
        ))}
      </TileRow>
    </section>
  );
}

/** A share of the example's price, in basis points: where its stop and its target sit. */
const STOP_BPS = 210n;
const TARGET_BPS = 144n;
/** The example long: its margin and leverage. An illustration on the live price, drawn with TEST. */
const EXAMPLE_MARGIN = '1000';
const EXAMPLE_LEVERAGE = 10n;
const BPS = 10_000n;

/**
 * The doors of the one account beside an example long on the busiest market: its size, what a stop or a target would
 * leave after our fee, all from the live price and the published taker rate (blank where no fee is set). TEST.
 */
function DeskSection({ line, takerBps, t }: { line: Line | undefined; takerBps: number | null; t: T }) {
  const doors = [
    { href: '/trade/markets', name: t('doorTrade'), line: t('doorTradeLine') },
    { href: '/register', name: t('doorWallet'), line: t('doorWalletLine') },
    { href: '/register', name: t('doorAgents'), line: t('doorAgentsLine') },
    { href: '/developers', name: t('doorApi'), line: t('doorApiLine') },
  ];
  return (
    <section className="ld-desk" aria-labelledby="ld-desk-title">
      <div className="ld-desk-copy">
        <SectionTitle className="ld-big-title">
          <span id="ld-desk-title">{t('deskTitle')}</span>
        </SectionTitle>
        <ul className="ld-doors">
          {doors.map((door) => (
            <li key={door.name}>
              <a href={door.href}>
                <strong>{door.name}</strong>
                <span>{door.line}</span>
                <span className="ld-door-arrow" aria-hidden="true">
                  →
                </span>
              </a>
            </li>
          ))}
        </ul>
      </div>
      <ExampleLong line={line} takerBps={takerBps} t={t} />
    </section>
  );
}

/** One example position, every figure worked from the live price: what a person sees on the desk before placing it. */
export function exampleLong(price: Scaled, takerBps: number | null) {
  const margin = dec(EXAMPLE_MARGIN)!;
  const size = margin * EXAMPLE_LEVERAGE;
  const fee = takerBps === null ? null : (size * BigInt(takerBps) * 2n) / BPS;
  const stop = price - (price * STOP_BPS) / BPS;
  const target = price + (price * TARGET_BPS) / BPS;
  const stopMove = -(size * STOP_BPS) / BPS;
  const targetMove = (size * TARGET_BPS) / BPS;
  return {
    size,
    fee,
    stop,
    target,
    ifStopped: fee === null ? null : stopMove - fee,
    ifTarget: fee === null ? null : targetMove - fee,
  };
}

const signedUsd = (value: Scaled) => (value < 0n ? `−${fmtUsd(str(-value))}` : `+${fmtUsd(str(value))}`);

function ExampleLong({ line, takerBps, t }: { line: Line | undefined; takerBps: number | null; t: T }) {
  const price = dec(line?.ticker?.last);
  const points = useTrendPoints(line?.market.symbol);
  const symbol = line?.market.base ?? '';
  const ex = price && price > 0n ? exampleLong(price, takerBps) : null;
  const usd = (value: Scaled) => fmtUsd(str(value));
  return (
    <figure className="ld-card" aria-label={t('cardLabel', { symbol })}>
      <div className="ld-card-chart">
        <div className="ld-card-head">
          <span className="ld-card-symbol">
            {symbol} <TestTag />
          </span>
          <span>{line && line.ticker?.last ? priceOf(line) : t('cardNoPrice')}</span>
        </div>
        <div className="ld-card-plot" hidden={points.length < 2}>
          {line ? <AreaChart label={t('trendOf', { symbol })} points={points} asset={line.market.quote} tone="ink" soft fit /> : null}
        </div>
        {ex && ex.ifTarget !== null && ex.ifStopped !== null ? (
          <div className="ld-card-levels">
            <span data-tone="up">{t('cardTargetTag', { price: usd(ex.target), pnl: signedUsd(ex.ifTarget) })}</span>
            <span data-tone="down">{t('cardStopTag', { price: usd(ex.stop), pnl: signedUsd(ex.ifStopped) })}</span>
          </div>
        ) : null}
      </div>
      <div className="ld-card-side">
        <dl className="ld-card-lines">
          <div>
            <dt>{t('cardSize', { lev: String(EXAMPLE_LEVERAGE) })}</dt>
            <dd>{ex ? usd(ex.size) : '—'}</dd>
          </div>
          <div>
            <dt>{t('cardStopped')}</dt>
            <dd data-tone="down">{ex?.ifStopped != null ? signedUsd(ex.ifStopped) : t('cardNotSet')}</dd>
          </div>
          <div>
            <dt>{t('cardTarget')}</dt>
            <dd data-tone="up">{ex?.ifTarget != null ? signedUsd(ex.ifTarget) : t('cardNotSet')}</dd>
          </div>
          <div>
            <dt>{takerBps === null ? t('cardFeeBlank') : t('cardFee', { pct: bpsAsPercent(takerBps) })}</dt>
            <dd>{ex?.fee != null ? usd(ex.fee) : t('cardNotSet')}</dd>
          </div>
        </dl>
        <ButtonLink tone="secondary" size="lg" block href="/register">
          {t('cardOpen')}
        </ButtonLink>
        <p className="ld-card-note">{t('cardNote')}</p>
      </div>
    </figure>
  );
}
