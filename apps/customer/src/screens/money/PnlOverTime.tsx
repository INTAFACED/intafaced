import { useMemo, useState, type PointerEvent } from 'react';
import { moneyCopy } from './copy';
import { Amount, Button, Skeleton, StateBlock, fmtUsd, navigate, refusalCopy } from './deps';
import type { LotBook } from './pnl-model';
import { usePnlOverTime } from './pnl-source';
import {
  BREAKDOWNS,
  BREAKDOWN_MAX_DAYS,
  PNL_RANGES,
  breakdownFromQuery,
  dayOf,
  firstActivity,
  marketKey,
  missingOf,
  offsetMinutes,
  pnlChart,
  rangeFromQuery,
  rangeSearch,
  resolveRange,
  type Breakdown,
  type PnlOverTime,
  type PnlRange,
} from './pnl-time-model';
import { stamp } from './time';
import { usePreferences } from '../../shared/preferences';

type Copy = ReturnType<typeof moneyCopy.useCopy>;

const W = 1000;
const H = 240;

const RANGE_COPY: Record<PnlRange, 'Range 1D' | 'Range 1W' | 'Range 1M' | 'Range 1Y' | 'Range all'> = {
  '1D': 'Range 1D',
  '1W': 'Range 1W',
  '1M': 'Range 1M',
  '1Y': 'Range 1Y',
  all: 'Range all',
};

const INTERVAL_COPY: Record<
  PnlOverTime['interval'],
  'Point every 5m' | 'Point every 1h' | 'Point every 4h' | 'Point every 1d' | 'Point every 1w'
> = {
  '5m': 'Point every 5m',
  '1h': 'Point every 1h',
  '4h': 'Point every 4h',
  '1d': 'Point every 1d',
  '1w': 'Point every 1w',
};

const MISSING_COPY: Record<PnlOverTime['points'][number]['missing'][number]['reason'], 'Missing no price' | 'Missing cost unknown'> = {
  no_price: 'Missing no price',
  cost_unknown: 'Missing cost unknown',
};

const BREAKDOWN_COPY: Record<Breakdown, 'Breakdown asset' | 'Breakdown market' | 'Breakdown day'> = {
  asset: 'Breakdown asset',
  market: 'Breakdown market',
  day: 'Breakdown day',
};

/** The service's own refusals for this read, in plain words; any other code takes the shared refusal words. */
const RANGE_REFUSAL: Record<string, 'Pnl range refused' | 'Pnl range too long' | 'Pnl prices unavailable' | 'Pnl mismatch'> = {
  'tax.pnl_range_invalid': 'Pnl range refused',
  'tax.pnl_range_too_long': 'Pnl range too long',
  'tax.pnl_prices_unavailable': 'Pnl prices unavailable',
  'tax.pnl_breakdown_mismatch': 'Pnl mismatch',
};

function usdText(value: string | null, copy: Copy): string {
  return value === null ? copy.t('Not known') : fmtUsd(value, { showPlus: true });
}

function go(search: string) {
  navigate(`/money/pnl${search === '' ? '' : `?${search}`}`, true);
}

/** The preset switch and the two dates of a custom range. Both live in the link, like the result view. */
function RangePicker({ search, offset, copy }: { search: string; offset: number; copy: Copy }) {
  const { t } = copy;
  const ask = rangeFromQuery(search);
  const today = dayOf(Date.now(), offset);
  const [fromDay, setFromDay] = useState(ask.kind === 'custom' ? ask.fromDay : '');
  const [toDay, setToDay] = useState(ask.kind === 'custom' ? ask.toDay : today);
  const ready = fromDay !== '' && toDay !== '' && fromDay <= toDay;
  return (
    <div className="money-pnl-range">
      <div className="money-alloc__switch" role="group" aria-label={t('Pnl range')}>
        {PNL_RANGES.map((option) => (
          <button
            key={option}
            type="button"
            className="money-alloc__opt"
            aria-pressed={ask.kind === 'preset' && ask.range === option}
            onClick={() => go(rangeSearch(search, { range: option }))}
          >
            {t(RANGE_COPY[option])}
          </button>
        ))}
      </div>
      <form
        className="money-pnl-range__dates"
        aria-label={t('Pnl custom range')}
        onSubmit={(event) => {
          event.preventDefault();
          if (ready) go(rangeSearch(search, { fromDay, toDay }));
        }}
      >
        <label className="money-note-form__label">
          {t('Range from')}{' '}
          <input
            type="date"
            className="money-note-form__input"
            value={fromDay}
            max={today}
            onChange={(event) => setFromDay(event.target.value)}
          />
        </label>
        <label className="money-note-form__label">
          {t('Range to')}{' '}
          <input
            type="date"
            className="money-note-form__input"
            value={toDay}
            max={today}
            onChange={(event) => setToDay(event.target.value)}
          />
        </label>
        <Button type="submit" variant="secondary" size={40} disabled={!ready}>
          {t('Show range')}
        </Button>
      </form>
    </div>
  );
}

/**
 * The cumulative line (J-portfolio-05 #4). Time runs along the bottom, so a missing stretch is a gap of its real width,
 * never a drop to zero. Hovering names the nearest point; the table under it carries every point for anyone who cannot
 * see the line.
 */
function PnlLine({ data, hidden, copy }: { data: PnlOverTime; hidden: boolean; copy: Copy }) {
  const { t } = copy;
  const { timeZone } = usePreferences();
  const chart = useMemo(() => pnlChart(data.points, W, H), [data.points]);
  const [hover, setHover] = useState<number | null>(null);
  const t0 = Date.parse(data.points[0]?.at ?? '');
  const span = Date.parse(data.points[data.points.length - 1]?.at ?? '') - t0;
  const label = t('Pnl chart label', { from: stamp(data.from, timeZone), to: stamp(data.to, timeZone) });
  const pick = (event: PointerEvent<SVGSVGElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    if (box.width <= 0 || !(span > 0)) return;
    const at = t0 + ((event.clientX - box.left) / box.width) * span;
    let best = 0;
    data.points.forEach((point, index) => {
      if (Math.abs(Date.parse(point.at) - at) < Math.abs(Date.parse(data.points[best]!.at) - at)) best = index;
    });
    setHover(best);
  };
  const focus = hover === null ? null : data.points[hover]!;
  if (!chart) return <p className="money-note">{t('Pnl chart none')}</p>;
  return (
    <figure className="money-pnl-chart">
      <div className="money-pnl-chart__plot">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={label}
          data-chart="pnl-cumulative"
          onPointerMove={pick}
          onPointerLeave={() => setHover(null)}
        >
          {chart.zeroY !== null ? (
            <line
              x1="0"
              x2={W}
              y1={chart.zeroY}
              y2={chart.zeroY}
              stroke="var(--if-line-stronger)"
              strokeDasharray="6 6"
              vectorEffect="non-scaling-stroke"
            />
          ) : null}
          {chart.runs.map((run, index) =>
            run.length === 1 ? (
              <line
                key={index}
                x1={run[0]!.x}
                x2={run[0]!.x}
                y1={run[0]!.y}
                y2={run[0]!.y}
                stroke="var(--if-lime)"
                strokeWidth="8"
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
                data-run={index}
              />
            ) : (
              <polyline
                key={index}
                points={run.map((p) => `${p.x},${p.y}`).join(' ')}
                fill="none"
                stroke="var(--if-lime)"
                strokeWidth="2"
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
                data-run={index}
              />
            ),
          )}
          {focus && span > 0 ? (
            <line
              x1={String(Math.round(((Date.parse(focus.at) - t0) / span) * W))}
              x2={String(Math.round(((Date.parse(focus.at) - t0) / span) * W))}
              y1="0"
              y2={H}
              stroke="var(--if-line-stronger)"
              vectorEffect="non-scaling-stroke"
            />
          ) : null}
        </svg>
        {focus ? (
          <p className="money-pnl-chart__tip" role="status" data-at={focus.at}>
            {stamp(focus.at, timeZone)}:{' '}
            {focus.totalUsd === null ? (
              t('Pnl point missing')
            ) : (
              <Amount value={fmtUsd(focus.totalUsd, { showPlus: true })} hidden={hidden} />
            )}
          </p>
        ) : null}
      </div>
      <figcaption className="money-pnl-chart__axis">
        <span>{stamp(data.from, timeZone)}</span>
        <span>
          {t('Pnl chart low')} <Amount value={fmtUsd(chart.low, { showPlus: true })} hidden={hidden} /> · {t('Pnl chart high')}{' '}
          <Amount value={fmtUsd(chart.high, { showPlus: true })} hidden={hidden} />
        </span>
        <span>{stamp(data.to, timeZone)}</span>
      </figcaption>
    </figure>
  );
}

function MissingNote({ data, copy }: { data: PnlOverTime; copy: Copy }) {
  const { t } = copy;
  const missing = missingOf(data.points);
  if (missing.count === 0) return null;
  return (
    <div className="money-note" data-label="pnl-missing" data-count={missing.count}>
      <p>{t('Pnl missing points', { count: String(missing.count) })}</p>
      <ul>
        {missing.coins.map((item) => (
          <li key={`${item.assetId}|${item.reason}`} data-asset={item.assetId} data-reason={item.reason}>
            {t(MISSING_COPY[item.reason], { asset: item.assetId })}
          </li>
        ))}
      </ul>
    </div>
  );
}

function PointRows({ data, hidden, copy }: { data: PnlOverTime; hidden: boolean; copy: Copy }) {
  const { t } = copy;
  const { timeZone } = usePreferences();
  return (
    <details className="money-pnl-points">
      <summary>{t('Pnl points table')}</summary>
      <table className="money-table" aria-label={t('Pnl points table')}>
        <thead>
          <tr>
            <th scope="col">{t('Pnl point time')}</th>
            <th scope="col" className="money-num">
              {t('Realised')}
            </th>
            <th scope="col" className="money-num">
              {t('Unrealised')}
            </th>
            <th scope="col" className="money-num">
              {t('Pnl point total')}
            </th>
          </tr>
        </thead>
        <tbody>
          {data.points.map((point) => (
            <tr
              key={point.at}
              data-point={point.at}
              data-usd={point.totalUsd ?? 'missing'}
              data-realized={point.realizedUsd ?? 'unknown'}
              data-unrealized={point.unrealizedUsd ?? 'unknown'}
            >
              <th scope="row">{stamp(point.at, timeZone)}</th>
              <td className="money-num">
                <Amount value={usdText(point.realizedUsd, copy)} hidden={hidden} />
              </td>
              <td className="money-num">
                <Amount value={usdText(point.unrealizedUsd, copy)} hidden={hidden} />
              </td>
              <td className="money-num">
                {point.totalUsd === null ? t('Pnl point missing') : <Amount value={usdText(point.totalUsd, copy)} hidden={hidden} />}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}

function rowLabel(by: Breakdown, key: string, copy: Copy): string {
  if (by !== 'market') return key;
  const market = marketKey(key);
  if (market.kind === 'held') return copy.t('Breakdown held');
  if (market.kind === 'moved') return copy.t('Breakdown moved', { asset: market.assetId });
  return market.market;
}

/**
 * Where the change over the range came from (J-portfolio-05 #5): by coin, by market or by day. The service refuses to
 * answer a breakdown that does not add up, so the rows shown always sum to the total above them.
 */
function BreakdownCard({ data, search, hidden, copy }: { data: PnlOverTime; search: string; hidden: boolean; copy: Copy }) {
  const { t } = copy;
  const by = breakdownFromQuery(search);
  const rows = by === 'asset' ? data.byAsset : by === 'market' ? data.byMarket : data.byDay;
  const choose = (next: Breakdown) => {
    const params = new URLSearchParams(search);
    if (next === 'asset') params.delete('by');
    else params.set('by', next);
    go(params.toString());
  };
  const offset = data.utcOffsetMinutes;
  const zone = `${offset < 0 ? '-' : '+'}${String(Math.floor(Math.abs(offset) / 60)).padStart(2, '0')}:${String(Math.abs(offset) % 60).padStart(2, '0')}`;
  return (
    <section className="money-card" aria-label={t('Pnl breakdown')}>
      <header className="money-card__head">
        <h2>{t('Pnl breakdown')}</h2>
      </header>
      <div className="money-alloc__switch" role="group" aria-label={t('Pnl breakdown by')}>
        {BREAKDOWNS.map((option) => (
          <button key={option} type="button" className="money-alloc__opt" aria-pressed={by === option} onClick={() => choose(option)}>
            {t(BREAKDOWN_COPY[option])}
          </button>
        ))}
      </div>
      <div className="money-label">
        <span>{t('Breakdown period')}</span>
      </div>
      <p className="money-total" data-figure="period" data-usd={data.periodUsd ?? 'unknown'}>
        <Amount value={usdText(data.periodUsd, copy)} hidden={hidden} />
      </p>
      {rows === null ? (
        <p className="money-note" data-label="days-too-many">
          {t('Breakdown days too many', { max: String(BREAKDOWN_MAX_DAYS) })}
        </p>
      ) : rows.length === 0 ? (
        <p className="money-note">{t('Breakdown empty')}</p>
      ) : (
        <table className="money-table" data-breakdown={by}>
          <thead>
            <tr>
              <th scope="col">{t(BREAKDOWN_COPY[by])}</th>
              <th scope="col" className="money-num">
                {t('Pnl point total')}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key} data-key={row.key} data-usd={row.usd ?? 'unknown'}>
                <th scope="row">{rowLabel(by, row.key, copy)}</th>
                <td className="money-num">
                  <Amount value={usdText(row.usd, copy)} hidden={hidden} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="money-note" data-figure="period-fees">
        {data.feesUsd === null ? (
          t('Breakdown fees unknown')
        ) : (
          <>
            {t('Breakdown fees')} <Amount value={fmtUsd(data.feesUsd)} hidden={hidden} />
          </>
        )}
      </p>
      <p className="money-note">{t('Breakdown rule')}</p>
      {by === 'day' ? <p className="money-note">{t('Pnl days in zone', { zone: `UTC${zone}` })}</p> : null}
    </section>
  );
}

/**
 * Profit and loss over time: the cumulative line over a range and where the change came from. Read from
 * `tax.pnlOverTime` under the saved choices, whatever method the room previews.
 */
export function PnlOverTimeCards({ book, search, hidden }: { book: LotBook; search: string; hidden: boolean }) {
  const copy = moneyCopy.useCopy();
  const { t } = copy;
  const { timeZone } = usePreferences();
  const offset = useMemo(() => offsetMinutes(timeZone, Date.now()), [timeZone]);
  const ask = useMemo(() => rangeFromQuery(search), [search]);
  const first = firstActivity(book);
  // Read the clock only when the range changes, so a preset's start stays put while the page is open.
  const range = useMemo(() => resolveRange(ask, Date.now(), offset, first), [ask, offset, first]);
  const result = usePnlOverTime(range === null ? null : { ...range, utcOffsetMinutes: offset });

  let body;
  if (ask.kind === 'invalid') {
    body = <p className="money-note">{t('Range invalid')}</p>;
  } else if (range === null || result.status === 'empty') {
    body = <p className="money-note">{t('Range nothing yet')}</p>;
  } else if (result.status === 'loading') {
    body = <Skeleton width="100%" height={H} className="bg-field" />;
  } else if (result.status === 'error') {
    body = (
      <StateBlock
        kind="error"
        className="money-state"
        title={t('Pnl over time unreadable')}
        onRetry={result.retry}
        retryLabel={t('Try again')}
      />
    );
  } else if (result.status === 'refused') {
    const own = RANGE_REFUSAL[result.code];
    const words = refusalCopy(result.code);
    body = (
      <p className="money-note" data-refused={result.code}>
        {own ? t(own) : `${words.title}. ${words.body ?? ''}`} {words.reference ?? ''}
      </p>
    );
  } else {
    const data = result.data;
    body = (
      <>
        <PnlLine data={data} hidden={hidden} copy={copy} />
        <MissingNote data={data} copy={copy} />
        <p className="money-note" data-interval={data.interval}>
          {t(INTERVAL_COPY[data.interval])}
        </p>
        <PointRows data={data} hidden={hidden} copy={copy} />
      </>
    );
  }

  return (
    <>
      <section className="money-card" aria-label={t('Pnl over time')}>
        <header className="money-card__head">
          <h2>{t('Pnl over time')}</h2>
        </header>
        <RangePicker key={search} search={search} offset={offset} copy={copy} />
        {body}
        <p className="money-note">{t('Pnl over time rule')}</p>
      </section>
      {result.status === 'ready' && ask.kind !== 'invalid' && range !== null ? (
        <BreakdownCard data={result.data} search={search} hidden={hidden} copy={copy} />
      ) : null}
    </>
  );
}
