/**
 * The studies bar of the chart workbench: the Indicators dialog, a chip per study (its settings), the legend with the
 * values under the pointer (or the last bar, when the legend is always shown), the data window, and the draw onto the
 * chart's host. The studies are the person's own, kept per workbench on this device.
 *
 * It needs the chart's host (`ChartHost`, from the workbench chart) and the bars the chart draws. It draws nothing until
 * the host is ready, and every value it shows comes from `computeStudy`.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { TIMEFRAME_MS } from '@intafaced/exchange-contract/schemas';
import type { Candle, Loadable } from '../../../data/types';
import { useSession } from '../../../features/session/session';
import { useDeviceSetting } from '../../../features/trade/hooks';
import type { DeskMarket } from '../../trade/desk/market';
import { useChartCandles, type ChartInterval } from '../../trade/chart/candles';
import { Button } from '../deps';
import type { ChartHost } from '../chart-host';
import { pendingCommand, type GroupCommand } from '../group-commands';
import { ALL_INTERVALS, intervalLabel } from '../workbench';
import { studyDef, type StudyKind } from './catalogue';
import { computeStudy, type Refusal, type SeriesOut, type StudyContext, type StudyResult } from './compute';
import {
  FRESH_STORE,
  addStudy,
  isStudyStore,
  removeStudy,
  shownOn,
  storeKey,
  updateStudy,
  movePane,
  panesOf,
  PANE_SIZE_MAX,
  PANE_SIZE_MIN,
  resizePane,
  setPaneSizes,
  toggleCollapsed,
  toggleMaximised,
  toggleOnMain,
  type StudyInstance,
  type StudyStore,
} from './model';
import { useTape } from './data';
import { IndicatorDialog, StudySettings, type StudyChanges } from './StudyDialogs';
import { useStudyDraw } from './useStudyDraw';
import { useWords, type StudiesWords } from './words';
import type { Print } from './math';
import './studies.css';

export interface StudiesBarProps {
  /** The chart's host. Null until the workbench chart is ready; the studies draw once it is. */
  host: ChartHost | null;
  market: DeskMarket;
  interval: ChartInterval;
  /** The bars the chart draws: the polled history with the live bar laid over it. Null while they load. */
  bars: readonly Candle[] | null;
  /** The workbench the studies belong to (`?w=`). Default `main`. */
  workbench?: string;
  /** Percent mode: a study with a line on the price scale is refused, since its prices would not match the scale. */
  percent?: boolean;
  /** A bar replay is cut: trades after the last drawn bar have not happened yet and are not read. */
  replaying?: boolean;
  /** The chart's sync group, when it has one. */
  group?: StudyGroupLink;
  /** The object tree's indicator slot (the main chart only): every study is listed there with its actions. */
  treeSlot?: HTMLElement | null;
}

export interface StudyGroupLink {
  size: number;
  /** The group's latest study command; its nonce is new for each request. */
  command: GroupCommand | null;
  /** The nonce this chart has applied, or counts as applied. Read when this chart's effect runs. */
  appliedNonce: () => number;
  /** Records the nonce this chart has applied, so the command is applied once. */
  onApplied: (nonce: number) => void;
  /** Asks the grid to add a study to every chart of the group. */
  onApplyToGroup: (kind: StudyKind) => void;
}

interface FeedState {
  /** The market and interval these feeds were read for. A feed for another key is not shown: it is loading. */
  key: string;
  higher: Record<string, Loadable<Candle[]>>;
  tape?: Loadable<Print[]>;
}
const NO_HIGHER: Record<string, Loadable<Candle[]>> = {};

type Words = StudiesWords;

function reasonText(r: Refusal, t: Words['t'], word: Words['word']): string {
  const p = r.params;
  switch (r.reason) {
    case 'enterPeriod':
      return t('Enter a period');
    case 'enterValue':
      return t('Enter a value');
    case 'enterInterval':
      return t('Choose an interval');
    case 'badInput':
      return t('That input is not one this study reads.');
    case 'needsBars':
      return p.interval
        ? t('Needs {count} bars at {interval}', { count: p.count ?? '', interval: p.interval })
        : t('Needs {count} bars', { count: p.count ?? '' });
    case 'noBars':
      return t('No bars are loaded for this market.');
    case 'noVolume':
      return t('This market has no volume in the loaded bars.');
    case 'noTape':
      return t('No public trades for this market.');
    case 'tapeWindow':
      return t('The public trades do not reach the loaded bars.');
    case 'tapeDepth':
      return t('Covers the last {count} public trades.', { count: p.count ?? '' });
    case 'feedError':
      return t('The data for this study could not be read. Try again later.');
    case 'feedRefused':
      return t('The data for this study was refused.');
    case 'notServed':
      return t('{series} is not published for {symbol}.', { series: word(p.series ?? ''), symbol: p.symbol ?? '' });
    case 'weightsBlank':
      return t('Enter every rating weight to see a score.');
    case 'needsDaily':
      return t('Pivot levels need a daily or finer interval.');
    case 'noPriorDay':
      return t('The prior day is not whole in the loaded bars.');
    case 'htfNotCoarser':
      return t('Choose an interval coarser than this chart.');
    case 'noHigherBars':
      return t('No higher-timeframe bars for this market.');
    case 'noTickSize':
      return t('The market has no tick or lot size, so no value is shown.');
    case 'percentOverlay':
      return t('Studies on price are off in percent mode. Switch the scale back to price.');
    case 'weightsZero':
      return t('The rating weights are all zero, so there is no score to show.');
  }
}

/** The short label of a study on its chip: its name in notation and its period inputs (`RSI 14`). */
/** The numeric inputs of a study, as shown after its name (20, 14 26 9, ...). */
function studyValues(study: StudyInstance): string {
  const def = studyDef(study.kind);
  return def.inputs
    .filter((input) => input.kind === 'period' || input.kind === 'number')
    .map((input) => study.inputs[input.key] ?? '')
    .filter((v) => v !== '')
    .join(' ');
}

function chipText(study: StudyInstance, word: Words['word']): string {
  const def = studyDef(study.kind);
  return [word(def.short), studyValues(study)].filter((v) => v !== '').join(' ');
}

const timeText = (seconds: number): string => `${new Date(seconds * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC`;

/** The value of a series at one time, as shown. Null when the series has no point there. */
function valueAt(series: SeriesOut, time: number): string | null {
  const point = series.points.find((p) => p.time === time);
  return point?.text ?? null;
}

/** Feeds the higher-timeframe bars of one study up to the bar: the desk's own candles at that interval. */
function HigherFeed({
  id,
  feedKey,
  symbol,
  interval,
  onData,
}: {
  id: string;
  feedKey: string;
  symbol: string;
  interval: ChartInterval;
  onData: (key: string, id: string, data: Loadable<Candle[]>) => void;
}) {
  const data = useChartCandles(symbol, interval);
  useEffect(() => {
    onData(feedKey, id, data);
  }, [feedKey, id, data, onData]);
  return null;
}

/** Feeds the public tape while a study reads it. */
function TapeFeed({
  feedKey,
  symbol,
  onData,
}: {
  feedKey: string;
  symbol: string;
  onData: (key: string, data: Loadable<Print[]>) => void;
}) {
  const data = useTape(symbol);
  useEffect(() => {
    onData(feedKey, data);
  }, [feedKey, data, onData]);
  return null;
}

function StudyRow({
  study,
  result,
  cursor,
  words,
  controls,
}: {
  study: StudyInstance;
  result: StudyResult | null;
  cursor: number | null;
  words: Words;
  /** The pane's own controls, for a study drawn in a pane of its own (or moved to the main pane). */
  controls?: ReactNode;
}) {
  const { t, word } = words;
  const def = studyDef(study.kind);
  let body: ReactNode = null;
  if (result === null || result.status === 'loading') body = <span className="st-row-note">{t('Loading')}</span>;
  else if (result.status === 'refused')
    body = (
      <span className="st-row-note" role="status">
        {reasonText(result, t, word)}
      </span>
    );
  else {
    body = (
      <>
        {cursor !== null && (
          <span className="st-row-values">
            {result.series.map((s) => (
              <span key={s.key} className="st-value" data-series={s.name}>
                <span className="st-value-name">{word(s.name)}</span> <span className="st-value-text">{valueAt(s, cursor) ?? '—'}</span>
              </span>
            ))}
          </span>
        )}
        {result.facts.map((f) => (
          <span key={f.name} className="st-fact">
            {word(f.name)}: {word(f.text)}
          </span>
        ))}
        {result.notes.map((n) => (
          <span key={`${n.label}:${n.reason}`} className="st-row-note" role="status">
            {word(n.label)}: {reasonText(n, t, word)}
          </span>
        ))}
        {result.table && (
          <table className="st-table" aria-label={t('Study table')}>
            <thead>
              <tr>
                <th scope="col">{t('Price bin')}</th>
                <th scope="col">{t('Buy volume')}</th>
                <th scope="col">{t('Sell volume')}</th>
                <th scope="col">{t('Share')}</th>
              </tr>
            </thead>
            <tbody>
              {result.table.map((row, n) => (
                <tr key={n} data-poc={row.poc || undefined}>
                  <td>{row.label}</td>
                  <td>{row.buy}</td>
                  <td>{row.sell}</td>
                  <td>{row.share}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </>
    );
  }
  return (
    <div
      className="st-row"
      data-study={study.id}
      data-pane={result?.status === 'ready' ? (result.series.some((x) => x.pane === 'sub') ? 'sub' : 'overlay') : undefined}
    >
      <span className="st-row-name">{word(def.name)}</span>
      {result?.status === 'ready' && result.series[0] && (
        <>
          {' '}
          <span className="st-row-formula">{word(result.series[0].name)}</span>
        </>
      )}
      {controls}
      {body}
    </div>
  );
}

export function StudiesBar({
  host,
  market,
  interval,
  bars,
  workbench = 'main',
  percent = false,
  replaying = false,
  group,
  treeSlot = null,
}: StudiesBarProps) {
  const words = useWords();
  const { t, word } = words;
  const { userId } = useSession();
  const [store, setStore] = useDeviceSetting<StudyStore>(storeKey(userId, workbench), FRESH_STORE, isStudyStore);
  const [adding, setAdding] = useState(false);
  // A group command is applied once per chart. The grid keeps the nonce each chart has applied, so a chart whose studies
  // bar mounts after the command fired still applies it, and a remount does not add it again.
  useEffect(() => {
    if (!group) return;
    const pending = pendingCommand(group.command, group.appliedNonce());
    if (!pending) return;
    group.onApplied(pending.nonce);
    setStore((now) => addStudy(now, pending.kind));
  }, [group, setStore]);
  const [editing, setEditing] = useState<string | null>(null);
  const [showWindow, setShowWindow] = useState(false);
  const [hover, setHover] = useState<number | null>(null);
  // The feeds are read for one market and interval: after a switch they are loading until they match it.
  const feedKey = `${market.symbol}|${interval}`;
  const [feedState, setFeedState] = useState<FeedState>({ key: feedKey, higher: NO_HIGHER });
  const feeds: FeedState | null = feedState.key === feedKey ? feedState : null;

  const shown = useMemo(() => store.studies.filter((s) => shownOn(s, interval)), [store.studies, interval]);
  const hiddenHere = useMemo(() => store.studies.filter((s) => !shownOn(s, interval)), [store.studies, interval]);
  const needsTape = shown.some((s) => studyDef(s.kind).needs === 'tape');
  const htfTargets = useMemo(
    () =>
      shown.flatMap((s) => {
        if (s.kind !== 'htf-sma') return [];
        const wanted = (ALL_INTERVALS as readonly string[]).includes(s.inputs.interval ?? '') ? (s.inputs.interval as ChartInterval) : null;
        return wanted !== null && TIMEFRAME_MS[wanted] > TIMEFRAME_MS[interval] ? [{ id: s.id, interval: wanted }] : [];
      }),
    [shown, interval],
  );

  const onFeed = useCallback((key: string, id: string, data: Loadable<Candle[]>) => {
    setFeedState((prev) => {
      const base: FeedState = prev.key === key ? prev : { key, higher: NO_HIGHER };
      return base.higher[id] === data && base === prev ? prev : { ...base, higher: { ...base.higher, [id]: data } };
    });
  }, []);
  const onTape = useCallback((key: string, data: Loadable<Print[]>) => {
    setFeedState((prev) => {
      const base: FeedState = prev.key === key ? prev : { key, higher: NO_HIGHER };
      return base.tape === data && base === prev ? prev : { ...base, tape: data };
    });
  }, []);

  const results = useMemo<Array<{ study: StudyInstance; result: StudyResult }> | null>(() => {
    if (bars === null) return null;
    const ctx: StudyContext = {
      symbol: market.symbol,
      interval,
      bars,
      tickSize: market.tickSize,
      lotSize: market.lotSize,
      higher: feeds?.higher ?? NO_HIGHER,
      tape: needsTape ? feeds?.tape : undefined,
      percent,
      // In a replay the last drawn bar is the newest bar there is: the trades after its close have not happened.
      replayEnd: replaying && bars.length > 0 ? bars[bars.length - 1]!.t + TIMEFRAME_MS[interval] : undefined,
    };
    return shown.map((study) => ({ study, result: computeStudy(study, ctx) }));
  }, [bars, market.symbol, market.tickSize, market.lotSize, interval, feeds, needsTape, shown, percent, replaying]);

  const drawn = useMemo<SeriesOut[]>(() => (results ?? []).flatMap((r) => (r.result.status === 'ready' ? r.result.series : [])), [results]);
  const layout = panesOf(store);
  const onSizes = useCallback((sizes: Record<string, number>) => setStore((now) => setPaneSizes(now, sizes)), [setStore]);
  useStudyDraw(host, drawn, market.tickSize, layout, onSizes);
  // The studies that draw in a pane under the price, top to bottom, and those moved onto the main pane.
  const subIds = (results ?? [])
    .filter((r) => r.result.status === 'ready' && r.result.series.some((x) => x.pane === 'sub'))
    .map((r) => r.study.id);
  const paneOrder = subIds.filter((id) => !layout.onMain.includes(id));

  // The pointer's bar. With the legend always shown and no pointer, the last bar is read.
  useEffect(() => {
    if (!host) return;
    const handler = (param: { time?: number }) => setHover(typeof param.time === 'number' ? param.time : null);
    host.chart.subscribeCrosshairMove(handler);
    return () => host.chart.unsubscribeCrosshairMove(handler);
  }, [host]);
  const lastTime = bars && bars.length > 0 ? Math.floor(bars[bars.length - 1]!.t / 1000) : null;
  const cursor = hover ?? (store.legendAlways ? lastTime : null);
  const barAt = cursor === null || bars === null ? undefined : bars.find((b) => Math.floor(b.t / 1000) === cursor);

  const editingStudy = editing === null ? undefined : store.studies.find((s) => s.id === editing);
  const resultFor = (id: string): StudyResult | null => results?.find((r) => r.study.id === id)?.result ?? null;

  const apply = (id: string, changes: StudyChanges) => {
    setStore((now) => updateStudy(now, id, changes));
    setEditing(null);
  };
  const remove = (id: string) => {
    setStore((now) => removeStudy(now, id));
    setEditing(null);
  };

  const nameOf = (s: StudyInstance) => [word(studyDef(s.kind).name), studyValues(s)].filter((v) => v !== '').join(' ');
  // Flips this interval in the study as it is now in the store, so a quick second click or a dialog change is not lost.
  const toggleHere = (id: string) =>
    setStore((now) => {
      const s = now.studies.find((x) => x.id === id);
      if (!s) return now;
      return updateStudy(now, id, {
        hiddenOn: shownOn(s, interval) ? [...s.hiddenOn, interval] : s.hiddenOn.filter((v) => v !== interval),
      });
    });

  const paneControls = (s: StudyInstance) => {
    const name = nameOf(s);
    const onMain = layout.onMain.includes(s.id);
    const at = paneOrder.indexOf(s.id);
    const collapsed = layout.collapsed.includes(s.id);
    const maximised = layout.maximised === s.id;
    const button = (label: string, onClick: () => void, disabled = false) => (
      <button type="button" className="st-pane-button" aria-label={label} title={label} disabled={disabled} onClick={onClick}>
        {label}
      </button>
    );
    return (
      <span
        className="st-pane"
        role="group"
        aria-label={t('{name} pane', { name })}
        data-pane-state={onMain ? 'main' : collapsed ? 'collapsed' : maximised ? 'maximised' : 'open'}
      >
        {!onMain && (
          <>
            {button(t('Move {name} pane up', { name }), () => setStore((now) => movePane(now, s.id, -1, paneOrder)), at <= 0)}
            {button(
              t('Move {name} pane down', { name }),
              () => setStore((now) => movePane(now, s.id, 1, paneOrder)),
              at < 0 || at >= paneOrder.length - 1,
            )}
            {button(t(collapsed ? 'Expand {name} pane' : 'Collapse {name} pane', { name }), () =>
              setStore((now) => toggleCollapsed(now, s.id)),
            )}
            {button(
              t('Make {name} pane taller', { name }),
              () => setStore((now) => resizePane(now, s.id, 1.5)),
              collapsed || maximised || (layout.sizes[s.id] ?? 1) >= PANE_SIZE_MAX,
            )}
            {button(
              t('Make {name} pane shorter', { name }),
              () => setStore((now) => resizePane(now, s.id, 1 / 1.5)),
              collapsed || maximised || (layout.sizes[s.id] ?? 1) <= PANE_SIZE_MIN,
            )}
            {button(t(maximised ? 'Restore the panes' : 'Maximise {name} pane', { name }), () =>
              setStore((now) => toggleMaximised(now, s.id)),
            )}
          </>
        )}
        {button(t(onMain ? 'Move {name} to its own pane' : 'Move {name} to the main pane', { name }), () =>
          setStore((now) => toggleOnMain(now, s.id)),
        )}
      </span>
    );
  };

  return (
    <section className="st" aria-label={t('Studies on this chart')} data-testid="studies">
      {treeSlot &&
        createPortal(
          // Inside the object tree, so it takes the tree's row styles (drawings.css).
          <div className="st-tree" data-testid="tree-indicators">
            <h3 className="dw-tree-title" id={`st-tree-${workbench}`}>
              {t('Indicators on this chart')}
            </h3>
            {store.studies.length === 0 ? <p className="dw-note">{t('No indicators on this chart')}</p> : null}
            <ul className="dw-rows" aria-labelledby={`st-tree-${workbench}`}>
              {store.studies.map((s) => {
                const here = shownOn(s, interval);
                return (
                  <li key={s.id} className="dw-row" data-study-id={s.id} data-study-kind={s.kind} data-shown-here={here}>
                    <span className="dw-row-name">
                      {nameOf(s)}
                      {!here ? (
                        <>
                          {' '}
                          <span className="dw-badge">{word('Hidden on this interval')}</span>
                        </>
                      ) : null}
                    </span>
                    <div className="dw-row-actions">
                      <button type="button" className="dw-link" onClick={() => toggleHere(s.id)}>
                        {here
                          ? t('Hide on {interval}', { interval: intervalLabel(interval) })
                          : t('Show on {interval}', { interval: intervalLabel(interval) })}
                      </button>
                      <button type="button" className="dw-link" onClick={() => setEditing(s.id)}>
                        {t('Edit {name}', { name: nameOf(s) })}
                      </button>
                      <button type="button" className="dw-link" onClick={() => remove(s.id)}>
                        {t('Remove {name}', { name: nameOf(s) })}
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>,
          treeSlot,
        )}
      <div className="st-bar">
        <Button type="button" variant="secondary" onClick={() => setAdding(true)}>
          {t('Indicators')}
        </Button>
        <div className="st-chips" role="group" aria-label={t('Studies on this chart')}>
          {store.studies.map((s) => (
            <button
              key={s.id}
              type="button"
              className="st-chip"
              data-hidden-here={shownOn(s, interval) ? undefined : true}
              aria-label={t('Settings for {name}', { name: nameOf(s) })}
              onClick={() => setEditing(s.id)}
            >
              {chipText(s, word)}
            </button>
          ))}
        </div>
        <label className="st-check">
          <input
            type="checkbox"
            checked={store.legendAlways}
            onChange={(event) => setStore((now) => ({ ...now, legendAlways: event.target.checked }))}
          />
          <span>{t('Legend always shown')}</span>
        </label>
        <button type="button" className="st-toggle" aria-pressed={showWindow} onClick={() => setShowWindow((now) => !now)}>
          {t('Data window')}
        </button>
      </div>

      <div className="st-legend" data-testid="study-legend">
        {shown.map((study) => (
          <StudyRow
            key={study.id}
            study={study}
            result={resultFor(study.id)}
            cursor={cursor}
            words={words}
            controls={subIds.includes(study.id) ? paneControls(study) : undefined}
          />
        ))}
        {hiddenHere.map((study) => (
          <div key={study.id} className="st-row" data-study={study.id} data-hidden-here="true">
            <span className="st-row-name">{word(studyDef(study.kind).name)}</span>
            <span className="st-row-note">{word('Hidden on this interval')}</span>
          </div>
        ))}
      </div>

      {showWindow && (
        <section
          className="st-window"
          aria-label={t('Data window')}
          data-testid="data-window"
          data-cursor={cursor === null ? undefined : String(cursor)}
        >
          {cursor === null || barAt === undefined ? (
            <p className="st-note">{t('Move the pointer over the chart to read its values.')}</p>
          ) : (
            <>
              <p className="st-window-time">{t('Values at {time}', { time: timeText(cursor) })}</p>
              <dl className="st-ohlc">
                <dt>{t('Open')}</dt>
                <dd>{barAt.o}</dd>
                <dt>{t('High')}</dt>
                <dd>{barAt.h}</dd>
                <dt>{t('Low')}</dt>
                <dd>{barAt.l}</dd>
                <dt>{t('Close')}</dt>
                <dd>{barAt.c}</dd>
              </dl>
              <ul className="st-window-list">
                {(results ?? [])
                  .filter((r) => r.result.status === 'ready')
                  .flatMap((r) => (r.result.status === 'ready' ? r.result.series : []))
                  .map((s) => (
                    <li key={s.key}>
                      <span>{word(s.name)}</span> <span>{valueAt(s, cursor) ?? '—'}</span>
                    </li>
                  ))}
              </ul>
            </>
          )}
        </section>
      )}

      <IndicatorDialog
        open={adding}
        onOpenChange={setAdding}
        groupSize={group?.size ?? 0}
        onAdd={(kind: StudyKind, toGroup: boolean) =>
          toGroup && group ? group.onApplyToGroup(kind) : setStore((now) => addStudy(now, kind))
        }
      />
      {editingStudy && (
        <StudySettings
          key={editingStudy.id}
          study={editingStudy}
          onApply={(changes) => apply(editingStudy.id, changes)}
          onRemove={() => remove(editingStudy.id)}
          onClose={() => setEditing(null)}
        />
      )}
      {htfTargets.map((target) => (
        <HigherFeed
          key={`${feedKey}|${target.id}`}
          id={target.id}
          feedKey={feedKey}
          symbol={market.symbol}
          interval={target.interval}
          onData={onFeed}
        />
      ))}
      {needsTape && <TapeFeed key={feedKey} feedKey={feedKey} symbol={market.symbol} onData={onTape} />}
    </section>
  );
}
