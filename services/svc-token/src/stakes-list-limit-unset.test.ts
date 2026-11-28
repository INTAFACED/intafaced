import { describe, expect, it, vi } from 'vitest';
import { partial } from '@intafaced/service-kit/testing';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { MemoryEventBus } from '@intafaced/events';
import { MemoryLedger, type AccountRef, type Balance, type LedgerClient } from '@intafaced/ledger-client';
import { DEFAULT_BUYBACK_PARAMS } from './economics/buyback.js';
import { DEFAULT_EMISSION_PARAMS } from './economics/emission.js';
import { createTokenRouter } from './router.js';
import { recordingSql } from './sql-recorder.testkit.js';
import { TokenError, TokenService, assertStakesListLimit } from './token-service.js';
import { userCopy } from './user-copy.js';

/**
 * listStakes page size is refuse-closed when unset.
 *
 * listStakes SELECTed token.stakes with no LIMIT, so omit dumped every row.
 * Blank must refuse. Owner/client may pass 50 explicitly.
 */

const EDGE_SECRET = 'a-token-list-limit-test-edge-secret-long-enough';
const USER = '11111111-1111-4111-8111-111111111111';
const edgeContext = createEdgeContext({ secret: EDGE_SECRET, serviceName: 'svc-token' });

function reader() {
  const raw = encodePrincipal({
    sub: USER,
    userId: USER,
    sid: '33333333-3333-4333-8333-333333333333',
    scopes: ['token:read'],
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
    id: 'req-list-limit',
  });
}

function service(sql: ReturnType<typeof recordingSql>['sql'], ledger: LedgerClient = new MemoryLedger()) {
  return new TokenService(sql, ledger, new MemoryEventBus('svc-token'), {
    assetId: 'IFC',
    emission: DEFAULT_EMISSION_PARAMS,
    buyback: DEFAULT_BUYBACK_PARAMS,
    loadParamsFromDb: false,
  });
}

describe('listStakes limit unset refuse', () => {
  it('assertStakesListLimit refuses blank / NaN / 0 — never invents 50', () => {
    expect(() => assertStakesListLimit(undefined)).toThrow(TokenError);
    expect(() => assertStakesListLimit(Number.NaN)).toThrow(TokenError);
    expect(() => assertStakesListLimit(0)).toThrow(TokenError);
    try {
      assertStakesListLimit(undefined);
      throw new Error('expected refuse');
    } catch (e) {
      expect(e).toBeInstanceOf(TokenError);
      expect((e as TokenError).code).toBe('token.stakes_list_limit_unset');
      expect((e as TokenError).message).toBe('Stake list limit is unset');
      expect((e as TokenError).message).not.toMatch(/50-row|default 50/i);
      expect(userCopy((e as TokenError).code)).toBe('The stake list size is not set.');
      expect(userCopy((e as TokenError).code)).not.toMatch(/50/);
    }
  });

  it('accepts owner-published 50 and caps at 200', () => {
    expect(assertStakesListLimit(50)).toBe(50);
    expect(assertStakesListLimit(1)).toBe(1);
    expect(assertStakesListLimit(200)).toBe(200);
    expect(assertStakesListLimit(201)).toBe(200);
  });

  it('listStakes refuses an unset limit before reading, and sends the published page as LIMIT', async () => {
    const { sql, queries } = recordingSql();
    const token = service(sql);
    for (const status of ['active', 'all'] as const) {
      await expect(token.listStakes(USER, status, undefined)).rejects.toMatchObject({ code: 'token.stakes_list_limit_unset' });
    }
    expect(queries).toEqual([]);

    for (const status of ['active', 'all'] as const) {
      queries.length = 0;
      await expect(token.listStakes(USER, status, 50)).resolves.toEqual([]);
      expect(queries).toHaveLength(1);
      expect(queries[0]!.text).toMatch(/FROM token\.stakes/);
      expect(queries[0]!.text).toMatch(/LIMIT \$\d+$/);
      expect(queries[0]!.values.at(-1)).toBe(50);
    }
    queries.length = 0;
    await token.listStakes(USER, 'active', 500);
    expect(queries[0]!.values.at(-1)).toBe(200);
  });

  it('router does not invent 50 when listStakes omits limit', async () => {
    const listStakes = vi.fn(async (_userId: string, _status?: string, limit?: number) => {
      assertStakesListLimit(limit);
      return [];
    });
    const caller = createTokenRouter(partial<TokenService>({ listStakes })).createCaller(reader());
    await expect(caller.listStakes({})).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      cause: { code: 'token.stakes_list_limit_unset' },
    });
    expect(listStakes).toHaveBeenLastCalledWith(USER, 'active', undefined);
    await expect(caller.listStakes({ status: 'all', limit: 50 })).resolves.toEqual([]);
    expect(listStakes).toHaveBeenLastCalledWith(USER, 'all', 50);
  });

  it('yield job active-stake work set stays unbounded (not this mill)', async () => {
    const { sql, queries } = recordingSql();
    const ledger = new (class extends MemoryLedger {
      override async balance(ref: AccountRef): Promise<Balance> {
        return { ...(await super.balance(ref)), amount: 10n ** 30n };
      }
    })();
    const token = service(sql, ledger);
    await token
      .distributeRevenue({ windowId: 'w-unbounded', sources: [{ module: 'trade', amount: 100n }] } as never)
      .catch(() => undefined);
    const work = queries.find((q) => /FROM token\.stakes WHERE status = 'active'/.test(q.text));
    expect(work, 'the yield plan reads the active stakes').toBeDefined();
    expect(work!.text).toBe("SELECT id, user_id, amount, tier, multiplier_bps FROM token.stakes WHERE status = 'active' ORDER BY id ASC");
    expect(work!.values).toEqual([]);
  });
});
