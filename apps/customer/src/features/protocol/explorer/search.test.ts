import { describe, expect, it } from 'vitest';
import { classifyQuery, pathFor } from './search';

describe('explorer search: a query by its shape', () => {
  it('reads a 40-hex address, a 64-hex hash and a height, and opens the page each has', () => {
    const address = '0x52908400098527886E0F7030069857D2E4169EE7';
    expect(classifyQuery(` ${address} `)).toEqual({ kind: 'address', value: address });
    expect(pathFor(classifyQuery(address))).toBe(`/chain/address/${address}`);
    const hash = `0x${'AB'.repeat(32)}`;
    expect(classifyQuery(hash)).toEqual({ kind: 'tx', value: hash.toLowerCase() });
    expect(pathFor(classifyQuery(hash))).toBeNull();
    expect(classifyQuery('00042')).toEqual({ kind: 'block', value: '42' });
    expect(classifyQuery('0')).toEqual({ kind: 'block', value: '0' });
    expect(pathFor(classifyQuery('42'))).toBe('/chain/blocks/42');
  });
  it('treats anything else as text, which has no page, and a blank as nothing', () => {
    expect(classifyQuery('TEST')).toEqual({ kind: 'text', value: 'TEST' });
    expect(classifyQuery('0x1234')).toEqual({ kind: 'text', value: '0x1234' });
    expect(classifyQuery(`0x${'g'.repeat(40)}`).kind).toBe('text');
    expect(pathFor(classifyQuery('TEST'))).toBeNull();
    expect(classifyQuery('   ')).toEqual({ kind: 'empty' });
  });
});
