import { useMemo, useState } from 'react';
import { Button, ButtonLink, Select } from '@intafaced/ui/lit';
import { TRADE_JOURNAL_MAX_DAYS, TRADE_JOURNAL_REPLAY, type TradeReplay as Replay } from '@intafaced/contracts/trade-journal-procedures';
import { WorkbenchChart } from '../../../screens/charts/WorkbenchChart';
import type { ChartHost } from '../../../screens/charts/chart-host';
import { REPLAY_SPEEDS, replayBars, useReplay } from '../../../screens/charts/replay';
import { useResource } from '../../../shared/resource';
import { useSeriesMarks, type SeriesMark } from '../../../shared/chart-marks';
import { chartValue } from '../../../shared/chart-value';
import { displayAmount } from '../../../shared/money';
import { Waiting } from '../../more';
import { useApi } from '../../session';
import { TestMark } from '../venue/volt/VoltVenue';
import { useAsOfText } from '../venue/VenueKit';
import { journalCopy } from './journal-copy';
import { marksShown, replayPlan, stopLine, stopOn, type ReplayMark, type ReplayPlan } from './replay-model';
import type { Candle } from '../../../data/types';

const when = (ms: number) => new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
const DAY_MS = 86_400_000;

/**
 * The replay of one closed journal trade (`/trade/journal?replay=<trade>`; J-charts-desk-20): its market's bars from the
 * venue in bar replay, stopped 10 bars before the entry bar, with the entry, the stop line (stepping where it was moved)
 * and the exit drawn only once the replay reaches their bars. Leaving replay opens the market's live chart. Read only:
 * the journal trade is not changed.
 */
export function TradeReplay({ owner, tradeId }: { owner: string; tradeId: string }) {
  const { t } = journalCopy.useCopy();
  const api = useApi();
  // The journal's own window (JournalRoom), so the trade is found where the journal lists it.
  const [since] = useState(() => new Date(Date.now() - (TRADE_JOURNAL_MAX_DAYS - 1) * DAY_MS).toISOString());
  const read = useResource(
    (signal) => api.call(TRADE_JOURNAL_REPLAY, { owner, since, tradeId }, { signal }),
    `journal-replay:${owner}:${tradeId}`,
  );
  const back = (
    <a className="lt-link" href="/trade/journal" data-testid="replay-back">
      {t('replayBack')}
    </a>
  );
  if (read.resource.status === 'loading') return <Waiting label={t('replayLoading')} />;
  if (read.resource.status === 'failed')
    return (
      <section className="lt-stack" data-testid="trade-replay">
        <p className="lt-hint" role="alert" data-testid="replay-refused">
          {t('replayRefused', { detail: read.resource.failure.message })}
        </p>
        {back}
      </section>
    );
  const replay = read.resource.data;
  const plan = replayPlan(replay);
  const { trade } = replay;
  return (
    <section className="lt-stack" aria-labelledby="trade-replay-title" data-testid="trade-replay" data-trade={trade.tradeId}>
      <h2 id="trade-replay-title">{t('replayTitle', { side: trade.side === 'long' ? t('long') : t('short'), market: trade.symbol })}</h2>
      <p className="lt-hint" data-testid="replay-trade">
        {t('replayTrade', {
          entry: displayAmount(trade.entryPrice),
          exit: displayAmount(trade.exitPrice),
          size: displayAmount(trade.size),
          net: trade.netPnl === null ? t('replayNetUnknown') : `${displayAmount(trade.netPnl)} ${trade.feeAsset}`,
        })}
      </p>
      {plan ? (
        <ReplayChart replay={replay} plan={plan} />
      ) : (
        <p className="lt-hint" role="status" data-testid="replay-bars-none">
          {t('replayBarsNone')}
        </p>
      )}
      {back}
    </section>
  );
}

function ReplayChart({ replay, plan }: { replay: Replay; plan: ReplayPlan }) {
  const { t } = journalCopy.useCopy();
  const asOfText = useAsOfText();
  const clock = useReplay();
  // The replay starts at once, 10 bars before the entry bar, on the bars as the venue sent them.
  const [started, setStarted] = useState(false);
  if (!started) {
    setStarted(true);
    clock.start(plan.bars, plan.start, 1);
  }
  const now = clock.replay;
  const drawn = now ? replayBars(plan.bars, now) : plan.bars.slice(0, plan.start + 1);
  const last = drawn[drawn.length - 1]?.t ?? 0;
  const shown = marksShown(plan, last);
  const stop = stopOn(plan, last);
  const { trade } = replay;
  const labels = useMemo(
    () => ({
      open: t('chartOpen'),
      high: t('chartHigh'),
      low: t('chartLow'),
      close: t('chartClose'),
      change: t('chartChange'),
      chart: t('replayChart', { market: trade.symbol }),
      keys: t('replayKeys'),
    }),
    [t, trade.symbol],
  );
  const markWords = (m: ReplayMark) =>
    t(m.kind === 'entry' ? 'markEntry' : m.kind === 'stop' ? 'markStop' : m.kind === 'stop-moved' ? 'markStopMoved' : 'markExit', {
      price: displayAmount(m.price),
      bar: when(m.bar),
    });
  const live = `/charts/${encodeURIComponent(trade.symbol)}?interval=${encodeURIComponent(replay.interval)}`;
  return (
    <div className="lt-stack">
      <div className="lt-row" role="group" aria-label={t('replayControls')}>
        <span data-testid="replay-position">
          {t('replayPosition', { bar: String((now?.position ?? plan.start) + 1), bars: String(plan.bars.length) })}
        </span>
        {now?.playing ? (
          <Button size="sm" onClick={clock.pause}>
            {t('replayPause')}
          </Button>
        ) : (
          <Button size="sm" onClick={clock.play}>
            {t('replayPlay')}
          </Button>
        )}
        <Button size="sm" onClick={clock.step}>
          {t('replayStep')}
        </Button>
        <Select
          label={t('replaySpeed')}
          value={String(now?.speed ?? 1)}
          options={REPLAY_SPEEDS.map((x) => ({ value: String(x), label: `${x}x` }))}
          onChange={(value) => {
            const speed = REPLAY_SPEEDS.find((x) => String(x) === value);
            if (speed) clock.speed(speed);
          }}
        />
        <ButtonLink size="sm" href={live} data-testid="replay-leave">
          {t('replayLeave')}
        </ButtonLink>
      </div>
      <WorkbenchChart
        candles={drawn}
        style="candles"
        scheme="standard"
        resetKey={`replay:${trade.tradeId}`}
        symbol={trade.symbol}
        tickSize={replay.tickSize ?? barStep(plan.bars)}
        timeZone="UTC"
        labels={labels}
      >
        {(host) => <ReplayMarks host={host} plan={plan} drawn={drawn} shown={shown} />}
      </WorkbenchChart>
      <p className="lt-hint" data-testid="replay-stop" data-price={stop ?? ''}>
        {stop === null ? t('replayNoStop') : t('replayStopNow', { price: displayAmount(stop) })}
      </p>
      <ol className="lt-stack" data-testid="replay-marks" aria-label={t('replayMarks')}>
        {shown.map((m) => (
          <li key={`${m.kind}:${m.bar}:${m.price}`} data-mark={m.kind} data-price={m.price} data-bar={new Date(m.bar).toISOString()}>
            {markWords(m)}
          </li>
        ))}
      </ol>
      {replay.bars.source === 'venue' ? (
        <p className="lt-hint" data-testid="replay-source" data-source="venue">
          <TestMark test={replay.venue.test} />{' '}
          {t('replaySource', { venue: replay.venue.name, interval: replay.interval, asOf: asOfText(replay.bars.asOf) })}
        </p>
      ) : replay.bars.source === 'record' ? (
        <p className="lt-hint" data-testid="replay-source" data-source="record" data-stored-at={replay.bars.storedAt}>
          <TestMark test={replay.venue.test} />{' '}
          {t('replaySourceRecord', { interval: replay.interval, stored: when(Date.parse(replay.bars.storedAt)) })}
        </p>
      ) : null}
    </div>
  );
}

const SECONDS = (ms: number) => Math.floor(ms / 1000);

/** A market no longer listed has no published step: the finest step the venue's own bar prices are written to. */
function barStep(bars: readonly Candle[]): string {
  const places = Math.max(0, ...bars.flatMap((b) => [b.o, b.h, b.l, b.c].map((p) => (p.split('.')[1] ?? '').length)));
  return places === 0 ? '1' : `0.${'0'.repeat(places - 1)}1`;
}

/** The marks reached so far on the chart's own canvas: entry and exit as arrows, the stop as a stepped dashed line. */
function ReplayMarks({
  host,
  plan,
  drawn,
  shown,
}: {
  host: ChartHost | null;
  plan: ReplayPlan;
  drawn: readonly Candle[];
  shown: readonly ReplayMark[];
}) {
  const { t } = journalCopy.useCopy();
  const marks: SeriesMark[] = shown.flatMap((m): SeriesMark[] =>
    m.kind === 'entry'
      ? [{ time: SECONDS(m.bar), position: 'belowBar', shape: 'arrowUp', token: '--lit-up', text: t('chartEntry') }]
      : m.kind === 'exit'
        ? [{ time: SECONDS(m.bar), position: 'aboveBar', shape: 'arrowDown', token: '--lit-down', text: t('chartExit') }]
        : [],
  );
  const points = stopLine(plan, drawn).map((p) => ({ time: SECONDS(p.time), value: chartValue(p.value) }));
  const key = `${shown.map((m) => `${m.kind}:${m.bar}`).join(',')}|${points.map((p) => `${p.time}:${p.value}`).join(',')}`;
  useSeriesMarks(host, marks, { token: '--lit-warn-text', points }, key);
  return null;
}
