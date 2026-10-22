/**
 * Unit card — D-explorer-01 indexer.explorer.blocks.list / get procedures
 *
 * 1. Promise: list is owner-bounded (unset refuses), descending, keeps orphans
 *    with reason and states asOf; get by height or hash; unknown => NOT_FOUND
 *    `protocol.not_found`; no explorer source wired => `indexer.explorer_unwired`.
 * 2. Break: invented default limit, a null block instead of not-found, hidden orphan.
 * 3. Done bar: the tests below.
 * 4. Class N
 * 5. Paths: router.ts explorer, explorer/blocks.ts
 * 6. RED: procedures absent.
 */
import { describe, expect, it } from 'vitest';
import { createEdgeContext } from '@intafaced/contracts';
import { MemoryChainSource } from '../chain/memory-source.js';
import { Indexer } from '../indexer.js';
import { MemoryProjectionStore } from '../projection/memory-store.js';
import { createIndexerRouter, type IndexerRouterDeps } from '../router.js';
import { CHAIN_ID } from '../testing/conformance.js';
import { userCopy } from '../user-copy.js';
import {
  INDEXER_EXPLORER_LIST_LIMIT_UNSET,
  INDEXER_EXPLORER_UNWIRED,
  PROTOCOL_NOT_FOUND,
  memoryExplorerSource,
  parseExplorerListLimit,
  type ExplorerBlockFact,
} from './blocks.js';

const edgeContext = createEdgeContext({ secret: 'an-indexer-explorer-test-edge-secret-len', serviceName: 'svc-indexer' });
const anonymous = () => edgeContext({ headers: { 'x-intafaced-region': 'DE' }, id: 'req-anon' });

const fact = (height: number, over: Partial<ExplorerBlockFact> = {}): ExplorerBlockFact => ({
  chainId: CHAIN_ID,
  height,
  hash: `0x${height.toString(16).padStart(64, '0')}`,
  gasUsed: 10n,
  gasLimit: 40n,
  baseFeePerGas: null,
  miner: '0x' + '2'.repeat(40),
  txCount: 1,
  size: 500,
  timestamp: 1_700_000_000 + height,
  orphaned: null,
  ...over,
});
const FACTS = [fact(1), fact(2), fact(3), fact(3, { hash: '0x' + 'e'.repeat(64), orphaned: { reason: 'reorg' } })];

function caller(explorer: IndexerRouterDeps['explorer'], halt = false) {
  const store = new MemoryProjectionStore(CHAIN_ID);
  const indexer = new Indexer({
    source: new MemoryChainSource(CHAIN_ID),
    store,
    finalityDepth: 64,
    ingestEnabled: () => true,
    startHeight: 0,
  });
  if (halt) Object.defineProperty(indexer, 'halted', { get: () => ({ reason: 'test halt', at: new Date(0) }) });
  return createIndexerRouter({
    store,
    indexer,
    chainId: CHAIN_ID,
    finalityDepth: 64,
    ingestEnabled: () => true,
    chainSource: 'memory',
    explorer,
  }).createCaller(anonymous());
}
const wired = (raw: string | undefined = '2') => memoryExplorerSource(parseExplorerListLimit(raw), FACTS);

describe('indexer.explorer.blocks', () => {
  it('unset list limit refuses typed', async () => {
    await expect(caller(wired('')).explorer.blocks.list({ chainId: CHAIN_ID })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: userCopy(INDEXER_EXPLORER_LIST_LIMIT_UNSET),
    });
  });
  it('unwired explorer refuses, never an empty list', async () => {
    await expect(caller(undefined).explorer.blocks.list({ chainId: CHAIN_ID })).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      message: userCopy(INDEXER_EXPLORER_UNWIRED),
    });
  });
  it('halted indexer refuses with the halt, no rows', async () => {
    await expect(caller(wired(), true).explorer.blocks.list({ chainId: CHAIN_ID })).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
  });
  it('lists descending, bounded, orphan kept, asOf stated', async () => {
    const page = await caller(wired()).explorer.blocks.list({ chainId: CHAIN_ID });
    expect(page.rows.map((r) => [r.height, r.orphaned?.reason ?? null])).toEqual([
      [3, null],
      [3, 'reorg'],
    ]);
    expect(page.rows[0]!.utilisation).toBe('0.25');
    expect(page.rows[0]!.baseFeePerGas).toBeNull();
    expect(page.nextCursor).toBe(3);
    expect(typeof page.asOf).toBe('string');
    const next = await caller(wired()).explorer.blocks.list({ chainId: CHAIN_ID, cursor: 3 });
    expect(next.rows.map((r) => r.height)).toEqual([2, 1]);
    expect(next.nextCursor).toBeNull();
  });
  it('a caller limit above the owner limit is clamped, not refused', async () => {
    const page = await caller(wired()).explorer.blocks.list({ chainId: CHAIN_ID, limit: 50 });
    expect(page.rows.map((r) => r.height)).toEqual([3, 3]);
    expect(page.nextCursor).toBe(3);
  });
  it('a caller limit below the owner limit is honoured', async () => {
    const page = await caller(memoryExplorerSource(parseExplorerListLimit('10'), FACTS)).explorer.blocks.list({
      chainId: CHAIN_ID,
      limit: 3,
    });
    expect(page.rows.map((r) => r.height)).toEqual([3, 3, 2]);
  });
  it('gets by height (canonical) and by hash (orphan)', async () => {
    const c = caller(wired());
    expect((await c.explorer.blocks.get({ chainId: CHAIN_ID, height: 3 })).orphaned).toBeNull();
    expect((await c.explorer.blocks.get({ chainId: CHAIN_ID, hash: '0x' + 'e'.repeat(64) })).orphaned).toEqual({ reason: 'reorg' });
  });
  it('unknown block or other chain is NOT_FOUND protocol.not_found', async () => {
    const c = caller(wired());
    for (const q of [
      { chainId: CHAIN_ID, height: 999_999_999 },
      { chainId: CHAIN_ID + 1, height: 1 },
    ]) {
      await expect(c.explorer.blocks.get(q)).rejects.toMatchObject({ code: 'NOT_FOUND', message: userCopy(PROTOCOL_NOT_FOUND) });
    }
  });
});
