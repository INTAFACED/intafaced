/**
 * Unit card — D-explorer-02 classify and drop window
 *
 * 1. Promise: blank window is indexer.tx_drop_window_unset; a never-seen hash
 *    is missing; a seen hash past the window is dropped with no invented body;
 *    an orphan with a canonical same nonce is replaced.
 * 2. Break: a blank window becoming dropped, or a zero value standing in for
 *    a missing price.
 * 3. Done bar: the tests below.
 */
import { describe, expect, it } from 'vitest';
import type { ChainTx } from '../chain/source.js';
import { INDEXER_TX_DROP_WINDOW_UNSET, classifyExplorerTx, parseTxDropWindow, type IndexedExplorerTx, type LiveTx } from './tx.js';

const HASH = `0x${'ab'.repeat(32)}`;
const FROM = `0x${'11'.repeat(20)}`;
const TOPIC = `0x${'22'.repeat(32)}`;

function tx(over: Partial<ChainTx> = {}): ChainTx {
  return {
    hash: HASH,
    index: 0,
    from: FROM,
    to: `0x${'33'.repeat(20)}`,
    valueWei: 0n,
    nonce: 4,
    gasLimit: 21_000n,
    gasPriceWei: null,
    gasConsumed: 21_000n,
    status: 'success',
    revertReason: null,
    input: '0x',
    createdContract: null,
    logs: [{ logIndex: 0, address: FROM, topics: [TOPIC], data: '0x' }],
    ...over,
  };
}

const NOW = new Date('2026-01-01T00:00:00.000Z');

describe('INDEXER_TX_DROP_WINDOW_SECONDS', () => {
  it('blank, zero and junk are unset', () => {
    for (const raw of [undefined, '', '  ', '0', '-1', 'nope', '1.5']) {
      expect(parseTxDropWindow(raw)).toEqual({ ok: false, code: INDEXER_TX_DROP_WINDOW_UNSET });
    }
  });
  it('a published positive window is kept', () => {
    expect(parseTxDropWindow('90')).toEqual({ ok: true, seconds: 90 });
  });
});

describe('classifyExplorerTx', () => {
  const window = parseTxDropWindow('60');

  it('a hash the node has never had is missing, not dropped and not zero', () => {
    expect(classifyExplorerTx({ indexed: null, live: null, pendingSince: null, now: NOW, dropWindow: window })).toEqual({
      kind: 'missing',
    });
  });

  it('a blank window refuses a hash we already saw, and does not call it dropped', () => {
    const decision = classifyExplorerTx({
      indexed: null,
      live: null,
      pendingSince: new Date(NOW.getTime() - 120_000),
      now: NOW,
      dropWindow: parseTxDropWindow(''),
    });
    expect(decision).toEqual({ kind: 'refuse', code: INDEXER_TX_DROP_WINDOW_UNSET });
  });

  it('past the window the hash is dropped with no body and no zero amounts', () => {
    const decision = classifyExplorerTx({
      indexed: null,
      live: null,
      pendingSince: new Date(NOW.getTime() - 61_000),
      now: NOW,
      dropWindow: window,
    });
    expect(decision).toMatchObject({
      kind: 'answer',
      answer: { status: 'dropped', transaction: null, receipt: null, logs: [], replacingHash: null },
    });
  });

  it('inside the window a vanished hash stays pending and still has no invented body', () => {
    const decision = classifyExplorerTx({
      indexed: null,
      live: null,
      pendingSince: new Date(NOW.getTime() - 1_000),
      now: NOW,
      dropWindow: window,
    });
    expect(decision).toMatchObject({ kind: 'answer', answer: { status: 'pending', transaction: null, recordPending: false } });
  });

  it('a mempool hit is pending, records the sight, and keeps a null gas price', () => {
    const live: LiveTx = {
      kind: 'pending',
      from: FROM,
      to: null,
      valueWei: 0n,
      nonce: 4,
      gasLimit: 21_000n,
      gasPriceWei: null,
      input: '0xabcdef',
    };
    const decision = classifyExplorerTx({ indexed: null, live, pendingSince: null, now: NOW, dropWindow: window });
    expect(decision).toMatchObject({
      kind: 'answer',
      answer: {
        status: 'pending',
        recordPending: true,
        receipt: null,
        transaction: { index: null, value: '0', gasPrice: null, gasLimit: '21000', to: null },
      },
    });
  });

  it('a failed mined tx keeps the node reason and does not turn value into a float', () => {
    const live: LiveTx = { kind: 'mined', tx: tx({ status: 'failed', revertReason: 'Error(string)', valueWei: 10n ** 18n }) };
    const decision = classifyExplorerTx({ indexed: null, live, pendingSince: null, now: NOW, dropWindow: window });
    expect(decision).toMatchObject({
      kind: 'answer',
      answer: {
        status: 'failed',
        transaction: { value: '1000000000000000000' },
        receipt: { status: 'failed', revertReason: 'Error(string)' },
      },
    });
  });

  it('an orphaned hash with a canonical same nonce is replaced', () => {
    const indexed: IndexedExplorerTx = {
      tx: tx(),
      blockStatus: 'orphaned',
      replacementHash: `0x${'cd'.repeat(32)}`,
      orphaned: { reason: 'reorg' },
    };
    const decision = classifyExplorerTx({ indexed, live: null, pendingSince: null, now: NOW, dropWindow: window });
    expect(decision).toMatchObject({
      kind: 'answer',
      answer: { status: 'replaced', replacingHash: indexed.replacementHash, orphaned: { reason: 'reorg' } },
    });
  });
});
