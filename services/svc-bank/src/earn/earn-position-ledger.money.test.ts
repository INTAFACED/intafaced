import { describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { MemoryLedger, formatAmount, parseAmount as amt, recipes } from '@intafaced/ledger-client';
import { EarnService } from './earn-service.js';

/**
 * Ledger-backed position / positionsOf without PG: MemoryLedger is the book,
 * sql is only the claim index. Fail-first: a drifted principal column used to
 * be returned as the open balance.
 */

const USER = '11111111-1111-4111-8111-111111111111';
const POOL_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const POSITION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OPENED_AT = new Date('2026-03-01T00:00:00Z');

interface PositionFixture {
  id: string;
  pool_id: string;
  user_id: string;
  asset_id: string;
  principal: string;
  opened_at: Date;
  matures_at: Date | null;
  status: 'pending' | 'active' | 'closed';
}

function sqlReturning(rows: PositionFixture[]): Sql {
  const fn = (strings: TemplateStringsArray) => {
    const q = strings.join(' ');
    if (q.includes('FROM bank.earn_positions')) return Promise.resolve(rows);
    throw new Error(`unexpected query: ${q}`);
  };
  return Object.assign(fn, { json: (v: unknown) => v }) as unknown as Sql;
}

async function serviceFor(row: PositionFixture, pot: 'funded' | 'empty'): Promise<EarnService> {
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
  if (pot === 'empty') {
    await ledger.post(
      recipes.earnWithdraw({
        positionId: POSITION_ID,
        poolId: POOL_ID,
        userId: USER,
        assetId: 'USDT',
        amount: amt('1000'),
      }),
    );
  }
  return new EarnService(sqlReturning([row]), ledger, { nativeAssetId: 'IFC' });
}

function row(principal: string, status: PositionFixture['status']): PositionFixture {
  return {
    id: POSITION_ID,
    pool_id: POOL_ID,
    user_id: USER,
    asset_id: 'USDT',
    principal,
    opened_at: OPENED_AT,
    matures_at: null,
    status,
  };
}

describe('position/positionsOf gate an active row on the ledger pot', () => {
  it('returns the column when the active row matches the funded pot', async () => {
    const earn = await serviceFor(row('1000', 'active'), 'funded');
    expect(formatAmount((await earn.position(POSITION_ID)).principal)).toBe('1000');
    const listed = await earn.positionsOf(USER, 50);
    expect(listed).toHaveLength(1);
    expect(formatAmount(listed[0]!.principal)).toBe('1000');
  });

  it('refuses position and positionsOf when the active column is inflated', async () => {
    const earn = await serviceFor(row('1000000', 'active'), 'funded');
    await expect(earn.position(POSITION_ID)).rejects.toMatchObject({ code: 'bank.earn_principal_mismatch' });
    await expect(earn.positionsOf(USER, 50)).rejects.toMatchObject({ code: 'bank.earn_principal_mismatch' });
  });

  it('refuses position and positionsOf when the active column is deflated', async () => {
    const earn = await serviceFor(row('1', 'active'), 'funded');
    await expect(earn.position(POSITION_ID)).rejects.toMatchObject({ code: 'bank.earn_principal_mismatch' });
    await expect(earn.positionsOf(USER, 50)).rejects.toMatchObject({ code: 'bank.earn_principal_mismatch' });
  });

  it('returns a closed column when the pot is already 0', async () => {
    const earn = await serviceFor(row('1000', 'closed'), 'empty');
    const position = await earn.position(POSITION_ID);
    expect(position.status).toBe('closed');
    expect(formatAmount(position.principal)).toBe('1000');
  });
});
