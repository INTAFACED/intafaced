import { describe, expect, it, vi } from 'vitest';
import { partial } from '@intafaced/service-kit/testing';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { MemoryEventBus } from '@intafaced/events';
import { MemoryLedger, type LedgerClient } from '@intafaced/ledger-client';
import { DEFAULT_BUYBACK_PARAMS } from './economics/buyback.js';
import { DEFAULT_EMISSION_PARAMS } from './economics/emission.js';
import { createTokenRouter } from './router.js';
import { recordingSql } from './sql-recorder.testkit.js';
import { TokenError, TokenService, assertProposalListLimit } from './token-service.js';
import { userCopy } from './user-copy.js';

/**
 * listProposals page size is refuse-closed when unset.
 *
 * listProposals used `input.limit ?? 50`, so omit invented a 50-row governance
 * page. Blank must refuse. Owner/client may pass 50 explicitly.
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

describe('listProposals limit unset refuse', () => {
  it('assertProposalListLimit refuses blank / NaN / 0 — never invents 50', () => {
    expect(() => assertProposalListLimit(undefined)).toThrow(TokenError);
    expect(() => assertProposalListLimit(Number.NaN)).toThrow(TokenError);
    expect(() => assertProposalListLimit(0)).toThrow(TokenError);
    try {
      assertProposalListLimit(undefined);
      throw new Error('expected refuse');
    } catch (e) {
      expect(e).toBeInstanceOf(TokenError);
      expect((e as TokenError).code).toBe('token.proposal_list_limit_unset');
      expect((e as TokenError).message).toBe('Proposal list limit is unset');
      expect((e as TokenError).message).not.toMatch(/50-row|default 50/i);
      expect(userCopy((e as TokenError).code)).toBe('The proposal list size is not set.');
      expect(userCopy((e as TokenError).code)).not.toMatch(/50/);
    }
  });

  it('accepts owner-published 50 and caps at 200', () => {
    expect(assertProposalListLimit(50)).toBe(50);
    expect(assertProposalListLimit(1)).toBe(1);
    expect(assertProposalListLimit(200)).toBe(200);
    expect(assertProposalListLimit(201)).toBe(200);
  });

  it('listProposals refuses an unset limit before reading, and sends the published page as LIMIT', async () => {
    const { sql, queries } = recordingSql();
    const token = service(sql);
    await expect(token.listProposals({})).rejects.toMatchObject({ code: 'token.proposal_list_limit_unset' });
    await expect(token.listProposals()).rejects.toMatchObject({ code: 'token.proposal_list_limit_unset' });
    expect(queries).toEqual([]);

    await expect(token.listProposals({ limit: 50 })).resolves.toEqual([]);
    expect(queries).toHaveLength(1);
    expect(queries[0]!.text).toMatch(/FROM token\.proposals/);
    expect(queries[0]!.text).toMatch(/LIMIT \$\d+$/);
    expect(queries[0]!.values.at(-1)).toBe(50);
    queries.length = 0;
    await token.listProposals({ limit: 500 });
    expect(queries[0]!.values.at(-1)).toBe(200);
  });

  it('router does not invent 50 when listProposals omits limit', async () => {
    const listProposals = vi.fn(async (input: { limit?: number }) => {
      assertProposalListLimit(input.limit);
      return [];
    });
    const caller = createTokenRouter(partial<TokenService>({ listProposals })).createCaller(reader());
    await expect(caller.listProposals({})).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      cause: { code: 'token.proposal_list_limit_unset' },
    });
    expect(listProposals.mock.lastCall?.[0]?.limit).toBeUndefined();
    await expect(caller.listProposals({ limit: 50 })).resolves.toEqual([]);
    expect(listProposals.mock.lastCall?.[0]?.limit).toBe(50);
  });
});
