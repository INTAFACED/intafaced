// @vitest-environment happy-dom
import { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChartBinding, useRestart, useSeriesPriceLines, type ChartSession } from './chart-binding';
import { useRestartingClock } from './live-socket';
import { useDeviceStored } from './device-stored';
import { useFocusTrap } from './focus-trap';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
  localStorage.clear();
});

describe('useRestart', () => {
  it('changes only when a value changes', () => {
    const seen: number[] = [];
    function Probe({ a, b }: { a: number; b: object }) {
      seen.push(useRestart([a, b]));
      return null;
    }
    const same = {};
    act(() => root.render(<Probe a={1} b={same} />));
    act(() => root.render(<Probe a={1} b={same} />));
    act(() => root.render(<Probe a={2} b={same} />));
    act(() => root.render(<Probe a={2} b={{}} />));
    expect(seen).toEqual([1, 1, 2, 3]);
  });
});

describe('useChartBinding', () => {
  it('builds once the bundle arrives, tears down and removes on a restart and when the room goes', async () => {
    const log: string[] = [];
    function Probe({ restart }: { restart: number }) {
      const element = useRef<HTMLDivElement>(null);
      useChartBinding<string, { remove(): void }>(
        element,
        {
          load: () => Promise.resolve(),
          engine: () => 'engine',
          ready: () => true,
          admit: () => true,
          build: (engine, _element, session: ChartSession<{ remove(): void }>) => {
            log.push(`build ${restart} ${engine}`);
            session.chart = { remove: () => log.push(`remove ${restart}`) };
          },
          teardown: (chart) => log.push(`teardown ${restart} ${chart ? 'chart' : 'none'}`),
          restyle: () => log.push(`restyle ${restart}`),
        },
        restart,
        0,
      );
      return <div ref={element} />;
    }
    await act(async () => root.render(<Probe restart={1} />));
    await act(async () => root.render(<Probe restart={2} />));
    act(() => root.unmount());
    root = createRoot(host);
    expect(log).toEqual(['restyle 1', 'build 1 engine', 'teardown 1 chart', 'remove 1', 'build 2 engine', 'teardown 2 chart', 'remove 2']);
  });

  it('does not build when not ready or when the room no longer admits it', async () => {
    const built: string[] = [];
    function Probe({ ready, admit }: { ready: boolean; admit: boolean }) {
      const element = useRef<HTMLDivElement>(null);
      useChartBinding<string, { remove(): void }>(
        element,
        {
          load: () => Promise.resolve(),
          engine: () => 'engine',
          ready: () => ready,
          admit: () => admit,
          build: () => built.push('built'),
          teardown: () => {},
          restyle: () => {},
        },
        ready ? 1 : 0,
        0,
      );
      return <div ref={element} />;
    }
    await act(async () => root.render(<Probe ready={false} admit />));
    await act(async () => root.render(<Probe ready admit={false} />));
    expect(built).toEqual([]);
  });
});

describe('useSeriesPriceLines', () => {
  it('removes the held lines and draws again on a restart, and does nothing with no series', () => {
    const created: unknown[] = [];
    const removed: unknown[] = [];
    let id = 0;
    const series = {
      createPriceLine: (options: Record<string, unknown>) => {
        const line = { id: ++id, ...options };
        created.push(line);
        return line;
      },
      removePriceLine: (line: unknown) => removed.push(line),
    };
    function Probe({ price, withSeries }: { price: number; withSeries: boolean }) {
      const target = useRef(withSeries ? series : null);
      target.current = withSeries ? series : null;
      const held = useRef<unknown[]>([]);
      useSeriesPriceLines(target, held, () => [{ price }], useRestart([price, withSeries]));
      return null;
    }
    act(() => root.render(<Probe price={1} withSeries={false} />));
    expect(created).toEqual([]);
    act(() => root.render(<Probe price={1} withSeries />));
    act(() => root.render(<Probe price={2} withSeries />));
    expect(created).toEqual([
      { id: 1, price: 1 },
      { id: 2, price: 2 },
    ]);
    expect(removed).toEqual([{ id: 1, price: 1 }]);
  });
});

describe('useRestartingClock', () => {
  it('starts, ticks, and starts again with the handlers of the render that restarted it', () => {
    vi.useFakeTimers();
    const log: string[] = [];
    function Probe({ label, restart }: { label: string; restart: number }) {
      useRestartingClock({ start: () => log.push(`start ${label}`), tick: () => log.push(`tick ${label}`) }, 1000, restart);
      return null;
    }
    act(() => root.render(<Probe label="a" restart={1} />));
    act(() => root.render(<Probe label="b" restart={1} />));
    act(() => vi.advanceTimersByTime(1000));
    act(() => root.render(<Probe label="c" restart={2} />));
    act(() => vi.advanceTimersByTime(1000));
    expect(log).toEqual(['start a', 'tick a', 'start c', 'tick c']);
  });
});

describe('useDeviceStored', () => {
  it('reads per key, writes back after every change, and reports a refused write', () => {
    localStorage.setItem('k:a', '["x"]');
    let set: ((update: string[] | ((current: string[]) => string[])) => void) | undefined;
    const shown: string[][] = [];
    const failures: string[] = [];
    function Probe({ id }: { id: string }) {
      const [value, setValue] = useDeviceStored<string[]>(
        `k:${id}`,
        () => JSON.parse(localStorage.getItem(`k:${id}`) ?? '[]') as string[],
        () => failures.push(id),
      );
      set = setValue;
      shown.push(value);
      return null;
    }
    act(() => root.render(<Probe id="a" />));
    act(() => set!((current) => [...current, 'y']));
    expect(localStorage.getItem('k:a')).toBe('["x","y"]');
    act(() => root.render(<Probe id="b" />));
    expect(shown.at(-1)).toEqual([]);
    expect(localStorage.getItem('k:b')).toBe('[]');
    const write = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new Error('full');
    });
    act(() => set!(['z']));
    write.mockRestore();
    expect(failures).toEqual(['b']);
    expect(shown.at(-1)).toEqual(['z']);
  });
});

describe('useFocusTrap', () => {
  it('makes the rest inert, focuses the start element, closes on Escape and puts everything back', () => {
    const outside = document.createElement('button');
    document.body.prepend(outside);
    outside.focus();
    const escaped: string[] = [];
    function Probe({ active }: { active: boolean }) {
      const pane = useRef<HTMLElement>(null);
      useFocusTrap(pane, active, () => escaped.push('escape'), '.start');
      return (
        <section ref={pane} tabIndex={-1}>
          <button className="start">start</button>
        </section>
      );
    }
    act(() => root.render(<Probe active />));
    expect(outside.inert).toBe(true);
    expect(document.activeElement?.className).toBe('start');
    act(() => {
      host.querySelector('section')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(escaped).toEqual(['escape']);
    act(() => root.render(<Probe active={false} />));
    expect(outside.inert).toBe(false);
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });
});
