import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { algoServiceId, clearIfSame, type Marker } from './guard';

/**
 * svc-trade's TWAP engine, imported at run time. Its path is a URL rather than a static specifier only so this app's
 * type program does not pull a services/ file in; the value is the module's real export.
 */
type Engine = { prepare(userId: string, input: Record<string, unknown>, lotSize: bigint): { parent: { id: string } } };
const ENGINE_URL = new URL('../../../../../../services/svc-trade/src/algo/twap-engine.ts', import.meta.url).href;
const { TwapEngine } = (await import(ENGINE_URL)) as { TwapEngine: new (ports: Record<string, unknown>) => Engine };
/** Amounts in the ledger's 18-decimal units: 0.010 and 0.001. */
const QTY = 10n ** 16n;
const LOT = 10n ** 15n;

/** The id the engine gives a plain TWAP create (`prepare` validates and builds the parent; it stores and emits nothing). */
function mintedAlgoId(userId: string, clientAlgoId: string): string {
  const at = new Date(1_700_000_000_000);
  const engine = new TwapEngine({
    now: () => at,
    randomId: () => 'unused',
    placeChild: async () => ({ orderId: 'o' }),
    cancelChild: async () => {},
    bestOpposingPrice: async () => 50n,
    markFor: async (marketId: string) => ({ marketId, price: 50n, asOf: at, quality: 'mid' }),
  });
  const input = {
    marketId: '11111111-1111-1111-1111-111111111111',
    symbol: 'BTC/USDT',
    side: 'buy',
    totalQty: QTY,
    durationMs: 10_000,
    sliceIntervalMs: 2_000,
    limitPrice: null,
    subAccountId: null,
    clientAlgoId,
  };
  return engine.prepare(userId, input, LOT).parent.id;
}

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
    // The id svc-trade's engine mints for the same create is the id this screen looks the bot up by.
    for (const userId of ['12345678-aaaa-bbbb-cccc-dddddddddddd', '9f8e7d6c-1111-4222-8333-444455556666']) {
      const minted = mintedAlgoId(userId, 'bot-x');
      expect(algoServiceId(userId, bot), userId).toBe(minted);
      expect(algoServiceId(userId, { ...bot, operation: 'pause', id: minted }), userId).toBe(minted);
    }
    // Another user's create is never taken for this one.
    expect(algoServiceId('9f8e7d6c-1111-4222-8333-444455556666', bot)).not.toBe(
      mintedAlgoId('12345678-aaaa-bbbb-cccc-dddddddddddd', 'bot-x'),
    );
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
