import { describe, expect, it, vi } from 'vitest';
import type { Principal } from '@intafaced/auth';
import type { Sql } from 'postgres';
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

/** A stand-in pay database that answers the rules read with one published pair, whose tag rule is `tag`. */
function rulesSql(tag: 'none' | 'required') {
  const row = {
    asset_id: 'USDT',
    network_id: 'stellar',
    minimum: '1',
    maximum: '1000',
    step: '0.01',
    tag,
    version: 1,
    set_by: USER,
    set_at: new Date(),
  };
  return (async () => [row]) as unknown as Sql;
}

function caller(portalSql: Sql | null = null) {
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
    portalSql,
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
  it('refuses a tag by name before anything is claimed or held', async () => {
    const { api, money } = caller();
    await expect(api.withdrawal.create({ ...input, destination: { ...input.destination, tag: '12345' } })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      cause: expect.objectContaining({ code: 'pay.withdrawal_tag_not_taken' }),
    });
    expect(money.withdraw).not.toHaveBeenCalled();
    expect(money.withdrawInternal).not.toHaveBeenCalled();
  });

  it('a send without a tag carries no tag field onwards', async () => {
    const { api, money, gate } = caller();
    money.withdraw.mockRejectedValueOnce(new Error('stop here'));
    await expect(api.withdrawal.create(input)).rejects.toBeDefined();
    const [gateCall] = gate.assertDirectAllowed.mock.calls[0] as unknown as [{ destination: object }];
    const [sent] = money.withdraw.mock.calls[0] as unknown as [{ destination: object }];
    expect(gateCall.destination).toEqual(input.destination);
    expect(gateCall.destination).not.toHaveProperty('tag');
    expect(sent.destination).toEqual(input.destination);
    expect(sent.destination).not.toHaveProperty('tag');
  });

  it('refuses a memo under any other key instead of stripping it', async () => {
    const { api, money } = caller();
    const memo = { ...input, destination: { ...input.destination, memo: '12345' } } as unknown as typeof input;
    await expect(api.withdrawal.create(memo)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(money.withdraw).not.toHaveBeenCalled();
  });

  it('refuses a tag or memo beside the destination instead of stripping it', async () => {
    const { api, money } = caller();
    for (const key of ['tag', 'memo']) {
      const beside = { ...input, [key]: '12345' } as unknown as typeof input;
      await expect(api.withdrawal.create(beside)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    }
    expect(money.withdraw).not.toHaveBeenCalled();
  });

  it('refuses a send with no tag on a network that requires one, before anything is claimed or held', async () => {
    const { api, money } = caller(rulesSql('required'));
    await expect(api.withdrawal.create({ ...input, railId: 'crypto-native', networkId: 'stellar', quoteRef: 'q-1' })).rejects.toMatchObject(
      {
        code: 'PRECONDITION_FAILED',
        cause: expect.objectContaining({ code: 'pay.withdrawal_tag_required' }),
      },
    );
    expect(money.withdraw).not.toHaveBeenCalled();
  });

  it('lets a send with no tag through on a network that takes none', async () => {
    const { api, money } = caller(rulesSql('none'));
    money.withdraw.mockRejectedValueOnce(new Error('stop here'));
    await expect(api.withdrawal.create({ ...input, railId: 'crypto-native', networkId: 'stellar', quoteRef: 'q-1' })).rejects.toBeDefined();
    expect(money.withdraw).toHaveBeenCalledTimes(1);
  });
});
