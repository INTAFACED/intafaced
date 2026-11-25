// volt-room: /
import { useMemo, useState } from 'react';
import { CoinIcon } from '@intafaced/ui/lit';
import { AreaChart, Segmented, Sparkline, TestTag } from '@intafaced/ui/lit/templates';
import { useCandles, useDataEnv, useMarkets, useSource, useSparklines, useTickers } from '../../data/hooks';
import { compareDecimal, dec, ratio, str, sub, sumOf } from '../../data/decimal';
import { fmtAmount, fmtPct, fmtPrice, fmtUsd } from '../../data/format';
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
/** The example order in "see the real screen": an amount, not a balance; its price and fee are live. */
const EXAMPLE_SPEND = '1000';

const pairPath = (market: MarketRow) => `/trade/spot/${encodeURIComponent(`${market.base}-${market.quote}`)}`;
const priceOf = (line: Line) => {
  const price = fmtPrice(line.ticker?.last, line.market.tickSize);
  if (price === '—' || !USD_QUOTES.has(line.market.quote)) return price;
  return `$${price}`;
};
const toneOf = (pct: Decimal | null | undefined) => {
  const sign = compareDecimal(pct, '0');
  return sign === 1 ? 'up' : sign === -1 ? 'down' : 'neutral';
};
const byVolume = (a: Line, b: Line) => compareDecimal(b.ticker?.quoteVolume24h ?? '0', a.ticker?.quoteVolume24h ?? '0') ?? 0;
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

/** The public landing page (/): the markets first, one balance behind them, and the real ticket with its fees. */
export function HomePage() {
  const { t } = landingCopy.useCopy();
  const { lines, state } = useLines();
  const takerBps = useTakerBps();
  const volume = useMemo(() => {
    const usd = lines.filter((l) => USD_QUOTES.has(l.market.quote) && l.ticker?.quoteVolume24h);
    return usd.length ? str(sumOf(usd.map((l) => dec(l.ticker!.quoteVolume24h) ?? 0n))) : null;
  }, [lines]);
  const popular = useMemo(() => [...lines].sort(byVolume), [lines]);
  const featured = popular[0];
  return (
    <div className="ld" data-room="landing">
      <section className="ld-hero" aria-labelledby="ld-title">
        <div className="ld-pitch">
          <h1 id="ld-title" className="ld-title">
            <span>{t('heroLine1')}</span>
            <span className="ld-title-dim">{t('heroLine2')}</span>
          </h1>
          <p className="ld-lead">{t('heroLead')}</p>
          <div className="ld-actions">
            <a className="ld-cta" href="/register">
              {t('createAccount')}
            </a>
            <a className="ld-cta-2" href="/trade/markets">
              {t('seeMarkets')}
            </a>
          </div>
          <p className="ld-note">{t('heroNote')}</p>
          <dl className="ld-stats">
            <div>
              <dt>{t('statMarkets')}</dt>
              <dd>{state.status === 'ready' ? String(lines.length) : '—'}</dd>
            </div>
            <div>
              <dt>{t('statVolume')}</dt>
              <dd>{fmtUsd(volume, { compact: true })}</dd>
            </div>
            <div>
              <dt>{takerBps === null ? t('statFeeBlank') : t('statFee')}</dt>
              <dd>{takerBps === null ? '—' : bpsAsPercent(takerBps)}</dd>
            </div>
          </dl>
        </div>
        <MarketBoard lines={lines} popular={popular} featured={featured} state={state} t={t} />
      </section>

      <Moving lines={lines} t={t} />

      <section className="ld-trust" aria-label={t('trustFees')}>
        <TrustItem title={t('trustReserves')} body={t('trustReservesBody')} />
        <TrustItem title={t('trustLicences')} body={t('trustLicencesBody')} />
        <TrustItem title={t('trustPasskeys')} body={t('trustPasskeysBody')} />
        <TrustItem title={t('trustFees')} body={t('trustFeesBody')} />
      </section>

      <Slab t={t} />

      <FeesPreview line={featured} takerBps={takerBps} t={t} />

      <section className="ld-closing" aria-labelledby="ld-closing-title">
        <h2 id="ld-closing-title">{t('closingTitle')}</h2>
        <a className="ld-cta" href="/register">
          {t('openAccount')}
        </a>
      </section>
    </div>
  );
}

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
  const lines24 = sparks.status === 'ready' ? sparks.data : {};
  return (
    <section className="ld-board" aria-label={t('boardLabel')}>
      <header className="ld-board-head">
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
        <span className="ld-live">
          <span className="ld-live-dot" aria-hidden="true" />
          {t('boardLive')}
        </span>
      </header>
      {featured ? <Featured line={featured} t={t} /> : null}
      {state.status === 'loading' ? (
        <p className="ld-board-note">{t('boardLoading')}</p>
      ) : state.status === 'error' ? (
        <p className="ld-board-note">{t('boardFailed')}</p>
      ) : rows.length === 0 ? (
        <p className="ld-board-note">{t('boardEmpty')}</p>
      ) : (
        <table className="ld-table">
          <caption className="ld-sr">{t('boardLabel')}</caption>
          <thead>
            <tr>
              <th scope="col">{t('colMarket')}</th>
              <th scope="col">{t('colPrice')}</th>
              <th scope="col">{t('colChange')}</th>
              <th scope="col" className="ld-col-trend">
                {t('colTrend')}
              </th>
              <th scope="col" className="ld-col-vol">
                {t('colVolume')}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((line) => {
              const pct = line.ticker?.changePct24h;
              return (
                <tr key={line.market.symbol} data-symbol={line.market.symbol}>
                  <th scope="row">
                    <a href={pairPath(line.market)} className="ld-coin">
                      <CoinIcon asset={line.market.base} size="sm" />
                      <span className="ld-coin-sym">{line.market.base}</span>
                      <span className="ld-coin-quote">/{line.market.quote}</span>
                    </a>
                  </th>
                  <td className="ld-num">{priceOf(line)}</td>
                  <td className="ld-num" data-tone={toneOf(pct)}>
                    {fmtPct(pct)}
                  </td>
                  <td className="ld-col-trend">
                    <Sparkline
                      label={t('trendOf', { symbol: line.market.base })}
                      values={lines24[line.market.symbol] ?? []}
                      tone={toneOf(pct)}
                      size="row"
                    />
                  </td>
                  <td className="ld-num ld-col-vol">{fmtUsd(line.ticker?.quoteVolume24h, { compact: true })}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <footer className="ld-board-foot">
        <span>{t('boardFootNote')}</span>
        <a href="/trade/markets">{t('boardAll', { count: String(lines.length) })} →</a>
      </footer>
    </section>
  );
}

/** The busiest market, large, with its last day drawn from its hourly candles. */
function Featured({ line, t }: { line: Line; t: T }) {
  const candles = useCandles(line.market.symbol, '1h', 48);
  const points = candles.status === 'ready' ? candles.data.map((c) => ({ at: new Date(c.t).toISOString(), value: c.c })) : [];
  const pct = line.ticker?.changePct24h;
  return (
    <a className="ld-featured" href={pairPath(line.market)}>
      <div className="ld-featured-figure">
        <span className="ld-coin">
          <CoinIcon asset={line.market.base} size="sm" />
          <span className="ld-coin-sym">{line.market.base}</span>
          <span className="ld-coin-quote">/{line.market.quote}</span>
        </span>
        <span className="ld-featured-price">{priceOf(line)}</span>
        <span className="ld-num" data-tone={toneOf(pct)}>
          {fmtPct(pct)}
        </span>
      </div>
      <div className="ld-featured-chart">
        <AreaChart
          label={t('trendOf', { symbol: line.market.base })}
          points={points}
          asset={line.market.quote}
          tone={toneOf(pct)}
          soft
          live
        />
      </div>
    </a>
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
        .filter((line, index, all) => all.findIndex((other) => other.market.base === line.market.base) === index)
        .slice(0, MOVERS),
    [lines],
  );
  const sparks = useSparklines(movers.map((m) => m.market.symbol));
  if (movers.length === 0) return null;
  return (
    <section className="ld-moving" aria-labelledby="ld-moving-title">
      <header className="ld-section-head">
        <h2 id="ld-moving-title">{t('movingTitle')}</h2>
        <p>{t('movingNote')}</p>
      </header>
      <ul className="ld-tiles">
        {movers.map((line) => {
          const pct = line.ticker?.changePct24h;
          return (
            <li key={line.market.symbol}>
              <a className="ld-tile" href={pairPath(line.market)}>
                <span className="ld-tile-top">
                  <span className="ld-coin-sym">{line.market.base}</span>
                  <span className="ld-num" data-tone={toneOf(pct)}>
                    {fmtPct(pct)}
                  </span>
                </span>
                <span className="ld-tile-price">{priceOf(line)}</span>
                <Sparkline
                  label={t('trendOf', { symbol: line.market.base })}
                  values={sparks.status === 'ready' ? (sparks.data[line.market.symbol] ?? []) : []}
                  tone={toneOf(pct)}
                />
              </a>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function TrustItem({ title, body }: { title: string; body: string }) {
  return (
    <div className="ld-trust-item">
      <h3>{title}</h3>
      <p>{body}</p>
    </div>
  );
}

/** B's engraved balance slab: one illustrative account (TEST) and the three doors it opens in the beta. */
function Slab({ t }: { t: T }) {
  const parts = [
    { name: t('partTrading'), share: 52 },
    { name: t('partWallet'), share: 39 },
    { name: t('partAgents'), share: 9 },
  ];
  const doors = [
    { href: '/trade/markets', name: t('doorTrade'), line: t('doorTradeLine') },
    { href: '/register', name: t('doorWallet'), line: t('doorWalletLine') },
    { href: '/register', name: t('doorAgents'), line: t('doorAgentsLine') },
  ];
  return (
    <section className="ld-slab-section" aria-labelledby="ld-slab-title">
      <div className="ld-slab-copy">
        <h2 id="ld-slab-title">{t('slabTitle')}</h2>
        <p>{t('slabLead')}</p>
        <ul className="ld-doors">
          {doors.map((door) => (
            <li key={door.name}>
              <a href={door.href}>
                <strong>{door.name}</strong>
                <span>{door.line}</span>
              </a>
            </li>
          ))}
        </ul>
      </div>
      <figure className="ld-slab" aria-label={t('slabExample')}>
        <div className="ld-slab-top">
          <span className="ld-slab-brand">INTAFACED</span>
          <span className="ld-slab-example">
            {t('slabExample')} <TestTag />
          </span>
        </div>
        <div className="ld-slab-figure">
          <span className="ld-slab-label">{t('slabTotal')}</span>
          <span className="ld-slab-total">
            $24,860<span className="ld-slab-cents">.40</span>
          </span>
          <span className="ld-slab-today" data-tone="up">
            {t('slabToday')}
          </span>
        </div>
        <div className="ld-slab-parts">
          {parts.map((part) => (
            <span key={part.name} className="ld-slab-part" style={{ flexGrow: part.share }}>
              <span className="ld-slab-bar" />
              <span>{part.name}</span>
            </span>
          ))}
        </div>
      </figure>
    </section>
  );
}

/** C's "see the real screen with its fees": the ticket on the busiest market's live price and the published taker rate. */
function FeesPreview({ line, takerBps, t }: { line: Line | undefined; takerBps: number | null; t: T }) {
  const spend = dec(EXAMPLE_SPEND)!;
  const price = dec(line?.ticker?.last);
  const fee = takerBps === null ? null : (spend * BigInt(takerBps)) / 10_000n;
  const net = fee === null ? spend : sub(spend, fee);
  const amount = price && price > 0n ? ratio(net, price) : null;
  const candles = useCandles(line?.market.symbol ?? 'BTC/USDT', '1h', 48);
  const points = line && candles.status === 'ready' ? candles.data.map((c) => ({ at: new Date(c.t).toISOString(), value: c.c })) : [];
  return (
    <section className="ld-fees" aria-labelledby="ld-fees-title">
      <header className="ld-section-head ld-fees-head">
        <h2 id="ld-fees-title">{t('feesTitle')}</h2>
        <p>{t('feesLead')}</p>
      </header>
      <div className="ld-ticket">
        <div className="ld-ticket-main">
          <span className="ld-ticket-kicker">
            {t('feesExample')} <TestTag />
          </span>
          <span className="ld-slab-label">{t('feesYouPay')}</span>
          <span className="ld-ticket-big">{fmtUsd(EXAMPLE_SPEND)}</span>
          <span className="ld-slab-label">{t('feesYouGet')}</span>
          <span className="ld-ticket-get">
            {amount === null ? '—' : `${fmtAmount(str(amount), { places: 6 })} ${line?.market.base ?? ''}`}
          </span>
          <div className="ld-ticket-chart" hidden={points.length < 2}>
            {line ? (
              <AreaChart label={t('trendOf', { symbol: line.market.base })} points={points} asset={line.market.quote} soft live />
            ) : null}
          </div>
        </div>
        <dl className="ld-ticket-lines">
          <div>
            <dt>{line ? t('feesBuy', { asset: line.market.base }) : t('feesPrice')}</dt>
            <dd>{line ? priceOf(line) : t('feesNoPrice')}</dd>
          </div>
          <div>
            <dt>{takerBps === null ? t('feesOurFee', { pct: '—' }) : t('feesOurFee', { pct: bpsAsPercent(takerBps) })}</dt>
            <dd>{fee === null ? t('feesNotSet') : fmtUsd(str(fee))}</dd>
          </div>
          <div>
            <dt>{t('feesVenue')}</dt>
            <dd>{t('feesVenueLine')}</dd>
          </div>
          <div className="ld-ticket-total">
            <dt>{t('feesTotal')}</dt>
            <dd>{fmtUsd(EXAMPLE_SPEND)}</dd>
          </div>
          <a className="ld-cta ld-cta-block" href="/register">
            {t('startTrading')}
          </a>
          <a className="ld-link" href="/fees">
            {t('feesSchedule')} →
          </a>
        </dl>
      </div>
    </section>
  );
}
