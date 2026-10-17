import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { algoServiceId, clearIfSame, type Marker } from './guard';

const KEY = 'trade-pending:u-1';
const storageWith = (marker: unknown) => {
  const map = new Map<string, string>();
  if (marker !== undefined) map.set(KEY, JSON.stringify(marker));
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    removeItem: (key: string) => void map.delete(key),
  };
};
const copy: Marker = { kind: 'copy', id: 'f-1', symbol: 'BTC-USDT', startedAt: 1000 };

describe('clearIfSame', () => {
  it('leaves a different marker in place (a spot order started in another tab)', () => {
    const storage = storageWith({ kind: 'place', id: 'o-2', symbol: 'BTC-USDT', startedAt: 2000 });
    expect(clearIfSame(storage, KEY, copy)).toBe(false);
    expect(storage.map.has(KEY)).toBe(true);
  });
  it('leaves a marker with the same id but a different startedAt', () => {
    const storage = storageWith({ ...copy, startedAt: 1001 });
    expect(clearIfSame(storage, KEY, copy)).toBe(false);
    expect(storage.map.has(KEY)).toBe(true);
  });
  it('leaves a marker with the same id but a different operation', () => {
    const storage = storageWith({ ...copy, operation: 'pause' });
    expect(clearIfSame(storage, KEY, copy)).toBe(false);
    expect(storage.map.has(KEY)).toBe(true);
  });
  it('removes the exact marker and says so', () => {
    const storage = storageWith(copy);
    expect(clearIfSame(storage, KEY, copy)).toBe(true);
    expect(storage.map.has(KEY)).toBe(false);
  });
  it('does nothing when nothing is stored or the value is not a marker', () => {
    expect(clearIfSame(storageWith(undefined), KEY, copy)).toBe(false);
    const junk = storageWith('not a marker');
    expect(clearIfSame(junk, KEY, copy)).toBe(false);
    expect(junk.map.has(KEY)).toBe(true);
  });
});

describe('algoServiceId', () => {
  const bot: Marker = { kind: 'algo', id: 'bot-x', symbol: 'BTC-USDT', startedAt: 1 };
  it('prefixes a create with the first 8 of the user id, as svc-trade stores it', () => {
    expect(algoServiceId('12345678-aaaa-bbbb-cccc-dddddddddddd', bot)).toBe('algo-12345678-bot-x');
    const engine = readFileSync(new URL('../../../../../../services/svc-trade/src/algo/twap-engine.ts', import.meta.url), 'utf8');
    expect(engine).toMatch(/algo-\$\{[^}]*slice\(0, 8\)/);
  });
  it('keeps the id unchanged for an operation on an existing bot', () => {
    expect(algoServiceId('12345678-aaaa', { ...bot, id: 'algo-12345678-bot-x', operation: 'pause' })).toBe('algo-12345678-bot-x');
  });
});

describe('the rooms settle only the marker they checked', () => {
  it('neither room calls guard.clear()', () => {
    for (const file of ['CopyRoom.tsx', 'BotsRoom.tsx']) {
      const text = readFileSync(new URL(file, import.meta.url), 'utf8');
      expect(text, file).not.toContain('guard.clear()');
      expect(text, file).toContain('guard.settle(pending)');
    }
  });
});
