// @vitest-environment happy-dom
import { act, useRef, type RefObject } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useEventListener, useInterval, useMounted, useNow, useResizeObserver, useTimeout } from './outside';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

describe('timers', () => {
  it('runs the latest interval callback and stops on null', () => {
    const seen: string[] = [];
    function Probe({ label, ms }: { label: string; ms: number | null }) {
      useInterval(() => seen.push(label), ms);
      return null;
    }
    act(() => root.render(<Probe label="a" ms={1000} />));
    act(() => vi.advanceTimersByTime(1000));
    act(() => root.render(<Probe label="b" ms={1000} />));
    act(() => vi.advanceTimersByTime(1000));
    act(() => root.render(<Probe label="c" ms={null} />));
    act(() => vi.advanceTimersByTime(5000));
    expect(seen).toEqual(['a', 'b']);
  });

  it('starts a timeout again when its restart value changes, and cancels it on null', () => {
    const fired: number[] = [];
    function Probe({ restart, ms }: { restart: number; ms: number | null }) {
      useTimeout(() => fired.push(restart), ms, restart);
      return null;
    }
    act(() => root.render(<Probe restart={1} ms={1000} />));
    act(() => vi.advanceTimersByTime(600));
    act(() => root.render(<Probe restart={2} ms={1000} />));
    act(() => vi.advanceTimersByTime(600));
    expect(fired).toEqual([]);
    act(() => vi.advanceTimersByTime(400));
    expect(fired).toEqual([2]);
    act(() => root.render(<Probe restart={3} ms={1000} />));
    act(() => root.render(<Probe restart={3} ms={null} />));
    act(() => vi.advanceTimersByTime(2000));
    expect(fired).toEqual([2]);
  });

  it('reads the clock again while ticking', () => {
    const reads: number[] = [];
    function Probe() {
      reads.push(useNow(1000));
      return null;
    }
    act(() => root.render(<Probe />));
    act(() => vi.advanceTimersByTime(1000));
    expect(reads.length).toBeGreaterThan(1);
    expect(reads.at(-1)! - reads[0]!).toBe(1000);
  });
});

describe('listeners and observers', () => {
  it('listens on a ref once mounted and lets go on unmount', () => {
    const keys: string[] = [];
    let box: RefObject<HTMLDivElement | null> | null = null;
    function Probe() {
      const ref = useRef<HTMLDivElement>(null);
      box = ref;
      useEventListener<KeyboardEvent>(ref, 'keydown', (event) => keys.push(event.key));
      return <div ref={ref} />;
    }
    act(() => root.render(<Probe />));
    const node = box!.current!;
    node.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
    act(() => root.render(<></>));
    node.dispatchEvent(new KeyboardEvent('keydown', { key: 'b' }));
    expect(keys).toEqual(['a']);
  });

  it('says the room is mounted only while it is', () => {
    let mounted: RefObject<boolean> | null = null;
    function Probe() {
      mounted = useMounted();
      return null;
    }
    act(() => root.render(<Probe />));
    expect(mounted!.current).toBe(true);
    act(() => root.render(<></>));
    expect(mounted!.current).toBe(false);
  });

  it('observes the element behind a ref and disconnects on unmount', () => {
    const observed: Element[] = [];
    let disconnected = 0;
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(readonly callback: () => void) {}
        observe(node: Element) {
          observed.push(node);
        }
        disconnect() {
          disconnected += 1;
        }
      },
    );
    function Probe() {
      const ref = useRef<HTMLDivElement>(null);
      useResizeObserver(ref, () => undefined);
      return <div ref={ref} />;
    }
    act(() => root.render(<Probe />));
    expect(observed).toHaveLength(1);
    act(() => root.render(<></>));
    expect(disconnected).toBe(1);
    vi.unstubAllGlobals();
  });
});
