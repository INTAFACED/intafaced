import { describe, expect, it } from 'vitest';
import { ChainUnavailableError } from './availability.js';
import {
  internalFromCallTracer,
  internalFromParity,
  isTraceDeclined,
  readBlockInternal,
  TRACE_MALFORMED,
  TRACE_UNAVAILABLE,
} from './internal-txs.js';

const BLOCK = `0x${'b'.repeat(64)}`;
const TX1 = `0x${'1'.repeat(64)}`;
const TX2 = `0x${'2'.repeat(64)}`;
const A = `0x${'a'.repeat(40)}`;
const B = `0x${'b'.repeat(40)}`;
const C = `0x${'c'.repeat(40)}`;
const D = `0x${'d'.repeat(40)}`;

const parity = (tx: string, traceAddress: number[], type: string, action: object, extra: object = {}) => ({
  blockHash: BLOCK,
  transactionHash: tx,
  traceAddress,
  type,
  action,
  ...extra,
});

describe('internalFromParity', () => {
  it('keeps value moves inside a transaction and drops the top call, zero values, delegate calls and block rewards', () => {
    const calls = internalFromParity(
      [
        parity(TX1, [], 'call', { callType: 'call', from: A, to: B, value: '0x5' }),
        parity(TX1, [0], 'call', { callType: 'call', from: B, to: C, value: '0x3' }),
        parity(TX1, [1], 'call', { callType: 'delegatecall', from: B, to: C, value: '0x9' }),
        parity(TX1, [2], 'call', { callType: 'staticcall', from: B, to: C, value: '0x0' }),
        parity(TX1, [3], 'call', { callType: 'call', from: B, to: D, value: '0x0' }),
        parity(TX2, [0], 'create', { from: A, value: '0x7' }, { result: { address: D } }),
        parity(TX2, [1], 'suicide', { address: D, refundAddress: C, balance: '0x7' }),
        { type: 'reward', action: { author: A, value: '0x1' } },
      ],
      BLOCK,
      [TX1, TX2],
    );
    expect(calls).toEqual([
      { txHash: TX1, path: '0', kind: 'call', from: B, to: C, valueWei: 3n },
      { txHash: TX2, path: '0', kind: 'create', from: A, to: D, valueWei: 7n },
      { txHash: TX2, path: '1', kind: 'selfdestruct', from: D, to: C, valueWei: 7n },
    ]);
  });

  it('drops a reverted call and everything under it, however deep, and keeps its siblings', () => {
    const calls = internalFromParity(
      [
        parity(TX1, [], 'call', { callType: 'call', from: A, to: B, value: '0x0' }),
        parity(TX1, [0], 'call', { callType: 'call', from: B, to: C, value: '0x1' }, { error: 'Reverted' }),
        parity(TX1, [0, 0], 'call', { callType: 'call', from: C, to: D, value: '0x2' }),
        parity(TX1, [0, 0, 0], 'call', { callType: 'call', from: D, to: A, value: '0x3' }),
        parity(TX1, [1], 'call', { callType: 'call', from: B, to: D, value: '0x4' }),
      ],
      BLOCK,
      [TX1],
    );
    expect(calls).toEqual([{ txHash: TX1, path: '1', kind: 'call', from: B, to: D, valueWei: 4n }]);
  });

  it('keeps nothing from a transaction whose top call failed', () => {
    const calls = internalFromParity(
      [
        parity(TX1, [], 'call', { callType: 'call', from: A, to: B, value: '0x0' }, { error: 'Reverted' }),
        parity(TX1, [0], 'call', { callType: 'call', from: B, to: C, value: '0x1' }),
      ],
      BLOCK,
      [TX1],
    );
    expect(calls).toEqual([]);
  });

  it('refuses a trace of another block as a malformed node answer, so the block is read again', () => {
    const other = parity(TX1, [0], 'call', { callType: 'call', from: A, to: B, value: '0x1' }, { blockHash: `0x${'c'.repeat(64)}` });
    expect(() => internalFromParity([other], BLOCK, [TX1])).toThrow(ChainUnavailableError);
  });

  it('calls a trace naming a transaction not in the block, or an unknown type, malformed', () => {
    expect(() =>
      internalFromParity([parity(`0x${'9'.repeat(64)}`, [0], 'call', { callType: 'call', from: A, to: B, value: '0x1' })], BLOCK, [TX1]),
    ).toThrow();
    expect(() => internalFromParity([parity(TX1, [0], 'weird', {})], BLOCK, [TX1])).toThrow();
    expect(() => internalFromParity({}, BLOCK, [TX1])).toThrow();
  });
});

describe('internalFromCallTracer', () => {
  it('walks each tree in block order, keeps value moves that stood, skips a failed frame and its subtree', () => {
    const calls = internalFromCallTracer(
      [
        {
          txHash: TX1,
          result: {
            type: 'CALL',
            from: A,
            to: B,
            value: '0x1',
            calls: [
              {
                type: 'CALL',
                from: B,
                to: C,
                value: '0x2',
                error: 'execution reverted',
                calls: [{ type: 'CALL', from: C, to: D, value: '0x3' }],
              },
              { type: 'DELEGATECALL', from: B, to: C, value: '0x5' },
              { type: 'CALL', from: B, to: D, value: '0x6', calls: [{ type: 'CREATE2', from: D, to: C, value: '0x7' }] },
            ],
          },
        },
        { txHash: TX2, result: { type: 'CALL', from: A, to: B, calls: [{ type: 'SELFDESTRUCT', from: B, to: A, value: '0x8' }] } },
      ],
      [TX1, TX2],
    );
    expect(calls).toEqual([
      { txHash: TX1, path: '2', kind: 'call', from: B, to: D, valueWei: 6n },
      { txHash: TX1, path: '2.0', kind: 'create', from: D, to: C, valueWei: 7n },
      { txHash: TX2, path: '0', kind: 'selfdestruct', from: B, to: A, valueWei: 8n },
    ]);
  });

  it('walks a tree 1024 calls deep without recursion', () => {
    let frame: Record<string, unknown> = { type: 'CALL', from: C, to: D, value: '0x1' };
    for (let i = 0; i < 1024; i += 1) frame = { type: 'CALL', from: A, to: B, value: '0x0', calls: [frame] };
    const calls = internalFromCallTracer([{ result: frame }], [TX1]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.path.split('.')).toHaveLength(1024);
  });

  it('calls a list that does not match the block malformed', () => {
    expect(() => internalFromCallTracer([], [TX1])).toThrow();
    expect(() =>
      internalFromCallTracer(
        [
          { txHash: TX2, result: {} },
          { txHash: TX1, result: {} },
        ],
        [TX1, TX2],
      ),
    ).toThrow();
  });
});

describe('isTraceDeclined', () => {
  it('reads a JSON-RPC error answer or a client error as the node declining', () => {
    expect(isTraceDeclined({ code: -32601, message: 'Method not found' })).toBe(true);
    expect(isTraceDeclined({ code: -32000, message: 'execution timeout' })).toBe(true);
    expect(isTraceDeclined(new Error('wrapped', { cause: { status: 400 } }))).toBe(true);
  });

  it('reads a rate limit, a busy node or a transport failure as transient', () => {
    expect(isTraceDeclined({ code: -32005, message: 'x' })).toBe(false);
    expect(isTraceDeclined({ code: -32000, message: 'Too Many Requests' })).toBe(false);
    expect(isTraceDeclined({ status: 429 })).toBe(false);
    expect(isTraceDeclined({ status: 408 })).toBe(false);
    expect(isTraceDeclined({ status: 503 })).toBe(false);
    expect(isTraceDeclined(new Error('fetch failed'))).toBe(false);
  });
});

describe('readBlockInternal', () => {
  const block = { hash: BLOCK, height: 26 };
  const client = (answers: Record<string, () => unknown>) => {
    const asked: string[] = [];
    return {
      asked,
      request: async ({ method }: { method: string }) => {
        asked.push(method);
        const answer = answers[method];
        if (!answer) throw { code: -32601, message: 'Method not found' };
        return answer();
      },
    };
  };

  it('asks nothing for a block with no transactions', async () => {
    const c = client({});
    expect(await readBlockInternal(c as never, block, [], 'http://node.test')).toEqual({ read: true, calls: [] });
    expect(c.asked).toEqual([]);
  });

  it('reads trace_block by height first', async () => {
    const c = client({ trace_block: () => [parity(TX1, [0], 'call', { callType: 'call', from: A, to: B, value: '0x1' })] });
    expect(await readBlockInternal(c as never, block, [TX1], 'http://node.test')).toEqual({
      read: true,
      calls: [{ txHash: TX1, path: '0', kind: 'call', from: A, to: B, valueWei: 1n }],
    });
    expect(c.asked).toEqual(['trace_block']);
  });

  it('falls back to the call tracer when trace_block is declined', async () => {
    const c = client({
      debug_traceBlockByHash: () => [{ result: { type: 'CALL', from: A, to: B, calls: [{ type: 'CALL', from: B, to: C, value: '0x2' }] } }],
    });
    expect(await readBlockInternal(c as never, block, [TX1], 'http://node.test')).toEqual({
      read: true,
      calls: [{ txHash: TX1, path: '0', kind: 'call', from: B, to: C, valueWei: 2n }],
    });
    expect(c.asked).toEqual(['trace_block', 'debug_traceBlockByHash']);
  });

  it('stores the block as not traced when the node declines both, or one transaction timed out', async () => {
    expect(await readBlockInternal(client({}) as never, block, [TX1], 'http://node.test')).toEqual({
      read: false,
      reason: TRACE_UNAVAILABLE,
    });
    const timedOut = client({ debug_traceBlockByHash: () => [{ txHash: TX1, error: 'execution timeout' }] });
    expect(await readBlockInternal(timedOut as never, block, [TX1], 'http://node.test')).toEqual({
      read: false,
      reason: TRACE_UNAVAILABLE,
    });
  });

  it('stores a malformed trace as not read with its own code', async () => {
    const c = client({ trace_block: () => [parity(TX1, [0], 'call', { callType: 'call', from: 'nope', to: B, value: '0x1' })] });
    expect(await readBlockInternal(c as never, block, [TX1], 'http://node.test')).toEqual({ read: false, reason: TRACE_MALFORMED });
  });

  it('throws on a rate limit or a dead node, so the block is read again rather than stored without its trace', async () => {
    const limited = {
      request: async () => {
        throw { code: -32005, message: 'limit exceeded' };
      },
    };
    await expect(readBlockInternal(limited as never, block, [TX1], 'http://node.test')).rejects.toBeInstanceOf(ChainUnavailableError);
    const dead = {
      request: async () => {
        throw new Error('fetch failed');
      },
    };
    await expect(readBlockInternal(dead as never, block, [TX1], 'http://node.test')).rejects.toBeInstanceOf(ChainUnavailableError);
  });
});
