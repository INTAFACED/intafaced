import { describe, expect, it, vi } from 'vitest';
import { partial } from '@intafaced/service-kit/testing';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { MemoryEventBus } from '@intafaced/events';
import { MemoryLedger, formatAmount, parseAmount as amt } from '@intafaced/ledger-client';
import { DEFAULT_BUYBACK_PARAMS } from './economics/buyback.js';
import { DEFAULT_EMISSION_PARAMS } from './economics/emission.js';
import { createTokenRouter } from './router.js';
import { recordingSql } from './sql-recorder.testkit.js';
import { TokenService, type StakeRecord } from './token-service.js';

const EDGE_SECRET = 'a-token-stake-id-pin-edge-secret-long-enough';
const USER = '11111111-1111-4111-8111-111111111111';
const STAKE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const edgeContext = createEdgeContext({ secret: EDGE_SECRET, serviceName: 'svc-token' });

function staker() {
  const raw = encodePrincipal({
    sub: USER,
    userId: USER,
    sid: '33333333-3333-4333-8333-333333333333',
    scopes: ['token:read', 'token:stake'],
    tier: 'basic',
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
  } as Principal);
  return edgeContext({
    headers: {
      'x-intafaced-principal': raw,
      'x-intafaced-principal-sig': signPrincipalHeader(raw, EDGE_SECRET, 'DE'),
      'x-intafaced-region': 'DE',
    },
    id: 'req-stake-id',
  });
}

function service(sql: ReturnType<typeof recordingSql>['sql'], loadParamsFromDb = false) {
  const ledger = new MemoryLedger();
  const post = vi.spyOn(ledger, 'post');
  const token = new TokenService(sql, ledger, new MemoryEventBus('svc-token'), {
    assetId: 'IFC',
    emission: DEFAULT_EMISSION_PARAMS,
    buyback: DEFAULT_BUYBACK_PARAMS,
    loadParamsFromDb,
    feeScheduleTtlMs: 0,
  });
  return { token, post };
}

describe('token.stake requires a caller stakeId', () => {
  it('does not mint a UUID on stake: a blank or missing stakeId refuses before any claim or ledger post', async () => {
    const { sql, queries } = recordingSql();
    const { token, post } = service(sql);
    for (const stakeId of ['', '   ', undefined]) {
      await expect(token.stake({ userId: USER, amount: amt('10'), tier: 'flex', stakeId: stakeId as string })).rejects.toMatchObject({
        code: 'token.stake_id_required',
      });
    }
    expect(queries).toEqual([]);
    expect(post).not.toHaveBeenCalled();
  });

  it('a given stakeId is the claim key the service writes, trimmed, never replaced', async () => {
    const { sql, queries } = recordingSql(() => {
      throw new Error('stop after the claim');
    });
    const { token } = service(sql);
    await expect(token.stake({ userId: USER, amount: amt('10'), tier: 'flex', stakeId: `  ${STAKE_ID}  ` })).rejects.toThrow(
      'stop after the claim',
    );
    expect(queries.length).toBeGreaterThan(0);
    expect(queries[0]!.values).toContain(STAKE_ID);
  });

  it('router stake input requires stakeId uuid and hands it to the service unchanged', async () => {
    const stake = vi.fn(async (input: { userId: string; amount: bigint; tier: 'flex'; stakeId: string }): Promise<StakeRecord> => ({
      id: input.stakeId,
      userId: input.userId,
      amount: input.amount,
      tier: input.tier,
      startedAt: new Date('2026-07-01T00:00:00.000Z'),
      unlocksAt: null,
      status: 'active',
    }));
    const caller = createTokenRouter(partial<TokenService>({ stake })).createCaller(staker());
    await expect(caller.stake({ amount: '10', tier: 'flex' } as never)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(caller.stake({ amount: '10', tier: 'flex', stakeId: undefined } as never)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    await expect(caller.stake({ amount: '10', tier: 'flex', stakeId: 'not-a-uuid' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(stake).not.toHaveBeenCalled();

    const staked = await caller.stake({ amount: '10', tier: 'flex', stakeId: STAKE_ID });
    expect(staked.id).toBe(STAKE_ID);
    expect(stake).toHaveBeenCalledTimes(1);
    expect(stake.mock.calls[0]![0]).toMatchObject({ userId: USER, stakeId: STAKE_ID, tier: 'flex' });
    expect(formatAmount(stake.mock.calls[0]![0].amount)).toBe('10');
  });

  it('emission curve initialEpochReward is a decimal string, not a JSON number', async () => {
    const row = (initialEpochReward: unknown) => [
      { total_supply: '1000000000', halving_interval: 210, emission_curve: { initialEpochReward } },
    ];
    const answer = (initialEpochReward: unknown) => recordingSql(() => row(initialEpochReward)).sql;

    await expect(service(answer(68000), true).token.emissionParams()).rejects.toMatchObject({
      code: 'token.params_invalid',
      message: 'token_params.emission_curve.initialEpochReward must be a decimal string, not a JSON number',
    });
    for (const odd of [true, null, '  ', { amount: '1' }]) {
      await expect(service(answer(odd), true).token.emissionParams()).rejects.toMatchObject({ code: 'token.params_unset' });
    }
    const params = await service(answer('68000'), true).token.emissionParams();
    expect(formatAmount(params.initialEpochReward)).toBe('68000');
    expect(params.halvingIntervalEpochs).toBe(210);
    expect(formatAmount(params.maxSupply)).toBe('1000000000');
  });
});
