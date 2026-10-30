/**
 * The workbench's charts: one, two or four, each a full market chart widget, with dragged borders, one chart maximised
 * on Alt+Enter, and sync by colour group (symbol and interval follow through the settings; crosshair and date range
 * follow through the charts themselves). The first chart is the address's market and the workbench's own setting.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { useSession } from '../../features/session/session';
import { useDeviceSetting } from '../../features/trade/hooks';
import type { ChartInterval } from '../trade/chart/candles';
import { findMarket, pairOf, type DeskMarket } from '../trade/desk/market';
import type { ChartHost } from './chart-host';
import { CHART_STYLES, type ChartStyle, type ColourScheme } from './chart-style';
import { chartsCopy } from './copy';
import { Dialog, DialogContent, DialogTitle, navigate, StateBlock } from './deps';
import {
  applyChange,
  cellsFor,
  chartCount,
  DEFAULT_GRID,
  EVEN_SIZES,
  followers,
  GROUPS,
  gridKey,
  isGridSetting,
  LAYOUT_IDS,
  LAYOUTS,
  limitedLayoutAfter,
  reasonFor,
  resize,
  withVisible,
  type CellSetting,
  type GridSetting,
  type Group,
  type LayoutId,
  type LimitRead,
  type SyncSet,
} from './grid';
import { MarketChartWidget, type AddonView, type WidgetProps } from './MarketChartWidget';
import { joinedNonce, type GroupCommands } from './group-commands';
import { StudiesBar } from './studies/StudiesBar';
import type { StudyKind } from './studies/catalogue';
import { OWNER_VALUE_UNSET, ownerValue, useChartOwnerValues } from './owner-values';
import { chartsHref, type WorkbenchSetting } from './workbench';

const LAYOUT_LABEL = {
  single: 'Layout single',
  'two-across': 'Layout two across',
  'two-down': 'Layout two down',
  grid: 'Layout grid',
} as const;
const GROUP_LABEL = { blue: 'Group blue', green: 'Group green', orange: 'Group orange' } as const;
const SYNC_LABEL = { symbol: 'Sync symbol', interval: 'Sync interval', crosshair: 'Sync crosshair', range: 'Sync range' } as const;

/** Every key the workbench binds, in the order the help list shows them. The help list is built from this table. */
export const SHORTCUTS = [
  { keys: 'Alt+Enter', action: 'Key maximise' },
  { keys: 'Alt+1 … Alt+6', action: 'Key style' },
  { keys: 'Alt+R', action: 'Key replay' },
  { keys: 'Alt+G', action: 'Key layout' },
  { keys: 'Alt+T', action: 'Key trade' },
  { keys: '← →', action: 'Key pan' },
  { keys: '+ −', action: 'Key zoom' },
  { keys: 'Home', action: 'Key home' },
  { keys: '?', action: 'Key help' },
] as const;

interface GridProps {
  market: DeskMarket;
  markets: readonly DeskMarket[];
  workbench: string;
  setting: WorkbenchSetting;
  setInterval: (interval: ChartInterval) => void;
  setMode: (mode: ChartStyle) => void;
  setScheme: (scheme: ColourScheme) => void;
  openSocket?: WidgetProps['openSocket'];
  /** Add-ons on the first chart only (the workbench's drawings): the chart's host and the bars it draws. */
  mainAddons?: WidgetProps['addons'];
}

const inField = (target: EventTarget | null) =>
  target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));

export function ChartGrid({ market, markets, workbench, setting, setInterval, setMode, setScheme, openSocket, mainAddons }: GridProps) {
  const { t } = chartsCopy.useCopy();
  const { userId } = useSession();
  const [grid, setGrid] = useDeviceSetting<GridSetting>(gridKey(userId, workbench), DEFAULT_GRID, isGridSetting);
  const owner = useChartOwnerValues(market.symbol);
  const limit: LimitRead = ownerValue(owner, 'chartCountLimit');
  const limitKey = limit.ok ? String(limit.value) : limit.why;
  const [refused, setRefused] = useState<LayoutId | null>(null);
  const [maximised, setMaximised] = useState<number | null>(null);
  const [help, setHelp] = useState(false);
  const [commands, setCommands] = useState<Record<number, { kind: 'replay'; nonce: number }>>({});
  // A study added to one sync group goes to every chart in it. The latest command of each group is kept until the next
  // one, so a chart whose studies bar mounts later still applies it. `applied` is the nonce each grid slot has applied.
  const [groupCommands, setGroupCommands] = useState<GroupCommands>({});
  const commandSeq = useRef(0);
  const applied = useRef<Record<number, number>>({});
  const applyToGroup = useCallback((group: Group, kind: StudyKind) => {
    commandSeq.current += 1;
    const nonce = commandSeq.current;
    setGroupCommands((now) => ({ ...now, [group]: { kind, nonce } }));
  }, []);
  // The first chart's colour group is kept beside the grid (its market and interval are the workbench's own).
  const [firstTag, setFirstTag] = useDeviceSetting<Group | 'none'>(
    `${gridKey(userId, workbench)}:first`,
    'blue',
    (v): v is Group | 'none' => v === 'none' || (GROUPS as readonly unknown[]).includes(v),
  );
  const first: CellSetting = {
    symbol: market.symbol,
    interval: setting.interval,
    mode: setting.mode,
    group: firstTag === 'none' ? null : firstTag,
  };

  // A stored layout is shown only once the limit is read and allows it. Otherwise one chart shows, and the note says why.
  const layout: LayoutId = reasonFor(grid.layout, limit) === null ? grid.layout : 'single';
  // A refusal belongs to the limit it was read against: a new limit clears it.
  useEffect(() => setRefused(null), [limitKey]);
  const cells = useMemo(
    () => cellsFor(layout, first, grid.cells),
    [layout, first.symbol, first.interval, first.mode, first.group, grid.cells],
  ); // eslint-disable-line react-hooks/exhaustive-deps

  // A slot that joins a group (or is shown in one for the first time) counts the group's current command as applied, so
  // it never replays a command issued before it joined. Layout effects run before any studies bar's effect in a commit.
  const slotGroups = useRef<Array<Group | null | undefined>>([]);
  useLayoutEffect(() => {
    cells.forEach((cell, i) => {
      if (slotGroups.current[i] === cell.group) return;
      slotGroups.current[i] = cell.group;
      applied.current[i] = joinedNonce(groupCommands, cell.group);
    });
    slotGroups.current.length = cells.length;
  }, [cells, groupCommands]);

  const chooseLayout = (next: LayoutId) => {
    if (reasonFor(next, limit) !== null) {
      setRefused(next);
      return;
    }
    setRefused(null);
    setMaximised(null);
    setGrid((now) => ({ ...now, layout: next, cells: cellsFor(next, first, now.cells).slice(1) }));
  };

  /** A change on chart `index`: applied there and to the charts that follow it; the first chart's goes to the address. */
  const change = useCallback(
    (index: number, patch: Partial<Pick<CellSetting, 'symbol' | 'interval' | 'mode'>>) => {
      const next = applyChange(cells, index, patch, grid.sync);
      const head = next[0]!;
      if (head.interval !== setting.interval) setInterval(head.interval);
      if (head.mode !== setting.mode) setMode(head.mode);
      const nextGrid = { ...grid, cells: withVisible(grid.cells, next.slice(1)) };
      setGrid(nextGrid);
      if (head.symbol !== market.symbol) {
        // The page is remounted for the new market before the stored grid would be written, so write it now.
        try {
          localStorage.setItem(gridKey(userId, workbench), JSON.stringify(nextGrid));
        } catch {
          /* The grid stays usable without browser storage. */
        }
        navigate(chartsHref(pairOf(head.symbol), { workbench }));
      }
    },
    [cells, grid, setting.interval, setting.mode, setInterval, setMode, setGrid, market.symbol, workbench, userId],
  );
  const setGroup = (index: number, group: Group | null) => {
    if (index === 0) setFirstTag(group ?? 'none');
    else
      setGrid((now) => ({
        ...now,
        cells: withVisible(
          now.cells,
          cellsFor(layout, first, now.cells)
            .slice(1)
            .map((c, i) => (i === index - 1 ? { ...c, group } : c)),
        ),
      }));
  };
  const setSync = (key: keyof SyncSet, on: boolean) => setGrid((now) => ({ ...now, sync: { ...now.sync, [key]: on } }));

  // Crosshair and date range follow through the charts' own hosts.
  const hosts = useRef<Array<ChartHost | null>>([]);
  const cellEls = useRef<Array<HTMLDivElement | null>>([]);
  const [hostsVersion, setHostsVersion] = useState(0);
  const onHost = useCallback((index: number, host: ChartHost | null) => {
    if (hosts.current[index] === host) return;
    hosts.current[index] = host;
    setHostsVersion((n) => n + 1);
  }, []);
  useEffect(() => {
    const live = hosts.current.slice(0, cells.length);
    let syncing = false;
    const off: Array<() => void> = [];
    live.forEach((host, i) => {
      if (!host) return;
      const mark = (name: string, value: string) => {
        const el = cellEls.current[i];
        if (el) el.dataset[name] = value;
      };
      const onMove = (param: { time?: number; point?: { x: number; y: number } }) => {
        mark('crosshair', param.time === undefined ? '' : String(param.time));
        // The price at the pointer's height, as the library reads it, so a check can compare a placed point with it.
        const atPointer = param.point ? host.main.coordinateToPrice(param.point.y) : null;
        mark('crosshairPrice', atPointer === null ? '' : String(atPointer));
        if (syncing || !grid.sync.crosshair) return;
        syncing = true;
        try {
          for (const j of followers(cells, i)) {
            const other = live[j];
            if (!other) continue;
            if (param.time === undefined || !param.point) other.chart.clearCrosshairPosition();
            else {
              // No price at this height on that chart: it takes the time alone, never a price made up.
              const price = other.main.coordinateToPrice(param.point.y);
              if (price !== null) other.chart.setCrosshairPosition(price, param.time, other.main);
            }
            cellEls.current[j]?.setAttribute('data-crosshair', param.time === undefined ? '' : String(param.time));
          }
        } finally {
          syncing = false;
        }
      };
      const onRange = (range: { from: number; to: number } | null) => {
        if (range) mark('range', `${range.from}-${range.to}`);
        if (syncing || !grid.sync.range || !range) return;
        syncing = true;
        try {
          for (const j of followers(cells, i)) live[j]?.chart.timeScale().setVisibleRange(range);
        } finally {
          syncing = false;
        }
      };
      host.chart.subscribeCrosshairMove(onMove);
      host.chart.timeScale().subscribeVisibleTimeRangeChange(onRange);
      off.push(() => {
        host.chart.unsubscribeCrosshairMove(onMove);
        host.chart.timeScale().unsubscribeVisibleTimeRangeChange(onRange);
      });
    });
    return () => off.forEach((f) => f());
  }, [hostsVersion, cells, grid.sync.crosshair, grid.sync.range]);

  // Dragged borders: the column border and the row border, each between two tracks; a double-click evens them.
  const area = useRef<HTMLDivElement>(null);
  // The drag in progress, so unmounting mid-drag removes its window listeners.
  const stopDrag = useRef<(() => void) | null>(null);
  useEffect(() => () => stopDrag.current?.(), []);
  const drag = (axis: 'cols' | 'rows') => (event: ReactPointerEvent<HTMLDivElement>) => {
    const box = area.current?.getBoundingClientRect();
    const span = box ? (axis === 'cols' ? box.width : box.height) : 0;
    if (!box || !(span > 0)) return;
    event.preventDefault();
    stopDrag.current?.();
    const start = axis === 'cols' ? event.clientX : event.clientY;
    const from = grid.sizes[axis];
    const move = (e: PointerEvent) => {
      const delta = ((axis === 'cols' ? e.clientX : e.clientY) - start) / span;
      setGrid((now) => ({ ...now, sizes: { ...now.sizes, [axis]: resize(from, delta) } }));
    };
    const stop = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
      if (stopDrag.current === stop) stopDrag.current = null;
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
    stopDrag.current = stop;
  };
  const even = (axis: 'cols' | 'rows') => () => setGrid((now) => ({ ...now, sizes: { ...now.sizes, [axis]: EVEN_SIZES[axis] } }));

  // The workbench's keys. Off inside text fields; the browser's own keys win.
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (help || inField(event.target)) return;
    const cell = (event.target as HTMLElement).closest<HTMLElement>('[data-cell]');
    const index = cell ? Number(cell.dataset.cell) : 0;
    if (event.altKey && event.key === 'Enter') {
      event.preventDefault();
      setMaximised((now) => (now === null && cells.length > 1 ? index : null));
    } else if (event.altKey && /^Digit[1-6]$/.test(event.code)) {
      event.preventDefault();
      change(index, { mode: CHART_STYLES[Number(event.code.slice(5)) - 1]! });
    } else if (event.altKey && event.code === 'KeyR') {
      event.preventDefault();
      setCommands((now) => ({ ...now, [index]: { kind: 'replay', nonce: Date.now() } }));
    } else if (event.altKey && event.code === 'KeyG') {
      event.preventDefault();
      const next = limitedLayoutAfter(layout, limit);
      if (next !== null) chooseLayout(next);
    } else if (event.altKey && event.code === 'KeyT') {
      event.preventDefault();
      navigate(`/trade/spot/${pairOf(cells[index]?.symbol ?? market.symbol)}`);
    } else if (!event.altKey && !event.ctrlKey && !event.metaKey && event.key === '?') {
      event.preventDefault();
      setHelp(true);
    }
  };

  // The note: a layout just refused, or the stored layout that is shown as one chart instead. Each reason has its code.
  const noted = refused ?? (layout !== grid.layout ? grid.layout : null);
  const reason = noted === null ? null : reasonFor(noted, limit);
  const note: { code?: string; text: string } | null =
    noted === null || reason === null
      ? null
      : reason === 'over' && limit.ok
        ? {
            code: 'trade.chart.layout_over_limit',
            text: t('Layout over limit', { limit: String(limit.value), count: String(chartCount(noted)) }),
          }
        : reason === 'unset'
          ? { code: OWNER_VALUE_UNSET, text: t('Layout limit unset') }
          : reason === 'unavailable'
            ? { code: 'trade.chart.owner_value_unavailable', text: t('Layout limit unavailable') }
            : reason === 'loading'
              ? { text: t('Layout limit loading') }
              : null;

  const { cols, rows } = LAYOUTS[layout];
  const template = {
    gridTemplateColumns: cols === 2 ? `${grid.sizes.cols[0]}fr 8px ${grid.sizes.cols[1]}fr` : '1fr',
    gridTemplateRows: rows === 2 ? `${grid.sizes.rows[0]}fr 8px ${grid.sizes.rows[1]}fr` : '1fr',
  };
  const place = (i: number) => ({ gridColumn: (i % cols) * 2 + 1, gridRow: Math.floor(i / cols) * 2 + 1 });

  return (
    <div className="cg" onKeyDown={onKey}>
      <div className="cg-bar" role="toolbar" aria-label={t('Grid options')}>
        <label className="cw-select cw-select--inline">
          <span>{t('Layout')}</span>
          {/* The layouts wait for the owner's chart limit; a choice made before it arrives would only be refused. */}
          <select
            value={layout}
            disabled={!limit.ok && limit.why === 'loading'}
            onChange={(event) => chooseLayout(event.target.value as LayoutId)}
          >
            {LAYOUT_IDS.map((id) => (
              <option key={id} value={id}>
                {t(LAYOUT_LABEL[id])}
              </option>
            ))}
          </select>
        </label>
        {cells.length > 1 && (
          <fieldset className="cg-sync">
            <legend>{t('Sync in a group')}</legend>
            {(['symbol', 'interval', 'crosshair', 'range'] as const).map((key) => (
              <label key={key} className="cw-check">
                <input type="checkbox" checked={grid.sync[key]} onChange={(event) => setSync(key, event.target.checked)} />
                <span>{t(SYNC_LABEL[key])}</span>
              </label>
            ))}
          </fieldset>
        )}
        <button type="button" className="cw-option" onClick={() => setHelp(true)}>
          {t('Shortcuts')}
        </button>
      </div>
      {note && (
        <p className="cw-note cg-note" role="status" data-code={note.code}>
          {note.text}
        </p>
      )}
      <div ref={area} data-testid="cg-area" className="cg-area" style={template} data-layout={layout} data-maximised={maximised ?? ''}>
        {cells.map((cell, i) => {
          const cellMarket = findMarket(markets as DeskMarket[], cell.symbol);
          const hidden = maximised !== null && maximised !== i;
          return (
            <div
              key={i}
              ref={(el) => {
                cellEls.current[i] = el;
              }}
              className="cg-cell"
              data-cell={i}
              data-symbol={cell.symbol}
              data-interval={cell.interval}
              data-group={cell.group ?? ''}
              style={maximised === i ? { gridColumn: '1 / -1', gridRow: '1 / -1' } : { ...place(i), display: hidden ? 'none' : undefined }}
              aria-label={t('Chart number', { n: String(i + 1) })}
              role="region"
            >
              {cells.length > 1 && (
                <div className="cg-cell-bar">
                  <span>{t('Chart number', { n: String(i + 1) })}</span>
                  <label className="cw-select cw-select--inline">
                    <span>{t('Group')}</span>
                    <select
                      value={cell.group ?? 'none'}
                      onChange={(event) => setGroup(i, event.target.value === 'none' ? null : (event.target.value as Group))}
                    >
                      <option value="none">{t('Group none')}</option>
                      {GROUPS.map((g) => (
                        <option key={g} value={g}>
                          {t(GROUP_LABEL[g])}
                        </option>
                      ))}
                    </select>
                  </label>
                  {i > 0 && (
                    <label className="cw-select cw-select--inline">
                      <span>{t('Choose a market')}</span>
                      <select value={cell.symbol} onChange={(event) => change(i, { symbol: event.target.value })}>
                        {markets.map((m) => (
                          <option key={m.symbol} value={m.symbol}>
                            {m.symbol}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  <button
                    type="button"
                    className="cw-option"
                    aria-pressed={maximised === i}
                    onClick={() => setMaximised((now) => (now === i ? null : i))}
                  >
                    {maximised === i ? t('Restore') : t('Maximise')}
                  </button>
                </div>
              )}
              {cellMarket ? (
                <MarketChartWidget
                  market={cellMarket}
                  interval={cell.interval}
                  mode={cell.mode}
                  onInterval={(interval) => change(i, { interval })}
                  onMode={(mode) => change(i, { mode })}
                  scheme={setting.scheme ?? 'standard'}
                  onScheme={i === 0 ? setScheme : undefined}
                  openSocket={openSocket}
                  onHost={(host) => onHost(i, host)}
                  command={commands[i] ?? null}
                  markets={markets}
                  addons={(host, bars, view: AddonView) => (
                    <>
                      {i === 0 ? mainAddons?.(host, bars, view) : null}
                      <StudiesBar
                        host={host}
                        market={cellMarket}
                        interval={cell.interval}
                        bars={bars}
                        percent={view.percent}
                        replaying={view.replaying}
                        workbench={i === 0 ? workbench : `${workbench}:${i}`}
                        group={
                          cell.group
                            ? {
                                size: cells.filter((c) => c.group === cell.group).length,
                                command: groupCommands[cell.group] ?? null,
                                appliedNonce: () => applied.current[i] ?? 0,
                                onApplied: (nonce) => {
                                  applied.current[i] = nonce;
                                },
                                onApplyToGroup: (kind) => applyToGroup(cell.group!, kind),
                              }
                            : undefined
                        }
                      />
                    </>
                  )}
                />
              ) : (
                <StateBlock kind="empty" title={t('Market not found title')} body={t('Market not found body')} />
              )}
            </div>
          );
        })}
        {cols === 2 && maximised === null && (
          <div
            className="cg-border cg-border--col"
            style={{ gridColumn: 2, gridRow: '1 / -1' }}
            role="separator"
            aria-orientation="vertical"
            aria-label={t('Column border')}
            onPointerDown={drag('cols')}
            onDoubleClick={even('cols')}
          />
        )}
        {rows === 2 && maximised === null && (
          <div
            className="cg-border cg-border--row"
            style={{ gridRow: 2, gridColumn: '1 / -1' }}
            role="separator"
            aria-orientation="horizontal"
            aria-label={t('Row border')}
            onPointerDown={drag('rows')}
            onDoubleClick={even('rows')}
          />
        )}
      </div>
      <Dialog open={help} onOpenChange={setHelp}>
        <DialogContent>
          <DialogTitle>{t('Shortcuts')}</DialogTitle>
          <dl className="cg-keys" data-testid="shortcut-list">
            {SHORTCUTS.map((row) => (
              <div key={row.keys}>
                <dt>
                  <kbd>{row.keys}</kbd>
                </dt>
                <dd>{t(row.action)}</dd>
              </div>
            ))}
          </dl>
          <p className="cg-keys-note">{t('Keys note')}</p>
        </DialogContent>
      </Dialog>
    </div>
  );
}
