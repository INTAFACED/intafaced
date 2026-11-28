import { describe, expect, it } from 'vitest';
import { MemoryEventBus } from '@intafaced/events';
import { MemoryLedger, formatAmount, parseAmount as amt, recipes } from '@intafaced/ledger-client';
import { DEFAULT_BUYBACK_PARAMS } from './economics/buyback.js';
import { DEFAULT_EMISSION_PARAMS } from './economics/emission.js';
import { recordingSql } from './sql-recorder.testkit.js';
import { TokenService } from './token-service.js';

const USER = '11111111-1111-4111-8111-111111111111';
const STAKE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const STAKE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const UNFUNDED = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

/** Two funded stake pots on the ledger (1000 and 500); the table rows are whatever the test claims. */
async function serviceWith(active: Array<{ id: string; amount: string }>) {
  const ledger = new MemoryLedger();
  for (const [stakeId, amount] of [
    [STAKE_A, '1000'],
    [STAKE_B, '500'],
  ] as const) {
    await ledger.post(
      recipes.deposit({ userId: USER, assetId: 'IFC', amount: amt(amount), rail: 'test', railRef: `${stakeId}:${amount}` }),
    );
    await ledger.post(recipes.stake({ stakeId, userId: USER, assetId: 'IFC', amount: amt(amount), tier: 'flex' }));
  }
  const { sql, queries } = recordingSql((q) => (q.text.includes('FROM token.stakes') ? active : []));
  const token = new TokenService(sql, ledger, new MemoryEventBus('svc-token'), {
    assetId: 'IFC',
    emission: DEFAULT_EMISSION_PARAMS,
    buyback: DEFAULT_BUYBACK_PARAMS,
    loadParamsFromDb: false,
    feeScheduleTtlMs: 0,
  });
  return { token, queries };
}

describe('token.stakeOf is ledger-backed', () => {
  it('sums the tokenStakeAccount pots of the active claims it reads for the user', async () => {
    const { token, queries } = await serviceWith([
      { id: STAKE_A, amount: '1000' },
      { id: STAKE_B, amount: '500' },
    ]);
    expect(formatAmount(await token.stakeOf(USER))).toBe('1500');
    const read = queries.find((q) => q.text.includes('FROM token.stakes'));
    expect(read?.values).toContain(USER);
    expect(read?.text).toMatch(/status = 'active'/);
  });

  it('refuses table/ledger drift in either direction, and a claim with no pot', async () => {
    for (const active of [
      [{ id: STAKE_A, amount: '1001' }],
      [{ id: STAKE_A, amount: '999' }],
      [
        { id: STAKE_A, amount: '1000' },
        { id: STAKE_B, amount: '5000' },
      ],
      [{ id: UNFUNDED, amount: '10' }],
    ]) {
      const { token } = await serviceWith(active);
      await expect(token.stakeOf(USER), JSON.stringify(active)).rejects.toMatchObject({ code: 'token.stake_ledger_mismatch' });
    }
  });

  it('counts only claimed pots: a funded pot with no active claim counts for nothing', async () => {
    const { token } = await serviceWith([{ id: STAKE_B, amount: '500' }]);
    expect(formatAmount(await token.stakeOf(USER))).toBe('500');
    const none = await serviceWith([]);
    expect(formatAmount(await none.token.stakeOf(USER))).toBe('0');
  });
});
