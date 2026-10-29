import { encodeAbiParameters, stringToHex } from 'viem';
import { describe, expect, it } from 'vitest';
import { decodeTokenDecimals, decodeTokenText, TokenMetaReader } from './token-meta.js';

const abiString = (text: string) => encodeAbiParameters([{ type: 'string' }], [text]);

describe('decodeTokenText', () => {
  it('reads an ABI string and the older bytes32 answer', () => {
    expect(decodeTokenText(abiString('TESTA'), 32)).toBe('TESTA');
    expect(decodeTokenText(stringToHex('MKR', { size: 32 }), 32)).toBe('MKR');
  });

  it('gives no answer for empty, malformed or over-long text, never a cut symbol', () => {
    expect(decodeTokenText('0x', 32)).toBeNull();
    expect(decodeTokenText('0xzz', 32)).toBeNull();
    expect(decodeTokenText(abiString('X'.repeat(33)), 32)).toBeNull();
  });

  it('cleans a control character the contract chose', () => {
    expect(decodeTokenText(abiString('A\u0000B'), 32)).toBe('A B');
  });
});

describe('decodeTokenDecimals', () => {
  it('reads a uint8 and refuses anything over 255 or malformed', () => {
    expect(decodeTokenDecimals(`0x${(18).toString(16).padStart(64, '0')}`)).toBe(18);
    expect(decodeTokenDecimals(`0x${(256).toString(16).padStart(64, '0')}`)).toBeNull();
    expect(decodeTokenDecimals('0x12')).toBeNull();
  });
});

describe('TokenMetaReader', () => {
  const TOKEN = `0x${'0a'.repeat(20)}`;

  it('stores a contract that refuses the call as null fields, reads each contract once, at the block asked', async () => {
    const calls: unknown[] = [];
    const client = {
      request: async ({ params }: { params: [{ data: string }, string] }) => {
        calls.push(params);
        if (params[0].data === '0x06fdde03') throw Object.assign(new Error('execution reverted'), { code: 3 });
        if (params[0].data === '0x95d89b41') return abiString('TESTA');
        return `0x${(6).toString(16).padStart(64, '0')}`;
      },
    };
    const reader = new TokenMetaReader(client as never, 'http://node.test');
    const first = await reader.read([TOKEN.toUpperCase().replace('0X', '0x')], 10);
    expect(first).toEqual([{ address: TOKEN, symbol: 'TESTA', name: null, decimals: 6 }]);
    expect(calls).toHaveLength(3);
    expect(calls.every((p) => (p as [unknown, string])[1] === '0xa')).toBe(true);
    expect(await reader.read([TOKEN], 11)).toEqual(first);
    expect(calls).toHaveLength(3);
  });

  it('refuses the block on a failure in transit, so it is read again', async () => {
    const client = {
      request: async () => {
        throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
      },
    };
    await expect(new TokenMetaReader(client as never, 'http://node.test').read([TOKEN], 1)).rejects.toThrow();
  });
});
