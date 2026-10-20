import { describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { TravelRuleError } from './errors.js';
import { createTravelRuleCustomerRouter } from './customer-router.js';
import type { CustomerStatus } from './schemas.js';
import type { TravelRuleService } from './service.js';

/** `travelRule.status.get` through the real router: scope, strict input, the caller's own id, typed refusals. */
const SECRET = 'a-travel-rule-test-edge-secret-long-enough';
const USER = '11111111-1111-4111-8111-111111111111';
const W = '33333333-3333-4333-8333-333333333333';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-pay' });

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
    id: 'req-travel-rule',
  });
}

const api = (svc: Partial<TravelRuleService>, scopes = ['trade:read']) =>
  createTravelRuleCustomerRouter(svc as TravelRuleService).createCaller(signed(scopes));

const status: CustomerStatus = {
  withdrawalId: W,
  status: 'repair',
  displayStatus: 'Pending',
  fieldsToCollect: ['beneficiary_name'],
  waitDeadline: '2026-10-20T10:05:00.000Z',
  blocker: null,
};

describe('travelRule.status.get', () => {
  it('answers for the signed-in user only', async () => {
    const asked: unknown[] = [];
    const caller = api({
      statusForCustomer: async (userId, withdrawalId) => {
        asked.push([userId, withdrawalId]);
        return status;
      },
    });
    await expect(caller.travelRule.status.get({ withdrawalId: W })).resolves.toEqual(status);
    expect(asked).toEqual([[USER, W]]);
    await expect(caller.travelRule.status.get({ withdrawalId: W, userId: 'someone-else' } as never)).rejects.toBeDefined();
    await expect(caller.travelRule.status.get({ withdrawalId: 'not-a-uuid' })).rejects.toBeDefined();
  });

  it('needs the read scope', async () => {
    await expect(
      api({ statusForCustomer: async () => status }, ['market:read']).travelRule.status.get({ withdrawalId: W }),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it("answers another account's withdrawal as not found, with the typed code", async () => {
    const caller = api({
      statusForCustomer: async () => {
        throw new TravelRuleError('travel_rule.transfer_not_found', 'no travel-rule record for this withdrawal');
      },
    });
    await expect(caller.travelRule.status.get({ withdrawalId: W })).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: expect.stringContaining('travel_rule.transfer_not_found'),
    });
  });
});
