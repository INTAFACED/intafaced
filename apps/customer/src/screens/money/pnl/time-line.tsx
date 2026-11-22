import { useMemo, useState } from 'react';
import { Button, Field } from '@intafaced/ui/lit';
import { TimeLine as KitTimeLine, type TimePoint } from '@intafaced/ui/lit/templates';
import { moneyCopy } from '../copy';
import { fmtUsd, navigate } from '../deps';
import { PNL_RANGES, dayOf, lineChart, rangeFromQuery, rangeSearch, type LinePoint, type PnlRange } from '../pnl-time-model';
import { stamp } from '../time';
import { usePreferences } from '../../../shared/preferences';
import { Amount, Pressed } from './parts';

type Copy = ReturnType<typeof moneyCopy.useCopy>;

/** The old chart's plot size: the low and the high are read from the same points it placed. */
const LINE_W = 1000;
const LINE_H = 240;

const RANGE_COPY: Record<PnlRange, 'Range 1D' | 'Range 1W' | 'Range 1M' | 'Range 1Y' | 'Range all'> = {
  '1D': 'Range 1D',
  '1W': 'Range 1W',
  '1M': 'Range 1M',
  '1Y': 'Range 1Y',
  all: 'Range all',
};

export const INTERVAL_COPY: Record<
  '5m' | '1h' | '4h' | '1d' | '1w',
  'Point every 5m' | 'Point every 1h' | 'Point every 4h' | 'Point every 1d' | 'Point every 1w'
> = {
  '5m': 'Point every 5m',
  '1h': 'Point every 1h',
  '4h': 'Point every 4h',
  '1d': 'Point every 1d',
  '1w': 'Point every 1w',
};

export function go(search: string) {
  navigate(`/money/pnl${search === '' ? '' : `?${search}`}`, true);
}

/** The preset switch and the two dates of a custom range. Both live in the link, like the result view. */
export function RangePicker({ search, offset, copy }: { search: string; offset: number; copy: Copy }) {
  const { t } = copy;
  const ask = rangeFromQuery(search);
  const today = dayOf(Date.now(), offset);
  const [fromDay, setFromDay] = useState(ask.kind === 'custom' ? ask.fromDay : '');
  const [toDay, setToDay] = useState(ask.kind === 'custom' ? ask.toDay : today);
  const ready = fromDay !== '' && toDay !== '' && fromDay <= toDay;
  return (
    <div className="lt-stack">
      <Pressed
        label={t('Pnl range')}
        options={PNL_RANGES}
        value={ask.kind === 'preset' ? ask.range : null}
        words={(option) => t(RANGE_COPY[option])}
        onChoose={(option) => go(rangeSearch(search, { range: option }))}
      />
      <form
        className="lt-actions"
        aria-label={t('Pnl custom range')}
        onSubmit={(event) => {
          event.preventDefault();
          if (ready) go(rangeSearch(search, { fromDay, toDay }));
        }}
      >
        <Field label={t('Range from')} type="date" value={fromDay} max={today} onChange={(event) => setFromDay(event.target.value)} />
        <Field label={t('Range to')} type="date" value={toDay} max={today} onChange={(event) => setToDay(event.target.value)} />
        <Button type="submit" tone="secondary" disabled={!ready}>
          {t('Show range')}
        </Button>
      </form>
    </div>
  );
}

/**
 * A line over time (J-portfolio-05 #4 and #7), on the kit's TimeLine. Time runs along the bottom, so a missing stretch is
 * a gap of its real width, never a drop to zero. Pointing at it, or the arrow keys, names one point; the table under each
 * line carries every point for anyone who cannot see it. `chart` marks the drawing (`data-chart`) for the journey's read.
 */
export function TimeLine({
  points,
  from,
  to,
  label,
  chart: id,
  signed,
  hidden,
  copy,
}: {
  points: readonly LinePoint[];
  from: string;
  to: string;
  label: string;
  chart: string;
  /** A result shows its sign (+/−); a value does not. */
  signed: boolean;
  hidden: boolean;
  copy: Copy;
}) {
  const { t } = copy;
  const { timeZone } = usePreferences();
  const ends = useMemo(() => lineChart(points, LINE_W, LINE_H), [points]);
  const line = useMemo<TimePoint[]>(() => points.map((point) => ({ at: point.at, value: point.usd })), [points]);
  const usd = (value: string) => fmtUsd(value, { showPlus: signed });
  return (
    <KitTimeLine
      label={label}
      keys={t('Pnl chart keys')}
      points={line}
      readout={(point) => (
        <>
          {stamp(point.at, timeZone)}: {point.value === null ? t('Pnl point missing') : <Amount value={usd(point.value)} hidden={hidden} />}
        </>
      )}
      empty={t('Pnl chart none')}
      caption={
        ends ? (
          <>
            <span>{stamp(from, timeZone)}</span>
            <span>
              {t('Pnl chart low')} <Amount value={usd(ends.low)} hidden={hidden} /> · {t('Pnl chart high')}{' '}
              <Amount value={usd(ends.high)} hidden={hidden} />
            </span>
            <span>{stamp(to, timeZone)}</span>
          </>
        ) : undefined
      }
      marks={{ 'data-chart': id }}
    />
  );
}
