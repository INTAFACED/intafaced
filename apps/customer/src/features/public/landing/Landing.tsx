import { useMemo, useState } from 'react';
import { AssetIcon, Segmented } from '@intafaced/ui/lit';
import { AreaChart, Sparkline, TestTag } from '@intafaced/ui/lit/templates';
import { useCandles, useDataEnv, useMarkets, useSource, useSparklines, useTickers } from '../../../data/hooks';
import { direction, fmtPct, fmtPrice, fmtUsd } from '../../../data/format';
import { dec, ratio, roundScaled, sumOf, times, toFixedString } from '../../../data/decimal';
import type { Loadable, TickerRow } from '../../../data/types';
import { isUsdQuote, listings, type Listing } from '../../../screens/home/select';
import { bpsAsPercent, publicFeesFetcher, rowFor, type PublicFeeSchedule } from '../fees';
import { landingCopy } from './landing-copy';
import './landing.css';

type Tab = 'popular' | 'gainers' | 'losers';
type Tickers = Record<string, TickerRow>;
const ROWS = 6;
const BUY_AMOUNTS = ['100', '250', '1000'] as const;

const tickersOf = (load: Loadable<Tickers>): Tickers | undefined => (load.status === 'ready' ? load.data : undefined);
const pctOf = (row: TickerRow | undefined) => dec(row?.changePct24h) ?? 0n;
const volumeOf = (row: TickerRow | undefined) => dec(row?.quoteVolume24h) ?? 0n;
const tone = (value: string | null | undefined) => {
  const dir = direction(value);
  return dir === 'up' || dir === 'down' ? dir : 'neutral';
};

/** The rows a tab lists: most traded first, or the biggest risers or fallers over 24 hours. */
export function rowsFor(tab: Tab, list: readonly Listing[], tickers: Tickers | undefined): Listing[] {
  const by = (score: (row: TickerRow | undefined) => bigint, desc: boolean) =>
    [...list].sort((a, b) => {
      const d = score(tickers?.[a.symbol]) - score(tickers?.[b.symbol]);
      return d === 0n ? 0 : d > 0n === desc ? -1 : 1;
    });
  if (tab === 'gainers') return by(pctOf, true).slice(0, ROWS);
  if (tab === 'losers') return by(pctOf, false).slice(0, ROWS);
  return by(volumeOf, true).slice(0, ROWS);
}

function priceOf(item: Listing, row: TickerRow | undefined): string {
  const price = fmtPrice(row?.last, item.market.tickSize);
  return isUsdQuote(item.market.quote) && row?.last ? `$${price}` : price;
}

function Change({ value }: { value: string | null | undefined }) {
  return (
    <span className="landing-num" data-tone={tone(value)}>
      {fmtPct(value)}
    </span>
  );
}

function Hero({ list, tickers, takerBps }: { list: Listing[] | null; tickers: Tickers | undefined; takerBps: number | null | undefined }) {
  const { t } = landingCopy.useCopy();
  const volume = list && tickers ? sumOf(list.filter((i) => isUsdQuote(i.market.quote)).map((i) => volumeOf(tickers[i.symbol]))) : null;
  return (
    <div className="landing-hero-copy">
      <h1>
        {t('Every market.')}
        <br />
        <span className="landing-dim">{t('One account.')}</span>
      </h1>
      <p className="landing-lede">{t('lede')}</p>
      <div className="landing-cta">
        <a className="lt-button lt-button-primary landing-cta-main" href="/register">
          {t('Create your account')}
        </a>
        <a className="lt-button lt-button-secondary" href="/login">
          {t('Sign in')}
        </a>
      </div>
      <p className="landing-hint">{t('Sign in with a passkey, or your email and a code.')}</p>
      <dl className="landing-stats">
        <div>
          <dt>{t('markets')}</dt>
          <dd className="landing-fig">{list ? list.length : '—'}</dd>
        </div>
        <div>
          <dt>{t('traded in 24h')}</dt>
          <dd className="landing-fig">{volume !== null ? fmtUsd(toFixedString(volume, 2), { compact: true }) : '—'}</dd>
        </div>
        <div>
          <dt>{t('taker fee from')}</dt>
          <dd className="landing-fig">{takerBps === undefined ? '—' : takerBps === null ? t('not set') : bpsAsPercent(takerBps)}</dd>
        </div>
      </dl>
    </div>
  );
}

function Featured({ item, row }: { item: Listing; row: TickerRow | undefined }) {
  const { t } = landingCopy.useCopy();
  const candles = useCandles(item.symbol, '1h', 48);
  const points = candles.status === 'ready' ? candles.data.map((c) => ({ at: new Date(c.t).toISOString(), value: c.c })) : [];
  return (
    <a className="landing-feat" href={`/trade/spot/${item.base}-${item.market.quote}`}>
      <div>
        <span className="landing-pair">
          <AssetIcon asset={item.base} />
          <b>{item.base}</b>
          <span className="landing-dim">/{item.market.quote}</span>
        </span>
        <div className="landing-feat-price landing-fig" data-money>
          {priceOf(item, row)}
        </div>
        <Change value={row?.changePct24h} />
      </div>
      <div className="landing-feat-chart">
        <AreaChart
          soft
          label={t('Price trend {asset}', { asset: item.base })}
          points={points}
          asset={item.market.quote}
          tone={tone(row?.changePct24h)}
        />
      </div>
    </a>
  );
}

function MarketsPanel({ list, tickers, load }: { list: Listing[] | null; tickers: Tickers | undefined; load: Loadable<Tickers> }) {
  const { t } = landingCopy.useCopy();
  const [tab, setTab] = useState<Tab>('popular');
  const rows = useMemo(() => (list ? rowsFor(tab, list, tickers) : []), [tab, list, tickers]);
  const sparks = useSparklines(rows.map((r) => r.symbol));
  const lines = sparks.status === 'ready' ? sparks.data : {};
  const top = list ? rowsFor('popular', list, tickers)[0] : undefined;
  return (
    <section className="landing-panel landing-markets" aria-label={t('Markets')}>
      <div className="landing-panel-head">
        <Segmented<Tab>
          label={t('Market list')}
          value={tab}
          onChange={setTab}
          options={[
            { value: 'popular', label: t('Popular') },
            { value: 'gainers', label: t('Gainers') },
            { value: 'losers', label: t('Losers') },
          ]}
        />
        <span className="landing-hint">{t('Live prices')}</span>
      </div>
      {top ? <Featured item={top} row={tickers?.[top.symbol]} /> : null}
      {list === null ? (
        <p className="landing-note">{t('Markets are loading')}</p>
      ) : list.length === 0 ? (
        <p className="landing-note">{t('No market is open right now.')}</p>
      ) : (
        <table className="landing-table">
          <thead>
            <tr>
              <th scope="col">{t('Market')}</th>
              <th scope="col">{t('Price')}</th>
              <th scope="col">
                <abbr title={t('24 hours')}>{t('24h')}</abbr>
              </th>
              <th scope="col" className="landing-wide">
                {t('24h')}
              </th>
              <th scope="col" className="landing-wide">
                {t('Volume')}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((item) => {
              const row = tickers?.[item.symbol];
              return (
                <tr key={item.symbol}>
                  <td>
                    <a className="landing-pair" href={`/trade/spot/${item.base}-${item.market.quote}`}>
                      <AssetIcon asset={item.base} />
                      <b>{item.base}</b>
                      <span className="landing-dim">/{item.market.quote}</span>
                    </a>
                  </td>
                  <td className="landing-num" data-money>
                    {priceOf(item, row)}
                  </td>
                  <td>
                    <Change value={row?.changePct24h} />
                  </td>
                  <td className="landing-wide landing-spark">
                    <Sparkline
                      size="row"
                      values={lines[item.symbol] ?? []}
                      label={t('Price trend {asset}', { asset: item.base })}
                      tone={tone(row?.changePct24h)}
                    />
                  </td>
                  <td className="landing-num landing-wide landing-dim">
                    {row?.quoteVolume24h && isUsdQuote(item.market.quote) ? fmtUsd(row.quoteVolume24h, { compact: true }) : '—'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {load.status === 'error' ? (
        <p className="landing-note">{t('Prices could not be read. They show again as soon as the service answers.')}</p>
      ) : null}
      <div className="landing-panel-foot">
        <span>{t('Prices refresh every few seconds.')}</span>
        <a href="/trade">{t('All {count} markets', { count: String(list?.length ?? 0) })}</a>
      </div>
    </section>
  );
}

function Moving({ list, tickers }: { list: Listing[] | null; tickers: Tickers | undefined }) {
  const { t } = landingCopy.useCopy();
  const movers = useMemo(() => {
    if (!list || !tickers) return [];
    const abs = (i: Listing) => {
      const p = pctOf(tickers[i.symbol]);
      return p < 0n ? -p : p;
    };
    return [...list]
      .filter((i) => tickers[i.symbol]?.changePct24h)
      .sort((a, b) => (abs(b) > abs(a) ? 1 : abs(b) < abs(a) ? -1 : 0))
      .slice(0, 5);
  }, [list, tickers]);
  const sparks = useSparklines(movers.map((m) => m.symbol));
  const lines = sparks.status === 'ready' ? sparks.data : {};
  if (movers.length === 0) return null;
  return (
    <section className="landing-moving" aria-labelledby="landing-moving-title">
      <div className="landing-row-head">
        <h2 id="landing-moving-title">{t("What's moving")}</h2>
        <span className="landing-hint">{t('Biggest 24h moves')}</span>
      </div>
      <div className="landing-movers">
        {movers.map((item) => {
          const row = tickers?.[item.symbol];
          return (
            <a key={item.symbol} className="landing-mover" href={`/trade/spot/${item.base}-${item.market.quote}`}>
              <span className="landing-mover-top">
                <b>{item.base}</b>
                <Change value={row?.changePct24h} />
              </span>
              <span className="landing-mover-price landing-fig" data-money>
                {priceOf(item, row)}
              </span>
              <Sparkline
                values={lines[item.symbol] ?? []}
                label={t('Price trend {asset}', { asset: item.base })}
                tone={tone(row?.changePct24h)}
              />
            </a>
          );
        })}
      </div>
    </section>
  );
}

function TrustBand() {
  const { t } = landingCopy.useCopy();
  const items = [
    [t('Proof of reserves'), t('A public, checkable report goes here once we hold customer funds. No figure until it is real.'), true],
    [t('Licences'), t('Each licence, its regulator and number. None is claimed today.'), true],
    [t('Passkeys, no passwords to steal'), t('Sign in with your face or fingerprint on the device you hold.'), false],
    [t('Fees before you confirm'), t("Every order shows its full cost, ours and the venue's, before you press the button."), false],
  ] as const;
  return (
    <section className="landing-panel landing-band" aria-label={t('Reserves and licences')}>
      {items.map(([title, body, placeholder]) => (
        <div key={title}>
          <h3>
            {title} {placeholder ? <span className="landing-placeholder">{t('Placeholder')}</span> : null}
          </h3>
          <p>{body}</p>
        </div>
      ))}
    </section>
  );
}

/** B's engraved slab: what one account looks like, with made-up figures marked TEST (no balance before sign-in is real). */
function Slab() {
  const { t } = landingCopy.useCopy();
  const parts = [
    [t('Cash'), '16'],
    [t('Crypto'), '34'],
    [t('Trading'), '24'],
    [t('Wallet'), '26'],
  ] as const;
  return (
    <figure className="landing-slab" aria-label={t('Example account')}>
      <div className="landing-slab-top">
        <span className="landing-brand">INTAFACED</span>
        <TestTag />
      </div>
      <figcaption className="landing-hint">{t('Everything you hold')}</figcaption>
      <div className="landing-slab-figure landing-fig">
        $24,860<span className="landing-dim">.40</span>
      </div>
      <div className="landing-num" data-tone="up">
        +$412.18 {t('today')}
      </div>
      <div className="landing-slab-bars">
        {parts.map(([name, share]) => (
          <span key={name} data-share={share} className="landing-slab-bar">
            <span className="landing-hint">{name}</span>
          </span>
        ))}
      </div>
    </figure>
  );
}

function OneAccount() {
  const { t } = landingCopy.useCopy();
  const areas = [
    ['/trade', t('Trade'), t('Spot and perpetuals, with the fee shown before you confirm')],
    ['/money', t('Money'), t('What you hold, what is locked, and every movement')],
    ['/wallet', t('Wallet'), t('Your own wallet, made when you sign up, no seed phrase to write down')],
    ['/agents', t('Agents'), t('Assistants that act only inside the limits you set')],
  ] as const;
  return (
    <section className="landing-panel landing-one" aria-labelledby="landing-one-title">
      <div>
        <h2 id="landing-one-title">{t('One balance behind all of it.')}</h2>
        <p className="landing-lede">{t('Trade, hold and move money from one account, added up in one number.')}</p>
        <ul className="landing-areas">
          {areas.map(([href, name, line]) => (
            <li key={href}>
              <a href={href}>
                <b>{name}</b>
                <span>{line}</span>
              </a>
            </li>
          ))}
        </ul>
      </div>
      <Slab />
    </section>
  );
}

/** C's preview: the buy screen's figures for a chosen amount, priced live from the market and the published fee. */
function FeePreview({
  item,
  row,
  takerBps,
}: {
  item: Listing | undefined;
  row: TickerRow | undefined;
  takerBps: number | null | undefined;
}) {
  const { t } = landingCopy.useCopy();
  const [amount, setAmount] = useState<(typeof BUY_AMOUNTS)[number]>('250');
  const candles = useCandles(item?.symbol ?? '', '1h', 72);
  if (!item) return null;
  const pay = dec(amount)!;
  const fee = typeof takerBps === 'number' ? roundScaled(ratio(times(pay, dec(String(takerBps))!), dec('10000')!) ?? 0n, 2) : null;
  const price = dec(row?.last);
  const get = price && price > 0n ? ratio(pay - (fee ?? 0n), price) : null;
  const points = candles.status === 'ready' ? candles.data.map((c) => ({ at: new Date(c.t).toISOString(), value: c.c })) : [];
  return (
    <section className="landing-panel landing-preview" aria-labelledby="landing-preview-title">
      <div className="landing-preview-copy">
        <h2 id="landing-preview-title">{t('See the real screen, with its fees.')}</h2>
        <p className="landing-lede">{t('This is the buy screen, priced live. Nothing is hidden behind the button.')}</p>
        <Segmented
          label={t('Amount to buy')}
          value={amount}
          onChange={setAmount}
          options={BUY_AMOUNTS.map((a) => ({ value: a, label: fmtUsd(a) }))}
        />
      </div>
      <div className="landing-preview-screen">
        <div className="landing-preview-main">
          <span className="landing-hint">{t('Buy {asset}', { asset: item.base })}</span>
          <span className="landing-hint">{t('You pay')}</span>
          <div className="landing-preview-pay landing-fig" data-money>
            {fmtUsd(amount)}
          </div>
          <span className="landing-hint">{t('You get, about')}</span>
          <div className="landing-preview-get landing-fig" data-money>
            {get !== null ? `${toFixedString(roundScaled(get, 8, 'down'), 8)} ${item.base}` : '—'}
          </div>
          <div className="landing-feat-chart">
            <AreaChart
              soft
              label={t('Price trend {asset}', { asset: item.base })}
              points={points}
              asset={item.market.quote}
              tone="neutral"
            />
          </div>
        </div>
        <dl className="landing-preview-lines">
          <div>
            <dt>{t('Price')}</dt>
            <dd className="landing-num">{priceOf(item, row)}</dd>
          </div>
          <div>
            <dt>{typeof takerBps === 'number' ? t('Our fee, {rate}', { rate: bpsAsPercent(takerBps) }) : t('Our fee')}</dt>
            <dd className="landing-num">
              {fee !== null ? fmtUsd(toFixedString(fee, 2)) : takerBps === null ? t('Not set yet: no order is taken until it is') : '—'}
            </dd>
          </div>
          <div>
            <dt>{t('Arrives in')}</dt>
            <dd>{t('Your account, once filled')}</dd>
          </div>
          <div className="landing-preview-total">
            <dt>{t('You pay in total')}</dt>
            <dd className="landing-num">{fmtUsd(amount)}</dd>
          </div>
          <p className="landing-hint">{t('The price moves while you read. The screen prices your order again when you confirm.')}</p>
        </dl>
      </div>
    </section>
  );
}

/** The public landing page (/): live markets beside sign-up, the trust band, one account, and the buy screen with its fees. */
export function Landing() {
  const { t } = landingCopy.useCopy();
  const env = useDataEnv();
  const markets = useMarkets();
  const tickerLoad = useTickers({ intervalMs: 5_000 });
  const fees = useSource(
    useMemo(() => env.poller.source<PublicFeeSchedule | null>('public-fees', publicFeesFetcher(env.api), { intervalMs: 60_000 }), [env]),
  );
  const list = useMemo(() => (markets.status === 'ready' ? listings(markets.data) : markets.status === 'empty' ? [] : null), [markets]);
  const tickers = tickersOf(tickerLoad);
  const takerBps = useMemo((): number | null | undefined => {
    if (fees.status !== 'ready') return fees.status === 'empty' ? null : undefined;
    const schedule = fees.data;
    const group = schedule?.groups.find((g) => g.isDefault) ?? schedule?.groups[0];
    const tier = schedule?.tiers[0];
    if (!group || !tier) return null;
    const row = rowFor(group, tier);
    return row && !row.refusal ? row.takerBps : null;
  }, [fees]);
  const btc = list?.find((i) => i.base === 'BTC') ?? (list ? rowsFor('popular', list, tickers)[0] : undefined);
  return (
    <div className="landing">
      <div className="landing-hero">
        <Hero list={list} tickers={tickers} takerBps={takerBps} />
        <MarketsPanel list={list} tickers={tickers} load={tickerLoad} />
      </div>
      <Moving list={list} tickers={tickers} />
      <TrustBand />
      <OneAccount />
      <FeePreview item={btc} row={btc ? tickers?.[btc.symbol] : undefined} takerBps={takerBps} />
      <section className="landing-close">
        <h2>{t('Open an account in two minutes.')}</h2>
        <a className="lt-button lt-button-primary landing-cta-main" href="/register">
          {t('Open an account')}
        </a>
      </section>
      <footer className="landing-foot">
        <span className="landing-brand">INTAFACED</span>
        <nav aria-label={t('Site links')}>
          <a href="/fees">{t('Fees')}</a>
          <a href="/status">{t('Status')}</a>
          <a href="/notice">{t('Notices')}</a>
          <a href="/help">{t('Help')}</a>
        </nav>
        <span>{t('Crypto is volatile. You can lose money.')}</span>
      </footer>
    </div>
  );
}
