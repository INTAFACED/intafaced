import { describe, expect, it, vi } from 'vitest';
import { issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import type { Context } from '@intafaced/contracts';
import type { CampaignService } from './campaigns.js';
import { CampaignsError } from './codes.js';
import type { DropService } from './drops.js';
import { createCampaignsRouter } from './router.js';
import type { TaskService } from './tasks.js';
import { parseTgeSchedule, tgeView } from './tge.js';

/**
 * The tRPC boundary: who may reach which door, that a claim is always the caller's own account, and that the TGE claim
 * refuses by name and calls nothing. The drop logic itself is proved against Postgres in `drops.pg.test.ts`.
 */

const authConfig = {
  secret: 'a-campaigns-router-test-secret-long-enough',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
};
const ME = '11111111-1111-4111-8111-111111111111';

async function ctx(scopes: string[], opts: { mfa?: boolean; signedOut?: boolean; region?: string } = {}): Promise<Context> {
  const region = opts.region ?? 'DE';
  if (opts.signedOut) return { principal: null, service: null, region, requestId: 'req-1' };
  const { token } = await issueAccessToken(
    { userId: ME, sessionId: '44444444-4444-4444-8444-444444444444', scopes, tier: 'none', mfa: opts.mfa ?? true },
    authConfig,
  );
  return { principal: await verifyAccessToken(token, authConfig), service: null, region, requestId: 'req-1' };
}

function setup(schedule: string | undefined = undefined) {
  const tge = parseTgeSchedule(schedule);
  const drops = {
    room: vi.fn(async () => ({ season: null, drops: [], tge: tgeView(tge) })),
    claim: vi.fn(async (input: { dropId: string; accountId: string }) => ({
      claim: {
        dropId: input.dropId,
        claimKey: `drop:${input.dropId}:${input.accountId}`,
        kind: 'entitlement' as const,
        claimedAt: '2026-10-24T12:00:00.000Z',
      },
      created: true,
      remaining: 2,
    })),
    tgeSchedule: () => tge,
    listForOps: vi.fn(async () => ({ seasons: [], drops: [] })),
    createDrop: vi.fn(),
  };
  const campaigns = {
    join: vi.fn(async (input: { campaignId: string; accountId: string }) => ({
      participation: {
        campaignId: input.campaignId,
        participationKey: `campaign:join:${input.campaignId}:${input.accountId}`,
        revision: 1,
        joinedAt: '2026-10-24T12:00:00.000Z',
      },
      created: true,
    })),
    myCampaigns: vi.fn(async () => ({ campaigns: [] })),
    requestReview: vi.fn(async (input: { campaignId: string; accountId: string }) => ({
      review: { campaignId: input.campaignId, requestedAt: '2026-10-24T12:00:00.000Z' },
      created: true,
    })),
    listForOps: vi.fn(async () => []),
    getForOps: vi.fn(async () => {
      throw new CampaignsError('campaign.unknown', 'No such campaign');
    }),
    transition: vi.fn(),
  };
  const tasks = {
    claim: vi.fn(async (input: { campaignId: string; accountId: string }) => ({
      reward: {
        rewardKey: `task:${input.campaignId}:${input.accountId}:once`,
        campaignId: input.campaignId,
        asset: 'USDT',
        amount: '10',
        state: 'posted',
        reason: null,
        ledgerTxId: 'tx_1',
        createdAt: '2026-10-24T12:00:00.000Z',
        postedAt: '2026-10-24T12:00:00.000Z',
        holdUntil: null,
        form: 'paid',
        lock: null,
        rollback: { windowSeconds: null, closesAt: null, blocker: 'campaigns.reclaim_unavailable' },
        attempts: [],
      },
      created: true,
    })),
    progress: vi.fn(),
    myRewards: vi.fn(async () => ({ rewards: [], totals: [], more: false })),
  };
  return {
    drops,
    campaigns,
    tasks,
    api: (c: Context) =>
      createCampaignsRouter(
        drops as unknown as DropService,
        campaigns as unknown as CampaignService,
        tasks as unknown as TaskService,
      ).createCaller(c),
  };
}

const messageOf = (e: unknown) => String((e as Error).message);

describe('campaigns router', () => {
  it('claims for the signed-in account, never one named in the request', async () => {
    const { drops, api } = setup();
    const out = await api(await ctx(['campaigns:read', 'campaigns:write'])).drops.claim({ dropId: 'drop_1' });
    expect(drops.claim).toHaveBeenCalledWith({ dropId: 'drop_1', accountId: ME });
    expect(out.claim.claimKey).toBe(`drop:drop_1:${ME}`);
    await expect(
      api(await ctx(['campaigns:write'])).drops.claim({ dropId: 'drop_1', accountId: 'someone-else' } as never),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('joins a campaign for the signed-in account, never one named in the request', async () => {
    const { campaigns, api } = setup();
    const out = await api(await ctx(['campaigns:read', 'campaigns:write'])).participation.join({ campaignId: 'cmp_1' });
    expect(campaigns.join).toHaveBeenCalledWith({ campaignId: 'cmp_1', accountId: ME });
    expect(out.participation.participationKey).toBe(`campaign:join:cmp_1:${ME}`);
    await expect(
      api(await ctx(['campaigns:write'])).participation.join({ campaignId: 'cmp_1', accountId: 'someone-else' } as never),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(api(await ctx(['campaigns:read'])).participation.join({ campaignId: 'cmp_1' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(api(await ctx([], { signedOut: true })).participation.mine()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('claims a task reward for the signed-in account only, behind campaigns:write', async () => {
    const { tasks, api } = setup();
    const out = await api(await ctx(['campaigns:write'])).tasks.claim({ campaignId: 'cmp_1' });
    expect(tasks.claim).toHaveBeenCalledWith({ campaignId: 'cmp_1', accountId: ME });
    expect(out.reward.rewardKey).toBe(`task:cmp_1:${ME}:once`);
    await expect(
      api(await ctx(['campaigns:write'])).tasks.claim({ campaignId: 'cmp_1', accountId: 'someone-else' } as never),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(api(await ctx(['campaigns:read'])).tasks.claim({ campaignId: 'cmp_1' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('reads My Rewards for the signed-in account only, behind campaigns:read', async () => {
    const { tasks, api } = setup();
    expect(await api(await ctx(['campaigns:read'])).rewards.mine({})).toEqual({ rewards: [], totals: [], more: false });
    expect(tasks.myRewards).toHaveBeenCalledWith({ accountId: ME });
    await expect(api(await ctx(['campaigns:read'])).rewards.mine({ accountId: 'someone-else' } as never)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    await expect(api(await ctx([], { signedOut: true })).rewards.mine({})).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('asks for an eligibility review for the signed-in account only, behind campaigns:write', async () => {
    const { campaigns, api } = setup();
    const out = await api(await ctx(['campaigns:write'])).participation.requestReview({ campaignId: 'cmp_1' });
    expect(campaigns.requestReview).toHaveBeenCalledWith({ campaignId: 'cmp_1', accountId: ME });
    expect(out.created).toBe(true);
    await expect(
      api(await ctx(['campaigns:write'])).participation.requestReview({ campaignId: 'cmp_1', accountId: 'someone-else' } as never),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(api(await ctx(['campaigns:read'])).participation.requestReview({ campaignId: 'cmp_1' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('keeps the campaign operator doors behind campaigns:ops and a second factor', async () => {
    const { campaigns, api } = setup();
    const move = { id: 'cmp_1', action: 'approve' as const, revision: 1 };
    await expect(api(await ctx(['campaigns:read', 'campaigns:write'])).ops.campaigns.transition(move)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(api(await ctx(['campaigns:ops'], { mfa: false })).ops.campaigns.list()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(campaigns.transition).not.toHaveBeenCalled();
    await expect(api(await ctx(['campaigns:ops'])).ops.campaigns.list()).resolves.toEqual([]);
    await expect(api(await ctx(['campaigns:ops'])).ops.campaigns.get({ id: 'cmp_missing' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('refuses signed out, and without the scope', async () => {
    const { drops, api } = setup();
    await expect(api(await ctx([], { signedOut: true })).drops.room()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(api(await ctx(['campaigns:read'])).drops.claim({ dropId: 'drop_1' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(drops.claim).not.toHaveBeenCalled();
  });

  it('keeps the operator doors behind campaigns:ops and a second factor', async () => {
    const { drops, api } = setup();
    await expect(api(await ctx(['campaigns:read', 'campaigns:write'])).ops.list()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(api(await ctx(['campaigns:ops'], { mfa: false })).ops.list()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(api(await ctx(['campaigns:ops'])).ops.list()).resolves.toEqual({ seasons: [], drops: [] });
    expect(drops.listForOps).toHaveBeenCalledTimes(1);
  });

  it('an unresolved region closes the operator doors too (the module guard)', async () => {
    vi.stubEnv('INTAFACED_REGION_FAIL_CLOSED', 'true');
    const { drops, api } = setup();
    await expect(api(await ctx(['campaigns:ops'], { region: '' })).ops.list()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(drops.listForOps).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });

  it('the TGE claim with a blank schedule refuses launch.schedule_unset on testnet and audit.external on mainnet', async () => {
    const { api } = setup();
    const caller = api(await ctx(['campaigns:write']));
    const testnet = await caller.tge.claim({ network: 'testnet' }).catch((e: unknown) => e);
    expect(testnet).toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(messageOf(testnet)).toContain('[launch.schedule_unset]');
    expect((testnet as { cause?: { code?: string } }).cause?.code).toBe('launch.schedule_unset');
    expect(messageOf(await caller.tge.claim({ network: 'mainnet' }).catch((e: unknown) => e))).toContain('[audit.external]');
  });

  it('a set schedule still posts nothing: testnet waits for the on-chain claim, mainnet for the audit', async () => {
    const { api } = setup('{"claimOpensAt":"2026-12-01T00:00:00Z"}');
    const caller = api(await ctx(['campaigns:write']));
    expect(messageOf(await caller.tge.claim({ network: 'testnet' }).catch((e: unknown) => e))).toContain('[chain.go]');
    expect(messageOf(await caller.tge.claim({ network: 'mainnet' }).catch((e: unknown) => e))).toContain('[audit.external]');
  });

  it('a malformed owner schedule fails at boot instead of reading as blank', () => {
    expect(parseTgeSchedule('   ')).toBeNull();
    expect(() => parseTgeSchedule('soon')).toThrow(/CAMPAIGNS_TGE_SCHEDULE_JSON/);
    expect(() => parseTgeSchedule('{"claimOpensAt":"2026-12-01"}')).toThrow(/CAMPAIGNS_TGE_SCHEDULE_JSON/);
  });
});
