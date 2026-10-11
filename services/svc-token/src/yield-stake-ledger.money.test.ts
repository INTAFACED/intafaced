import { describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { MemoryEventBus } from '@intafaced/events';
import { MemoryLedger, formatAmount, houseFees, parseAmount as amt, recipes, userAvailable, type Amount } from '@intafaced/ledger-client';
import { distributeYield } from './economics/buyback.js';
import { DEFAULT_BUYBACK_PARAMS } from './economics/buyback.js';
import { DEFAULT_EMISSION_PARAMS } from './economics/emission.js';
import { STAKE_TIERS } from './economics/staking.js';
import { TokenService } from './token-service.js';

/**
 * L1251. Yield weight is the ledger pot, not the stake table.
 *
 * planYieldWindow used to pass token.stakes.amount into distributeYield.
 * stakeOf and closeProposal already refuse token.stake_ledger_mismatch when
 * that amount disagrees with tokenStakeAccount. A drifted active row must
 * refuse the same way, and must not be written into yield_payouts. A row
 * that matches the pot still takes the share distributeYield already computes.
 * The fee figure is the existing yield fixture. No new rate.
 */

const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';
const PAYER = '99999999-9999-4999-8999-999999999999';
const STAKE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const STAKE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const FEE = '100';
const POT = '1000';
const FLEX_BPS = STAKE_TIERS.flex.multiplierBps;

type StakeRow = { id: string; user_id: string; amount: string; tier: 'flex'; multiplier_bps: string };
type Payout = { windowId: string; userId: string; amount: string };

function yieldSql(active: StakeRow[]): { sql: Sql; payouts: Payout[] } {
  const payouts: Payout[] = [];

  const query = (strings: TemplateStringsArray, values: unknown[], sink: Payout[]) => {
    const q = strings.join(' ');
    if (q.includes('FROM token.yield_windows')) return Promise.resolve([]);
    if (q.includes('pg_advisory_xact_lock')) return Promise.resolve([]);
    if (q.includes('INSERT INTO token.yield_windows')) return Promise.resolve([]);
    if (q.includes('FROM token.stakes')) return Promise.resolve(active);
    if (q.includes('INSERT INTO token.yield_payouts')) {
      sink.push({ windowId: String(values[0]), userId: String(values[1]), amount: String(values[2]) });
      return Promise.resolve([]);
    }
    if (q.includes('UPDATE token.yield_payouts')) {
      return Promise.resolve([{ user_id: String(values[2]) }]);
    }
    return Promise.reject(new Error(`unexpected query: ${q}`));
  };

  const fn = (strings: TemplateStringsArray, ...values: unknown[]) => query(strings, values, payouts);
  const begin = async (_isolation: string, cb: (tx: typeof fn) => Promise<unknown>) => {
    const staged: Payout[] = [];
    const tx = (strings: TemplateStringsArray, ...values: unknown[]) => query(strings, values, staged);
    const result = await cb(tx);
    payouts.push(...staged);
    return result;
  };

  return { sql: Object.assign(fn, { begin, json: (v: unknown) => v }) as unknown as Sql, payouts };
}

async function funded(ledger: MemoryLedger, userId: string, stakeId: string, amount: string): Promise<void> {
  await ledger.post(
    recipes.deposit({
      userId,
      assetId: 'IFC',
      amount: amt(amount),
      rail: 'test',
      railRef: `${stakeId}:deposit`,
    }),
  );
  await ledger.post(
    recipes.stake({
      stakeId,
      userId,
      assetId: 'IFC',
      amount: amt(amount),
      tier: 'flex',
    }),
  );
}

async function accrueFees(ledger: MemoryLedger, amount: string): Promise<void> {
  await ledger.post(
    recipes.deposit({
      userId: PAYER,
      assetId: 'IFC',
      amount: amt(amount),
      rail: 'test',
      railRef: `fees:${amount}`,
    }),
  );
  await ledger.post(
    recipes.feeCharge({
      chargeId: `trade:${amount}`,
      userId: PAYER,
      module: 'trade',
      mode: 'asset',
      assetId: 'IFC',
      amount: amt(amount),
    }),
  );
}

function row(id: string, userId: string, amount: string): StakeRow {
  return { id, user_id: userId, amount, tier: 'flex', multiplier_bps: String(FLEX_BPS) };
}

function service(sql: Sql, ledger: MemoryLedger): TokenService {
  return new TokenService(sql, ledger, new MemoryEventBus('svc-token'), {
    assetId: 'IFC',
    emission: DEFAULT_EMISSION_PARAMS,
    buyback: DEFAULT_BUYBACK_PARAMS,
    loadParamsFromDb: false,
    feeScheduleTtlMs: 0,
  });
}

describe('planYieldWindow gates on tokenStakeAccount', () => {
  it('refuses a drifted active row and does not insert a payout for that amount', async () => {
    const ledger = new MemoryLedger();
    await funded(ledger, USER_A, STAKE_A, POT);
    await funded(ledger, USER_B, STAKE_B, POT);
    await accrueFees(ledger, FEE);
    const { sql, payouts } = yieldSql([row(STAKE_A, USER_A, POT), row(STAKE_B, USER_B, '10000')]);
    const token = service(sql, ledger);

    await expect(
      token.distributeRevenue({ windowId: 'l1251-drift', sources: [{ module: 'trade', amount: amt(FEE) }] }),
    ).rejects.toMatchObject({ code: 'token.stake_ledger_mismatch' });

    expect(payouts.filter((p) => p.userId === USER_B)).toEqual([]);
    expect(payouts).toEqual([]);
    expect(formatAmount((await ledger.balance(houseFees('trade', 'IFC'))).amount)).toBe(FEE);
    expect(formatAmount((await ledger.balance(userAvailable(USER_A, 'IFC'))).amount)).toBe('0');
    expect(formatAmount((await ledger.balance(userAvailable(USER_B, 'IFC'))).amount)).toBe('0');
  });

  it('pays a stake whose table amount matches the ledger its existing share', async () => {
    const ledger = new MemoryLedger();
    await funded(ledger, USER_A, STAKE_A, POT);
    await funded(ledger, USER_B, STAKE_B, POT);
    await accrueFees(ledger, FEE);
    const active = [row(STAKE_A, USER_A, POT), row(STAKE_B, USER_B, POT)];
    const { sql, payouts } = yieldSql(active);
    const token = service(sql, ledger);

    const result = await token.distributeRevenue({
      windowId: 'l1251-match',
      sources: [{ module: 'trade', amount: amt(FEE) }],
    });

    const shares = distributeYield(
      amt(FEE),
      active.map((s) => ({
        userId: s.user_id,
        amount: amt(s.amount),
        tier: s.tier,
        multiplierBps: FLEX_BPS,
      })),
    );
    expect(shares).toHaveLength(2);
    expect(result.recipients).toBe(2);
    expect(formatAmount(result.distributed)).toBe(FEE);

    let paid: Amount = 0n;
    for (const share of shares) {
      const inserted = payouts.find((p) => p.userId === share.userId);
      expect(inserted?.amount).toBe(formatAmount(share.share));
      expect(formatAmount((await ledger.balance(userAvailable(share.userId, 'IFC'))).amount)).toBe(formatAmount(share.share));
      paid += share.share;
    }
    expect(formatAmount(paid)).toBe(FEE);
  });
});
