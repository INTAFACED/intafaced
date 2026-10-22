/**
 * Unit card — D-explorer-01 explorer blocks list window + block facts (BE core)
 *
 * 1. Promise: blank/unset INDEXER_EXPLORER_LIST_LIMIT refuses
 *    `indexer.explorer_list_limit_unset`; utilisation is gas_used/gas_limit as a
 *    decimal string; orphaned blocks stay listed with badge + reason; list is
 *    descending from the head and bounded by the owner limit.
 * 2. Break: an invented default limit, a float utilisation, hidden orphans.
 * 3. Done bar: the tests below.
 * 4. Class N
 * 5. Paths: explorer/blocks.ts
 * 6. RED: module absent.
 */
import { describe, expect, it } from 'vitest';
import {
  INDEXER_EXPLORER_LIST_LIMIT_UNSET,
  parseExplorerListLimit,
  utilisation,
  listBlocks,
  type ExplorerBlockFact,
} from './blocks.js';

const fact = (height: number, over: Partial<ExplorerBlockFact> = {}): ExplorerBlockFact => ({
  chainId: 1, height, hash: `0x${height.toString(16).padStart(64, '0')}`,
  gasUsed: 15_000_000n, gasLimit: 30_000_000n, baseFeePerGas: 7n, miner: '0x' + '1'.repeat(40),
  txCount: 3, size: 1000, timestamp: 1_700_000_000 + height, orphaned: null, ...over,
});

describe('INDEXER_EXPLORER_LIST_LIMIT', () => {
  it.each([undefined, '', '  ', 'abc', '0', '-1', '1.5', '201'])('refuses %j', (raw) => {
    const r = parseExplorerListLimit(raw);
    expect(r).toEqual({ ok: false, code: INDEXER_EXPLORER_LIST_LIMIT_UNSET });
  });
  it('serves an owner-set value', () => {
    expect(parseExplorerListLimit('25')).toEqual({ ok: true, limit: 25 });
  });
});

describe('utilisation', () => {
  it('is a decimal string', () => {
    expect(utilisation(15_000_000n, 30_000_000n)).toBe('0.5');
    expect(utilisation(1n, 3n)).toBe('0.333333');
    expect(utilisation(30n, 30n)).toBe('1');
  });
  it('a zero gas limit is unknown, never zero', () => {
    expect(utilisation(0n, 0n)).toBeNull();
  });
});

describe('listBlocks', () => {
  const facts = [fact(1), fact(2), fact(3), fact(2, { hash: '0xdead', orphaned: { reason: 'reorg at 2' } })];
  it('descends from the head, bounded by limit, cursor pages', () => {
    const p1 = listBlocks(facts, { limit: 2 });
    expect(p1.rows.filter((r) => !r.orphaned).map((r) => r.height)).toEqual([3, 2]);
    expect(p1.nextCursor).toBe(2);
    const p2 = listBlocks(facts, { limit: 2, cursor: p1.nextCursor! });
    expect(p2.rows.map((r) => r.height)).toEqual([1]);
    expect(p2.nextCursor).toBeNull();
  });
  it('keeps orphaned blocks visible with badge and reason', () => {
    const rows = listBlocks(facts, { limit: 10 }).rows;
    const orphan = rows.find((r) => r.hash === '0xdead');
    expect(orphan?.orphaned).toEqual({ reason: 'reorg at 2' });
    expect(rows.find((r) => r.height === 2 && !r.orphaned)?.utilisation).toBe('0.5');
  });
});
