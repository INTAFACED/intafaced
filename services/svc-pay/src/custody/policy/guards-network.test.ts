import { describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { parseAmount } from '@intafaced/ledger-client';
import { fakeSql, partial } from '@intafaced/service-kit/testing';
import { FRESH, type UserMoneyWithdrawalContext } from '../../seams/guards.js';
import { evaluatePolicy } from './engine.js';
import { createCustodyPolicyGuards, GUARD_CUSTODY_POLICY_BLOCKED } from './guards.js';
import type { PolicyRule } from './schemas.js';

// A rule's `networks` names chain networks, so the guard matches it against the withdrawal's network, as
// `simulate` does, never against the rail id (`crypto-native`).
const rules: PolicyRule[] = [
  { id: 'block-ethereum', action: 'block', match: { networks: ['ethereum'] } },
  { id: 'allow-other', action: 'allow', match: {} },
];

function guardFor(networkId: string) {
  // Every query answers the published version; only `loadPublishedPolicy` reads the rows.
  const tx = fakeSql<Sql>([{ version: 1, rules }]);
  const guard = createCustodyPolicyGuards({ sql: tx, mode: 'required' });
  const ctx = partial<UserMoneyWithdrawalContext>({
    tx,
    userId: 'user-1',
    assetId: 'USDT',
    amount: parseAmount('10'),
    rail: 'crypto-native',
    networkId,
    destination: { kind: 'crypto', ref: '0x0000000000000000000000000000000000000002' },
    clientRef: `ref-${networkId}`,
    replay: FRESH,
  });
  return () => guard.beforeUserMoneyWithdrawal!(ctx);
}

describe('custody policy guard network matching', () => {
  it('blocks a withdrawal on a network the published policy blocks, as simulate says it does', async () => {
    const simulated = await evaluatePolicy(
      rules,
      {
        initiator: 'user-1',
        assetId: 'USDT',
        amount: parseAmount('10'),
        network: 'ethereum',
        destinationKind: 'crypto',
        destinationRef: '0x0000000000000000000000000000000000000002',
        txType: 'transfer',
      },
      async () => 0n,
    );
    expect(simulated).toMatchObject({ outcome: 'block', ruleId: 'block-ethereum' });
    await expect(guardFor('ethereum')()).rejects.toMatchObject({ code: GUARD_CUSTODY_POLICY_BLOCKED });
  });

  it('lets a withdrawal on another network through the same policy', async () => {
    await expect(guardFor('base')()).resolves.toBeUndefined();
  });
});
