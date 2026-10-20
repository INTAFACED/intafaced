import { describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { parseAmount } from '@intafaced/ledger-client';
import { createPayRouter } from '../router.js';
import { PayError, type PayService } from '../payment-service.js';
import { CardSandboxAdapter } from '../rails/card-sandbox.js';
import { RailRegistry } from '../rails/registry.js';
import type { UserMoneyService, WithdrawalRecord } from '../user-money-service.js';
import { WITHDRAWAL_CANCELED_CODE } from './status.js';

/** `withdrawal.cancel` through the real router: scope, strict input, the caller's own id, typed refusals. */
const SECRET = 'a-pay-cancel-test-edge-secret-long-enough';
const USER = '11111111-1111-4111-8111-111111111111';
const ID = '33333333-3333-4333-8333-333333333333';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-pay' });
const rails = new RailRegistry([
  new CardSandboxAdapter({ secret: 'pay-cancel-test-rail-secret-at-least-32-chars', toleranceSeconds: 300 }),
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
    id: 'req-cancel',
  });
}

const api = (money: Partial<UserMoneyService>, scopes = ['trade:write']) =>
  createPayRouter({} as PayService, rails, money as UserMoneyService).createCaller(signed(scopes));

const cancelled: WithdrawalRecord = {
  id: ID,
  userId: USER,
  assetId: 'USDT',
  amount: parseAmount('40'),
  rail: 'card-sandbox',
  destination: { kind: 'bank', ref: 'DE89370400440532013000' },
  clientRef: 'w-1',
  railRef: null,
  attempts: 0,
  failureCode: WITHDRAWAL_CANCELED_CODE,
  status: 'failed',
  createdAt: new Date('2026-10-20T08:00:00.000Z'),
} as WithdrawalRecord;

describe('withdrawal.cancel', () => {
  it('cancels for the signed-in user and shows the customer status', async () => {
    const asked: unknown[] = [];
    const caller = api({
      cancelWithdrawal: async (input) => {
        asked.push(input);
        return cancelled;
      },
    });
    await expect(caller.withdrawal.cancel({ withdrawalId: ID })).resolves.toMatchObject({
      id: ID,
      customerStatus: 'canceled',
      failureCode: WITHDRAWAL_CANCELED_CODE,
    });
    expect(asked).toEqual([{ userId: USER, withdrawalId: ID }]);
    await expect(caller.withdrawal.cancel({ withdrawalId: ID, userId: 'someone-else' } as never)).rejects.toBeDefined();
    await expect(caller.withdrawal.cancel({ withdrawalId: 'not-a-uuid' })).rejects.toBeDefined();
  });

  it('needs the write scope', async () => {
    const caller = api({ cancelWithdrawal: async () => cancelled }, ['trade:read']);
    await expect(caller.withdrawal.cancel({ withdrawalId: ID })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('answers a refusal with a conflict the customer can read', async () => {
    const caller = api({
      cancelWithdrawal: async () => {
        throw new PayError('The withdrawal was sent and cannot be cancelled', 'pay.withdrawal_not_cancellable');
      },
    });
    await expect(caller.withdrawal.cancel({ withdrawalId: ID })).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});
