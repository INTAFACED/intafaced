import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DUAL_CONTROL_MISSING } from '../auth/four-eyes.js';
import { ACTION_APPROVAL_MISSING, stubActionApprovals } from '../auth/privileged-dual-control.js';
import {
  FEE_TIER_BPS_REQUIRED,
  LIMIT_MULTIPLIER_REQUIRED,
  RANK_NOT_FOUND,
  RANK_REQUIRED,
  changeFeeTier,
  changeLimit,
  requireFeeDiscountBps,
  requireLimitMultiplier,
} from './limit-fee-tier.js';

type PerkRow = {
  rank: number;
  perks: {
    feeDiscountBps: number;
    p2pLimitMultiplier: number;
    copyFollowerCap: number;
    lobbyHostRights: boolean;
    cardTier: 'none' | 'standard' | 'metal' | 'obsidian';
    otcAccess: boolean;
    launchpadTier: number;
  };
};

function store(rows: PerkRow[]) {
  const state = { writes: 0, loads: 0 };
  const fn = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?').toLowerCase();
    if (text.includes('from rank_thresholds')) {
      const rank = values[0];
      return rows.filter((r) => r.rank === rank).map((r) => ({ rank: r.rank, perks: r.perks }));
    }
    if (text.includes('update rank_thresholds')) {
      state.writes += 1;
      const next = values[0] as PerkRow['perks'];
      const rank = values[1];
      for (const r of rows) {
        if (r.rank === rank) r.perks = next;
      }
      return [];
    }
    throw new Error(`unexpected sql: ${text}`);
  };
  const sql = fn as typeof fn & {
    json: (value: unknown) => unknown;
    writes: number;
    loads: number;
    rows: PerkRow[];
    loadTiers(): Promise<void>;
  };
  sql.json = (value: unknown) => value;
  sql.rows = rows;
  sql.loadTiers = async () => {
    state.loads += 1;
  };
  Object.defineProperty(sql, 'writes', { get: () => state.writes });
  Object.defineProperty(sql, 'loads', { get: () => state.loads });
  return sql as Parameters<typeof changeFeeTier>[0] & {
    writes: number;
    loads: number;
    rows: PerkRow[];
    json: (value: unknown) => unknown;
    loadTiers(): Promise<void>;
  };
}

const ACTOR = '11111111-1111-4111-8111-111111111111';
const CONFIRM = '22222222-2222-4222-8222-222222222222';
const dual = { actorId: ACTOR, approvalId: 'appr-1', operationId: 'op-1', targetId: 'identity.change_fee_tier' };
const approvals = stubActionApprovals(CONFIRM);
const here = dirname(fileURLToPath(import.meta.url));

function seeded(): PerkRow {
  return {
    rank: 3,
    perks: {
      feeDiscountBps: 100,
      p2pLimitMultiplier: 2,
      copyFollowerCap: 50,
      lobbyHostRights: false,
      cardTier: 'standard',
      otcAccess: false,
      launchpadTier: 0,
    },
  };
}

describe('limit / fee-tier dual-control (R-onboard)', () => {
  it('missing or same-actor confirm refuses and does not write', async () => {
    const sql = store([seeded()]);
    await expect(
      changeFeeTier(sql, { rank: 3, feeDiscountBps: 150 }, { actorId: ACTOR, targetId: 'identity.change_fee_tier' }, undefined, approvals),
    ).rejects.toMatchObject({
      code: ACTION_APPROVAL_MISSING,
    });
    await expect(
      changeLimit(
        sql,
        { rank: 3, p2pLimitMultiplier: 3 },
        { actorId: ACTOR, confirmActorId: ACTOR, targetId: 'identity.change_limit' },
        undefined,
        approvals,
      ),
    ).rejects.toMatchObject({
      code: ACTION_APPROVAL_MISSING,
    });
    expect(sql.writes).toBe(0);
    expect(sql.rows[0]?.perks.feeDiscountBps).toBe(100);
    expect(sql.rows[0]?.perks.p2pLimitMultiplier).toBe(2);
  });

  it('does not invent fee-tier bps or a limit multiplier', async () => {
    const sql = store([seeded()]);
    expect(() => requireFeeDiscountBps(undefined)).toThrow(/does not invent fee-tier bps/);
    expect(() => requireLimitMultiplier(undefined)).toThrow(/does not invent a limit/);
    await expect(changeFeeTier(sql, { rank: 3, feeDiscountBps: undefined }, dual, undefined, approvals)).rejects.toMatchObject({
      code: FEE_TIER_BPS_REQUIRED,
    });
    await expect(
      changeLimit(sql, { rank: 3, p2pLimitMultiplier: undefined }, { ...dual, targetId: 'identity.change_limit' }, undefined, approvals),
    ).rejects.toMatchObject({
      code: LIMIT_MULTIPLIER_REQUIRED,
    });
    expect(sql.writes).toBe(0);
    expect(sql.rows[0]?.perks.feeDiscountBps).toBe(100);
  });

  it('two distinct actors change fee-tier bps and leave other perks', async () => {
    const sql = store([seeded()]);
    const out = await changeFeeTier(sql, { rank: 3, feeDiscountBps: 150 }, dual, sql, approvals);
    expect(out).toEqual({ rank: 3, feeDiscountBps: 150, p2pLimitMultiplier: 2 });
    expect(sql.rows[0]?.perks.feeDiscountBps).toBe(150);
    expect(sql.rows[0]?.perks.copyFollowerCap).toBe(50);
    expect(sql.loads).toBe(1);
  });

  it('two distinct actors change the P2P limit multiplier', async () => {
    const sql = store([seeded()]);
    const out = await changeLimit(sql, { rank: 3, p2pLimitMultiplier: 4 }, { ...dual, targetId: 'identity.change_limit' }, sql, approvals);
    expect(out).toEqual({ rank: 3, feeDiscountBps: 100, p2pLimitMultiplier: 4 });
    expect(sql.writes).toBe(1);
  });

  it('missing rank or unknown ladder row refuses and does not insert', async () => {
    const sql = store([seeded()]);
    await expect(changeFeeTier(sql, { rank: undefined, feeDiscountBps: 150 }, dual, undefined, approvals)).rejects.toMatchObject({
      code: RANK_REQUIRED,
    });
    await expect(changeFeeTier(sql, { rank: 99, feeDiscountBps: 150 }, dual, undefined, approvals)).rejects.toMatchObject({
      code: RANK_NOT_FOUND,
    });
    expect(sql.writes).toBe(0);
    expect(sql.rows).toHaveLength(1);
  });

  it('boot path installs the hitch; mill door names a second actor', () => {
    const indexSrc = readFileSync(join(here, '../index.ts'), 'utf8');
    expect(indexSrc).toMatch(/installLimitFeeTierDualControl\(rank, sql, actionApprovals\)/);
    expect(indexSrc).toMatch(/createLimitFeeTierRouter\(sql, rank, actionApprovals\)/);

    const door = readFileSync(join(here, '../limit-fee-tier-router.ts'), 'utf8');
    expect(door).toMatch(/approvalId/);
    expect(door).toMatch(/ctx\.principal\.userId/);
    expect(door).toMatch(/PRECONDITION_FAILED/);
    expect(door).toMatch(/ACTION_APPROVAL_MISSING/);
    expect(door).toMatch(/changeFeeTier/);
    expect(door).toMatch(/changeLimit/);
    expect(door).not.toMatch(/:\s*10\b|:\s*20\b/);
  });
});
