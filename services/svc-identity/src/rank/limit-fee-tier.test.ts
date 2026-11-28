import { describe, expect, it } from 'vitest';
import { partial } from '@intafaced/service-kit/testing';
import type { ActionApprovalService } from '../auth/action-approval-service.js';
import { BOOT_TIMEOUT_MS, bootIdentity, contextWith } from '../boot.testkit.js';
import { createLimitFeeTierRouter } from '../limit-fee-tier-router.js';
import type { RankService } from './rank-service.js';
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

  it(
    'boot path installs the hitch; mill door names a second actor',
    async () => {
      // The booted service serves both doors on the shared approvals: no approval, or one the service never issued,
      // refuses before anything is read or written.
      const boot = await bootIdentity();
      const op = boot.appRouter.createCaller(await contextWith(['admin:compliance'], { userId: ACTOR, mfa: true }));
      const before = boot.queries.length;
      for (const call of [
        () => op.changeFeeTier({ rank: 3, feeDiscountBps: 150 }),
        () => op.changeLimit({ rank: 3, p2pLimitMultiplier: 3 }),
      ]) {
        const err = await call().catch((e: unknown) => e);
        expect(err).toMatchObject({ code: 'PRECONDITION_FAILED' });
        expect((err as { cause?: { code?: string } }).cause?.code).toBe(ACTION_APPROVAL_MISSING);
      }
      const unissued = await op
        .changeFeeTier({ rank: 3, feeDiscountBps: 150, approvalId: 'appr-x', operationId: 'op-x' })
        .catch((e: unknown) => e);
      // The approvals are the service's own (its action_approvals table): an approval it never issued is not found.
      expect(unissued).toMatchObject({ code: 'BAD_REQUEST', message: expect.stringMatching(/approval not found/) });
      expect(boot.queries.slice(before).some((q) => /rank_thresholds/i.test(q.text))).toBe(false);
    },
    BOOT_TIMEOUT_MS,
  );

  it('the mill door refuses a change without a spent approval', async () => {
    const consumed: Array<{ targetId: string; approvalId: string }> = [];
    const approvals = partial<Pick<ActionApprovalService, 'consume'>>({
      consume: async (service: string, input: Parameters<ActionApprovalService['consume']>[1]) => {
        consumed.push({ targetId: input.targetId, approvalId: input.approvalId });
        return stubActionApprovals(CONFIRM).consume(service, input);
      },
    });
    const sql = store([seeded()]);
    const door = createLimitFeeTierRouter(sql, partial<RankService>({ loadTiers: async () => undefined }), approvals);
    const customer = door.createCaller(await contextWith(['identity:read', 'identity:write'], { userId: ACTOR }));
    await expect(customer.changeFeeTier({ rank: 3, feeDiscountBps: 150, approvalId: 'appr-1', operationId: 'op-1' })).rejects.toMatchObject(
      {
        code: 'FORBIDDEN',
      },
    );
    const op = door.createCaller(await contextWith(['admin:compliance'], { userId: ACTOR, mfa: true }));
    const missing = await op.changeFeeTier({ rank: 3, feeDiscountBps: 150 }).catch((e: unknown) => e);
    expect(missing).toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect((missing as { cause?: { code?: string } }).cause?.code).toBe(ACTION_APPROVAL_MISSING);
    // No invented bps or multiplier: the door needs the value named.
    await expect(op.changeFeeTier({ rank: 3, approvalId: 'appr-1', operationId: 'op-1' } as never)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    await expect(op.changeLimit({ rank: 3, approvalId: 'appr-1', operationId: 'op-1' } as never)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(sql.writes).toBe(0);
    expect(consumed).toEqual([]);

    // With a second person's approval, each change spends it for its own target.
    await expect(op.changeFeeTier({ rank: 3, feeDiscountBps: 150, approvalId: 'appr-1', operationId: 'op-1' })).resolves.toEqual({
      rank: 3,
      feeDiscountBps: 150,
      p2pLimitMultiplier: 2,
    });
    await expect(op.changeLimit({ rank: 3, p2pLimitMultiplier: 4, approvalId: 'appr-2', operationId: 'op-2' })).resolves.toEqual({
      rank: 3,
      feeDiscountBps: 150,
      p2pLimitMultiplier: 4,
    });
    expect(consumed).toEqual([
      { targetId: 'identity.change_fee_tier', approvalId: 'appr-1' },
      { targetId: 'identity.change_limit', approvalId: 'appr-2' },
    ]);
    expect(sql.writes).toBe(2);
    await expect(op.changeFeeTier({ rank: 99, feeDiscountBps: 150, approvalId: 'appr-3', operationId: 'op-3' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});
