import { describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { MemoryEventBus } from '@intafaced/events';
import { MemoryLedger, formatAmount, parseAmount as amt, recipes } from '@intafaced/ledger-client';
import { DEFAULT_BUYBACK_PARAMS } from './economics/buyback.js';
import { DEFAULT_EMISSION_PARAMS } from './economics/emission.js';
import { TokenService } from './token-service.js';

/**
 * Ledger-backed stakeOf without PG: MemoryLedger is the book, sql is only the
 * claim index. Fail-first: inflating the row used to raise feeDiscountBps.
 */

const USER = '11111111-1111-4111-8111-111111111111';
const STAKE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const SEEDED_SCHEDULE = {
  basis: 'staked',
  tiers: [
    { minStake: '0', discountBps: 0 },
    { minStake: '1000', discountBps: 1_000 },
    { minStake: '10000', discountBps: 2_000 },
  ],
};

function sqlReturning(active: Array<{ id: string; amount: string }>): Sql {
  const fn = (strings: TemplateStringsArray) => {
    const q = strings.join(' ');
    if (q.includes('FROM token.stakes')) return Promise.resolve(active);
    if (q.includes('FROM token.token_params')) {
      return Promise.resolve([{ fee_discount_schedule: SEEDED_SCHEDULE }]);
    }
    throw new Error(`unexpected query: ${q}`);
  };
  return Object.assign(fn, { json: (v: unknown) => v }) as Sql;
}

async function fundedService(active: Array<{ id: string; amount: string }>) {
  const ledger = new MemoryLedger();
  await ledger.post(
    recipes.deposit({
      userId: USER,
      assetId: 'IFC',
      amount: amt('1000'),
      rail: 'test',
      railRef: `${USER}:1000`,
    }),
  );
  await ledger.post(
    recipes.stake({
      stakeId: STAKE_ID,
      userId: USER,
      assetId: 'IFC',
      amount: amt('1000'),
      tier: 'flex',
    }),
  );
  const token = new TokenService(sqlReturning(active), ledger, new MemoryEventBus('svc-token'), {
    assetId: 'IFC',
    emission: DEFAULT_EMISSION_PARAMS,
    buyback: DEFAULT_BUYBACK_PARAMS,
    loadParamsFromDb: false,
    feeScheduleTtlMs: 0,
  });
  return token;
}

describe('stakeOf gates on the ledger pot', () => {
  it('returns the book when the active row matches tokenStakeAccount', async () => {
    const token = await fundedService([{ id: STAKE_ID, amount: '1000' }]);
    expect(formatAmount(await token.stakeOf(USER))).toBe('1000');
    const access = await token.accessOf(USER);
    expect(formatAmount(access.staked)).toBe('1000');
    expect(access.feeDiscountBps).toBe(1_000);
  });

  it('refuses stakeOf and accessOf when the table is inflated — no extra discount', async () => {
    const token = await fundedService([{ id: STAKE_ID, amount: '10000' }]);
    await expect(token.stakeOf(USER)).rejects.toMatchObject({ code: 'token.stake_ledger_mismatch' });
    await expect(token.accessOf(USER)).rejects.toMatchObject({ code: 'token.stake_ledger_mismatch' });
  });

  it('is zero when there is no active claim, even if a pot exists', async () => {
    const token = await fundedService([]);
    expect(formatAmount(await token.stakeOf(USER))).toBe('0');
    expect((await token.accessOf(USER)).feeDiscountBps).toBe(0);
  });
});
