import { describe, expect, it } from 'vitest';
import { crossShardAnchor, hashAssetTx, LedgerShardUnwiredError, assertLedgerShardingEnabled } from './sharding.js';

describe('ledger sharding socket', () => {
  it('refuses closed when the durable shard path is disabled', () => {
    expect(() => assertLedgerShardingEnabled()).toThrowError(LedgerShardUnwiredError);
    try {
      assertLedgerShardingEnabled();
    } catch (error) {
      expect(error).toMatchObject({ code: 'ledger.shard_unwired' });
    }
  });

  it('anchors tips in sorted asset order (golden)', () => {
    const tips = { BTC: 'b'.repeat(64), USDT: 'a'.repeat(64) };
    expect(crossShardAnchor(tips)).toBe('12718068114b77d97e28658a11acf604f1bf3f6193e91629d14a8389ee61e3e3');
    expect(crossShardAnchor({ USDT: tips.USDT, BTC: tips.BTC })).toBe(crossShardAnchor(tips));
  });

  it('uses independent previous links for each asset', () => {
    const txWith = (usdtAmount: bigint, usdtBalanceAfter: bigint) => ({
      id: 'tx-1',
      module: 'test',
      reason: 'test',
      postedAt: new Date('2026-01-01T00:00:00.000Z'),
      entries: [
        {
          id: '1',
          txId: 'tx-1',
          accountId: 'a',
          assetId: 'USDT',
          direction: 'debit' as const,
          amount: usdtAmount,
          balanceAfter: usdtBalanceAfter,
        },
        { id: '2', txId: 'tx-1', accountId: 'b', assetId: 'BTC', direction: 'credit' as const, amount: 1n, balanceAfter: 1n },
      ],
    });
    const tx = txWith(1n, 1n);
    const usdt = hashAssetTx(tx, 'USDT', null);
    expect(usdt).not.toBe(hashAssetTx(tx, 'BTC', null));
    expect(usdt).not.toBe(hashAssetTx(tx, 'USDT', 'b'.repeat(64)));
    expect(usdt).not.toBe(hashAssetTx(txWith(2n, 1n), 'USDT', null));
    expect(usdt).not.toBe(hashAssetTx(txWith(1n, 2n), 'USDT', null));
  });
});
