import { describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { parseAmount } from '@intafaced/ledger-client';
import { createPayRouter } from '../router.js';
import { PayError, type PayService } from '../payment-service.js';
import { CardSandboxAdapter } from '../rails/card-sandbox.js';
import { RailRegistry } from '../rails/registry.js';
import type { UserMoneyService, WithdrawalRecord } from '../user-money-service.js';
import { INTERNAL_RAIL } from './internal.js';

/** W-withdraw-14 through the real router: `withdrawal.create` takes the internal branch for a platform address, and `withdrawal.destination`. */
const SECRET = 'a-pay-internal-test-edge-secret-long-enough';
const USER = '11111111-1111-4111-8111-111111111111';
const ID = '33333333-3333-4333-8333-333333333333';
const ADDRESS = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-pay' });
const rails = new RailRegistry([
  new CardSandboxAdapter({ secret: 'pay-internal-test-rail-secret-at-least-32-chars', toleranceSeconds: 300 }),
]);

function signed(scopes: string[]) {
  const p = {
    sub: USER,
    userId: USER,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes,
    tier: 'full',
    mfa: true,
    expiresAt: new Date(Date.now() + 60_000),
  } as Principal;
  const raw = encodePrincipal(p);
  return edgeContext({
    headers: {
      'x-intafaced-principal': raw,
      'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
      'x-intafaced-region': 'DE',
    },
    id: 'req-internal',
  });
}

const api = (money: Partial<UserMoneyService>, scopes = ['trade:withdraw', 'trade:read']) =>
  createPayRouter({} as PayService, rails, money as UserMoneyService).createCaller(signed(scopes));

const sent: WithdrawalRecord = {
  id: ID,
  userId: USER,
  assetId: 'USDT',
  amount: parseAmount('25'),
  rail: INTERNAL_RAIL,
  destination: { kind: 'crypto', ref: ADDRESS },
  clientRef: 'w-1',
  railRef: 'bank-tx-1',
  attempts: 0,
  failureCode: null,
  status: 'sent',
  createdAt: new Date('2026-10-24T08:00:00.000Z'),
  networkId: null,
  quoteRef: null,
  fee: null,
  journal: 'accepted',
};
const create = (railId: string) => ({
  assetId: 'USDT',
  amount: '25',
  railId,
  destination: { kind: 'crypto', ref: ADDRESS },
  clientRef: 'w-1',
});

describe('withdrawal.create, internal branch', () => {
  it('takes the internal branch for a platform address whatever rail was named, with the caller as the sender', async () => {
    for (const railId of [INTERNAL_RAIL, 'crypto-native']) {
      const asked: unknown[] = [];
      const caller = api({
        platformDestination: async () => ({ kind: 'internal' }),
        withdrawInternal: async (input) => {
          asked.push(input);
          return sent;
        },
        withdraw: async () => {
          throw new Error('the chain path must not be asked');
        },
      });
      await expect(caller.withdrawal.create(create(railId))).resolves.toMatchObject({ id: ID, status: 'sent', railRef: 'bank-tx-1' });
      expect(asked).toEqual([
        { userId: USER, assetId: 'USDT', amount: parseAmount('25'), destination: { kind: 'crypto', ref: ADDRESS }, clientRef: 'w-1' },
      ]);
    }
  });

  it('takes no network or quote on the internal branch: a send inside the platform has no network fee', async () => {
    const asked: unknown[] = [];
    const caller = api({
      platformDestination: async () => ({ kind: 'internal' }),
      withdrawInternal: async (input) => {
        asked.push(input);
        return sent;
      },
    });
    await caller.withdrawal.create({ ...create('crypto-native'), networkId: 'ethereum', quoteRef: 'q-1' });
    expect(asked).toEqual([
      { userId: USER, assetId: 'USDT', amount: parseAmount('25'), destination: { kind: 'crypto', ref: ADDRESS }, clientRef: 'w-1' },
    ]);
  });

  it('sends a self-send to the internal branch, which refuses it by name', async () => {
    const caller = api({
      platformDestination: async () => ({ kind: 'self' }),
      withdrawInternal: async () => {
        throw new PayError('self', 'pay.withdrawal_self_send');
      },
    });
    await expect(caller.withdrawal.create(create('crypto-native'))).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringContaining('pay.withdrawal_self_send'),
    });
  });

  it('leaves an outside address on the named rail', async () => {
    let chain = 0;
    const caller = api({
      platformDestination: async () => ({ kind: 'external' }),
      withdrawInternal: async () => {
        throw new Error('the internal branch must not be asked');
      },
      withdraw: async (input) => {
        chain += 1;
        expect(input.rail).toBe('crypto-native');
        return { ...sent, rail: 'crypto-native' };
      },
    });
    await caller.withdrawal.create(create('crypto-native'));
    expect(chain).toBe(1);
  });

  it('answers an unwired bank as a precondition and a lost answer as unknown', async () => {
    const unwired = api({
      platformDestination: async () => ({ kind: 'internal' }),
      withdrawInternal: async () => {
        throw new PayError('unwired', 'pay.internal_settlement_unwired');
      },
    });
    await expect(unwired.withdrawal.create(create(INTERNAL_RAIL))).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    const lost = api({
      withdrawInternal: async () => {
        throw new PayError('lost', 'pay.rail_outcome_unknown', { withdrawalId: ID, state: 'requested' });
      },
    });
    await expect(lost.withdrawal.create(create(INTERNAL_RAIL))).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });
});

describe('withdrawal.destination', () => {
  it('says where an address leads for the signed-in caller and never names the other account', async () => {
    const asked: unknown[] = [];
    const caller = api(
      {
        platformDestination: async (userId, destination) => {
          asked.push([userId, destination]);
          return { kind: 'internal' };
        },
      },
      ['trade:read'],
    );
    await expect(caller.withdrawal.destination({ destination: { kind: 'crypto', ref: ADDRESS } })).resolves.toEqual({ kind: 'internal' });
    expect(asked).toEqual([[USER, { kind: 'crypto', ref: ADDRESS }]]);
    await expect(
      caller.withdrawal.destination({ destination: { kind: 'crypto', ref: ADDRESS }, userId: 'x' } as never),
    ).rejects.toBeDefined();
  });

  it('passes an unavailable reason through, and needs trade:read', async () => {
    const money = { platformDestination: async () => ({ kind: 'unavailable' as const, reason: 'unavailable' as const }) };
    await expect(api(money, ['trade:read']).withdrawal.destination({ destination: { kind: 'crypto', ref: ADDRESS } })).resolves.toEqual({
      kind: 'unavailable',
      reason: 'unavailable',
    });
    await expect(
      api(money, ['trade:write']).withdrawal.destination({ destination: { kind: 'crypto', ref: ADDRESS } }),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });
});
