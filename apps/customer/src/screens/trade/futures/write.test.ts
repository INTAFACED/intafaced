import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Position } from '@intafaced/exchange-contract/schemas';
import type { ApiResult } from '../../../shared/api';
import { pendingKey, readPending, type Pending } from '../buy/write-lock';
import type { FuturesApi, OpenInput } from './api';
import { checkPending, intentId, loadIntent, runIntent, type Intent } from './write';

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
  };
}

let storage: ReturnType<typeof memoryStorage>;
beforeEach(() => {
  storage = memoryStorage();
  vi.stubGlobal('localStorage', storage);
  vi.stubGlobal('window', new EventTarget());
  vi.stubGlobal('navigator', {
    locks: { request: async (_name: string, _options: unknown, callback: (lock: unknown) => Promise<void>) => callback({ name: 'lock' }) },
  });
});
afterEach(() => vi.unstubAllGlobals());

const USER = 'u1';
const intentKeyFor = (id: string) => `futures-intent:${USER}:${id}`;

function position(over: Partial<Position> = {}): Position {
  return {
    id: 'pos-1',
    symbol: 'BTC/USDT:USDT',
    timestamp: Date.now(),
    datetime: new Date().toISOString(),
    side: 'long',
    status: 'open',
    closingReason: null,
    contracts: '1',
    contractSize: null,
    entryPrice: '100',
    markPrice: '100',
    notional: '100',
    leverage: '5',
    collateral: '20',
    initialMargin: '20',
    maintenanceMargin: null,
    unrealizedPnl: null,
    realizedPnl: null,
    liquidationPrice: null,
    marginMode: 'isolated',
    percentage: null,
    ...over,
  };
}

const ok = (data: Position): ApiResult<Position> => ({ ok: true, data });
const failure = (reason: 'uncertain' | 'rejected', code?: string, status?: number) =>
  ({ ok: false, reason, message: 'test', ...(code ? { code } : {}), ...(status ? { status } : {}) }) as ApiResult<never>;

/** A fake service: every write is a counted spy, answers are queued per call. */
function fakeApi() {
  const api = {
    open: vi.fn<(input: OpenInput) => Promise<ApiResult<Position>>>(),
    close: vi.fn<(id: string, input: { quantity: string; clientCloseId: string }) => Promise<ApiResult<Position>>>(),
    setLeverage:
      vi.fn<
        (input: { symbol: string; positionId: string; leverage: string; clientAdjustmentId: string }) => Promise<ApiResult<Position>>
      >(),
    addMargin:
      vi.fn<(input: { symbol: string; positionId: string; amount: string; clientAdjustmentId: string }) => Promise<ApiResult<Position>>>(),
    reduceMargin:
      vi.fn<(input: { symbol: string; positionId: string; amount: string; clientAdjustmentId: string }) => Promise<ApiResult<Position>>>(),
    position: vi.fn<(id: string) => Promise<ApiResult<Position>>>(),
    positions: vi.fn<() => Promise<ApiResult<Position[]>>>(),
  };
  return { api, typed: api as unknown as FuturesApi };
}

const openInput: OpenInput = { symbol: 'BTC/USDT:USDT', side: 'long', size: '1', leverage: '5', clientOpenId: 'open-abc' };
const openIntent: Intent = { op: 'open', input: openInput };
const closeIntent: Intent = {
  op: 'close',
  positionId: 'pos-1',
  symbol: 'BTC/USDT:USDT',
  size: '1.250',
  clientCloseId: 'close-intent-1',
};

function pendingFor(id: string): Pending {
  const note = readPending(USER);
  if (note.state !== 'pending') throw new Error(`expected a device note for ${id}`);
  expect(note.pending.id).toBe(id);
  return note.pending;
}

describe('runIntent: unknown outcomes', () => {
  it('a 5xx answer to an open is uncertain and keeps the device note and the saved intent', async () => {
    const { api, typed } = fakeApi();
    api.open.mockResolvedValue(failure('uncertain', undefined, 503));
    const outcome = await runIntent(typed, USER, openIntent);
    expect(outcome).toEqual({ kind: 'uncertain', id: 'open-abc' });
    expect(readPending(USER).state).toBe('pending');
    expect(storage.data.has(pendingKey(USER))).toBe(true);
    expect(loadIntent(USER, 'open-abc')).toEqual(openIntent);
    expect(api.open).toHaveBeenCalledTimes(1);
  });

  it.each(['trade.mark_missing', 'trade.mark_unusable'])('%s is a definite refusal and clears the note', async (code) => {
    const { api, typed } = fakeApi();
    api.open.mockResolvedValue(failure('uncertain', code, 503));
    const outcome = await runIntent(typed, USER, openIntent);
    expect(outcome.kind).toBe('refused');
    expect(readPending(USER)).toEqual({ state: 'none' });
    expect(storage.data.has(intentKeyFor('open-abc'))).toBe(false);
  });

  it('an unrelated 5xx code stays uncertain', async () => {
    const { api, typed } = fakeApi();
    api.open.mockResolvedValue(failure('uncertain', 'trade.internal', 500));
    expect((await runIntent(typed, USER, openIntent)).kind).toBe('uncertain');
    expect(readPending(USER).state).toBe('pending');
  });

  it('a request that throws is uncertain and keeps the note', async () => {
    const { api, typed } = fakeApi();
    api.open.mockRejectedValue(new Error('network'));
    expect(await runIntent(typed, USER, openIntent)).toEqual({ kind: 'uncertain', id: 'open-abc' });
    expect(readPending(USER).state).toBe('pending');
  });
});

describe('checkPending: open', () => {
  async function startUncertainOpen() {
    const fake = fakeApi();
    fake.api.open.mockResolvedValue(failure('uncertain', undefined, 504));
    await runIntent(fake.typed, USER, openIntent);
    return fake;
  }

  it('finds nothing: says "not found", sends no write, keeps the note', async () => {
    const { api, typed } = await startUncertainOpen();
    api.positions.mockResolvedValue({ ok: true, data: [] });
    const outcome = await checkPending(typed, USER, pendingFor('open-abc'));
    expect(outcome).toEqual({ kind: 'uncertain', id: 'open-abc', notFound: true });
    expect(api.open).toHaveBeenCalledTimes(1); // only the original attempt
    expect(readPending(USER).state).toBe('pending');
    expect(loadIntent(USER, 'open-abc')).toEqual(openIntent);
  });

  it('resend sends exactly one more open with the SAME clientOpenId', async () => {
    const { api, typed } = await startUncertainOpen();
    api.positions.mockResolvedValue({ ok: true, data: [] });
    api.open.mockResolvedValue(ok(position()));
    const outcome = await checkPending(typed, USER, pendingFor('open-abc'), { resend: true });
    expect(outcome.kind).toBe('done');
    expect(api.open).toHaveBeenCalledTimes(2);
    expect(api.open.mock.calls[1]![0]).toEqual(api.open.mock.calls[0]![0]);
    expect(api.open.mock.calls[1]![0].clientOpenId).toBe('open-abc');
    expect(readPending(USER)).toEqual({ state: 'none' });
    expect(loadIntent(USER, 'open-abc')).toBeNull();
  });

  it('a matching position is the answer: done, nothing re-sent, note cleared', async () => {
    const { api, typed } = await startUncertainOpen();
    api.positions.mockResolvedValue({ ok: true, data: [position({ id: 'pos-9' })] });
    const outcome = await checkPending(typed, USER, pendingFor('open-abc'), { resend: true });
    expect(outcome).toMatchObject({ kind: 'done', position: { id: 'pos-9' } });
    expect(api.open).toHaveBeenCalledTimes(1);
    expect(readPending(USER)).toEqual({ state: 'none' });
    expect(loadIntent(USER, 'open-abc')).toBeNull();
  });

  it('a failed position read is uncertain (not "not found"), sends nothing and keeps the note', async () => {
    const { api, typed } = await startUncertainOpen();
    api.positions.mockResolvedValue(failure('uncertain', undefined, 503));
    const outcome = await checkPending(typed, USER, pendingFor('open-abc'), { resend: true });
    expect(outcome).toEqual({ kind: 'uncertain', id: 'open-abc' });
    expect(api.open).toHaveBeenCalledTimes(1);
    expect(readPending(USER).state).toBe('pending');
    expect(loadIntent(USER, 'open-abc')).toEqual(openIntent);
  });
});

describe('checkPending: close', () => {
  async function startUncertainClose() {
    const fake = fakeApi();
    fake.api.close.mockResolvedValue(failure('uncertain', undefined, 502));
    await runIntent(fake.typed, USER, closeIntent);
    return fake;
  }

  it('a position already closed is done, with no second close', async () => {
    const { api, typed } = await startUncertainClose();
    api.position.mockResolvedValue(ok(position({ status: 'closed' })));
    const outcome = await checkPending(typed, USER, pendingFor('close:pos-1'));
    expect(outcome).toMatchObject({ kind: 'done', position: { status: 'closed' } });
    expect(api.close).toHaveBeenCalledTimes(1); // only the original attempt
    expect(readPending(USER)).toEqual({ state: 'none' });
    expect(loadIntent(USER, 'close:pos-1')).toBeNull();
  });

  it('a failed position read is uncertain and keeps the note', async () => {
    const { api, typed } = await startUncertainClose();
    api.position.mockResolvedValue(failure('uncertain', undefined, 503));
    const outcome = await checkPending(typed, USER, pendingFor('close:pos-1'));
    expect(outcome).toEqual({ kind: 'uncertain', id: 'close:pos-1' });
    expect(api.close).toHaveBeenCalledTimes(1);
    expect(readPending(USER).state).toBe('pending');
    expect(loadIntent(USER, 'close:pos-1')).toEqual(closeIntent);
  });

  it('two sends of the same close intent pass the same clientCloseId', async () => {
    const { api, typed } = await startUncertainClose();
    api.position.mockResolvedValue(ok(position({ status: 'open' })));
    api.close.mockResolvedValue(ok(position({ status: 'closed' })));
    const outcome = await checkPending(typed, USER, pendingFor('close:pos-1'));
    expect(outcome.kind).toBe('done');
    expect(api.close).toHaveBeenCalledTimes(2);
    const expected = ['pos-1', { quantity: '1.250', clientCloseId: 'close-intent-1' }] as const;
    expect(api.close.mock.calls[0]).toEqual(expected);
    expect(api.close.mock.calls[1]).toEqual(api.close.mock.calls[0]);
    expect(readPending(USER)).toEqual({ state: 'none' });
  });
});

describe('checkPending: margin and leverage replays', () => {
  const cases: Array<{ name: string; intent: Intent; method: 'addMargin' | 'reduceMargin' | 'setLeverage' }> = [
    {
      name: 'add margin',
      method: 'addMargin',
      intent: { op: 'margin-add', input: { symbol: 'BTC/USDT:USDT', positionId: 'pos-1', amount: '5', clientAdjustmentId: 'adj-add-1' } },
    },
    {
      name: 'remove margin',
      method: 'reduceMargin',
      intent: {
        op: 'margin-reduce',
        input: { symbol: 'BTC/USDT:USDT', positionId: 'pos-1', amount: '2', clientAdjustmentId: 'adj-red-1' },
      },
    },
    {
      name: 'leverage',
      method: 'setLeverage',
      intent: { op: 'leverage', input: { symbol: 'BTC/USDT:USDT', positionId: 'pos-1', leverage: '3', clientAdjustmentId: 'adj-lev-1' } },
    },
  ];

  it.each(cases)('$name replays the saved request with the same clientAdjustmentId', async ({ intent, method }) => {
    const { api, typed } = fakeApi();
    api[method].mockResolvedValueOnce(failure('uncertain', undefined, 503));
    const first = await runIntent(typed, USER, intent);
    expect(first).toEqual({ kind: 'uncertain', id: intentId(intent) });

    api[method].mockResolvedValueOnce(ok(position()));
    const replay = await checkPending(typed, USER, pendingFor(intentId(intent)));
    expect(replay.kind).toBe('done');
    expect(api[method]).toHaveBeenCalledTimes(2);
    expect(api[method].mock.calls[1]![0]).toEqual(api[method].mock.calls[0]![0]);
    expect((api[method].mock.calls[1]![0] as { clientAdjustmentId: string }).clientAdjustmentId).toBe(
      (intent as { input: { clientAdjustmentId: string } }).input.clientAdjustmentId,
    );
    expect(api.position).not.toHaveBeenCalled(); // no read first: the request id makes the replay safe
    expect(api.positions).not.toHaveBeenCalled();
    expect(readPending(USER)).toEqual({ state: 'none' });
    expect(loadIntent(USER, intentId(intent))).toBeNull();
  });
});

describe('guards', () => {
  it('a second write is blocked while a note is pending, and sends nothing', async () => {
    const { api, typed } = fakeApi();
    api.open.mockResolvedValue(failure('uncertain', undefined, 503));
    await runIntent(typed, USER, openIntent);
    const other: Intent = {
      op: 'close',
      positionId: 'pos-2',
      symbol: 'BTC/USDT:USDT',
      size: '2',
      clientCloseId: 'close-intent-2',
    };
    const outcome = await runIntent(typed, USER, other);
    expect(outcome).toMatchObject({ kind: 'blocked', reason: 'pending' });
    expect(api.close).not.toHaveBeenCalled();
    expect(loadIntent(USER, 'close:pos-2')).toBeNull();
  });

  it('checkPending with no saved intent is blocked as unreadable and sends nothing', async () => {
    const { api, typed } = fakeApi();
    const outcome = await checkPending(typed, USER, { kind: 'position', id: 'ghost', symbol: 'BTC/USDT:USDT', startedAt: Date.now() });
    expect(outcome).toEqual({ kind: 'blocked', reason: 'unreadable' });
    expect(api.open).not.toHaveBeenCalled();
  });
});
