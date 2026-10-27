import { describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { createPayRouter } from '../router.js';
import type { PayService } from '../payment-service.js';
import { CardSandboxAdapter } from '../rails/card-sandbox.js';
import { RailRegistry } from '../rails/registry.js';
import { PayGuardRefusal } from '../seams/guards.js';
import type { UserMoneyService } from '../user-money-service.js';
import { GUARD_WITHDRAWAL_LIMIT_UNSET } from './guards.js';

/** `withdrawal.limits`: the caller's own remaining allowance, through the real router. */
const SECRET = 'a-pay-limits-test-edge-secret-long-enough';
const USER = '11111111-1111-4111-8111-111111111111';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-pay' });
const rails = new RailRegistry([
  new CardSandboxAdapter({ secret: 'pay-limits-test-rail-secret-at-least-32-chars', toleranceSeconds: 300 }),
]);

function signed(scopes: string[]) {
  const p = {
    sub: USER,
    userId: USER,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes,
    tier: 'full',
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
  } as Principal;
  const raw = encodePrincipal(p);
  return edgeContext({
    headers: {
      'x-intafaced-principal': raw,
      'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
      'x-intafaced-region': 'DE',
    },
    id: 'req-limits',
  });
}

// TEST figures, illustrative only.
const VIEW = {
  tier: 'basic',
  assetId: 'USDT',
  base: { perTx: '10', rolling24h: '15' },
  override: null,
  perTx: '10',
  rolling24h: '15',
  used24h: '9',
  remaining: { perTx: '10', rolling24h: '6' },
  maxNow: '6',
};

function api(allowance: UserMoneyService['withdrawalAllowance'], scopes = ['trade:read']) {
  const money = { withdrawalAllowance: allowance } as unknown as UserMoneyService;
  return createPayRouter({} as PayService, rails, money).createCaller(signed(scopes));
}

describe('withdrawal.limits', () => {
  it('returns the caller their own allowance, asking for the signed-in user and never one from the request', async () => {
    const asked: Array<[string, string]> = [];
    const caller = api(async (userId, assetId) => {
      asked.push([userId, assetId]);
      return VIEW;
    });
    await expect(caller.withdrawal.limits({ assetId: 'USDT' })).resolves.toEqual(VIEW);
    expect(asked).toEqual([[USER, 'USDT']]);
  });

  it('a blank limit is a typed refusal with the guard code, never a made-up figure', async () => {
    const caller = api(async () => {
      throw new PayGuardRefusal(GUARD_WITHDRAWAL_LIMIT_UNSET, 'refused');
    });
    await expect(caller.withdrawal.limits({ assetId: 'USDT' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: GUARD_WITHDRAWAL_LIMIT_UNSET,
    });
  });

  it('needs a read scope: a merchant scope reads nothing', async () => {
    const caller = api(async () => VIEW, ['pay:read']);
    await expect(caller.withdrawal.limits({ assetId: 'USDT' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('withdrawal.tierLimits', () => {
  // TEST figures, illustrative only.
  const PUBLISHED = { enforced: true, limits: [{ tier: 'basic', assetId: 'USDT', perTx: '10', rolling24h: '15' }] };
  const caller = (scopes = ['trade:read']) => {
    const money = { withdrawalTierLimits: async () => PUBLISHED } as unknown as UserMoneyService;
    return createPayRouter({} as PayService, rails, money).createCaller(signed(scopes));
  };

  it("returns the owner's published figures per tier", async () => {
    expect(await caller().withdrawal.tierLimits()).toEqual(PUBLISHED);
  });

  it('an unwired reader refuses with its typed code, never an empty list that reads as no limits', async () => {
    const money = {
      withdrawalTierLimits: async () => {
        throw new PayGuardRefusal('pay.guard_withdrawal_limits_unwired', 'unavailable');
      },
    } as unknown as UserMoneyService;
    const api = createPayRouter({} as PayService, rails, money).createCaller(signed(['trade:read']));
    await expect(api.withdrawal.tierLimits()).rejects.toMatchObject({ message: 'pay.guard_withdrawal_limits_unwired' });
  });

  it('needs trade:read', async () => {
    await expect(caller(['identity:read']).withdrawal.tierLimits()).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
