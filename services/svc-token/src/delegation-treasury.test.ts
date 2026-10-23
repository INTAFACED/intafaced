import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { DELEGATION_PARKED, parkedDelegation, refuseDelegation } from './delegation.js';
import { createTokenRouter } from './router.js';
import { TokenError, type TokenService } from './token-service.js';
import { reportTreasury, type TreasurySums } from './treasury-view.js';
import { userCopy } from './user-copy.js';

/**
 * MC-token-04. Delegation is parked (no chain GO, no stored delegate, no
 * invented self-delegation). The treasury view is only rows this service
 * already recorded: no rows is null, not zero, and a blank total is not zero.
 */

const SECRET = 'a-token-delegation-test-edge-secret-long-enough';
const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');

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
    burned: null,
    burnedCount: '0',
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
  burned: null,
  bought: null,
  toRewards: null,
  distributed: null,
};

describe('delegation parked', () => {
  it('reads null and does not invent a delegatee', () => {
    expect(parkedDelegation()).toEqual({ delegateeUserId: null, parked: DELEGATION_PARKED });
    expect(parkedDelegation()).toEqual(parkedDelegation());
  });

  it('refuses a blank target before the park, and does not keep it', () => {
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

  it('parks a member id, including the caller, and two calls still store nothing', () => {
    const codes: string[] = [];
    for (const id of [OTHER, USER, `  ${OTHER}  `]) {
      try {
        refuseDelegation(id);
      } catch (err) {
        codes.push((err as TokenError).code);
      }
    }
    expect(codes).toEqual(['token.delegation_parked', 'token.delegation_parked', 'token.delegation_parked']);
    expect(userCopy('token.delegation_parked')).toBe('Delegation is not available.');
  });

  it('castVote does not read a delegation', () => {
    const src = readFileSync(join(ROOT, 'services/svc-token/src/token-service.ts'), 'utf8');
    const start = src.indexOf('async castVote(');
    const end = src.indexOf('async listProposals(', start);
    const fn = src.slice(start, end);
    expect(fn).not.toMatch(/delegat/i);
    const delegation = readFileSync(join(ROOT, 'services/svc-token/src/delegation.ts'), 'utf8');
    expect(delegation).not.toMatch(/\b(insert|update|sql)\b/i);
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
        burned: '0',
        burnedCount: '1',
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
      view: { minted: '10.5', burned: '0', bought: '0', toRewards: '0', distributed: '3.25' },
    });
  });

  it('refuses a blank, negative, or mismatched total instead of zero', () => {
    expect(reportTreasury(emptySums({ minted: null, mintedCount: '1' })).ok).toBe(false);
    expect(reportTreasury(emptySums({ minted: '  ', mintedCount: '1' })).ok).toBe(false);
    expect(reportTreasury(emptySums({ minted: '-1', mintedCount: '1' })).ok).toBe(false);
    expect(reportTreasury(emptySums({ minted: '5', mintedCount: '0' })).ok).toBe(false);
    expect(reportTreasury(emptySums({ mintedCount: 'no' })).ok).toBe(false);
    expect(userCopy('token.treasury_figure_unreadable')).toBe('A treasury figure recorded by this service could not be read.');
  });

  it('the service query does not read the ledger or a price', () => {
    const src = readFileSync(join(ROOT, 'services/svc-token/src/token-service.ts'), 'utf8');
    const start = src.indexOf('async treasuryView(');
    const end = src.indexOf('async emissionSchedule(', start);
    const fn = src.slice(start, end);
    expect(fn).toContain('closed = true');
    expect(fn).toContain("status = 'settled'");
    expect(fn).toContain('ledger_tx_id IS NOT NULL');
    expect(fn).not.toMatch(/this\.ledger|burnAccount|houseFees|price/i);
    const fold = readFileSync(join(ROOT, 'services/svc-token/src/treasury-view.ts'), 'utf8');
    expect(fold).not.toMatch(/\bNumber\(/);
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

  it('a signed read is null and parked, and delegate refuses without calling the service', async () => {
    const treasuryView = vi.fn();
    const token = { treasuryView } as unknown as TokenService;
    const caller = createTokenRouter(token).createCaller(signed());
    await expect(caller.delegation()).resolves.toEqual({ delegateeUserId: null, parked: 'token.delegation_parked' });
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
      message: 'Delegation is not available.',
      cause: { code: 'token.delegation_parked' },
    });
    await expect(caller.delegate({ delegateeUserId: USER })).rejects.toMatchObject({
      cause: { code: 'token.delegation_parked' },
    });
    expect(treasuryView).not.toHaveBeenCalled();
  });

  it('two parked delegates still leave the read null', async () => {
    const token = {} as unknown as TokenService;
    const caller = createTokenRouter(token).createCaller(signed());
    const results = await Promise.allSettled([caller.delegate({ delegateeUserId: OTHER }), caller.delegate({ delegateeUserId: OTHER })]);
    expect(results.map((r) => (r.status === 'rejected' ? (r.reason as { cause?: { code?: string } }).cause?.code : 'ok'))).toEqual([
      'token.delegation_parked',
      'token.delegation_parked',
    ]);
    await expect(caller.delegation()).resolves.toEqual({ delegateeUserId: null, parked: 'token.delegation_parked' });
  });

  it('treasury returns the service report and refuses an unreadable figure', async () => {
    const view = { minted: '10.5', burned: null, bought: null, toRewards: null, distributed: null };
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
