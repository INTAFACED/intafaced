// @vitest-environment happy-dom
import { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useAttributeChanges, usePointerFollow, useSeriesPrimitive, useTouchAction } from './chart-drawing';
import { useSaveOnChange } from './device-save';
import { useCentredBar, useChartStage, useMainSeriesBars, type StageChart, type StageTimeScale } from './chart-stage';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;
let element: HTMLDivElement;

beforeEach(() => {
  container = document.createElement('div');
  element = document.createElement('div');
  document.body.append(container, element);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  element.remove();
});

const pointer = (type: string, target: EventTarget) => target.dispatchEvent(new Event(type, { bubbles: true }));

describe('usePointerFollow', () => {
  it('follows the window only between follow and unfollow, and stops with a fresh session on a new owner', () => {
    const seen: string[] = [];
    function Probe({ owner }: { owner: string | null }) {
      usePointerFollow<string, { presses: number }>(element, owner, {
        session: () => ({ presses: 0 }),
        onDown: (_e, g) => {
          g.session.presses += 1;
          seen.push(`down:${g.owner}:${g.session.presses}`);
          g.follow();
        },
        onMove: (_e, g) => seen.push(`move:${g.owner}`),
        onUp: (_e, g) => {
          seen.push(`up:${g.owner}`);
          g.unfollow();
        },
        onCancel: (_e, g) => seen.push(`cancel:${g.owner}`),
        onAnyUp: (_e, g) => seen.push(`anyup:${g.owner}`),
        onAnyCancel: (_e, g) => seen.push(`anycancel:${g.owner}`),
        onStop: (g) => seen.push(`stop:${g.owner}`),
      });
      return null;
    }
    act(() => root.render(<Probe owner="a" />));
    pointer('pointermove', window);
    pointer('pointerdown', element);
    pointer('pointermove', window);
    pointer('pointerup', window);
    pointer('pointermove', window);
    act(() => root.render(<Probe owner="b" />));
    pointer('pointerdown', element);
    act(() => root.render(<Probe owner={null} />));
    pointer('pointermove', window);
    pointer('pointercancel', window);
    expect(seen).toEqual(['down:a:1', 'move:a', 'anyup:a', 'up:a', 'stop:a', 'down:b:1', 'stop:b']);
  });
});

describe('useTouchAction and useAttributeChanges', () => {
  it('sets touch-action while asked and puts back what was there; reports marked attributes and stops', async () => {
    element.style.touchAction = 'pan-y';
    const changes: string[] = [];
    const MARKS = ['data-mark'] as const;
    function Probe({ value }: { value: string | null }) {
      useTouchAction(element, value);
      useAttributeChanges(
        element,
        MARKS,
        () => changes.push('change'),
        () => changes.push('stop'),
      );
      return null;
    }
    act(() => root.render(<Probe value="none" />));
    expect(element.style.touchAction).toBe('none');
    act(() => root.render(<Probe value={null} />));
    expect(element.style.touchAction).toBe('pan-y');
    element.setAttribute('data-other', '1');
    element.setAttribute('data-mark', '1');
    // A mutation record is delivered as a microtask.
    await act(async () => {
      await Promise.resolve();
    });
    act(() => root.unmount());
    root = createRoot(container);
    expect(changes).toEqual(['change', 'stop']);
  });
});

describe('useSeriesPrimitive', () => {
  it('binds and attaches to each new series, detaches the old one, and paints on a new scene only', () => {
    const log: string[] = [];
    const series = (name: string) => ({
      attachPrimitive: () => log.push(`attach:${name}`),
      detachPrimitive: () => log.push(`detach:${name}`),
      name,
    });
    const s1 = series('s1');
    const s2 = series('s2');
    const primitive = { bind: (s: { name: string }) => log.push(`bind:${s.name}`) };
    function Probe({ s, scene }: { s: ReturnType<typeof series>; scene: object }) {
      useSeriesPrimitive<ReturnType<typeof series>>(s, element, primitive, {
        scene,
        paint: () => log.push('paint'),
        onAttach: (el) => (el.dataset.attached = 'yes'),
        onDetach: (el) => delete el.dataset.attached,
      });
      return null;
    }
    const sceneA = {};
    act(() => root.render(<Probe s={s1} scene={sceneA} />));
    act(() => root.render(<Probe s={s1} scene={sceneA} />));
    act(() => root.render(<Probe s={s2} scene={{}} />));
    expect(element.dataset.attached).toBe('yes');
    expect(log).toEqual(['bind:s1', 'attach:s1', 'paint', 'detach:s1', 'bind:s2', 'attach:s2', 'paint']);
  });
});

describe('useSaveOnChange', () => {
  it('skips the value just read, then writes each change and reports whether it held', () => {
    const writes: string[] = [];
    const saved: boolean[] = [];
    function Probe({ value, storeKey }: { value: string; storeKey: string }) {
      useSaveOnChange(
        value,
        storeKey,
        (k, v) => (writes.push(`${k}=${v}`), v !== 'bad'),
        (ok) => saved.push(ok),
      );
      return null;
    }
    act(() => root.render(<Probe value="a" storeKey="k" />));
    act(() => root.render(<Probe value="b" storeKey="k" />));
    act(() => root.render(<Probe value="bad" storeKey="k" />));
    expect(writes).toEqual(['k=b', 'k=bad']);
    expect(saved).toEqual([true, false]);
  });
});

describe('chart stage', () => {
  type FakeSeries = {
    name: string;
    setData(d: unknown[]): void;
    update(p: unknown): void;
    createPriceLine(): unknown;
    removePriceLine(): void;
  };
  function fakeChart(log: string[]) {
    let range: { from: number; to: number } | null = { from: 0, to: 40 };
    const scale: StageTimeScale = {
      fitContent: () => log.push('fit'),
      getVisibleLogicalRange: () => range,
      setVisibleLogicalRange: (next) => {
        range = next;
        log.push(`range:${next.from}-${next.to}`);
      },
      subscribeVisibleLogicalRangeChange: () => log.push('sub-range'),
      unsubscribeVisibleLogicalRangeChange: () => log.push('unsub-range'),
    };
    let n = 0;
    const chart: StageChart<FakeSeries> = {
      subscribeCrosshairMove: () => log.push('sub-move'),
      unsubscribeCrosshairMove: () => log.push('unsub-move'),
      timeScale: () => scale,
      addSeries: () => {
        n += 1;
        const name = `s${n}`;
        log.push(`add:${name}`);
        return {
          name,
          setData: (d) => log.push(`set:${name}:${d.length}`),
          update: () => log.push(`update:${name}`),
          createPriceLine: () => ({}),
          removePriceLine: () => undefined,
        };
      },
      removeSeries: (s) => log.push(`remove:${s.name}`),
      applyOptions: () => undefined,
      remove: () => log.push('remove-chart'),
    };
    return chart;
  }

  it('makes the chart once, a series per key with a host each, feeds bars, centres an asked bar, and reports null on leaving', async () => {
    const log: string[] = [];
    const hosts: Array<string | null> = [];
    const chart = fakeChart(log);
    function Probe({ kind, bars, focus }: { kind: string; bars: Array<{ t: number }>; focus: { index: number; nonce: number } | null }) {
      const el = useRef<HTMLDivElement>(element);
      const stage = useChartStage<string, StageChart<FakeSeries>, FakeSeries, string>(el, {
        load: () => Promise.resolve('lib'),
        create: () => chart,
        onCrosshairMove: () => undefined,
        onVisibleRangeChange: () => undefined,
        series: () => ({ definition: kind, options: {} }),
        seriesKey: kind,
        host: (_l, _c, s) => `host:${s.name}`,
        onHost: (h) => hosts.push(h),
      });
      useMainSeriesBars(stage.chart, stage.main, stage.host, bars, {
        key: kind,
        fitKey: 'market',
        plan: (before) => (before ? { kind: 'update', from: before.length - 1 } : { kind: 'reset' }),
        points: () => ({ points: bars.map((b) => b.t), report: null }),
      });
      useCentredBar(stage.chart, focus);
      return null;
    }
    const bars = [{ t: 1 }, { t: 2 }];
    act(() => root.render(<Probe kind="candles" bars={bars} focus={null} />));
    await act(async () => {
      await Promise.resolve();
    });
    act(() => root.render(<Probe kind="candles" bars={[...bars, { t: 3 }]} focus={null} />));
    act(() => root.render(<Probe kind="line" bars={[...bars, { t: 3 }]} focus={{ index: 50, nonce: 1 }} />));
    act(() => root.unmount());
    root = createRoot(container);
    expect(hosts).toEqual([null, 'host:s1', 'host:s2', null]);
    expect(log).toEqual([
      'sub-move',
      'sub-range',
      'add:s1',
      'set:s1:2',
      'fit',
      'update:s1',
      'update:s1',
      'remove:s1',
      'add:s2',
      // A new series in the same commit: its bars are set before the view is centred, and the new host updates them once more.
      'set:s2:3',
      'range:30-70',
      'update:s2',
      'unsub-move',
      'unsub-range',
      'remove-chart',
    ]);
  });
});
