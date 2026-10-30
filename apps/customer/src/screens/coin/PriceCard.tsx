import { useEffect, useMemo, useState } from 'react';
import { CoinChart } from './CoinChart';
import { QuotePicker } from './QuotePicker';
import { coinCopy } from './copy';
import { fallbackSince, heroPrice, moveSince, startsLate, tickerMove, type Move } from './coin-math';
import {
  ChangeText,
  fmtChangeLine,
  fmtPrice,
  HeroNumber,
  partialWindowStart,
  refusalCopy,
  Skeleton,
  stepOf,
  StateBlock,
  ToggleGroup,
  ToggleGroupItem,
  useTicker,
  usePreferences,
  zoneName,
  type Candle,
  type Loadable,
  type TickerRow,
} from './deps';
import { DEFAULT_RANGE, RANGES, rangeById, type RangeSpec } from './ranges';
import { dayAndTime, updatedAt } from './time';
import { useRangeCandles } from './use-range-candles';

type Copy = ReturnType<typeof coinCopy.useCopy>['t'];

const RANGE_LABEL = {
  '1D': 'Range 1D',
  '1W': 'Range 1W',
  '1M': 'Range 1M',
  '6M': 'Range 6M',
  '1Y': 'Range 1Y',
  All: 'Range All',
} as const satisfies Record<RangeSpec['id'], Parameters<Copy>[0]>;
const RANGE_SUFFIX = {
  '1D': 'Past day',
  '1W': 'Past week',
  '1M': 'Past month',
  '6M': 'Past six months',
  '1Y': 'Past year',
  All: 'All time',
} as const satisfies Record<RangeSpec['id'], Parameters<Copy>[0]>;

/** The big number: HeroNumber (counts when the price ticks) live, plain digits of the same size under the crosshair. */
function Price({ value, decimals, scrubText }: { value: string | null; decimals: number; scrubText: string | null }) {
  if (scrubText !== null)
    return (
      <span className="if-num inline-flex items-baseline gap-2 text-hero font-bold text-fg tabular-nums" data-testid="scrub-price">
        {scrubText}
      </span>
    );
  return <HeroNumber value={value} decimals={decimals} prefix="$" sensitive={false} data-testid="price" />;
}

export function PriceCard({
  asset,
  symbol,
  tickSize,
  quotes,
  quote,
  onQuote,
}: {
  asset: string;
  symbol: string;
  tickSize: string;
  /** More than one means the pill is drawn. */
  quotes: readonly string[];
  quote: string;
  onQuote: (quote: string) => void;
}) {
  const { t } = coinCopy.useCopy();
  const { timeZone } = usePreferences();
  const ticker = useTicker(symbol);
  const [rangeId, setRangeId] = useState<RangeSpec['id']>(DEFAULT_RANGE);
  const range = rangeById(rangeId);
  const { candles, interval, limit } = useRangeCandles(symbol, range);
  const [scrub, setScrub] = useState<Candle | null>(null);
  useEffect(() => setScrub(null), [rangeId, symbol]);

  const list = candles.status === 'ready' ? candles.data : null;
  const live = ticker.status === 'ready' ? ticker.data.last : null;
  const price = scrub ? scrub.c : live;
  // The line keeps the colour of the live move while the crosshair moves; only the header follows the crosshair.
  // The past day's change comes from the candles when there are some. While they load, or if they cannot be read, the 1D
  // line states the change the ticker already carries instead of an empty dash; longer ranges have no such figure.
  const tickerRow = ticker.status === 'ready' ? ticker.data : null;
  const liveMove: Move | null = useMemo(
    () => (list ? moveSince(list, live) : range.id === '1D' ? tickerMove(tickerRow) : null),
    [list, live, range.id, tickerRow],
  );
  const move: Move | null = useMemo(() => (scrub && list ? moveSince(list, scrub.c) : liveMove), [list, scrub, liveMove]);
  const hero = heroPrice(price, tickSize);

  // The change's trailing words: the range, or "Since 14 Oct, 19:29" when the market has less history than that; under
  // the crosshair, the time of the candle.
  const tickerSince = fallbackSince(!list, range.id, tickerRow, Date.now());
  const step = stepOf(range.interval);
  const suffix = scrub
    ? dayAndTime(scrub.t, timeZone)
    : list && range.id !== 'All' && startsLate(list, step, step * range.limit, Date.now())
      ? // The first coarse candle opens before the market's first trade (a 4 h candle at 16:00 for a 19:25 market), so
        // start from whichever is later; the Key stats note uses the same first-trade time.
        t('Since {time}', {
          time: dayAndTime(
            Math.max(list[0]!.t, ticker.status === 'ready' ? (partialWindowStart(ticker.data, Date.now()) ?? 0) : 0),
            timeZone,
          ),
        })
      : tickerSince !== null
        ? // Candles are out and the ticker says the market is younger than a day, so the fallback change starts there too.
          t('Since {time}', { time: dayAndTime(tickerSince, timeZone) })
        : t(RANGE_SUFFIX[rangeId]);

  const updated = ticker.status === 'ready' ? ticker.asOf : null;

  return (
    <section data-testid="coin-price-card" className="coin-card coin-price-card" aria-label={t('{name} price', { name: asset })}>
      <div className="coin-price-card__head">
        <div data-testid="coin-price-card__figure" className="coin-price-card__figure">
          {ticker.status === 'loading' ? (
            <>
              <Skeleton height={56} width={260} className="bg-field" />
              <Skeleton height={20} width={200} className="bg-field" />
            </>
          ) : ticker.status === 'ready' ? (
            <>
              <Price value={hero.value} decimals={hero.decimals} scrubText={scrub ? `$${fmtPrice(scrub.c, tickSize)}` : null} />
              <ChangeText
                sensitive={false}
                className="coin-change"
                data-testid="change"
                value={move ? fmtChangeLine(move.change, move.changeRatio) : null}
                direction={move?.direction}
                suffix={suffix}
              />
            </>
          ) : (
            <TickerProblem ticker={ticker} />
          )}
        </div>
        <QuotePicker quotes={quotes} quote={quote} onQuote={onQuote} />
      </div>

      <div className="coin-price-card__chart" data-testid="chart-area">
        <ChartBody
          asset={asset}
          candles={candles}
          tickSize={tickSize}
          resetKey={`${symbol}:${interval}:${limit}`}
          direction={liveMove?.direction ?? 'flat'}
          timeZone={zoneName(timeZone)}
          onScrub={setScrub}
        />
      </div>

      <ToggleGroup
        variant="pill"
        data-testid="coin-ranges"
        className="coin-ranges"
        aria-label={t('Chart range')}
        value={rangeId}
        onValueChange={(next) => setRangeId(rangeById(next).id)}
      >
        {RANGES.map((item) => (
          <ToggleGroupItem key={item.id} value={item.id} aria-label={t(RANGE_LABEL[item.id])} title={t(RANGE_LABEL[item.id])}>
            {item.id}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>

      <p className="coin-updated" data-testid="updated">
        {updated !== null ? t('Last updated {time}', { time: updatedAt(updated, timeZone) }) : ''}
      </p>
    </section>
  );
}

function TickerProblem({ ticker }: { ticker: Loadable<TickerRow> }) {
  const { t } = coinCopy.useCopy();
  if (ticker.status === 'error')
    return <StateBlock kind="error" title={t('Couldn’t load the price')} onRetry={ticker.retry} retryLabel={t('Try again')} />;
  if (ticker.status === 'refused') {
    const words = refusalCopy(ticker.code);
    return <StateBlock kind="refused" title={words.title} body={words.body} code={words.reference} action={words.action} />;
  }
  return <StateBlock kind="empty" title={t('Couldn’t load the price')} />;
}

function ChartBody({
  asset,
  candles,
  tickSize,
  resetKey,
  direction,
  timeZone,
  onScrub,
}: {
  asset: string;
  candles: Loadable<Candle[]>;
  tickSize: string;
  resetKey: string;
  direction: Move['direction'];
  timeZone: string | undefined;
  onScrub: (candle: Candle | null) => void;
}) {
  const { t } = coinCopy.useCopy();
  if (candles.status === 'loading')
    return (
      <div className="coin-chart-loading" aria-busy="true" role="status">
        <Skeleton height={360} className="bg-field" />
        <span className="coin-chart-loading__label">{t('Loading the chart')}</span>
      </div>
    );
  if (candles.status === 'error')
    return <StateBlock kind="error" title={t('Couldn’t load the chart')} onRetry={candles.retry} retryLabel={t('Try again')} />;
  if (candles.status === 'refused') {
    const words = refusalCopy(candles.code);
    return <StateBlock kind="refused" title={words.title} body={words.body} code={words.reference} action={words.action} />;
  }
  if (candles.status === 'empty' || candles.data.length < 2)
    return (
      <div className="coin-chart-empty" data-testid="chart-empty">
        {t('No trades yet')}
      </div>
    );
  return (
    <CoinChart
      candles={candles.data}
      resetKey={resetKey}
      tickSize={tickSize}
      direction={direction}
      timeZone={timeZone}
      label={t('Price chart of {asset}', { asset })}
      onScrub={onScrub}
    />
  );
}
