import { describe, expect, it } from 'vitest';
import type { Loadable } from '../../../data/types';
import { clockOffsetMs, connectionOf, DELAYED_AFTER_MS } from './connection';

const ready = (asOf: number): Loadable<number> => ({ status: 'ready', data: 1, asOf });
const error: Loadable<number> = { status: 'error', retry: () => undefined };

describe('connectionOf', () => {
  const now = 1_000_000;
  it('is connecting until the first answers arrive', () => {
    expect(connectionOf([{ status: 'loading' }, { status: 'loading' }], now)).toBe('connecting');
    expect(connectionOf([{ status: 'empty' }], now)).toBe('connecting');
  });
  it('is live while every answer is recent', () => {
    expect(connectionOf([ready(now - 1_000), ready(now - 5_000)], now)).toBe('live');
    expect(connectionOf([ready(now - DELAYED_AFTER_MS)], now)).toBe('live');
  });
  it('is delayed when the oldest answer is older than the limit', () => {
    expect(connectionOf([ready(now - 500), ready(now - DELAYED_AFTER_MS - 1)], now)).toBe('delayed');
  });
  it('is reconnecting as soon as a read has failed with nothing good left', () => {
    expect(connectionOf([ready(now), error], now)).toBe('reconnecting');
    expect(connectionOf([error], now)).toBe('reconnecting');
  });
  it('treats a refusal from the service as an answer, not a lost connection', () => {
    expect(connectionOf([{ status: 'refused', code: 'market.closed' }, { status: 'loading' }], now)).toBe('live');
    expect(connectionOf([{ status: 'refused', code: 'x' }, ready(now - 100)], now)).toBe('live');
  });
});

describe('clockOffsetMs', () => {
  it('is the service clock minus ours at the moment the snapshot arrived', () => {
    expect(clockOffsetMs(1_000_500, 1_000_000)).toBe(500);
    expect(clockOffsetMs(999_000, 1_000_000)).toBe(-1_000);
  });
  it('is null when it cannot be trusted', () => {
    expect(clockOffsetMs(null, 1)).toBeNull();
    expect(clockOffsetMs(1, undefined)).toBeNull();
    expect(clockOffsetMs(Number.NaN, 1)).toBeNull();
    expect(clockOffsetMs(1_000_000 + 25 * 3_600_000, 1_000_000)).toBeNull();
  });
});
