import { describe, expect, it, vi } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { createPayRouter } from '../../router.js';
import type { PayService } from '../../payment-service.js';
import { CardSandboxAdapter } from '../../rails/card-sandbox.js';
import { RailRegistry } from '../../rails/registry.js';
import type { UserMoneyService } from '../../user-money-service.js';

/** J-wallet-05 #1 through the real router: a tag on create is refused by name before any guard or claim, never dropped. */
const SECRET = 'a-pay-tag-router-test-edge-secret-long-enough';
const USER = '11111111-1111-4111-8111-111111111111';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-pay' });

function signed() {
  const p = {
    sub: USER,
    userId: USER,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes: ['trade:withdraw'],
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
    id: 'req-tag',
  });
}

const rails = new RailRegistry([new CardSandboxAdapter({ secret: 'pay-tag-router-test-rail-secret-at-least-32', toleranceSeconds: 300 })]);

function caller() {
  const money = { withdraw: vi.fn(), withdrawInternal: vi.fn(), platformDestination: vi.fn(async () => ({ kind: 'external' })) };
  const gate = { assertDirectAllowed: vi.fn(async () => undefined) };
  const api = createPayRouter(
    {} as PayService,
    rails,
    money as unknown as UserMoneyService,
    null,
    undefined,
    undefined,
    null,
    undefined,
    null,
    null,
    null,
    gate,
  ).createCaller(signed());
  return { api, money, gate };
}

const input = {
  assetId: 'USDT',
  amount: '25',
  railId: 'card-sandbox',
  destination: { kind: 'crypto', ref: '0x00000000000000000000000000000000000000a1' },
  clientRef: 'w-tag',
};

describe('withdrawal.create with a tag', () => {
  it('refuses a tag by name and asks no guard, rail or ledger', async () => {
    const { api, money, gate } = caller();
    await expect(api.withdrawal.create({ ...input, destination: { ...input.destination, tag: '12345' } })).rejects.toMatchObject({
      cause: expect.objectContaining({ code: 'pay.withdrawal_tag_not_taken' }),
    });
    expect(gate.assertDirectAllowed).not.toHaveBeenCalled();
    expect(money.platformDestination).not.toHaveBeenCalled();
    expect(money.withdraw).not.toHaveBeenCalled();
    expect(money.withdrawInternal).not.toHaveBeenCalled();
  });

  it('a send without a tag carries no tag field onwards', async () => {
    const { api, money, gate } = caller();
    money.withdraw.mockRejectedValueOnce(new Error('stop here'));
    await expect(api.withdrawal.create(input)).rejects.toBeDefined();
    expect(gate.assertDirectAllowed).toHaveBeenCalledWith(expect.objectContaining({ destination: input.destination }));
    expect(money.withdraw).toHaveBeenCalledWith(expect.objectContaining({ destination: input.destination }));
  });
});
