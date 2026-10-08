import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { z } from 'zod';
import type { Resource } from '../../shared/resource';
import { Button, Field, Loading, Failure, EmptyState } from '../../shared/ui';
import { TIMEFRAMES, type Listing, type TradeApi } from './trade-api';
import { SecondaryChart, type ChartView } from './Chart';

const geometrySchema = z.object({
  ticket: z.number().int().min(260).max(460),
  book: z.number().int().min(220).max(420),
  chart: z.number().int().min(380).max(900),
  management: z.number().int().min(184).max(600),
});
type Geometry = z.infer<typeof geometrySchema>;
const R5_GEOMETRY: Geometry = { ticket: 320, book: 288, chart: 548, management: 184 };
const GEOMETRY_KEY = 'trade-desk-geometry:v1';
type Axis = keyof Geometry;
const LABELS: Record<Axis, string> = {
  ticket: 'Resize order ticket',
  book: 'Resize order book',
  chart: 'Resize chart height',
  management: 'Resize order management height',
};
const MIN: Geometry = { ticket: 260, book: 220, chart: 380, management: 184 };
const MAX: Geometry = { ticket: 460, book: 420, chart: 900, management: 600 };
const chartViewSchema = z.object({
  interval: z.string().refine((value) => TIMEFRAMES.includes(value as (typeof TIMEFRAMES)[number])),
  type: z.enum(['Candles', 'Line', 'Heikin Ashi']),
  studies: z.array(z.enum(['MA', 'Volume', 'VWAP', 'RSI', 'MACD', 'Bollinger'])).max(6),
});
const extraSchema = z.object({
  symbol: z.string().max(100).nullable(),
  interval: chartViewSchema.shape.interval,
  type: chartViewSchema.shape.type,
});
type Extra = z.infer<typeof extraSchema>;
const workspaceSchema = z.object({
  name: z.string().trim().min(1).max(64),
  paper: z.boolean(),
  geometry: geometrySchema,
  layout: z.enum(['single', 'dual', 'stacked', 'grid']),
  primary: chartViewSchema,
  extras: z.array(extraSchema).max(3),
});
type SavedWorkspace = z.infer<typeof workspaceSchema>;
type Layout = SavedWorkspace['layout'];
const WORKSPACES_KEY = 'trade-desk-workspaces:v1';
const DEFAULT_VIEW: ChartView = { interval: '15m', type: 'Candles', studies: ['Volume'] };
type ChartSlot = ReactNode | ((view: ChartView, revision: number, onChange: (view: ChartView) => void) => ReactNode);

/** Pixel geometry is a view boundary. None of these values are order input or money. */
export function DeskFrame({
  chart,
  book,
  ticket,
  management,
  api,
  market,
  markets = [],
}: {
  chart: ChartSlot;
  book: ReactNode;
  ticket: ReactNode;
  management: ReactNode;
  api?: TradeApi;
  market?: Listing;
  markets?: Listing[];
}) {
  const [geometry, setGeometry] = useState<Geometry>(() => {
    try {
      const parsed = geometrySchema.safeParse(JSON.parse(localStorage.getItem(GEOMETRY_KEY) ?? 'null'));
      return parsed.success ? parsed.data : R5_GEOMETRY;
    } catch {
      return R5_GEOMETRY;
    }
  });
  const [notice, setNotice] = useState('');
  const [layout, setLayout] = useState<Layout>('single');
  const [primary, setPrimary] = useState<ChartView>(DEFAULT_VIEW);
  const [viewRevision, setViewRevision] = useState(0);
  const [extras, setExtras] = useState<Extra[]>([]);
  const [name, setName] = useState('');
  const [saved, setSaved] = useState<SavedWorkspace[]>(() => {
    try {
      const parsed = z
        .array(workspaceSchema)
        .max(12)
        .safeParse(JSON.parse(localStorage.getItem(WORKSPACES_KEY) ?? '[]'));
      return parsed.success ? parsed.data : [];
    } catch {
      return [];
    }
  });
  const onViewChange = useCallback((view: ChartView) => {
    setPrimary((current) =>
      current.interval === view.interval && current.type === view.type && current.studies.join(',') === view.studies.join(',')
        ? current
        : view,
    );
  }, []);
  const [width, setWidth] = useState(1440);
  const host = useRef<HTMLDivElement>(null);
  const drag = useRef<{ axis: Axis; origin: number; value: number } | null>(null);
  useEffect(() => {
    if (!host.current) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(entry.contentRect.width);
    });
    observer.observe(host.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem(GEOMETRY_KEY, JSON.stringify(geometry));
    } catch {
      setNotice('Panel sizes remain in this tab because device storage is unavailable.');
    }
  }, [geometry]);
  useEffect(() => {
    if (width <= 980) return;
    setGeometry((current) => {
      const ticket = Math.min(current.ticket, Math.floor(width) - MIN.book - 400);
      const book = Math.min(current.book, Math.floor(width) - ticket - 400);
      return ticket === current.ticket && book === current.book ? current : { ...current, ticket, book };
    });
  }, [width]);
  function template(value: Layout) {
    setLayout(value);
    setExtras(
      value === 'single'
        ? []
        : (value === 'grid' ? ['1h', '4h', '1d'] : ['1h']).map((interval) => ({ symbol: null, interval, type: 'Line' })),
    );
    if (value === 'grid' || value === 'stacked') setGeometry((current) => ({ ...current, chart: Math.max(800, current.chart) }));
  }
  function save() {
    if (!market || !name.trim()) return;
    const entry = workspaceSchema.safeParse({ name: name.trim(), paper: market.paper, geometry, layout, primary, extras });
    if (!entry.success) {
      setNotice('This workspace could not be saved. Review its view settings.');
      return;
    }
    const next = [...saved.filter((row) => row.name !== entry.data.name), entry.data].slice(-12);
    try {
      localStorage.setItem(WORKSPACES_KEY, JSON.stringify(next));
      setSaved(next);
      setNotice('Workspace saved on this device. Account synchronization is not connected.');
    } catch {
      setNotice('Device storage is unavailable; this workspace was not saved.');
    }
  }
  function restore(value: SavedWorkspace) {
    if (!market || value.paper !== market.paper) {
      setNotice('Switch to the saved workspace’s live or simulated mode before restoring it.');
      return;
    }
    const ticket = width > 980 ? Math.min(value.geometry.ticket, Math.floor(width) - MIN.book - 400) : value.geometry.ticket;
    const book = width > 980 ? Math.min(value.geometry.book, Math.floor(width) - ticket - 400) : value.geometry.book;
    setGeometry({
      ...value.geometry,
      ticket,
      book,
      chart: Math.max(value.layout === 'grid' || value.layout === 'stacked' ? 800 : MIN.chart, value.geometry.chart),
    });
    setLayout(value.layout);
    setPrimary(value.primary);
    setExtras(value.extras);
    setViewRevision((current) => current + 1);
    setNotice(`Restored ${value.name} on this device. Unpublished linked markets remain unavailable.`);
  }
  function remove(value: SavedWorkspace) {
    const next = saved.filter((row) => row.name !== value.name);
    try {
      localStorage.setItem(WORKSPACES_KEY, JSON.stringify(next));
      setSaved(next);
      setNotice(`Deleted ${value.name} from this device.`);
    } catch {
      setNotice('Device storage is unavailable; this workspace was not deleted.');
    }
  }
  function maximum(axis: Axis) {
    return axis === 'ticket'
      ? Math.max(MIN.ticket, Math.min(MAX.ticket, width - geometry.book - 400))
      : axis === 'book'
        ? Math.max(MIN.book, Math.min(MAX.book, width - geometry.ticket - 400))
        : MAX[axis];
  }
  function minimum(axis: Axis) {
    return axis === 'chart' && (layout === 'grid' || layout === 'stacked') ? 800 : MIN[axis];
  }
  function resize(axis: Axis, value: number) {
    setGeometry((current) => ({ ...current, [axis]: Math.round(Math.max(minimum(axis), Math.min(maximum(axis), value))) }));
  }
  function handle(axis: Axis) {
    const horizontal = axis === 'chart' || axis === 'management';
    return (
      <div
        className={`trade-resize trade-resize--${axis}`}
        role="separator"
        tabIndex={0}
        aria-label={LABELS[axis]}
        aria-orientation={horizontal ? 'horizontal' : 'vertical'}
        aria-valuemin={minimum(axis)}
        aria-valuemax={maximum(axis)}
        aria-valuenow={geometry[axis]}
        aria-valuetext={`${geometry[axis]} pixels`}
        onKeyDown={(event) => {
          const increase = horizontal ? 'ArrowDown' : 'ArrowLeft',
            decrease = horizontal ? 'ArrowUp' : 'ArrowRight';
          if (![increase, decrease, 'Home', 'End'].includes(event.key)) return;
          event.preventDefault();
          resize(
            axis,
            event.key === 'Home'
              ? minimum(axis)
              : event.key === 'End'
                ? maximum(axis)
                : geometry[axis] + (event.key === increase ? 1 : -1) * (event.shiftKey ? 80 : 20),
          );
        }}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = { axis, origin: horizontal ? event.clientY : event.clientX, value: geometry[axis] };
        }}
        onPointerMove={(event) => {
          if (drag.current?.axis !== axis) return;
          resize(axis, drag.current.value + ((horizontal ? event.clientY : event.clientX) - drag.current.origin) * (horizontal ? 1 : -1));
        }}
        onPointerUp={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
          drag.current = null;
        }}
        onPointerCancel={() => {
          drag.current = null;
        }}
        onLostPointerCapture={() => {
          drag.current = null;
        }}
      />
    );
  }
  const style = {
    '--trade-ticket-width': `${geometry.ticket}px`,
    '--trade-book-width': `${geometry.book}px`,
    '--trade-chart-height': `${geometry.chart}px`,
    '--trade-management-height': `${geometry.management}px`,
  } as CSSProperties;
  return (
    <>
      <div className="trade-workspace-controls">
        <details>
          <summary>Workspace</summary>
          <div className="trade-menu">
            <strong>Chart arrangement</strong>
            <small>The primary chart follows the selected market and ticket. Linked charts are analysis only.</small>
            {(
              [
                ['single', 'Focused chart'],
                ['dual', 'Two timeframes'],
                ['grid', 'Four timeframes'],
                ['stacked', 'Stacked comparison'],
              ] as const
            ).map(([value, label]) => (
              <button key={value} aria-pressed={layout === value} disabled={!market} onClick={() => template(value)}>
                {label}
              </button>
            ))}
            <label className="trade-workspace-name">
              Workspace name
              <input
                aria-label="Workspace name"
                value={name}
                maxLength={64}
                disabled={!market}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <button disabled={!market || !name.trim()} onClick={save}>
              Save workspace on device
            </button>
            {saved.map((value) => (
              <div className="trade-saved-workspace" key={value.name}>
                <button disabled={!market} aria-label={`Restore workspace ${value.name}`} onClick={() => restore(value)}>
                  {value.name} · {value.paper ? 'simulated' : 'live'}
                </button>
                <button aria-label={`Delete workspace ${value.name}`} onClick={() => remove(value)}>
                  ×
                </button>
              </div>
            ))}
            <button
              onClick={() => {
                setGeometry(R5_GEOMETRY);
                setLayout('single');
                setExtras([]);
                setPrimary(DEFAULT_VIEW);
                setViewRevision((current) => current + 1);
                setNotice('Default R5 panel sizes restored on this device.');
              }}
            >
              Restore default workspace
            </button>
            <small>
              Drag a divider or use its arrow keys; Shift makes a larger step. Home and End set its bounds. Panel geometry stays on this
              device.
            </small>
          </div>
        </details>
        {notice && <span role="status">{notice}</span>}
      </div>
      <div className="trade-workspace trade-workspace--resizable" ref={host} style={style}>
        <div className="trade-analysis">
          <div className="trade-analysis-top">
            <div className={`trade-chart-group trade-chart-grid trade-chart-grid--${layout}`}>
              {typeof chart === 'function' ? chart(primary, viewRevision, onViewChange) : chart}
              {market &&
                api &&
                extras.map((view, index) => {
                  const selected =
                    view.symbol === null
                      ? market
                      : markets.find((candidate) => candidate.symbol === view.symbol && candidate.paper === market.paper);
                  const label = `Linked chart ${index + 1}`;
                  function change(patch: Partial<Extra>) {
                    setExtras((current) => current.map((row, slot) => (slot === index ? { ...row, ...patch } : row)));
                  }
                  return (
                    <section className="trade-extra-chart" aria-label={`${label} · ${selected?.symbol ?? 'unavailable'}`} key={index}>
                      <div className="trade-extra-toolbar">
                        <strong>{label}</strong>
                        <label>
                          Market
                          <select
                            aria-label={`${label} market`}
                            value={view.symbol ?? ''}
                            onChange={(event) => change({ symbol: event.target.value || null })}
                          >
                            <option value="">Follow primary market</option>
                            {view.symbol && !selected && (
                              <option value={view.symbol} disabled>
                                {view.symbol} · unavailable
                              </option>
                            )}
                            {markets
                              .filter((candidate) => candidate.paper === market.paper)
                              .map((candidate) => (
                                <option key={candidate.id} value={candidate.symbol}>
                                  {candidate.symbol}
                                </option>
                              ))}
                          </select>
                        </label>
                        <label>
                          Interval
                          <select
                            aria-label={`${label} interval`}
                            value={view.interval}
                            onChange={(event) => change({ interval: event.target.value })}
                          >
                            {TIMEFRAMES.map((interval) => (
                              <option key={interval}>{interval}</option>
                            ))}
                          </select>
                        </label>
                        <label>
                          Type
                          <select
                            aria-label={`${label} type`}
                            value={view.type}
                            onChange={(event) => change({ type: event.target.value as Extra['type'] })}
                          >
                            {['Candles', 'Line', 'Heikin Ashi'].map((type) => (
                              <option key={type}>{type}</option>
                            ))}
                          </select>
                        </label>
                      </div>
                      {selected ? (
                        <SecondaryChart
                          key={`${selected.id}:${view.interval}`}
                          api={api}
                          symbol={selected.symbol}
                          interval={view.interval}
                          type={view.type}
                          workspace
                        />
                      ) : (
                        <EmptyState title="Linked market unavailable">
                          This saved market is not published in the current live or simulated catalog. Choose an actual market; no
                          replacement has been inferred.
                        </EmptyState>
                      )}
                    </section>
                  );
                })}
            </div>
            {book}
            {handle('book')}
            {handle('chart')}
          </div>
          <div className="trade-management">
            {management}
            {handle('management')}
          </div>
        </div>
        {ticket}
        {handle('ticket')}
      </div>
    </>
  );
}

/** No market identity means no chart axes, book rows, private reads or order dispatch. */
export function UnavailableDesk({
  resource,
  retry,
  title,
  simulation,
  management,
}: {
  resource: Resource<Listing[]>;
  retry: () => void;
  title: string;
  simulation: boolean;
  management?: ReactNode;
}) {
  return (
    <DeskFrame
      chart={
        <section className="trade-chart trade-chart--absent" aria-label="Market chart unavailable">
          <div className="trade-chart-toolbar">
            <strong>Chart</strong>
            <span className="muted">Published market required</span>
          </div>
          <div className="trade-absent-content">
            {resource.status === 'loading' ? (
              <Loading label="Loading published markets" />
            ) : resource.status === 'failed' ? (
              <Failure result={resource.failure} />
            ) : (
              <EmptyState title={title}>
                {simulation
                  ? 'Only explicitly published simulated markets can open this workspace. Live markets cannot supply its data or funds.'
                  : 'Choose a published spot market to load its actual history, book and trading rules.'}
              </EmptyState>
            )}
            {resource.status !== 'loading' && (
              <Button variant="secondary" onClick={retry}>
                Retry published markets
              </Button>
            )}
          </div>
        </section>
      }
      book={
        <section className="trade-book trade-book--absent" aria-label="Order book unavailable">
          <div className="trade-chart-toolbar">
            <strong>Order book</strong>
          </div>
          <div className="trade-absent-content">
            <h3>Liquidity unavailable</h3>
            <p>The book and recent trades need a published market identity. Prices, quantities and spread remain absent.</p>
          </div>
        </section>
      }
      management={
        management ?? (
          <section className="trade-blotter" aria-label="Order management unavailable">
            <div className="trade-chart-toolbar">
              <strong>Open orders · History · Fills</strong>
            </div>
            <div className="trade-absent-content">
              <h3>Order management unavailable</h3>
              <p>Select a published market to inspect its orders and fills. Order and fund status cannot be verified yet.</p>
            </div>
          </section>
        )
      }
      ticket={
        <aside className="trade-ticket-column trade-ticket-column--absent" aria-label="Order ticket unavailable">
          <div className="trade-ticket-body">
            <h2>{simulation ? 'Simulated order' : 'Spot order'}</h2>
            <p className="muted">A published market is required to verify trading rules and review your order.</p>
            <Field label="Order amount" value="" disabled placeholder="Market units unavailable" />
            <Field label="Limit price" value="" disabled placeholder="Quote unit unavailable" />
            <Button disabled>Review order</Button>
          </div>
          <section className="trade-funds">
            <h3>{simulation ? 'Simulation · no live funds' : 'Funds unavailable'}</h3>
            <p>
              {simulation
                ? 'This workspace does not read live balances. A published paper market is required before a simulated order can be reviewed.'
                : 'Available account funds cannot be verified until published market information is available.'}
            </p>
            <a className="text-link" href="/money">
              Manage in Money ↗
            </a>
          </section>
        </aside>
      }
    />
  );
}
