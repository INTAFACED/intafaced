/**
 * RC-identity-08: what a recovery sweep does with each of the owner's balances. Free value moves, held value stays until
 * it is released, and a negative balance (a debt the owner still owes) stops the sweep.
 */
import { describe, expect, it } from 'vitest';
import { parseAmount, type AccountRef } from '@intafaced/ledger-client';
import { splitHoldings, type RecoveryAccount } from './recovery-claims.js';

const OWNER = '71111111-1111-4111-8111-111111111111';
const row = (assetId: string, kind: string, amount: string, purpose?: string): RecoveryAccount => ({
  account: { ownerType: 'user', ownerId: OWNER, assetId, kind, ...(purpose ? { purpose } : {}) } as AccountRef,
  spaceId: null,
  spaceName: null,
  amount: parseAmount(amount),
});

describe('splitHoldings', () => {
  it('moves free value, keeps held or purposed value, and stops at a debt', () => {
    const split = splitHoldings([
      row('USDT', 'available', '100'),
      row('USDT', 'hold', '10'),
      row('BTC', 'available', '0.5', 'earn'),
      row('ETH', 'available', '-2'),
    ]);
    expect(split.sweepable.map((a) => a.account.assetId)).toEqual(['USDT']);
    expect(split.held.map((a) => [a.account.assetId, a.account.kind])).toEqual([
      ['BTC', 'available'],
      ['USDT', 'hold'],
    ]);
    expect(split.blockers.map((a) => a.account.assetId)).toEqual(['ETH']);
  });

  it('with nothing owed and nothing held, everything free moves', () => {
    const split = splitHoldings([row('USDT', 'available', '5'), row('BTC', 'available', '0.1')]);
    expect(split.sweepable).toHaveLength(2);
    expect(split.held).toEqual([]);
    expect(split.blockers).toEqual([]);
  });
});
