import { describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { createPayRouter } from '../router.js';
import type { PayService } from '../payment-service.js';
import { CardSandboxAdapter } from '../rails/card-sandbox.js';
import { RailRegistry } from '../rails/registry.js';
import type { UserMoneyService } from '../user-money-service.js';

/** `withdrawal.history` and `withdrawal.eligibility` through the real router: scope, strict input, the caller's own id. */
const SECRET = 'a-pay-history-test-edge-secret-long-enough';
const USER = '11111111-1111-4111-8111-111111111111';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-pay' });
const rails = new RailRegistry([
  new CardSandboxAdapter({ secret: 'pay-history-test-rail-secret-at-least-32-chars', toleranceSeconds: 300 }),
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
    id: 'req-history',
  });
}

function api(money: Partial<UserMoneyService>, scopes = ['trade:read']) {
  return createPayRouter({} as PayService, rails, money as UserMoneyService).createCaller(signed(scopes));
}

describe('withdrawal.history and withdrawal.eligibility', () => {
  it('asks for the signed-in user and never one from the request', async () => {
    const asked: Array<[string, unknown]> = [];
    const caller = api({
      searchWithdrawals: async (userId, filter) => {
        asked.push([userId, filter]);
        return { items: [], next: null };
      },
    });
    await expect(caller.withdrawal.history({ limit: 25, status: 'settled', assetId: 'USDT' })).resolves.toEqual({ items: [], next: null });
    expect(asked).toEqual([[USER, { limit: 25, status: 'settled', assetId: 'USDT' }]]);
    await expect(caller.withdrawal.history({ userId: 'someone-else', limit: 1 } as never)).rejects.toBeDefined();
  });

  it('refuses a status that is not in the vocabulary and a page size over 200', async () => {
    const caller = api({ searchWithdrawals: async () => ({ items: [], next: null }) });
    await expect(caller.withdrawal.history({ limit: 10, status: 'sent' as never })).rejects.toBeDefined();
    await expect(caller.withdrawal.history({ limit: 201 })).rejects.toBeDefined();
  });

  it('needs a read scope: a merchant scope reads nothing', async () => {
    const caller = api({ searchWithdrawals: async () => ({ items: [], next: null }) }, ['pay:read']);
    await expect(caller.withdrawal.history({ limit: 10 })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(caller.withdrawal.eligibility({ assetId: 'USDT' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('returns the eligibility checks for the caller', async () => {
    const view = { eligible: false, checks: [{ reason: 'open_orders' as const, state: 'unwired' as const, detail: 'not connected' }] };
    const asked: Array<[string, string]> = [];
    const caller = api({
      withdrawalEligibilityFor: async (userId, assetId) => {
        asked.push([userId, assetId]);
        return view;
      },
    });
    await expect(caller.withdrawal.eligibility({ assetId: 'USDT' })).resolves.toEqual(view);
    expect(asked).toEqual([[USER, 'USDT']]);
  });

  it('says so when the history is not wired, instead of answering empty', async () => {
    const { UserMoneyService } = await import('../user-money-service.js');
    const money = new UserMoneyService({} as never, {} as never, rails, {} as never);
    await expect(money.searchWithdrawals(USER, { limit: 1 })).rejects.toMatchObject({ code: 'pay.withdrawal_history_unwired' });
    await expect(money.withdrawalEligibilityFor(USER, 'USDT')).rejects.toMatchObject({ code: 'pay.withdrawal_eligibility_unwired' });
  });
});
