import { describe, expect, it, vi } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { formatAmount, parseAmount as amt } from '@intafaced/ledger-client';
import { ACCESS_TIERS, STAKE_TIERS } from './economics/staking.js';
import { ActionApprovalConsumeError, stubApprovalConsumer, type ActionApprovalConsumer } from './action-approval-consume.js';
import { createTokenRouter } from './router.js';
import { TokenError, assertProposalListLimit, assertStakesListLimit, type StakeRecord, type TokenService } from './token-service.js';
import { userCopy } from './user-copy.js';

/**
 * Mount boundary for svc-token — stake/unstake/mintEpoch/yield/buyback must
 * only run for a principal the edge signed. A forgeable principal here is
 * forgeable custody of someone else's IFC (stake), permanent supply inflation
 * (mint), or treasury fee sweeps / burns (yield + buyback).
 */

const SECRET = 'a-token-mount-test-edge-secret-long-enough';
const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const CONFIRM = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const APPROVAL = { approvalId: 'appr-1', operationId: 'op-1' } as const;

const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-token' });

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    sub: USER,
    userId: USER,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes: ['token:read', 'token:stake'],
    tier: 'basic',
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
    ...overrides,
  } as Principal;
}

const anonymous = () => edgeContext({ headers: { 'x-intafaced-region': 'DE' }, id: 'req-anon' });

function signed(p: Principal = principal()) {
  const raw = encodePrincipal(p);
  return edgeContext({
    headers: {
      'x-intafaced-principal': raw,
      'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
      'x-intafaced-region': 'DE',
    },
    id: 'req-signed',
  });
}

function jobCaller(p: Principal = principal()) {
  return { ...signed(p), service: 'svc-token' as const };
}

function forged(p: Principal = principal()) {
  return edgeContext({
    headers: { 'x-intafaced-principal': encodePrincipal(p), 'x-intafaced-region': 'DE' },
    id: 'req-forged',
  });
}

function stakeRecord(overrides: Partial<StakeRecord> = {}): StakeRecord {
  return {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    userId: USER,
    amount: amt('1000'),
    tier: 'flex',
    startedAt: new Date('2026-01-01T00:00:00.000Z'),
    unlocksAt: null,
    status: 'active',
    ...overrides,
  };
}

function stubToken(overrides: Partial<TokenService> = {}): TokenService {
  return {
    stakeOf: vi.fn(async () => 0n),
    accessOf: vi.fn(async () => ({ staked: 0n, tier: { name: 'Base' }, feeDiscountBps: 0 })),
    stake: vi.fn(async () => stakeRecord()),
    unstake: vi.fn(async () => stakeRecord({ status: 'closed' })),
    getStake: vi.fn(async () => stakeRecord()),
    listStakes: vi.fn(async () => [stakeRecord()]),
    mintEpoch: vi.fn(async (epoch: number) => ({ epoch, minted: amt('136000') })),
    mintNextEpoch: vi.fn(async () => ({ epoch: 0, minted: amt('136000') })),
    nextEmissionEpoch: vi.fn(async () => 0),
    distributeRevenue: vi.fn(async () => ({
      windowId: 'w1',
      distributed: amt('100'),
      recipients: 1,
      skipped: 0,
      alreadyPaid: 0,
    })),
    recordBuyback: vi.fn(async () => ({
      runId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      burned: amt('50'),
      toRewards: amt('50'),
    })),
    burnedSupply: vi.fn(async () => amt('0')),
    closeProposal: vi.fn(async () => ({
      id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      kind: 'fee_param' as const,
      body: {},
      status: 'passed' as const,
      opensAt: new Date('2026-07-15T00:00:00.000Z'),
      closesAt: new Date('2026-07-22T00:00:00.000Z'),
      createdAt: new Date('2026-07-15T00:00:00.000Z'),
      title: null,
      bodyMd: null,
      discussionLink: null,
      businessKey: null,
      authorId: null,
      revision: 1,
      votingType: 'basic' as const,
      choices: null,
      snapshot: null,
      ranking: null,
      choiceTally: null,
      counts: { votes: 1, for: 1, against: 0, abstain: 0 },
      tally: {
        forWeight: amt('1000'),
        againstWeight: amt('0'),
        abstainWeight: amt('0'),
        totalWeight: amt('1000'),
        voterCount: 1,
      },
      execute: null,
    })),
    ...overrides,
  } as unknown as TokenService;
}

describe('svc-token mount — authorisation', () => {
  it('refuses anonymous callers on stake mutations', async () => {
    let called = false;
    const token = stubToken({
      stake: vi.fn(async () => {
        called = true;
        return stakeRecord();
      }),
    });

    await expect(
      createTokenRouter(token)
        .createCaller(anonymous())
        .stake({ amount: '1000', tier: 'flex', stakeId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }),
    ).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    expect(called).toBe(false);
  });

  it('refuses a self-asserted principal, however privileged it claims to be', async () => {
    const ctx = forged(principal({ scopes: ['token:stake', 'admin:treasury'], tier: 'full', mfa: true }));
    expect(ctx.principal).toBeNull();

    await expect(
      createTokenRouter(stubToken())
        .createCaller(ctx)
        .stake({ amount: '1000', tier: 'flex', stakeId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }),
    ).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });

  it('accepts an edge-signed principal with token:stake', async () => {
    const token = stubToken();
    const result = await createTokenRouter(token)
      .createCaller(signed())
      .stake({ amount: '1000', tier: 'flex', stakeId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' });
    expect(result.userId).toBe(USER);
    expect(result.amount).toBe('1000');
    expect(token.stake).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: USER,
        amount: amt('1000'),
        tier: 'flex',
        stakeId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      }),
    );
  });

  it('refuses a signed stake before service effects when screening is explicitly strict and unconfigured', async () => {
    const prior = {
      failClosed: process.env.INTAFACED_SCREENING_FAIL_CLOSED,
      regions: process.env.INTAFACED_SANCTIONS_REGIONS,
      source: process.env.INTAFACED_SANCTIONS_LIST_SOURCE,
    };
    const token = stubToken();
    try {
      process.env.INTAFACED_SCREENING_FAIL_CLOSED = 'on';
      delete process.env.INTAFACED_SANCTIONS_REGIONS;
      delete process.env.INTAFACED_SANCTIONS_LIST_SOURCE;

      let caught: unknown;
      try {
        await createTokenRouter(token)
          .createCaller(signed())
          .stake({ amount: '50', tier: 'm12', stakeId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' });
      } catch (error) {
        caught = error;
      }

      expect(caught).toMatchObject({
        code: 'FORBIDDEN',
        cause: { code: 'denied.screening_unconfigured' },
      });
      expect(token.stake).not.toHaveBeenCalled();
    } finally {
      if (prior.failClosed === undefined) delete process.env.INTAFACED_SCREENING_FAIL_CLOSED;
      else process.env.INTAFACED_SCREENING_FAIL_CLOSED = prior.failClosed;
      if (prior.regions === undefined) delete process.env.INTAFACED_SANCTIONS_REGIONS;
      else process.env.INTAFACED_SANCTIONS_REGIONS = prior.regions;
      if (prior.source === undefined) delete process.env.INTAFACED_SANCTIONS_LIST_SOURCE;
      else process.env.INTAFACED_SANCTIONS_LIST_SOURCE = prior.source;
    }
  });

  it('refuses stake when KYC tier is none (jurisdiction matrix on token)', async () => {
    const token = stubToken();
    await expect(
      createTokenRouter(token)
        .createCaller(signed(principal({ tier: 'none' })))
        .stake({ amount: '1000', tier: 'flex', stakeId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(token.stake).not.toHaveBeenCalled();
  });

  it('refuses omit stakeId at the door so a retry cannot mint a second stake', async () => {
    const token = stubToken();
    await expect(
      createTokenRouter(token)
        .createCaller(signed())
        .stake({ amount: '1000', tier: 'flex' } as never),
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(token.stake).not.toHaveBeenCalled();
  });

  it('stakeOf/accessOf bind to the principal — no free userId', async () => {
    const token = stubToken();
    await createTokenRouter(token).createCaller(signed()).stakeOf();
    expect(token.stakeOf).toHaveBeenCalledWith(USER);
    await createTokenRouter(token).createCaller(signed()).accessOf();
    expect(token.accessOf).toHaveBeenCalledWith(USER);
  });

  it('wires stake amounts as decimal strings — never the raw scaled bigint', async () => {
    // Same class of bug #1100 sealed on /internal/stake. Amount is value×10^18;
    // Amount.toString() emits the scaled integer, and any client that
    // parseAmounts the field reads a stake 10^18× too large (fail-open).
    const staked = amt('10000');
    const operatorTier = ACCESS_TIERS.find((t) => t.name === 'Operator')!;
    const token = stubToken({
      stakeOf: vi.fn(async () => staked),
      accessOf: vi.fn(async () => ({
        staked,
        tier: operatorTier,
        feeDiscountBps: 2000,
      })),
    });

    const stakeOf = await createTokenRouter(token).createCaller(signed()).stakeOf();
    expect(stakeOf.staked).toBe(formatAmount(staked));
    expect(stakeOf.staked).toBe('10000');
    expect(stakeOf.staked).not.toBe(staked.toString());
    expect(amt(stakeOf.staked)).toBe(staked);

    const accessOf = await createTokenRouter(token).createCaller(signed()).accessOf();
    expect(accessOf.staked).toBe('10000');
    expect(accessOf.staked).not.toBe(staked.toString());
    expect(amt(accessOf.staked)).toBe(staked);
    expect(accessOf.tier).toBe('Operator');
    expect(accessOf.feeDiscountBps).toBe(2000);
  });

  it('maps table/ledger stake drift to PRECONDITION_FAILED — no discount off the table', async () => {
    const token = stubToken({
      stakeOf: vi.fn(async () => {
        throw new TokenError('table disagrees with ledger', 'token.stake_ledger_mismatch');
      }),
      accessOf: vi.fn(async () => {
        throw new TokenError('table disagrees with ledger', 'token.stake_ledger_mismatch');
      }),
    });
    await expect(createTokenRouter(token).createCaller(signed()).stakeOf()).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: userCopy('token.stake_ledger_mismatch'),
    });
    await expect(createTokenRouter(token).createCaller(signed()).accessOf()).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: userCopy('token.stake_ledger_mismatch'),
    });
  });

  it('stakes as the principal — never as a userId from the client', async () => {
    const token = stubToken();
    // Input has no userId field; if someone smuggled it, zod would strip it.
    await createTokenRouter(token)
      .createCaller(signed())
      .stake({ amount: '50', tier: 'm12', stakeId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' });

    expect(token.stake).toHaveBeenCalledWith({
      userId: USER,
      amount: amt('50'),
      tier: 'm12',
      stakeId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    });
  });

  it("refuses unstake of another user's stake", async () => {
    const token = stubToken({
      getStake: vi.fn(async () => stakeRecord({ userId: OTHER })),
      unstake: vi.fn(async () => {
        throw new Error('must not unstake');
      }),
    });

    await expect(
      createTokenRouter(token).createCaller(signed()).unstake({ stakeId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(token.unstake).not.toHaveBeenCalled();
  });

  it('unstakes an owned stake and returns the closed record', async () => {
    const token = stubToken({
      getStake: vi.fn(async () => stakeRecord()),
      unstake: vi.fn(async () => stakeRecord({ status: 'closed' })),
    });

    const result = await createTokenRouter(token).createCaller(signed()).unstake({ stakeId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' });
    expect(result.status).toBe('closed');
    expect(token.unstake).toHaveBeenCalledWith('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  });

  it('maps lock / not-found errors to the right TRPC codes (fail closed)', async () => {
    const locked = stubToken({
      getStake: vi.fn(async () => stakeRecord({ tier: 'm12' })),
      unstake: vi.fn(async () => {
        throw new TokenError('Stake is locked', 'token.stake_locked');
      }),
    });
    await expect(
      createTokenRouter(locked).createCaller(signed()).unstake({ stakeId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: userCopy('token.stake_locked') });

    const missing = stubToken({
      getStake: vi.fn(async () => null),
    });
    await expect(
      createTokenRouter(missing).createCaller(signed()).unstake({ stakeId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', message: userCopy('token.stake_not_found') });
  });
});

describe('svc-token mount — emissions', () => {
  it('refuses mintEpoch unsigned', async () => {
    const token = stubToken();
    await expect(createTokenRouter(token).createCaller(signed()).mintEpoch({})).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    expect(token.mintEpoch).not.toHaveBeenCalled();
    expect(token.mintNextEpoch).not.toHaveBeenCalled();
  });

  it('refuses mintEpoch with session admin:treasury — not a job back door', async () => {
    const token = stubToken();
    const admin = signed(principal({ scopes: ['admin:treasury'], userId: USER, mfa: true }));
    await expect(createTokenRouter(token, { emissionsEnabled: true }).createCaller(admin).mintEpoch({})).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    expect(token.mintNextEpoch).not.toHaveBeenCalled();
  });

  it('mints the next epoch for HMAC as svc-token when emissions are enabled', async () => {
    const token = stubToken();
    const result = await createTokenRouter(token, { emissionsEnabled: true }).createCaller(jobCaller()).mintEpoch({});
    expect(result).toEqual({ epoch: 0, minted: '136000' });
    expect(token.mintNextEpoch).toHaveBeenCalledOnce();
  });

  it('mints a specific epoch when HMAC as svc-token requests it', async () => {
    const token = stubToken({
      mintEpoch: vi.fn(async (epoch: number) => ({ epoch, minted: amt('68000') })),
    });
    const result = await createTokenRouter(token, { emissionsEnabled: true }).createCaller(jobCaller()).mintEpoch({ epoch: 7 });
    expect(result).toEqual({ epoch: 7, minted: '68000' });
    expect(token.mintEpoch).toHaveBeenCalledWith(7);
  });

  it('fails closed when EMISSIONS_ENABLED is off — no mint lands', async () => {
    const token = stubToken();
    await expect(
      createTokenRouter(token, { emissionsEnabled: false }).createCaller(jobCaller()).mintEpoch({ epoch: 0 }),
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
    expect(token.mintEpoch).not.toHaveBeenCalled();
    expect(token.mintNextEpoch).not.toHaveBeenCalled();
  });

  it('maps token.epoch_too_early to TOO_MANY_REQUESTS and keeps the wait-time message (next and explicit epoch)', async () => {
    const early = () => new TokenError('Epoch 1 cannot start yet: wait 3h more', 'token.epoch_too_early', 10_800_000);
    const token = stubToken({
      mintNextEpoch: vi.fn(async () => {
        throw early();
      }),
      mintEpoch: vi.fn(async () => {
        throw early();
      }),
    });
    const caller = createTokenRouter(token, { emissionsEnabled: true }).createCaller(jobCaller());
    await expect(caller.mintEpoch({})).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
      message: 'Epoch 1 cannot start yet: wait 3h more',
    });
    await expect(caller.mintEpoch({ epoch: 1 })).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
  });

  it('refuses mintEpoch HMAC as svc-trade', async () => {
    const token = stubToken();
    await expect(
      createTokenRouter(token, { emissionsEnabled: true })
        .createCaller({ ...signed(), service: 'svc-trade' })
        .mintEpoch({}),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(token.mintNextEpoch).not.toHaveBeenCalled();
  });
});

describe('svc-token mount — yield + buyback', () => {
  const RUN = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

  it('refuses yield.runWindow without HMAC', async () => {
    const runYieldWindow = vi.fn(async () => ({
      windowId: 'w1',
      distributed: amt('55'),
      recipients: 1,
      skipped: 0,
      alreadyPaid: 0,
    }));
    await expect(
      createTokenRouter(stubToken(), { runYieldWindow }).createCaller(signed()).yield.runWindow({ windowId: 'w1' }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(runYieldWindow).not.toHaveBeenCalled();
  });

  it('runs yield.runWindow for HMAC as svc-token — windowId only, no sources', async () => {
    const runYieldWindow = vi.fn(async () => ({
      windowId: 'w1',
      distributed: amt('55'),
      recipients: 1,
      skipped: 0,
      alreadyPaid: 0,
    }));
    const result = await createTokenRouter(stubToken(), { runYieldWindow }).createCaller(jobCaller()).yield.runWindow({
      windowId: 'w1',
    });
    expect(result).toEqual({ windowId: 'w1', distributed: '55', recipients: 1, skipped: 0, alreadyPaid: 0 });
    expect(runYieldWindow).toHaveBeenCalledWith({ windowId: 'w1' });
  });

  it('refuses yield.runWindow when the job is unset', async () => {
    await expect(createTokenRouter(stubToken()).createCaller(jobCaller()).yield.runWindow({ windowId: 'w1' })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      cause: { code: 'token.yield_job_unset' },
    });
  });

  it('refuses yield.runWindow with caller-typed sources', async () => {
    const runYieldWindow = vi.fn(async () => ({
      windowId: 'w1',
      distributed: amt('55'),
      recipients: 1,
      skipped: 0,
      alreadyPaid: 0,
    }));
    await expect(
      createTokenRouter(stubToken(), { runYieldWindow })
        .createCaller(jobCaller())
        .yield.runWindow({ windowId: 'w1', sources: [{ module: 'trade', amount: '999' }] } as never),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(runYieldWindow).not.toHaveBeenCalled();
  });

  it('refuses distributeRevenue without admin:treasury', async () => {
    const token = stubToken();
    await expect(
      createTokenRouter(token)
        .createCaller(signed())
        .distributeRevenue({ windowId: 'w1', sources: [{ module: 'trade', amount: '100' }] }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(token.distributeRevenue).not.toHaveBeenCalled();
  });

  it('distributes revenue for an MFA admin plus identity-issued approval', async () => {
    const token = stubToken();
    const admin = signed(principal({ scopes: ['admin:treasury'], mfa: true }));
    const result = await createTokenRouter(token, { approvals: stubApprovalConsumer(CONFIRM) })
      .createCaller(admin)
      .distributeRevenue({
        windowId: 'w1',
        sources: [{ module: 'trade', amount: '100' }],
        ...APPROVAL,
      });
    expect(result).toEqual({
      windowId: 'w1',
      distributed: '100',
      recipients: 1,
      skipped: 0,
      alreadyPaid: 0,
      confirmOperatorId: CONFIRM,
    });
    expect(token.distributeRevenue).toHaveBeenCalledWith({
      windowId: 'w1',
      sources: [{ module: 'trade', amount: amt('100') }],
    });
  });

  it('refuses to spend a source-list approval on a comma-joined lookalike before the ledger move', async () => {
    const shown = [
      { module: 'cards', amount: '100' },
      { module: 'swap', amount: '1' },
    ];
    const lookalike = [{ module: 'cards:100,swap', amount: '1' }];
    const admin = signed(principal({ scopes: ['admin:treasury'], mfa: true }));

    let shownHash = '';
    const capture: ActionApprovalConsumer = {
      async consume(input) {
        shownHash = input.payloadHash;
        return stubApprovalConsumer(CONFIRM).consume(input);
      },
    };

    const shownToken = stubToken();
    const shownResult = await createTokenRouter(shownToken, { approvals: capture })
      .createCaller(admin)
      .distributeRevenue({ windowId: 'w1', sources: shown, ...APPROVAL });
    expect(shownResult.confirmOperatorId).toBe(CONFIRM);
    expect(shownToken.distributeRevenue).toHaveBeenCalledWith({
      windowId: 'w1',
      sources: [
        { module: 'cards', amount: amt('100') },
        { module: 'swap', amount: amt('1') },
      ],
    });

    let presentedHash = '';
    const locked: ActionApprovalConsumer = {
      async consume(input) {
        presentedHash = input.payloadHash;
        if (input.payloadHash !== shownHash) {
          throw new ActionApprovalConsumeError('payload hash does not match the approved action', 'action_approval.consume_failed');
        }
        return stubApprovalConsumer(CONFIRM).consume(input);
      },
    };

    const otherToken = stubToken();
    await expect(
      createTokenRouter(otherToken, { approvals: locked })
        .createCaller(admin)
        .distributeRevenue({ windowId: 'w1', sources: lookalike, ...APPROVAL }),
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      cause: { code: 'action_approval.consume_failed' },
    });
    expect(presentedHash).not.toBe('');
    expect(presentedHash).not.toBe(shownHash);
    expect(otherToken.distributeRevenue).not.toHaveBeenCalled();
  });

  it('refuses distributeRevenue missing approval ids — typed-in confirm is not authority', async () => {
    const token = stubToken();
    const admin = signed(principal({ scopes: ['admin:treasury'], mfa: true }));
    const caller = createTokenRouter(token, { approvals: stubApprovalConsumer(CONFIRM) }).createCaller(admin);
    await expect(caller.distributeRevenue({ windowId: 'w1', sources: [{ module: 'trade', amount: '100' }] })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
    await expect(
      caller.distributeRevenue({ windowId: 'w1', sources: [{ module: 'trade', amount: '100' }], confirmOperatorId: CONFIRM }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    await expect(
      caller.distributeRevenue({ windowId: 'w1', sources: [{ module: 'trade', amount: '100' }], confirmOperatorId: USER }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(token.distributeRevenue).not.toHaveBeenCalled();
  });

  it('refuses distributeRevenue without MFA', async () => {
    const token = stubToken();
    const adminNoMfa = signed(principal({ scopes: ['admin:treasury'], mfa: false }));
    await expect(
      createTokenRouter(token)
        .createCaller(adminNoMfa)
        .distributeRevenue({ windowId: 'w1', sources: [{ module: 'trade', amount: '100' }] }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(token.distributeRevenue).not.toHaveBeenCalled();
  });

  describe('feeDiscount.publish — the owner door to the fee-decay schedule', () => {
    const LADDER = {
      basis: 'staked' as const,
      tiers: [
        { minStake: '0', discountBps: 0 },
        { minStake: '1000', discountBps: 1_000 },
      ],
    };
    const writer = () => signed(principal({ scopes: ['admin:write'] }));
    const published = (stored = 'unset') =>
      stubToken({
        feeDiscountScheduleRow: vi.fn(async () => ({ schedule: null, version: stored })),
        publishFeeDiscountSchedule: vi.fn(async () => ({ schedule: LADDER, version: 'sha256:new', previousVersion: 'unset' })),
      } as Partial<TokenService>);

    it('publishes the approved ladder over the version it replaces, and names the approver', async () => {
      const token = published();
      let seen: Parameters<ActionApprovalConsumer['consume']>[0] | null = null;
      const capture: ActionApprovalConsumer = {
        async consume(input) {
          seen = input;
          return stubApprovalConsumer(CONFIRM).consume(input);
        },
      };
      const result = await createTokenRouter(token, { approvals: capture })
        .createCaller(writer())
        .feeDiscount.publish({ schedule: LADDER, expectedVersion: 'unset', ...APPROVAL });
      expect(result).toEqual({ schedule: LADDER, version: 'sha256:new', previousVersion: 'unset', confirmOperatorId: CONFIRM });
      expect(token.publishFeeDiscountSchedule).toHaveBeenCalledWith({ schedule: LADDER, expectedVersion: 'unset' });
      expect(seen).toMatchObject({ targetService: 'svc-token', targetId: 'token.fee_discount.publish', expectedVersion: 'unset' });
    });

    it('binds the approval to the ladder and the version: a different one presents a different hash', async () => {
      const hashes: string[] = [];
      const capture: ActionApprovalConsumer = {
        async consume(input) {
          hashes.push(input.payloadHash);
          return stubApprovalConsumer(CONFIRM).consume(input);
        },
      };
      const caller = createTokenRouter(published(), { approvals: capture }).createCaller(writer());
      await caller.feeDiscount.publish({ schedule: LADDER, expectedVersion: 'unset', ...APPROVAL });
      await createTokenRouter(published('sha256:other'), { approvals: capture })
        .createCaller(writer())
        .feeDiscount.publish({ schedule: LADDER, expectedVersion: 'sha256:other', ...APPROVAL });
      await caller.feeDiscount.publish({
        schedule: { ...LADDER, tiers: [LADDER.tiers[0]!, { minStake: '1000', discountBps: 5_000 }] },
        expectedVersion: 'unset',
        ...APPROVAL,
      });
      expect(new Set(hashes).size).toBe(3);
    });

    it('refuses without admin:write, without approval ids, and when the approver is the proposer', async () => {
      const token = published();
      await expect(
        createTokenRouter(token, { approvals: stubApprovalConsumer(CONFIRM) })
          .createCaller(signed())
          .feeDiscount.publish({ schedule: LADDER, expectedVersion: 'unset', ...APPROVAL }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(
        createTokenRouter(token, { approvals: stubApprovalConsumer(CONFIRM) })
          .createCaller(writer())
          .feeDiscount.publish({ schedule: LADDER, expectedVersion: 'unset' }),
      ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', cause: { code: 'action_approval.missing' } });
      await expect(
        createTokenRouter(token, { approvals: stubApprovalConsumer(USER) })
          .createCaller(writer())
          .feeDiscount.publish({ schedule: LADDER, expectedVersion: 'unset', ...APPROVAL }),
      ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
      await expect(
        createTokenRouter(token)
          .createCaller(writer())
          .feeDiscount.publish({ schedule: LADDER, expectedVersion: 'unset', ...APPROVAL }),
      ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', cause: { code: 'action_approval.identity_unwired' } });
      expect(token.publishFeeDiscountSchedule).not.toHaveBeenCalled();
    });

    it('refuses a ladder the door would refuse before it spends the founders approval', async () => {
      const token = published();
      let consumed = 0;
      const counting: ActionApprovalConsumer = {
        async consume(input) {
          consumed += 1;
          return stubApprovalConsumer(CONFIRM).consume(input);
        },
      };
      const caller = createTokenRouter(token, { approvals: counting }).createCaller(writer());
      const falling = {
        basis: 'staked' as const,
        tiers: [
          { minStake: '0', discountBps: 2_000 },
          { minStake: '1000', discountBps: 1_000 },
        ],
      };
      await expect(caller.feeDiscount.publish({ schedule: falling, expectedVersion: 'unset', ...APPROVAL })).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: expect.stringContaining('tiers[1].discountBps must not be below'),
      });
      // Not a decimal, or more places than the ledger keeps: refused by name, not a server error.
      for (const minStake of ['abc', '1,000', '0.0000000000000000001']) {
        await expect(
          caller.feeDiscount.publish({
            schedule: { basis: 'staked', tiers: [LADDER.tiers[0]!, { minStake, discountBps: 1_000 }] },
            expectedVersion: 'unset',
            ...APPROVAL,
          }),
        ).rejects.toMatchObject({ code: 'BAD_REQUEST', cause: { code: 'token.fee_discount_invalid' } });
      }
      // A field the door does not store is refused, not dropped from the approval and the row.
      await expect(
        caller.feeDiscount.publish({
          schedule: { ...LADDER, effectiveAt: '2026-11-01T00:00:00.000Z' } as typeof LADDER,
          expectedVersion: 'unset',
          ...APPROVAL,
        }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      expect(consumed).toBe(0);
      expect(token.publishFeeDiscountSchedule).not.toHaveBeenCalled();
    });

    it('answers a stale version as a conflict and a bad ladder with the step that is wrong', async () => {
      const replaced = published('sha256:newer');
      let consumed = 0;
      await expect(
        createTokenRouter(replaced, {
          approvals: {
            async consume(input) {
              consumed += 1;
              return stubApprovalConsumer(CONFIRM).consume(input);
            },
          },
        })
          .createCaller(writer())
          .feeDiscount.publish({ schedule: LADDER, expectedVersion: 'unset', ...APPROVAL }),
      ).rejects.toMatchObject({ code: 'CONFLICT', cause: { code: 'token.fee_discount_stale' } });
      expect(consumed).toBe(0);
      expect(replaced.publishFeeDiscountSchedule).not.toHaveBeenCalled();
      // Lost the race after the check: the write refuses under its lock.
      const stale = stubToken({
        feeDiscountScheduleRow: vi.fn(async () => ({ schedule: null, version: 'unset' })),
        publishFeeDiscountSchedule: vi.fn(async () => {
          throw new TokenError('expectedVersion unset is stale', 'token.fee_discount_stale');
        }),
      } as Partial<TokenService>);
      await expect(
        createTokenRouter(stale, { approvals: stubApprovalConsumer(CONFIRM) })
          .createCaller(writer())
          .feeDiscount.publish({ schedule: LADDER, expectedVersion: 'unset', ...APPROVAL }),
      ).rejects.toMatchObject({ code: 'CONFLICT', message: userCopy('token.fee_discount_stale') });
      const invalid = stubToken({
        feeDiscountScheduleRow: vi.fn(async () => ({ schedule: null, version: 'unset' })),
        publishFeeDiscountSchedule: vi.fn(async () => {
          throw new TokenError('fee_discount_schedule.tiers[1].minStake must be above the step before it', 'token.fee_discount_invalid');
        }),
      } as Partial<TokenService>);
      await expect(
        createTokenRouter(invalid, { approvals: stubApprovalConsumer(CONFIRM) })
          .createCaller(writer())
          .feeDiscount.publish({ schedule: LADDER, expectedVersion: 'unset', ...APPROVAL }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: expect.stringContaining('tiers[1].minStake') });
    });

    it('reads the stored ladder and its version for a token reader or an operator', async () => {
      const token = stubToken({
        feeDiscountScheduleRow: vi.fn(async () => ({ schedule: LADDER, version: 'sha256:abc' })),
      } as Partial<TokenService>);
      await expect(createTokenRouter(token).createCaller(signed()).feeDiscount.get()).resolves.toEqual({
        schedule: LADDER,
        version: 'sha256:abc',
      });
      await expect(
        createTokenRouter(token)
          .createCaller(signed(principal({ scopes: ['admin:read'], tier: 'none' })))
          .feeDiscount.get(),
      ).resolves.toMatchObject({ version: 'sha256:abc' });
      await expect(createTokenRouter(token).createCaller(anonymous()).feeDiscount.get()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
      await expect(
        createTokenRouter(token)
          .createCaller(signed(principal({ scopes: ['trade:read'] })))
          .feeDiscount.get(),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });
  });

  it('refuses buyback.runWindow without HMAC', async () => {
    const runBuybackWindow = vi.fn(async () => ({
      runId: RUN,
      tokensBought: amt('10'),
      burned: amt('6'),
      toRewards: amt('4'),
    }));
    await expect(
      createTokenRouter(stubToken(), { runBuybackWindow })
        .createCaller(signed())
        .buyback.runWindow({
          runId: RUN,
          revenueWindow: { from: '2026-07-01T00:00:00.000Z', to: '2026-07-08T00:00:00.000Z' },
        }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(runBuybackWindow).not.toHaveBeenCalled();
  });

  it('runs buyback.runWindow for HMAC as svc-token — no tokensBought input', async () => {
    const runBuybackWindow = vi.fn(async () => ({
      runId: RUN,
      tokensBought: amt('10'),
      burned: amt('6'),
      toRewards: amt('4'),
    }));
    const result = await createTokenRouter(stubToken(), { runBuybackWindow })
      .createCaller(jobCaller())
      .buyback.runWindow({
        runId: RUN,
        revenueWindow: { from: '2026-07-01T00:00:00.000Z', to: '2026-07-08T00:00:00.000Z' },
      });
    expect(result).toEqual({ runId: RUN, tokensBought: '10', burned: '6', toRewards: '4' });
    expect(runBuybackWindow).toHaveBeenCalledWith({
      runId: RUN,
      revenueWindow: { from: new Date('2026-07-01T00:00:00.000Z'), to: new Date('2026-07-08T00:00:00.000Z') },
    });
  });

  it('refuses buyback.runWindow when the job is unset', async () => {
    await expect(
      createTokenRouter(stubToken())
        .createCaller(jobCaller())
        .buyback.runWindow({
          runId: RUN,
          revenueWindow: { from: '2026-07-01T00:00:00.000Z', to: '2026-07-08T00:00:00.000Z' },
        }),
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      cause: { code: 'token.buyback_job_unset' },
    });
  });

  it('refuses buyback.runWindow with caller-typed tokensBought', async () => {
    const runBuybackWindow = vi.fn(async () => ({
      runId: RUN,
      tokensBought: amt('10'),
      burned: amt('6'),
      toRewards: amt('4'),
    }));
    await expect(
      createTokenRouter(stubToken(), { runBuybackWindow })
        .createCaller(jobCaller())
        .buyback.runWindow({
          runId: RUN,
          revenueWindow: { from: '2026-07-01T00:00:00.000Z', to: '2026-07-08T00:00:00.000Z' },
          tokensBought: '999',
        } as never),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(runBuybackWindow).not.toHaveBeenCalled();
  });

  it('refuses recordBuyback without admin:treasury', async () => {
    const token = stubToken();
    await expect(
      createTokenRouter(token)
        .createCaller(signed())
        .recordBuyback({
          runId: RUN,
          revenueWindow: { from: '2026-07-01T00:00:00.000Z', to: '2026-07-08T00:00:00.000Z' },
          revenueTotal: { IFC: '1000' },
          tokensBought: '100',
        }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(token.recordBuyback).not.toHaveBeenCalled();
  });

  it('records a buyback for an MFA admin plus identity-issued approval', async () => {
    const token = stubToken();
    const admin = signed(principal({ scopes: ['admin:treasury'], mfa: true }));
    const result = await createTokenRouter(token, { approvals: stubApprovalConsumer(CONFIRM) })
      .createCaller(admin)
      .recordBuyback({
        runId: RUN,
        revenueWindow: { from: '2026-07-01T00:00:00.000Z', to: '2026-07-08T00:00:00.000Z' },
        revenueTotal: { IFC: '1000' },
        tokensBought: '100',
        ...APPROVAL,
      });
    expect(result).toEqual({ runId: RUN, burned: '50', toRewards: '50', confirmOperatorId: CONFIRM });
    expect(token.recordBuyback).toHaveBeenCalledWith({
      runId: RUN,
      revenueWindow: {
        from: new Date('2026-07-01T00:00:00.000Z'),
        to: new Date('2026-07-08T00:00:00.000Z'),
      },
      revenueTotal: { IFC: '1000' },
      tokensBought: amt('100'),
    });
  });

  it('refuses recordBuyback missing approval ids — typed-in confirm is not authority', async () => {
    const token = stubToken();
    const admin = signed(principal({ scopes: ['admin:treasury'], mfa: true }));
    const caller = createTokenRouter(token, { approvals: stubApprovalConsumer(CONFIRM) }).createCaller(admin);
    const body = {
      runId: RUN,
      revenueWindow: { from: '2026-07-01T00:00:00.000Z', to: '2026-07-08T00:00:00.000Z' },
      revenueTotal: { IFC: '1000' },
      tokensBought: '100',
    };
    await expect(caller.recordBuyback(body)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    await expect(caller.recordBuyback({ ...body, confirmOperatorId: CONFIRM })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
    await expect(caller.recordBuyback({ ...body, confirmOperatorId: USER })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
    expect(token.recordBuyback).not.toHaveBeenCalled();
  });

  it('refuses recordBuyback without MFA even when admin:treasury is present', async () => {
    const token = stubToken();
    const adminNoMfa = signed(principal({ scopes: ['admin:treasury'], mfa: false }));
    await expect(
      createTokenRouter(token)
        .createCaller(adminNoMfa)
        .recordBuyback({
          runId: RUN,
          revenueWindow: { from: '2026-07-01T00:00:00.000Z', to: '2026-07-08T00:00:00.000Z' },
          revenueTotal: { IFC: '1000' },
          tokensBought: '100',
        }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(token.recordBuyback).not.toHaveBeenCalled();
  });

  it('rejects a non-ordered revenue window without calling the service', async () => {
    const token = stubToken();
    const admin = signed(principal({ scopes: ['admin:treasury'], mfa: true }));
    await expect(
      createTokenRouter(token)
        .createCaller(admin)
        .recordBuyback({
          runId: RUN,
          revenueWindow: { from: '2026-07-08T00:00:00.000Z', to: '2026-07-01T00:00:00.000Z' },
          revenueTotal: { IFC: '1000' },
          tokensBought: '100',
          confirmOperatorId: CONFIRM,
        }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(token.recordBuyback).not.toHaveBeenCalled();
  });

  it('serves burnedSupply to a token:read principal', async () => {
    const token = stubToken({ burnedSupply: vi.fn(async () => amt('42')) });
    const result = await createTokenRouter(token).createCaller(signed()).burnedSupply();
    expect(result).toEqual({ burned: '42' });
  });
});

describe('svc-token mount — governance close', () => {
  const PID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

  it('refuses closeProposal without token:stake', async () => {
    const token = stubToken();
    await expect(
      createTokenRouter(token)
        .createCaller(signed(principal({ scopes: ['token:read'] })))
        .closeProposal({ proposalId: PID }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(token.closeProposal).not.toHaveBeenCalled();
  });

  it('closes and returns passed|rejected as decimal tally strings', async () => {
    const token = stubToken();
    const result = await createTokenRouter(token).createCaller(signed()).closeProposal({ proposalId: PID });
    expect(result.status).toBe('passed');
    expect(result.tally.forWeight).toBe('1000');
    expect(result.execute).toBeNull();
    expect(token.closeProposal).toHaveBeenCalledWith({ proposalId: PID });
  });

  it('maps quorum unset to PRECONDITION_FAILED', async () => {
    const token = stubToken({
      closeProposal: vi.fn(async () => {
        throw new TokenError('Governance quorum/threshold is unset', 'token.governance_quorum_unset');
      }),
    });
    await expect(createTokenRouter(token).createCaller(signed()).closeProposal({ proposalId: PID })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      cause: { code: 'token.governance_quorum_unset' },
    });
  });

  it('returns token.governance_execute_unwired on grant close without inventing a transfer', async () => {
    const token = stubToken({
      closeProposal: vi.fn(async () => ({
        id: PID,
        kind: 'grant' as const,
        body: { amount: '999' },
        status: 'passed' as const,
        opensAt: new Date('2026-07-15T00:00:00.000Z'),
        closesAt: new Date('2026-07-22T00:00:00.000Z'),
        createdAt: new Date('2026-07-15T00:00:00.000Z'),
        title: null,
        bodyMd: null,
        discussionLink: null,
        businessKey: null,
        authorId: null,
        revision: 1,
        votingType: 'basic' as const,
        choices: null,
        snapshot: null,
        ranking: null,
        choiceTally: null,
        counts: { votes: 1, for: 1, against: 0, abstain: 0 },
        tally: {
          forWeight: amt('1000'),
          againstWeight: amt('0'),
          abstainWeight: amt('0'),
          totalWeight: amt('1000'),
          voterCount: 1,
        },
        execute: 'token.governance_execute_unwired' as const,
      })),
    });
    const result = await createTokenRouter(token).createCaller(signed()).closeProposal({ proposalId: PID });
    expect(result.status).toBe('passed');
    expect(result.execute).toBe('token.governance_execute_unwired');
  });

  it('listProposals omit is PRECONDITION_FAILED — never invents a 50-row page', async () => {
    const token = stubToken({
      listProposals: async (input: { limit?: number } = {}) => {
        assertProposalListLimit(input.limit);
        return [];
      },
    });
    const caller = createTokenRouter(token).createCaller(signed(principal({ scopes: ['token:read'] })));
    await expect(caller.listProposals({})).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: userCopy('token.proposal_list_limit_unset'),
    });
    await expect(caller.listProposals()).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: userCopy('token.proposal_list_limit_unset'),
    });
    expect(userCopy('token.proposal_list_limit_unset')).not.toMatch(/50/);
    await expect(caller.listProposals({ limit: 50 })).resolves.toEqual([]);
  });

  it('does not let a reader open another author draft', () => {
    const procedures = createTokenRouter(stubToken())._def.procedures as Record<string, unknown>;
    expect(procedures.openDueProposals).toBeUndefined();
  });
});

describe('svc-token mount — the public surface', () => {
  it('serves health to an anonymous caller', async () => {
    await expect(createTokenRouter(stubToken()).createCaller(anonymous()).health()).resolves.toEqual({
      ok: true,
      service: 'svc-token',
    });
  });

  it('lists stakes for the signed principal', async () => {
    const token = stubToken();
    const list = await createTokenRouter(token).createCaller(signed()).listStakes({ status: 'active', limit: 50 });
    expect(list).toHaveLength(1);
    expect(list[0]?.amount).toBe('1000');
    expect(token.listStakes).toHaveBeenCalledWith(USER, 'active', 50);
  });

  it('listStakes omit is PRECONDITION_FAILED — never invents a 50-row page', async () => {
    const token = stubToken({
      listStakes: async (_userId: string, _status?: 'active' | 'closed' | 'pending' | 'all', limit?: number) => {
        assertStakesListLimit(limit);
        return [];
      },
    });
    const caller = createTokenRouter(token).createCaller(signed(principal({ scopes: ['token:read'] })));
    await expect(caller.listStakes({ status: 'active' })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: userCopy('token.stakes_list_limit_unset'),
    });
    await expect(caller.listStakes()).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: userCopy('token.stakes_list_limit_unset'),
    });
    expect(userCopy('token.stakes_list_limit_unset')).not.toMatch(/50/);
    await expect(caller.listStakes({ limit: 50 })).resolves.toEqual([]);
  });
});

describe('svc-token mount — owner reads', () => {
  const STAKE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

  function reader() {
    return createTokenRouter(stubToken()).createCaller(signed(principal({ scopes: ['token:read'] })));
  }

  it('refuses a session without token:read', async () => {
    const token = stubToken({
      previewUnstake: vi.fn(),
      yieldHistory: vi.fn(),
      revenueShareHistory: vi.fn(),
      myVotes: vi.fn(),
      emissionSchedule: vi.fn(),
    });
    const caller = createTokenRouter(token).createCaller(signed(principal({ scopes: ['token:stake'] })));
    await expect(caller.terms()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(caller.stakePreview({ amount: '1', tier: 'flex' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(caller.unstakePreview({ stakeId: STAKE })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(caller.yieldHistory({ limit: 10 })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(caller.revenueShareHistory({ limit: 10 })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(caller.myVotes({ limit: 10 })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(caller.emissionSchedule({ count: 2 })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(token.previewUnstake).not.toHaveBeenCalled();
    expect(token.yieldHistory).not.toHaveBeenCalled();
    expect(token.revenueShareHistory).not.toHaveBeenCalled();
    expect(token.myVotes).not.toHaveBeenCalled();
    expect(token.emissionSchedule).not.toHaveBeenCalled();
  });

  it('publishes stake tiers from STAKE_TIERS and the staking asset only when TOKEN_ASSET_ID is set', async () => {
    const previous = process.env.TOKEN_ASSET_ID;
    try {
      delete process.env.TOKEN_ASSET_ID;
      const unpublished = await reader().terms();
      expect(unpublished.stakingAsset).toEqual({
        published: false,
        assetId: null,
        reason: 'staking_asset_unpublished',
      });
      expect(unpublished.tiers.map((tier) => [tier.name, tier.lockDays, tier.multiplierBps])).toEqual(
        (['flex', 'm3', 'm12'] as const).map((name) => [name, STAKE_TIERS[name].lockDays, STAKE_TIERS[name].multiplierBps]),
      );
      expect(unpublished.tiers.every((tier) => tier.minimumStake === null && tier.minimumStakeReason === 'stake_minimum_unpublished')).toBe(
        true,
      );

      process.env.TOKEN_ASSET_ID = '  TST  ';
      const published = await reader().terms();
      expect(published.stakingAsset).toEqual({ published: true, assetId: 'TST' });

      process.env.TOKEN_ASSET_ID = '   ';
      const blank = await reader().terms();
      expect(blank.stakingAsset.published).toBe(false);
      expect(blank.stakingAsset).not.toHaveProperty('assetId', 'IFC');
    } finally {
      if (previous === undefined) delete process.env.TOKEN_ASSET_ID;
      else process.env.TOKEN_ASSET_ID = previous;
    }
  });

  it('refuses stakePreview for an unknown tier or an unpublished asset', async () => {
    const previous = process.env.TOKEN_ASSET_ID;
    try {
      delete process.env.TOKEN_ASSET_ID;
      await expect(reader().stakePreview({ amount: '1', tier: 'm3' })).rejects.toMatchObject({
        code: 'PRECONDITION_FAILED',
        message: userCopy('token.staking_asset_unpublished'),
      });
      process.env.TOKEN_ASSET_ID = 'TST';
      await expect(reader().stakePreview({ amount: '1', tier: 'nope' })).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: userCopy('token.stake_tier_unknown'),
      });
      const preview = await reader().stakePreview({ amount: '2', tier: 'flex' });
      expect(preview.multiplierBps).toBe(STAKE_TIERS.flex.multiplierBps);
      expect(preview.unlocksAt).toBeNull();
    } finally {
      if (previous === undefined) delete process.env.TOKEN_ASSET_ID;
      else process.env.TOKEN_ASSET_ID = previous;
    }
  });
});

describe('governance settings and roles — the founders doors (MC-token-02)', () => {
  const writer = () => signed(principal({ scopes: ['admin:write'] }));
  const governed = () =>
    stubToken({
      setGovernanceSettings: vi.fn(async (input) => ({
        votingDelayMs: input.votingDelayMs,
        votingPeriodMs: input.votingPeriodMs,
        revision: input.expectedRevision + 1,
      })),
      setGovernanceRole: vi.fn(async (input) => ({ userId: input.userId, role: input.role, revision: input.expectedRevision + 1 })),
      cancelProposal: vi.fn(),
    } as Partial<TokenService>);

  it('writes the approved pair over its revision, binds the approval to exactly it, and names the approver', async () => {
    const token = governed();
    const seen: Array<Parameters<ActionApprovalConsumer['consume']>[0]> = [];
    const capture: ActionApprovalConsumer = {
      async consume(input) {
        seen.push(input);
        return stubApprovalConsumer(CONFIRM).consume(input);
      },
    };
    const caller = createTokenRouter(token, { approvals: capture }).createCaller(writer());
    const result = await caller.governance.setSettings({
      votingDelayMs: '0',
      votingPeriodMs: '86400000',
      expectedRevision: 0,
      ...APPROVAL,
    });
    expect(result).toEqual({ votingDelayMs: '0', votingPeriodMs: '86400000', revision: 1, confirmOperatorId: CONFIRM });
    expect(token.setGovernanceSettings).toHaveBeenCalledWith({
      votingDelayMs: 0n,
      votingPeriodMs: 86_400_000n,
      expectedRevision: 0,
      actorId: USER,
      approverId: CONFIRM,
    });
    expect(seen[0]).toMatchObject({ targetService: 'svc-token', targetId: 'token.governance.settings.set', expectedVersion: '0' });
    await caller.governance.setSettings({ votingDelayMs: null, votingPeriodMs: '86400000', expectedRevision: 0, ...APPROVAL });
    await caller.governance.setSettings({ votingDelayMs: '0', votingPeriodMs: '86400000', expectedRevision: 1, ...APPROVAL });
    expect(new Set(seen.map((s) => s.payloadHash)).size).toBe(3);
  });

  it('refuses one founder alone, a missing approval, a reader, and a pair the door refuses before the approval is spent', async () => {
    const token = governed();
    const input = { votingDelayMs: '0', votingPeriodMs: '86400000', expectedRevision: 0, ...APPROVAL };
    await expect(
      createTokenRouter(token, { approvals: stubApprovalConsumer(USER) })
        .createCaller(writer())
        .governance.setSettings(input),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    await expect(
      createTokenRouter(token, { approvals: stubApprovalConsumer(CONFIRM) })
        .createCaller(writer())
        .governance.setSettings({ votingDelayMs: '0', votingPeriodMs: '86400000', expectedRevision: 0 }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', cause: { code: 'action_approval.missing' } });
    await expect(
      createTokenRouter(token, { approvals: stubApprovalConsumer(CONFIRM) })
        .createCaller(signed())
        .governance.setSettings(input),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    let consumed = 0;
    const counting: ActionApprovalConsumer = {
      async consume(i) {
        consumed += 1;
        return stubApprovalConsumer(CONFIRM).consume(i);
      },
    };
    await expect(
      createTokenRouter(token, { approvals: counting })
        .createCaller(writer())
        .governance.setSettings({ ...input, votingPeriodMs: '0' }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', cause: { code: 'token.settings_invalid' } });
    expect(consumed).toBe(0);
    expect(token.setGovernanceSettings).not.toHaveBeenCalled();
  });

  it('a role change is the same two-founder door and never names the founder who asks', async () => {
    const token = governed();
    const caller = createTokenRouter(token, { approvals: stubApprovalConsumer(CONFIRM) }).createCaller(writer());
    expect(await caller.governance.setRole({ userId: OTHER, role: 'moderator', expectedRevision: 0, ...APPROVAL })).toEqual({
      userId: OTHER,
      role: 'moderator',
      revision: 1,
      confirmOperatorId: CONFIRM,
    });
    await expect(caller.governance.setRole({ userId: USER, role: 'admin', expectedRevision: 0, ...APPROVAL })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      cause: { code: 'token.role_invalid' },
    });
    await expect(
      createTokenRouter(token, { approvals: stubApprovalConsumer(USER) })
        .createCaller(writer())
        .governance.setRole({ userId: OTHER, role: 'moderator', expectedRevision: 0, ...APPROVAL }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(token.setGovernanceRole).toHaveBeenCalledTimes(1);
  });

  it('a cancel refused for the role is FORBIDDEN, and needs a signed principal', async () => {
    const token = governed();
    vi.mocked(token.cancelProposal).mockRejectedValue(new TokenError('no', 'token.permission_denied'));
    await expect(
      createTokenRouter(token).createCaller(signed()).governance.cancel({ proposalId: 'gov:proposal:x', reason: 'A duplicate proposal' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', message: userCopy('token.permission_denied') });
    await expect(
      createTokenRouter(token).createCaller(forged()).governance.cancel({ proposalId: 'gov:proposal:x', reason: 'A duplicate proposal' }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });
});
