// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Candle, Loadable } from '../../../data/types';
import type { DeskMarket } from '../../trade/desk/market';
import type { ChartHost } from '../chart-host';
import type { Print } from './math';

// TEST bars and TEST trades, not published figures.
const world = vi.hoisted(() => ({
  tape: { status: 'empty' } as unknown,
  higher: { status: 'empty' } as unknown,
}));
vi.mock('../../../features/session/session', () => ({ useSession: () => ({ userId: 'u1', api: {} }) }));
vi.mock('./data', () => ({ useTape: () => world.tape }));
vi.mock('../../trade/chart/candles', async (original) => ({
  ...(await original<typeof import('../../trade/chart/candles')>()),
  useChartCandles: () => world.higher,
}));
import { StudiesBar, type StudyGroupLink } from './StudiesBar';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface FakeSeries {
  def: unknown;
  opts: Record<string, unknown>;
  pane: number;
  data: Array<{ time: number; value?: number }>;
  removed: boolean;
  setData(data: Array<{ time: number; value?: number }>): void;
  seriesType(): string;
  options(): Record<string, unknown>;
}

/** A chart host with the parts the studies use: it records what is added, and which pane it went to. */
function fakeHost(): { host: ChartHost; made: FakeSeries[]; move: (time: number | undefined) => void } {
  const made: FakeSeries[] = [];
  const crosshair: Array<(param: { time?: number }) => void> = [];
  const chart = {
    addSeries(def: unknown, opts: Record<string, unknown>, pane = 0) {
      const s: FakeSeries = {
        def,
        opts,
        pane,
        data: [],
        removed: false,
        setData(data) {
          this.data = data;
        },
        seriesType: () => (def === 'HistogramSeries' ? 'Histogram' : 'Line'),
        options: () => opts,
      };
      made.push(s);
      return s;
    },
    removeSeries(s: FakeSeries) {
      s.removed = true;
    },
    panes: () => [],
    removePane: () => undefined,
    subscribeCrosshairMove: (handler: (param: { time?: number }) => void) => crosshair.push(handler),
    unsubscribeCrosshairMove: (handler: (param: { time?: number }) => void) => crosshair.splice(crosshair.indexOf(handler), 1),
  };
  const host = {
    lib: { LineSeries: 'LineSeries', HistogramSeries: 'HistogramSeries' },
    chart,
    main: {},
    element: document.createElement('div'),
    tickSize: '0.01',
    symbol: 'BTC/USDT',
  } as unknown as ChartHost;
  return { host, made, move: (time) => crosshair.forEach((handler) => handler({ time })) };
}

const STEP = 900_000; // 15 minutes, in ms
/** TEST bars: closes cycle 100 to 109, highs one above, lows one below, volume 5 unless `volume` says otherwise. */
const bars = (n: number, volume = '5'): Candle[] =>
  Array.from({ length: n }, (_, i) => {
    const c = String(100 + (i % 10));
    return { t: i * STEP, o: c, h: String(101 + (i % 10)), l: String(99 + (i % 10)), c, v: volume, filled: false };
  });
const market: DeskMarket = {
  symbol: 'BTC/USDT',
  base: 'BTC',
  quote: 'USDT',
  tickSize: '0.01',
  lotSize: '0.001',
  minAmount: '0.001',
  minCost: '5',
  open: true,
  state: 'OPEN',
};
const ready = <T,>(data: T): Loadable<T> => ({ status: 'ready', data, asOf: 0 });

let host: HTMLDivElement;
let root: Root | null = null;
let fake: ReturnType<typeof fakeHost>;

async function render(
  props: {
    interval?: string;
    bars?: Candle[] | null;
    workbench?: string;
    percent?: boolean;
    replaying?: boolean;
    group?: StudyGroupLink;
  } = {},
) {
  root ??= createRoot(host);
  const mounted = root;
  await act(async () =>
    mounted.render(
      <StudiesBar
        host={fake.host}
        market={market}
        interval={(props.interval ?? '15m') as never}
        bars={props.bars === undefined ? bars(240) : props.bars}
        workbench={props.workbench}
        percent={props.percent}
        replaying={props.replaying}
        group={props.group}
      />,
    ),
  );
}

const click = (node: Element | null | undefined) => act(async () => node?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
const typeInto = (node: Element | null | undefined, value: string) =>
  act(async () => {
    const input = node as HTMLInputElement;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
const choose = (node: Element | null | undefined, value: string) =>
  act(async () => {
    const select = node as HTMLSelectElement;
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
const buttonNamed = (label: string, scope: ParentNode = document) =>
  [...scope.querySelectorAll('button')].find((node) => node.getAttribute('aria-label') === label || node.textContent?.trim() === label);
/** A field in a settings dialog, found by the words of its label. */
const field = (label: string) =>
  [...document.querySelectorAll('label.st-field')]
    .find((node) => node.querySelector('span')?.textContent === label)
    ?.querySelector('input, select') ?? null;
const legend = () => host.querySelector('[data-testid="study-legend"]')?.textContent ?? '';
const chips = () => [...host.querySelectorAll('.st-chip')].map((node) => node.textContent);
const store = (workbench = 'main') => JSON.parse(localStorage.getItem(`charts-studies:u1:${workbench}`) ?? 'null');

/** Adds a study by searching the dialog for its name and pressing its Add. */
async function addStudy(search: string, name: string) {
  await click(buttonNamed('Indicators', host));
  await typeInto(document.querySelector('input[type="search"]'), search);
  await click(buttonNamed(`Add ${name}`));
}

const EMPTY = JSON.stringify({ studies: [], remembered: {}, legendAlways: false });
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  localStorage.clear();
  // Most tests start from a workbench with no studies; the Volume default has its own tests below.
  localStorage.setItem('charts-studies:u1:main', EMPTY);
  localStorage.setItem('charts-studies:u1:w2', EMPTY);
  fake = fakeHost();
  world.tape = { status: 'empty' };
  world.higher = { status: 'empty' };
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
  document.body.innerHTML = '';
});

describe('a fresh workbench', () => {
  it('starts with Volume on, and removing it is kept', async () => {
    localStorage.clear();
    await render();
    expect(chips()).toEqual(['Volume']);
    expect(fake.made.filter((s) => !s.removed && s.pane === 1)).toHaveLength(1);
    await click(buttonNamed('Settings for Volume'));
    await click(buttonNamed('Remove study'));
    expect(chips()).toEqual([]);
    expect(store().studies).toEqual([]);
  });
});

describe('the indicator dialog', () => {
  it('finds RSI under Oscillators and Add puts it in a sub-pane', async () => {
    await render();
    await click(buttonNamed('Indicators', host));
    await typeInto(document.querySelector('input[type="search"]'), 'rsi');
    const group = document.querySelector('section[aria-label="Oscillators"]');
    expect(group?.textContent).toContain('Relative Strength Index');
    expect(document.querySelector('section[aria-label="Trend"]')).toBeNull();
    await click(buttonNamed('Add Relative Strength Index'));
    expect(chips()).toEqual(['RSI 14']);
    const drawn = fake.made.filter((s) => !s.removed);
    expect(drawn.length).toBeGreaterThan(0);
    expect(drawn.every((s) => s.pane === 1)).toBe(true);
    expect(store().studies[0]).toMatchObject({ kind: 'rsi', inputs: { period: '14' } });
  });

  it('says a search with no match in words', async () => {
    await render();
    await click(buttonNamed('Indicators', host));
    await typeInto(document.querySelector('input[type="search"]'), 'zzz');
    expect(document.body.textContent).toContain('No indicator matches zzz.');
  });
});

describe('settings', () => {
  it('a moving average with period 50 on highs draws those values in the colour chosen', async () => {
    await render();
    await addStudy('sma', 'Simple moving average');
    await click(buttonNamed('Settings for Simple moving average 20'));
    await choose(field('Source'), 'high');
    await typeInto(field('Period'), '50');
    await choose(field('Colour'), 'ma-2');
    await click(buttonNamed('Apply'));
    expect(store().studies[0]).toMatchObject({ inputs: { period: '50', source: 'high' }, color: 'ma-2' });
    expect(chips()).toEqual(['SMA 50']);
    const overlay = fake.made.find((s) => s.pane === 0 && !s.removed);
    // Highs are 101 to 110 cycling; the mean of the last 50 highs is the value at bar 49 onward, read from the data.
    const highs = bars(240).map((b) => Number(b.h));
    const expected = highs.slice(0, 50).reduce((a, b) => a + b, 0) / 50;
    expect(overlay?.data[49]?.value).toBeCloseTo(Number(expected.toFixed(2)), 10);
    expect(overlay?.data[48]?.value).toBeUndefined();
  });

  it('a blank period keeps Apply disabled and says so, and fills nothing in', async () => {
    await render();
    await addStudy('sma', 'Simple moving average');
    await click(buttonNamed('Settings for Simple moving average 20'));
    await typeInto(field('Period'), '');
    expect(document.body.textContent).toContain('Enter a period');
    expect((buttonNamed('Apply') as HTMLButtonElement).disabled).toBe(true);
    // The draft is not applied: the saved study keeps its default period, and the chart keeps the line it had.
    expect(store().studies[0].inputs.period).toBe('20');
  });

  it('a removed study comes back with the settings it was removed with', async () => {
    await render();
    await addStudy('sma', 'Simple moving average');
    await click(buttonNamed('Settings for Simple moving average 20'));
    await typeInto(field('Period'), '50');
    await click(buttonNamed('Apply'));
    await click(buttonNamed('Settings for Simple moving average 50'));
    await click(buttonNamed('Remove study'));
    expect(chips()).toEqual([]);
    await addStudy('sma', 'Simple moving average');
    expect(chips()).toEqual(['SMA 50']);
  });
});

describe('visibility per interval', () => {
  it('a study hidden on 1h shows on the other intervals, the setting is remembered, and the 1h legend says so', async () => {
    await render();
    await addStudy('sma', 'Simple moving average');
    await click(buttonNamed('Settings for Simple moving average 20'));
    await click(document.querySelector('input[aria-label="Shown on 1h"]'));
    await click(buttonNamed('Apply'));
    expect(store().studies[0].hiddenOn).toEqual(['1h']);
    await render({ interval: '1h' });
    expect(legend()).toContain('Hidden on this interval');
    expect(fake.made.filter((s) => !s.removed)).toHaveLength(0);
    await render({ interval: '15m' });
    expect(fake.made.filter((s) => !s.removed).length).toBeGreaterThan(0);
  });
});

describe('legend and data window', () => {
  it('with the legend always shown, the last bar’s values show without a pointer', async () => {
    await render();
    await addStudy('sma', 'Simple moving average');
    expect(legend()).not.toMatch(/\d\.\d\d/);
    await click(host.querySelector('.st-check input[type="checkbox"]'));
    const closes = bars(240)
      .slice(-20)
      .map((b) => Number(b.c));
    const sma20 = (closes.reduce((a, b) => a + b, 0) / 20).toFixed(2);
    const row = host.querySelector('[data-study="sma-1"]');
    expect(row?.textContent).toContain(sma20);
  });

  it('the data window reads every series at the bar under the pointer', async () => {
    await render();
    await addStudy('sma', 'Simple moving average');
    await click(host.querySelector('button.st-toggle'));
    expect(host.querySelector('[data-testid="data-window"]')?.textContent).toContain('Move the pointer over the chart');
    const target = bars(240)[100]!;
    await act(async () => fake.move(target.t / 1000));
    const windowText = host.querySelector('[data-testid="data-window"]')?.textContent ?? '';
    expect(windowText).toContain(target.c);
    expect(windowText).toContain(target.h);
    expect(windowText).toContain('SMA 20');
  });
});

describe('refusals say what is missing', () => {
  it('Ichimoku with 40 bars names the 52 bars it needs and draws no cloud', async () => {
    await render({ bars: bars(40) });
    await addStudy('ichimoku', 'Ichimoku Cloud');
    expect(legend()).toContain('Leading B: Needs 52 bars');
    expect(fake.made.filter((s) => !s.removed).map((s) => s.def)).toContain('LineSeries');
  });

  it('a market with no volume says so for the volume study', async () => {
    await render({ bars: bars(30, '0') });
    await addStudy('volume', 'Volume');
    expect(legend()).toContain('This market has no volume in the loaded bars.');
  });

  it('a market with no public trades says so for volume delta', async () => {
    world.tape = { status: 'empty' };
    await render();
    await addStudy('delta', 'Volume delta');
    expect(legend()).toContain('No public trades for this market.');
  });

  it('a volume profile reads the tape and marks its point of control', async () => {
    const prints: Print[] = [
      { t: 0, side: 'buy', amount: '2', price: '100' },
      { t: 1, side: 'sell', amount: '1', price: '101' },
      { t: 2, side: 'buy', amount: '4', price: '101' },
    ];
    world.tape = ready(prints);
    await render();
    await addStudy('profile', 'Volume profile');
    const poc = host.querySelector('tr[data-poc]');
    // Bin 23 holds the print at 101: buy 4 and sell 1. The busiest bin is the point of control.
    expect(poc?.textContent).toContain('4.000');
    expect(poc?.textContent).toContain('1.000');
    expect(legend()).toContain('Point of control');
  });

  it('open interest is refused by name and nothing is drawn for it', async () => {
    await render();
    await addStudy('open interest', 'Open interest');
    expect(legend()).toContain('Open interest is not published for BTC/USDT.');
    expect(fake.made.filter((s) => !s.removed)).toHaveLength(0);
  });

  it('a higher-timeframe study on the chart’s own interval refuses; a coarser one reads the bars', async () => {
    await render();
    await addStudy('higher', 'Higher-timeframe moving average');
    await click(buttonNamed('Settings for Higher-timeframe moving average 20'));
    await choose(field('Interval'), '15m');
    await click(buttonNamed('Apply'));
    expect(legend()).toContain('Choose an interval coarser than this chart.');

    const htfBars = bars(60).map((b, i) => ({ ...b, t: i * 3_600_000 }));
    world.higher = ready(htfBars);
    await click(buttonNamed('Settings for Higher-timeframe moving average 20'));
    await choose(field('Interval'), '1h');
    await click(buttonNamed('Apply'));
    expect(legend()).toContain('Higher bars read: 60');
  });

  it('studies belong to one workbench: another workbench keeps its own list', async () => {
    await render({ workbench: 'w2' });
    await addStudy('sma', 'Simple moving average');
    expect(store('w2').studies.map((s: { kind: string }) => s.kind)).toEqual(['sma']);
    expect(store('main').studies).toEqual([]);
  });
});

describe('a sync group command reaches every chart once', () => {
  const link = (over: Partial<StudyGroupLink>): StudyGroupLink => ({
    size: 2,
    command: { nonce: 3, kind: 'sma' },
    appliedNonce: () => 0,
    onApplied: vi.fn(),
    onApplyToGroup: vi.fn(),
    ...over,
  });

  it('a chart whose studies bar mounts after the command fired still applies it, once', async () => {
    const group = link({ appliedNonce: () => 2 });
    await render({ group });
    expect(chips()).toEqual(['SMA 20']);
    expect(group.onApplied).toHaveBeenCalledWith(3);
    expect(store().studies.map((s: { kind: string }) => s.kind)).toEqual(['sma']);
  });

  it('a chart that already applied the command does not add it again', async () => {
    const group = link({ appliedNonce: () => 3 });
    await render({ group });
    expect(chips()).toEqual([]);
    expect(group.onApplied).not.toHaveBeenCalled();
  });
});

describe('the chart as drawn', () => {
  it('in percent mode the overlay studies are refused by name, and a study in its own pane still draws', async () => {
    await render({ percent: true });
    await addStudy('sma', 'Simple moving average');
    expect(legend()).toContain('Studies on price are off in percent mode. Switch the scale back to price.');
    expect(fake.made.filter((s) => !s.removed)).toHaveLength(0);
    await addStudy('rsi', 'Relative Strength Index');
    expect(fake.made.filter((s) => !s.removed && s.pane === 1).length).toBeGreaterThan(0);
  });

  it('a replay reads the trades before its last drawn bar closes, and the whole tape when it is not replaying', async () => {
    const STEP_MS = 900_000;
    const prints: Print[] = [
      { t: 50 * STEP_MS + 1000, side: 'buy', amount: '2', price: '100' },
      { t: 150 * STEP_MS, side: 'sell', amount: '1', price: '101' },
    ];
    world.tape = ready(prints);
    await render({ bars: bars(100), replaying: true });
    await addStudy('profile', 'Volume profile');
    expect(legend()).toContain('Public trades read: 1');
    await render({ bars: bars(100), replaying: false });
    expect(legend()).toContain('Public trades read: 2');
  });

  it('a new poll updates the drawn values in place and removes no pane, so a dragged pane keeps its height', async () => {
    await render();
    await addStudy('rsi', 'Relative Strength Index');
    const made = fake.made.length;
    await render({ bars: bars(241) });
    expect(fake.made).toHaveLength(made);
    expect(fake.made.some((s) => s.removed)).toBe(false);
    const rsi = fake.made.find((s) => s.pane === 1 && !s.removed);
    expect(rsi?.data).toHaveLength(241);
  });
});
