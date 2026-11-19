import { describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { MemoryLedger, formatAmount, parseAmount as amt, recipes } from '@intafaced/ledger-client';
import { EarnService } from './earn-service.js';

/**
 * Ledger-backed principalOf / poolSize without PG: MemoryLedger is the book,
 * sql is only the claim index. Fail-first: inflating the row used to report
 * the column as if it were staked.
 */

const USER = '11111111-1111-4111-8111-111111111111';
const POOL_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const POSITION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function sqlReturning(active: Array<{ id: string; user_id: string; asset_id: string; principal: string }>): Sql {
  const fn = (strings: TemplateStringsArray) => {
    const q = strings.join(' ');
    if (q.includes('FROM bank.earn_positions')) return Promise.resolve(active);
    throw new Error(`unexpected query: ${q}`);
  };
  return Object.assign(fn, { json: (v: unknown) => v }) as Sql;
}

async function fundedService(active: Array<{ id: string; user_id: string; asset_id: string; principal: string }>) {
  const ledger = new MemoryLedger();
  await ledger.post(
    recipes.deposit({
      userId: USER,
      assetId: 'USDT',
      amount: amt('1000'),
      rail: 'test',
      railRef: `${USER}:1000`,
    }),
  );
  await ledger.post(
    recipes.earnDeposit({
      positionId: POSITION_ID,
      poolId: POOL_ID,
      userId: USER,
      assetId: 'USDT',
      amount: amt('1000'),
    }),
  );
  return new EarnService(sqlReturning(active), ledger, { nativeAssetId: 'IFC' });
}

const matchingRow = {
  id: POSITION_ID,
  user_id: USER,
  asset_id: 'USDT',
  principal: '1000',
};

describe('principalOf/poolSize gate on the ledger pot', () => {
  it('returns the book when the active row matches earnStakeAccount', async () => {
    const earn = await fundedService([matchingRow]);
    expect(formatAmount(await earn.principalOf(USER, 'USDT'))).toBe('1000');
    expect(formatAmount(await earn.poolSize(POOL_ID))).toBe('1000');
  });

  it('refuses principalOf and poolSize when the table is inflated', async () => {
    const earn = await fundedService([{ ...matchingRow, principal: '1000000' }]);
    await expect(earn.principalOf(USER, 'USDT')).rejects.toMatchObject({ code: 'bank.earn_principal_mismatch' });
    await expect(earn.poolSize(POOL_ID)).rejects.toMatchObject({ code: 'bank.earn_principal_mismatch' });
  });

  it('refuses when the table is deflated rather than reporting a silent short', async () => {
    const earn = await fundedService([{ ...matchingRow, principal: '1' }]);
    await expect(earn.principalOf(USER, 'USDT')).rejects.toMatchObject({ code: 'bank.earn_principal_mismatch' });
    await expect(earn.poolSize(POOL_ID)).rejects.toMatchObject({ code: 'bank.earn_principal_mismatch' });
  });

  it('is zero when there is no active claim, even if a pot exists', async () => {
    const earn = await fundedService([]);
    expect(formatAmount(await earn.principalOf(USER, 'USDT'))).toBe('0');
    expect(formatAmount(await earn.poolSize(POOL_ID))).toBe('0');
  });
});
