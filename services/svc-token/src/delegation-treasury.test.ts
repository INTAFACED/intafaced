import { describe, expect, it, vi } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { MemoryEventBus } from '@intafaced/events';
import { burnAccount, parseAmount, type LedgerClient } from '@intafaced/ledger-client';
import { DEFAULT_BUYBACK_PARAMS } from './economics/buyback.js';
import { DEFAULT_EMISSION_PARAMS } from './economics/emission.js';
import { recordingSql } from './sql-recorder.testkit.js';
import { DELEGATION_BLOCKER, DELEGATION_UNAVAILABLE, refuseDelegation, unavailableDelegation } from './delegation.js';
import { createTokenRouter } from './router.js';
import { TokenError, TokenService } from './token-service.js';
import { reportLastBuyback, reportTreasury, type TreasurySums } from './treasury-view.js';
import { userCopy } from './user-copy.js';

/**
 * MC-token-04. Delegation is unavailable because there is no chain service
 * and no on-chain delegate registry (`no_chain_service`). Nothing is stored.
 * Treasury sums are rows this service already recorded: no rows is null, not
 * zero. `burned` is filled by the service from `burnedSupply`, not this fold.
 */

const SECRET = 'a-token-delegation-test-edge-secret-long-enough';
const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-token' });

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    sub: USER,
    userId: USER,
    sid: '33333333-3333-4333-8333-333333333333',
    scopes: ['token:read', 'token:stake'],
    tier: 'basic',
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
    ...overrides,
  } as Principal;
}

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

const anonymous = () => edgeContext({ headers: { 'x-intafaced-region': 'DE' }, id: 'req-anon' });

function emptySums(overrides: Partial<TreasurySums> = {}): TreasurySums {
  return {
    minted: null,
    mintedCount: '0',
    bought: null,
    boughtCount: '0',
    toRewards: null,
    toRewardsCount: '0',
    distributed: null,
    distributedCount: '0',
    ...overrides,
  };
}

const emptyView = {
  minted: null,
  bought: null,
  toRewards: null,
  distributed: null,
};

describe('delegation unavailable', () => {
  it('reads null and names the chain-service blocker', () => {
    expect(unavailableDelegation()).toEqual({ delegateeUserId: null, blocker: DELEGATION_BLOCKER });
    expect(unavailableDelegation()).toEqual(unavailableDelegation());
  });

  it('refuses a blank target before the chain blocker, and does not keep it', () => {
    for (const blank of [undefined, null, '', '   ']) {
      expect(() => refuseDelegation(blank)).toThrow(TokenError);
      try {
        refuseDelegation(blank);
      } catch (err) {
        expect((err as TokenError).code).toBe('token.delegation_delegatee_unset');
        expect(userCopy((err as TokenError).code)).toBe('The person to delegate to is not set.');
      }
    }
  });

  it('refuses a non-member target and does not treat it as a chain address to store', () => {
    try {
      refuseDelegation('0xabc');
      throw new Error('expected refuse');
    } catch (err) {
      expect((err as TokenError).code).toBe('token.delegation_delegatee_invalid');
      expect(userCopy((err as TokenError).code)).toBe('That delegation target is not a member.');
    }
  });

  it('refuses a member id, including the caller, and two calls still store nothing', () => {
    const seen: Array<{ code: string; blocker?: string }> = [];
    for (const id of [OTHER, USER, `  ${OTHER}  `]) {
      try {
        refuseDelegation(id);
      } catch (err) {
        const tokenErr = err as TokenError;
        seen.push({ code: tokenErr.code, blocker: tokenErr.blocker });
      }
    }
    expect(seen).toEqual([
      { code: DELEGATION_UNAVAILABLE, blocker: 'no_chain_service' },
      { code: DELEGATION_UNAVAILABLE, blocker: 'no_chain_service' },
      { code: DELEGATION_UNAVAILABLE, blocker: 'no_chain_service' },
    ]);
    expect(userCopy(DELEGATION_UNAVAILABLE)).toBe('There is no chain service and no on-chain delegate registry.');
  });
});

describe('treasury view', () => {
  it('is null on every figure when this service has no rows', () => {
    expect(reportTreasury(emptySums())).toEqual({ ok: true, view: emptyView });
  });

  it('canonicalises a recorded total and keeps a recorded zero', () => {
    const reported = reportTreasury(
      emptySums({
        minted: '10.500',
        mintedCount: '2',
        bought: '0.0',
        boughtCount: '1',
        toRewards: '0',
        toRewardsCount: '1',
        distributed: '3.250000000000000000',
        distributedCount: '4',
      }),
    );
    expect(reported).toEqual({
      ok: true,
      view: { minted: '10.5', bought: '0', toRewards: '0', distributed: '3.25' },
    });
  });

  it('last buyback is null when no run is settled, and a recorded zero stays zero', () => {
    expect(reportLastBuyback(null)).toEqual({ ok: true, last: null });
    expect(reportLastBuyback({ bought: null, burned: null, toRewards: null, executedAt: null })).toEqual({ ok: true, last: null });
    expect(
      reportLastBuyback({
        bought: '5.0',
        burned: '0',
        toRewards: '0.0',
        executedAt: new Date('2026-06-01T00:00:00.000Z'),
      }),
    ).toEqual({
      ok: true,
      last: { bought: '5', burned: '0', toRewards: '0', executedAt: '2026-06-01T00:00:00.000Z' },
    });
  });

  it('refuses a partial or unreadable last buyback instead of zero', () => {
    expect(reportLastBuyback({ bought: '1', burned: null, toRewards: '0', executedAt: '2026-06-01T00:00:00.000Z' }).ok).toBe(false);
    expect(reportLastBuyback({ bought: '-1', burned: '1', toRewards: '0', executedAt: '2026-06-01T00:00:00.000Z' }).ok).toBe(false);
    expect(reportLastBuyback({ bought: '1', burned: '1', toRewards: '0', executedAt: 'not-a-date' }).ok).toBe(false);
    expect(reportLastBuyback({ bought: '-1', burned: null, toRewards: null, executedAt: null }).ok).toBe(false);
  });

  it('refuses a blank, negative, or mismatched total instead of zero', () => {
    expect(reportTreasury(emptySums({ minted: null, mintedCount: '1' })).ok).toBe(false);
    expect(reportTreasury(emptySums({ minted: '  ', mintedCount: '1' })).ok).toBe(false);
    expect(reportTreasury(emptySums({ minted: '-1', mintedCount: '1' })).ok).toBe(false);
    expect(reportTreasury(emptySums({ minted: '5', mintedCount: '0' })).ok).toBe(false);
    expect(reportTreasury(emptySums({ mintedCount: 'no' })).ok).toBe(false);
    expect(userCopy('token.treasury_figure_unreadable')).toBe('A treasury figure recorded by this service could not be read.');
  });

  it('the service query does not read the ledger or a price', async () => {
    // The sums are rows this service recorded; the one ledger read is the burn account's balance.
    const { sql, queries } = recordingSql(() => [
      {
        minted: '10.5',
        minted_count: '2',
        bought: '17',
        to_rewards: '9',
        settled_count: '3',
        distributed: '3.25',
        distributed_count: '4',
        last_bought: '5',
        last_burned: '3',
        last_to_rewards: '2',
        last_executed_at: '2026-06-01T00:00:00.000Z',
      },
    ]);
    const asked: string[] = [];
    const ledger = new Proxy({} as LedgerClient, {
      get: (_target, method: string) =>
        method === 'balance'
          ? async (account: unknown) => {
              asked.push(`balance ${JSON.stringify(account)}`);
              return { amount: parseAmount('7') };
            }
          : () => {
              asked.push(method);
              throw new Error(`treasuryView must not call ledger.${method}`);
            },
    });
    const token = new TokenService(sql, ledger, new MemoryEventBus('svc-token'), {
      assetId: 'IFC',
      emission: DEFAULT_EMISSION_PARAMS,
      buyback: DEFAULT_BUYBACK_PARAMS,
      loadParamsFromDb: false,
    });
    const view = await token.treasuryView();
    expect(view).toEqual({
      minted: '10.5',
      bought: '17',
      toRewards: '9',
      distributed: '3.25',
      // burned is the burn account, not a sum of the runs' recorded burns.
      burned: '7',
      lastBuyback: { bought: '5', burned: '3', toRewards: '2', executedAt: '2026-06-01T00:00:00.000Z' },
    });
    expect(asked).toEqual([`balance ${JSON.stringify(burnAccount('IFC'))}`]);
    expect(queries).toHaveLength(1);
    const read = queries[0]!.text;
    expect(read).toContain('closed = true');
    expect(read).toContain("status = 'settled'");
    expect(read).toContain('ledger_tx_id IS NOT NULL');
    expect(read).toContain('ORDER BY executed_at DESC, id DESC');
    expect(read).not.toMatch(/SUM\(tokens_burned\)/);
    expect(read).not.toMatch(/price/i);

    // The fold keeps every digit of a recorded total: no float on the way.
    const big = '9007199254740993.000000000000000001';
    expect(reportTreasury(emptySums({ minted: big, mintedCount: '1' }))).toEqual({
      ok: true,
      view: { ...emptyView, minted: big },
    });
  });
});

describe('delegation and treasury routes', () => {
  it('anonymous callers are unauthorised and the service is not asked', async () => {
    const treasuryView = vi.fn();
    const token = { treasuryView } as unknown as TokenService;
    const caller = createTokenRouter(token).createCaller(anonymous());
    await expect(caller.delegation()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(caller.delegate({ delegateeUserId: OTHER })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(caller.treasury()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(treasuryView).not.toHaveBeenCalled();
  });

  it('a signed read names the blocker, and delegate refuses without calling the service', async () => {
    const treasuryView = vi.fn();
    const token = { treasuryView } as unknown as TokenService;
    const caller = createTokenRouter(token).createCaller(signed());
    await expect(caller.delegation()).resolves.toEqual({ delegateeUserId: null, blocker: 'no_chain_service' });
    await expect(caller.delegate({})).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'The person to delegate to is not set.',
      cause: { code: 'token.delegation_delegatee_unset' },
    });
    await expect(caller.delegate({ delegateeUserId: '0xabc' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      cause: { code: 'token.delegation_delegatee_invalid' },
    });
    await expect(caller.delegate({ delegateeUserId: OTHER })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'There is no chain service and no on-chain delegate registry.',
      cause: { code: 'token.delegation_unavailable', blocker: 'no_chain_service' },
    });
    await expect(caller.delegate({ delegateeUserId: USER })).rejects.toMatchObject({
      cause: { code: 'token.delegation_unavailable', blocker: 'no_chain_service' },
    });
    expect(treasuryView).not.toHaveBeenCalled();
  });

  it('two refused delegates still leave the read null', async () => {
    const token = {} as TokenService;
    const caller = createTokenRouter(token).createCaller(signed());
    const results = await Promise.allSettled([caller.delegate({ delegateeUserId: OTHER }), caller.delegate({ delegateeUserId: OTHER })]);
    expect(results.map((r) => (r.status === 'rejected' ? (r.reason as { cause?: { code?: string } }).cause?.code : 'ok'))).toEqual([
      'token.delegation_unavailable',
      'token.delegation_unavailable',
    ]);
    await expect(caller.delegation()).resolves.toEqual({ delegateeUserId: null, blocker: 'no_chain_service' });
  });

  it('treasury returns the service report and refuses an unreadable figure', async () => {
    const view = {
      minted: '10.5',
      burned: '7',
      bought: '17',
      toRewards: '9',
      distributed: '3.25',
      lastBuyback: { bought: '5', burned: '3', toRewards: '2', executedAt: '2026-06-01T00:00:00.000Z' },
    };
    const token = { treasuryView: vi.fn(async () => view) } as unknown as TokenService;
    const caller = createTokenRouter(token).createCaller(signed());
    await expect(caller.treasury()).resolves.toEqual(view);
    const broken = {
      treasuryView: vi.fn(async () => {
        throw new TokenError('A treasury figure this service recorded could not be read', 'token.treasury_figure_unreadable');
      }),
    } as unknown as TokenService;
    await expect(createTokenRouter(broken).createCaller(signed()).treasury()).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'A treasury figure recorded by this service could not be read.',
      cause: { code: 'token.treasury_figure_unreadable' },
    });
  });

  it('token:stake without token:read cannot read the treasury or the delegation', async () => {
    const treasuryView = vi.fn();
    const token = { treasuryView } as unknown as TokenService;
    const caller = createTokenRouter(token).createCaller(signed(principal({ scopes: ['token:stake'] })));
    await expect(caller.treasury()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(caller.delegation()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(treasuryView).not.toHaveBeenCalled();
  });
});
