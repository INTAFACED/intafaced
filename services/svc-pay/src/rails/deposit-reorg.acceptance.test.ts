import { beforeEach, describe, expect, it } from 'vitest';
import {
  InsufficientFundsError,
  MemoryLedger,
  formatAmount,
  parseAmount as amt,
  railBoundary,
  recipes,
  userAvailable,
} from '@intafaced/ledger-client';
import { DepositBlockReorg, type ChainHeightHash } from './deposit-reorg.js';

/**
 * WAL-0070. A deposit credited from block hash H is taken back when the node
 * reports a different hash at that height. One reversing ledger entry. A
 * withdrawal of that amount is refused.
 */

const USER = '11111111-1111-4111-8111-111111111111';
const ASSET = 'USDT';
const RAIL = 'crypto-native';
const RAIL_REF = '0xtx-wal-0070';
const DEPOSIT_ID = 'dep-wal-0070';
const HEIGHT = '100';
const HASH_H = '0x1111111111111111111111111111111111111111111111111111111111111111';
const HASH_REWRITTEN = '0x2222222222222222222222222222222222222222222222222222222222222222';
const AMOUNT = amt('4');

class MapHeightHash implements ChainHeightHash {
  private readonly hashes = new Map<string, string | null>();

  set(height: string, hash: string | null): void {
    this.hashes.set(height, hash);
  }

  async hashAt(height: string): Promise<string | null> {
    return this.hashes.has(height) ? (this.hashes.get(height) ?? null) : null;
  }
}

describe('WAL-0070 rewritten deposit block reverses the credit', () => {
  let ledger: MemoryLedger;
  let chain: MapHeightHash;
  let reorg: DepositBlockReorg;

  beforeEach(async () => {
    ledger = new MemoryLedger();
    chain = new MapHeightHash();
    reorg = new DepositBlockReorg(chain, ledger);
    await ledger.post(
      recipes.deposit({
        userId: USER,
        assetId: ASSET,
        amount: AMOUNT,
        rail: RAIL,
        railRef: RAIL_REF,
      }),
    );
    reorg.note({
      depositId: DEPOSIT_ID,
      userId: USER,
      assetId: ASSET,
      amount: AMOUNT,
      rail: RAIL,
      railRef: RAIL_REF,
      height: HEIGHT,
      blockHash: HASH_H,
    });
  });

  async function available(): Promise<string> {
    return formatAmount((await ledger.balance(userAvailable(USER, ASSET))).amount);
  }

  async function railTip(): Promise<string> {
    return formatAmount((await ledger.balance(railBoundary(RAIL, ASSET))).amount);
  }

  function reversals() {
    return ledger.journal().filter((tx) => tx.reason === 'deposit.reversed');
  }

  it('removes the credited amount from available when the hash at that height changes', async () => {
    chain.set(HEIGHT, HASH_H);
    expect(await reorg.observe()).toEqual([]);
    expect(await available()).toBe('4');
    expect(await railTip()).toBe('-4');

    chain.set(HEIGHT, HASH_REWRITTEN);
    const posted = await reorg.observe();
    expect(posted).toEqual([{ depositId: DEPOSIT_ID, txId: posted[0]!.txId }]);
    expect(await available()).toBe('0');
    expect(await railTip()).toBe('0');
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('posts the reversal once for the same deposit', async () => {
    chain.set(HEIGHT, HASH_REWRITTEN);
    const first = await reorg.observe();
    const second = await reorg.observe();
    expect(first).toHaveLength(1);
    expect(second).toEqual([]);
    expect(reversals()).toHaveLength(1);
    expect(reversals()[0]!.id).toBe(first[0]!.txId);
    expect(await available()).toBe('0');
  });

  it('refuses a withdrawal of the reversed amount', async () => {
    chain.set(HEIGHT, HASH_REWRITTEN);
    await reorg.observe();
    expect(await available()).toBe('0');

    await expect(
      ledger.post(
        recipes.withdrawHold({
          userId: USER,
          assetId: ASSET,
          amount: AMOUNT,
          rail: RAIL,
          withdrawalId: 'wd-wal-0070',
        }),
      ),
    ).rejects.toBeInstanceOf(InsufficientFundsError);

    expect(await available()).toBe('0');
    expect(reversals()).toHaveLength(1);
    expect(ledger.reconcile()).toEqual({ ok: true });
  });
});
