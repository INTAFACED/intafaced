// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useBackoffPoll } from './backoff-poll';

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

const flush = () => act(async () => void (await Promise.resolve()));

describe('useBackoffPoll', () => {
  it('checks at once, then waits the growing back-off after each check ends, and stops on a new key or null', async () => {
    const seen: string[] = [];
    let misses = 0;
    const waits = [5_000, 10_000, 20_000];
    function Probe({ id }: { id: string | null }) {
      useBackoffPoll(
        id,
        async () => {
          seen.push(id ?? 'none');
          misses += 1;
        },
        () => waits[misses - 1] ?? 60_000,
      );
      return null;
    }
    act(() => root.render(<Probe id="a" />));
    await flush();
    expect(seen).toEqual(['a']);
    await act(async () => void vi.advanceTimersByTime(4_999));
    expect(seen).toEqual(['a']);
    await act(async () => void vi.advanceTimersByTime(1));
    await flush();
    expect(seen).toEqual(['a', 'a']);
    await act(async () => void vi.advanceTimersByTime(10_000));
    await flush();
    expect(seen).toEqual(['a', 'a', 'a']);
    misses = 0;
    act(() => root.render(<Probe id="b" />));
    await flush();
    expect(seen).toEqual(['a', 'a', 'a', 'b']);
    act(() => root.render(<Probe id={null} />));
    await act(async () => void vi.advanceTimersByTime(120_000));
    expect(seen).toEqual(['a', 'a', 'a', 'b']);
  });

  it('never schedules after a check that ends once the key has gone', async () => {
    let release: () => void = () => undefined;
    let runs = 0;
    function Probe({ id }: { id: string | null }) {
      useBackoffPoll(
        id,
        () => {
          runs += 1;
          return new Promise<void>((done) => (release = done));
        },
        () => 5_000,
      );
      return null;
    }
    act(() => root.render(<Probe id="a" />));
    expect(runs).toBe(1);
    act(() => root.render(<Probe id={null} />));
    await act(async () => release());
    await act(async () => void vi.advanceTimersByTime(60_000));
    expect(runs).toBe(1);
  });

  it('runs the latest check on a wake signal without moving the timer, and unsubscribes when stopped', async () => {
    const target = new EventTarget();
    const wake = (now: () => void) => {
      target.addEventListener('wake', now);
      return () => target.removeEventListener('wake', now);
    };
    const seen: string[] = [];
    function Probe({ id, label }: { id: string | null; label: string }) {
      useBackoffPoll(
        id,
        async () => void seen.push(label),
        () => 5_000,
        wake,
      );
      return null;
    }
    act(() => root.render(<Probe id="a" label="first" />));
    await flush();
    act(() => root.render(<Probe id="a" label="second" />));
    await act(async () => void target.dispatchEvent(new Event('wake')));
    expect(seen).toEqual(['first', 'second']);
    await act(async () => void vi.advanceTimersByTime(5_000));
    await flush();
    expect(seen).toEqual(['first', 'second', 'second']);
    act(() => root.render(<Probe id={null} label="third" />));
    await act(async () => void target.dispatchEvent(new Event('wake')));
    expect(seen).toEqual(['first', 'second', 'second']);
  });
});
