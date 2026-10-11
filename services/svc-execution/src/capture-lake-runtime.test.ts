import { parseAmount } from '@intafaced/ledger-client';
import { VenueUnavailableError, type VenueBookSnapshot } from '@intafaced/venue-contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCaptureLakeRuntime } from './capture-lake-runtime.js';
import type { OmsSnapshotFn } from './oms-market-snapshot.js';

const REFUSED_DRAIN = {
  ingested: [],
  persistence: { ok: false as const, reason: 'no_tsdb' as const },
};

/** Node's signed 32-bit timer ceiling. One past this becomes a 1ms loop. */
const MAX_DRAIN_INTERVAL_MS = 2_147_483_647;

const BOOK: VenueBookSnapshot = {
  venueId: 'binance-spot',
  symbol: 'BTC/USDT',
  sequence: 1,
  sequenced: true,
  observedAt: new Date('2026-08-24T00:00:00.000Z'),
  bids: [[parseAmount('50000'), parseAmount('10')]],
  asks: [[parseAmount('50001'), parseAmount('10')]],
};

describe('createCaptureLakeRuntime', () => {
  it('records books on snapshot and drains with no_tsdb when owner env unset', async () => {
    const runtime = createCaptureLakeRuntime({});
    const snapshot: OmsSnapshotFn = async () => BOOK;
    const wrapped = runtime.wrapSnapshotMap({ 'binance-spot': snapshot });
    await expect(wrapped['binance-spot']!('BTC/USDT')).resolves.toEqual(BOOK);
    const result = await runtime.drain();
    expect(result.persistence).toEqual({ ok: false, reason: 'no_tsdb' });
  });

  it('returns the fetched book when recordBook throws and records a capture hole', async () => {
    const runtime = createCaptureLakeRuntime({});
    const snapshot: OmsSnapshotFn = async () => BOOK;
    const wrapped = runtime.wrapSnapshotMap({ 'binance-spot': snapshot });
    vi.spyOn(runtime.lake, 'recordBook').mockImplementation(() => {
      throw new Error('capture write failed');
    });

    await expect(wrapped['binance-spot']!('BTC/USDT')).resolves.toBe(BOOK);

    expect(runtime.lake.records().filter((record) => record.kind === 'book')).toEqual([]);
    expect(runtime.lake.holes()).toEqual([
      expect.objectContaining({
        kind: 'hole',
        venueId: 'binance-spot',
        symbol: 'BTC/USDT',
        reason: 'capture_failed',
        detail: 'capture write failed',
      }),
    ]);
  });

  it('records holes when snapshot throws VenueUnavailableError', async () => {
    const runtime = createCaptureLakeRuntime({});
    const snapshot: OmsSnapshotFn = async () => {
      throw new VenueUnavailableError('binance-spot', 'no_depth', 'dust book');
    };
    const wrapped = runtime.wrapSnapshotMap({ 'binance-spot': snapshot });
    await expect(wrapped['binance-spot']!('BTC/USDT')).rejects.toMatchObject({ reason: 'no_depth' });
    expect(runtime.lake.records().filter((record) => record.kind === 'book')).toEqual([]);
    expect(runtime.lake.holes()).toEqual([
      expect.objectContaining({
        kind: 'hole',
        venueId: 'binance-spot',
        symbol: 'BTC/USDT',
        reason: 'no_depth',
        detail: 'dust book',
      }),
    ]);
    const result = await runtime.drain();
    expect(result.persistence).toEqual({ ok: false, reason: 'no_tsdb' });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('does not pass an interval above 2147483647 to setInterval', async () => {
    vi.useFakeTimers();
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const drain = vi.fn(async () => REFUSED_DRAIN);
    const runtime = createCaptureLakeRuntime({ CONNECT_DATA_LAKE_DRAIN_INTERVAL_MS: String(MAX_DRAIN_INTERVAL_MS + 1) }, drain);

    runtime.start();

    expect(setIntervalSpy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(drain).not.toHaveBeenCalled();
    await runtime.stop();
    expect(drain).toHaveBeenCalledTimes(1);
  });

  it.each(['', '   ', 'nope', '0', '-15'])('does not start a drain timer when the interval is %j', async (raw) => {
    vi.useFakeTimers();
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const drain = vi.fn(async () => REFUSED_DRAIN);
    const runtime = createCaptureLakeRuntime({ CONNECT_DATA_LAKE_DRAIN_INTERVAL_MS: raw }, drain);

    runtime.start();

    expect(setIntervalSpy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(drain).not.toHaveBeenCalled();
  });

  it('does not start a drain timer when the interval is omitted', async () => {
    vi.useFakeTimers();
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const drain = vi.fn(async () => REFUSED_DRAIN);
    const runtime = createCaptureLakeRuntime({}, drain);

    runtime.start();

    expect(setIntervalSpy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(drain).not.toHaveBeenCalled();
  });

  it('schedules a drain on a finite positive interval at or below 2147483647', async () => {
    vi.useFakeTimers();
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const drain = vi.fn(async () => REFUSED_DRAIN);
    const runtime = createCaptureLakeRuntime({ CONNECT_DATA_LAKE_DRAIN_INTERVAL_MS: '1000' }, drain);

    runtime.start();

    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 1000);
    expect(drain).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(999);
    expect(drain).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(drain).toHaveBeenCalledTimes(1);

    await runtime.stop();
  });

  it('schedules a drain when the interval is exactly 2147483647', async () => {
    vi.useFakeTimers();
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const drain = vi.fn(async () => REFUSED_DRAIN);
    const runtime = createCaptureLakeRuntime({ CONNECT_DATA_LAKE_DRAIN_INTERVAL_MS: String(MAX_DRAIN_INTERVAL_MS) }, drain);

    runtime.start();

    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), MAX_DRAIN_INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(MAX_DRAIN_INTERVAL_MS - 1);
    expect(drain).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(drain).toHaveBeenCalledTimes(1);
    await runtime.stop();
  });

  it('catches a rejected interval drain so it is not an unhandled rejection', async () => {
    vi.useFakeTimers();
    const unhandled: unknown[] = [];
    const onUnhandled = (err: unknown) => {
      unhandled.push(err);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const drain = vi.fn(async () => {
        if (drain.mock.calls.length <= 2) throw new Error('drain failed');
        return REFUSED_DRAIN;
      });
      const runtime = createCaptureLakeRuntime({ CONNECT_DATA_LAKE_DRAIN_INTERVAL_MS: '1000' }, drain);
      runtime.start();
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(1000);
      await new Promise((resolve) => process.nextTick(resolve));
      expect(drain).toHaveBeenCalledTimes(2);
      expect(unhandled).toEqual([]);
      await runtime.stop();
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('does not treat a refused persistence result as a successful drain', async () => {
    vi.useFakeTimers();
    const unhandled: unknown[] = [];
    const onUnhandled = (err: unknown) => {
      unhandled.push(err);
    };
    process.on('unhandledRejection', onUnhandled);
    let sawRefusal = false;
    try {
      const drain = vi.fn(async () => ({
        ingested: [],
        persistence: {
          reason: 'no_tsdb' as const,
          get ok(): false {
            sawRefusal = true;
            return false;
          },
        },
      }));
      const runtime = createCaptureLakeRuntime({ CONNECT_DATA_LAKE_DRAIN_INTERVAL_MS: '1000' }, drain);
      runtime.start();
      await vi.advanceTimersByTimeAsync(1000);
      expect(drain).toHaveBeenCalledTimes(1);
      expect(sawRefusal).toBe(true);
      expect(unhandled).toEqual([]);
      await vi.advanceTimersByTimeAsync(1000);
      expect(drain).toHaveBeenCalledTimes(2);
      await runtime.stop();
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('does not start another drain while one is in flight', async () => {
    vi.useFakeTimers();
    let release: (value: typeof REFUSED_DRAIN) => void = () => undefined;
    const drain = vi.fn(
      () =>
        new Promise<typeof REFUSED_DRAIN>((resolve) => {
          if (drain.mock.calls.length === 1) {
            release = resolve;
            return;
          }
          resolve(REFUSED_DRAIN);
        }),
    );
    const runtime = createCaptureLakeRuntime({ CONNECT_DATA_LAKE_DRAIN_INTERVAL_MS: '1000' }, drain);
    runtime.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(drain).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(drain).toHaveBeenCalledTimes(1);
    release(REFUSED_DRAIN);
    await vi.advanceTimersByTimeAsync(1000);
    expect(drain).toHaveBeenCalledTimes(2);
    await runtime.stop();
  });

  it('stop waits for an in-flight drain and then drains once more', async () => {
    vi.useFakeTimers();
    const pending: Array<(value: typeof REFUSED_DRAIN) => void> = [];
    const drain = vi.fn(
      () =>
        new Promise<typeof REFUSED_DRAIN>((resolve) => {
          pending.push(resolve);
        }),
    );
    const runtime = createCaptureLakeRuntime({ CONNECT_DATA_LAKE_DRAIN_INTERVAL_MS: '1000' }, drain);
    runtime.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(pending).toHaveLength(1);

    let stopped = false;
    const stopping = runtime.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    expect(pending).toHaveLength(1);

    pending[0]!(REFUSED_DRAIN);
    await vi.advanceTimersByTimeAsync(0);
    expect(pending).toHaveLength(2);
    expect(stopped).toBe(false);

    pending[1]!(REFUSED_DRAIN);
    await stopping;
    expect(stopped).toBe(true);
    expect(drain).toHaveBeenCalledTimes(2);
  });
});
