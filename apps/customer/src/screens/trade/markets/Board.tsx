import { useMemo, useState } from 'react';
import {
  ButtonLink,
  Dim,
  MarketBoard,
  MarketBoardSkeleton,
  MarketHero,
  MoverTile,
  PanelHead,
  Tag,
  TileRow,
  ToggleChips,
} from '@intafaced/ui/lit';
import { AreaChart } from '@intafaced/ui/lit/templates';
import { useSession } from '../../../features/session/session';
import { assetName, marketsCopy } from './copy';
import { direction, fmtPct, isHiddenPath, useSparklines, type Decimal } from './deps';
import { Pct } from './parts';
import {
  byVolume,
  displayName,
  entryTarget,
  fundingText,
  interestText,
  isPerp,
  leverageText,
  priceText,
  topMovers,
  volumeText,
  type Entry,
  type Mode,
} from './select';

/** Markets the board can show: priced, and open to trade. */
const priced = (entries: readonly Entry[]) => entries.filter((entry) => entry.ticker?.last != null && entry.market.orderable);

/**
 * The top of Markets: the most traded market large, with its day on a chart and one press to trade it, and beside it
 * the biggest movers. Drawn only from markets with a price; with none, nothing (the list below says why).
 */
export function Board({
  entries,
  mode,
}: {
  /** Spot and perpetual markets together. */
  entries: readonly Entry[];
  mode: Mode;
}) {
  const copy = marketsCopy.useCopy();
  const { t } = copy;
  const signedIn = Boolean(useSession().session);
  const top = useMemo(() => byVolume(priced(entries)), [entries]);
  const movers = useMemo(() => topMovers(priced(entries), 6), [entries]);
  const [chosen, setChosen] = useState<string | null>(null);
  const symbols = useMemo(() => [...new Set([...top.slice(0, 4), ...movers].map((entry) => entry.market.symbol))], [top, movers]);
  const sparks = useSparklines(symbols);
  const lines = sparks.status === 'ready' ? sparks.data : {};
  // First the market the person chose, else the most traded one that has a day to draw.
  const hero =
    top.find((entry) => entry.market.symbol === chosen) ?? top.find((entry) => (lines[entry.market.symbol]?.length ?? 0) > 1) ?? top[0];
  if (!hero) return null;

  const { market, ticker, perp } = hero;
  const pair = displayName(hero);
  const target = entryTarget(hero, mode, isHiddenPath, signedIn);
  const points = (lines[market.symbol] ?? []).map((value, i) => ({ at: String(i), value }));
  // The pick's six: the day's range and volume, then a perpetual's open interest, funding and maximum leverage ("—" on
  // spot, and on a perpetual until the venue read carries them).
  const stats: Array<[string, string]> = [
    [t('24h high'), priceText(market, ticker?.high24h)],
    [t('24h low'), priceText(market, ticker?.low24h)],
    [t('Volume'), volumeText(market, ticker)],
    [t('Open interest'), interestText(market, perp)],
    [t('Funding 1h'), fundingText(perp)],
    [t('Max leverage'), leverageText(perp) ?? '—'],
  ];

  return (
    <MarketBoard data-testid="mkt-board">
      <MarketHero
        data-testid="mkt-hero"
        label={t('{pair} today', { pair })}
        picks={
          top.length > 1 ? (
            <ToggleChips
              label={t('Show a market')}
              options={pickChips(top).map((entry) => ({ value: entry.market.symbol, label: entry.market.base }))}
              value={hero.market.symbol}
              onChange={(value) => value && setChosen(value)}
            />
          ) : undefined
        }
        asset={market.base}
        symbol={pair}
        tag={<Tag tone="neutral">{isPerp(hero) ? (leverageText(perp) ?? t('Perp')) : t('Spot')}</Tag>}
        name={assetName(market.base, copy) ?? market.base}
        price={priceText(market, ticker?.last)}
        change={
          <>
            <Pct value={ticker?.changePct24h} /> <Dim>{t('in 24h')}</Dim>
          </>
        }
        action={
          target ? (
            <ButtonLink tone="primary" href={target}>
              {mode === 'pro' || isPerp(hero) ? t('Trade {pair}', { pair }) : t('Buy {asset}', { asset: market.base })}
            </ButtonLink>
          ) : undefined
        }
        stats={stats}
        chartTitle={t('Price, last 24 hours')}
        chart={
          points.length > 1 ? (
            <AreaChart label={t('{pair}, last 24 hours', { pair })} points={points} asset={market.quote} tone="ink" soft />
          ) : (
            <p>
              <Dim>{t('No price history for {pair} here.', { pair })}</Dim>
            </p>
          )
        }
      />

      {movers.length > 1 ? (
        <section aria-label={t('What’s moving')} data-testid="mkt-moving">
          <PanelHead title={t('What’s moving')} aside={t('Biggest 24h moves')} />
          <TileRow min="card">
            {movers.map((entry) => (
              <MoverTile
                key={entry.market.symbol}
                symbol={displayName(entry)}
                price={priceText(entry.market, entry.ticker?.last)}
                change={fmtPct(entry.ticker?.changePct24h)}
                trend={lines[entry.market.symbol] ?? []}
                trendLabel={t('{pair}, last 24 hours', { pair: displayName(entry) })}
                href={entryTarget(entry, mode, isHiddenPath, signedIn) ?? undefined}
                data-testid="mkt-mover"
              />
            ))}
          </TileRow>
        </section>
      ) : null}
    </MarketBoard>
  );
}

/** The hero's chips: the four most traded coins, one chip per coin (BTC-PERP, else BTC/USDC). */
function pickChips(top: readonly Entry[]): Entry[] {
  return top.filter((entry, i) => top.findIndex((other) => other.market.base === entry.market.base) === i).slice(0, 4);
}

/** The board at its final size while the markets load: the hero panel and a strip of movers, so nothing moves. */
export function BoardSkeleton() {
  return <MarketBoardSkeleton data-testid="mkt-board" />;
}
