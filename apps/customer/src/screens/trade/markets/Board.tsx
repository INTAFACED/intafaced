import { useMemo, useState } from 'react';
import { AssetIcon, ToggleChips } from '@intafaced/ui/lit';
import { AreaChart, Sparkline } from '@intafaced/ui/lit/templates';
import { useSession } from '../../../features/session/session';
import { assetName, marketsCopy } from './copy';
import { direction, isHiddenPath, useSparklines, type Decimal } from './deps';
import { Pct } from './parts';
import { marketTarget, priceText, volumeText, type Entry, type Mode } from './select';

/** Markets the board can show: priced, and open to trade. */
const priced = (entries: readonly Entry[]) => entries.filter((entry) => entry.ticker?.last != null && entry.market.orderable);

/** Largest 24h volume first; one row per coin (BTC/USDT beside BTC/USDC would read as a repeat). */
function byVolume(entries: readonly Entry[]): Entry[] {
  const sorted = [...entries].sort((a, b) => Number(b.ticker?.quoteVolume24h ?? 0) - Number(a.ticker?.quoteVolume24h ?? 0));
  return sorted.filter((entry, i) => sorted.findIndex((other) => other.market.base === entry.market.base) === i);
}

/** Biggest 24h move either way first. */
function byMove(entries: readonly Entry[]): Entry[] {
  return [...byVolume(entries)].sort(
    (a, b) => Math.abs(Number(b.ticker?.changePct24h ?? 0)) - Math.abs(Number(a.ticker?.changePct24h ?? 0)),
  );
}

const toneOf = (value: Decimal | null | undefined) => {
  const dir = direction(value);
  return dir === 'up' ? 'up' : dir === 'down' ? 'down' : 'neutral';
};

/**
 * The top of Markets: the most traded market large, with its day on a chart and one press to trade it, and beside it
 * the biggest movers. Drawn only from markets with a price; with none, nothing (the list below says why).
 */
export function Board({ entries, mode }: { entries: readonly Entry[]; mode: Mode }) {
  const copy = marketsCopy.useCopy();
  const { t } = copy;
  const signedIn = Boolean(useSession().session);
  const top = useMemo(() => byVolume(priced(entries)), [entries]);
  const movers = useMemo(() => byMove(priced(entries)).slice(0, 6), [entries]);
  const [chosen, setChosen] = useState<string | null>(null);
  const symbols = useMemo(() => [...new Set([...top.slice(0, 4), ...movers].map((entry) => entry.market.symbol))], [top, movers]);
  const sparks = useSparklines(symbols);
  const lines = sparks.status === 'ready' ? sparks.data : {};
  // First the market the person chose, else the most traded one that has a day to draw.
  const hero =
    top.find((entry) => entry.market.symbol === chosen) ?? top.find((entry) => (lines[entry.market.symbol]?.length ?? 0) > 1) ?? top[0];
  if (!hero) return null;

  const { market, ticker } = hero;
  const pair = `${market.base}/${market.quote}`;
  const target = marketTarget(market, mode, isHiddenPath, signedIn);
  const points = (lines[market.symbol] ?? []).map((value, i) => ({ at: String(i), value }));
  const stats: Array<[string, string]> = [
    [t('24h high'), priceText(market, ticker?.high24h)],
    [t('24h low'), priceText(market, ticker?.low24h)],
    [t('24h volume'), volumeText(market, ticker)],
  ];

  return (
    <div className="mkt-board" data-testid="mkt-board">
      <section className="mkt-hero" aria-label={t('{pair} today', { pair })} data-testid="mkt-hero">
        <div className="mkt-hero__main">
          {top.length > 1 ? (
            <div className="mkt-hero__picks">
              <ToggleChips
                label={t('Show a market')}
                options={top.slice(0, 4).map((entry) => ({ value: entry.market.symbol, label: entry.market.base }))}
                value={hero.market.symbol}
                onChange={(value) => value && setChosen(value)}
              />
            </div>
          ) : null}
          <div className="mkt-hero__name">
            <AssetIcon asset={market.base} size="md" />
            <span className="mkt-hero__pair">
              <strong>{pair}</strong>
              <span className="mkt-dim">{assetName(market.base, copy) ?? market.base}</span>
            </span>
          </div>
          <p className="mkt-hero__price" dir="ltr">
            {priceText(market, ticker?.last)}
          </p>
          <p className="mkt-hero__change">
            <Pct value={ticker?.changePct24h} /> <span className="mkt-dim">{t('in 24h')}</span>
          </p>
          {target ? (
            <a className="lt-button lt-button-primary mkt-hero__go" href={target}>
              {mode === 'pro' ? t('Trade {pair}', { pair }) : t('Buy {asset}', { asset: market.base })}
            </a>
          ) : null}
          <dl className="mkt-hero__stats">
            {stats.map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd dir="ltr">{value}</dd>
              </div>
            ))}
          </dl>
        </div>
        <div className="mkt-hero__chart" data-tone={toneOf(ticker?.changePct24h)}>
          <span className="mkt-dim">{t('Price, last 24 hours')}</span>
          {points.length > 1 ? (
            <AreaChart
              label={t('{pair}, last 24 hours', { pair })}
              points={points}
              asset={market.quote}
              tone={toneOf(ticker?.changePct24h)}
              soft
            />
          ) : (
            <p className="mkt-dim mkt-hero__nochart">{t('No price history for {pair} here.', { pair })}</p>
          )}
        </div>
      </section>

      {movers.length > 1 ? (
        <section className="mkt-moving" aria-labelledby="mkt-moving-title" data-testid="mkt-moving">
          <header className="mkt-moving__head">
            <h2 id="mkt-moving-title">{t('What’s moving')}</h2>
            <span className="mkt-dim">{t('Biggest 24h moves')}</span>
          </header>
          <ul className="mkt-moving__list">
            {movers.map(({ market: m, ticker: tk }) => {
              const href = marketTarget(m, mode, isHiddenPath, signedIn);
              const Tag = href ? 'a' : 'span';
              return (
                <li key={m.symbol}>
                  <Tag className="mkt-mover" href={href ?? undefined} data-testid="mkt-mover">
                    <span className="mkt-mover__top">
                      <strong>
                        {m.base}
                        <span className="mkt-dim">/{m.quote}</span>
                      </strong>
                      <Pct value={tk?.changePct24h} />
                    </span>
                    <span className="mkt-mover__price" dir="ltr">
                      {priceText(m, tk?.last)}
                    </span>
                    <Sparkline
                      label={t('{pair}, last 24 hours', { pair: `${m.base}/${m.quote}` })}
                      values={lines[m.symbol] ?? []}
                      tone={toneOf(tk?.changePct24h)}
                    />
                  </Tag>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

/** The board at its final size while the markets load: the hero panel and a strip of movers, so nothing moves. */
export function BoardSkeleton() {
  return (
    <div className="mkt-board" data-testid="mkt-board" aria-hidden="true">
      <div className="mkt-hero mkt-skeleton" data-size="hero" />
      <div className="mkt-moving__list">
        {[0, 1, 2, 3, 4, 5].map((index) => (
          <div key={index} className="mkt-mover mkt-skeleton" data-size="tile" />
        ))}
      </div>
    </div>
  );
}
