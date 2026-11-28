import type { Context } from '@intafaced/contracts';
import { describe, expect, it } from 'vitest';
import type { PayService } from './payment-service.js';
import { RailRegistry } from './rails/registry.js';
import { describeRoutingPolicy as describeMountedRoutingPolicy } from './routing/routing-policy.js';
import { createPayRouter } from './router.js';
import type { UserMoneyService } from './user-money-service.js';
import { FORBIDDEN_ROUTING_SCORE_FIELDS } from './routing-inputs.js';
import {
  REFERENCE_PROFILE_RAIL_IDS,
  ROUTING_DECISION_KIND,
  ROUTING_INPUT_MISSING,
  ROUTING_NO_RAIL,
  ROUTING_REQUIRED_DIMENSIONS,
  describeRoutingPolicy,
} from './routing-policy.js';

describe('describeRoutingPolicy', () => {
  it('states mechanism honesty without inventing approval rates or payer rails', () => {
    const p = describeRoutingPolicy();
    expect(p.requiredDimensions).toEqual([...ROUTING_REQUIRED_DIMENSIONS]);
    expect(p.refuseCodes).toEqual([ROUTING_INPUT_MISSING, ROUTING_NO_RAIL, 'pay.routing_approval_rate_unset']);
    expect(p.decisionKind).toBe(ROUTING_DECISION_KIND);
    expect(p.forbiddenScoreFields).toEqual([...FORBIDDEN_ROUTING_SCORE_FIELDS]);
    expect(p.referenceProfileRailIds).toEqual([...REFERENCE_PROFILE_RAIL_IDS]);
    expect(p.inventsApprovalRates).toBe(false);
    expect(p.inventsCostWeights).toBe(false);
    expect(p.payerMayNameRail).toBe(false);
    expect(p.preferenceOperatorSupplied).toBe(true);
    expect(p.referenceProfilesNotSilentDefault).toBe(true);
    expect(p.skipCannotHonestlyAccept).toBe(true);
    expect(p.idempotencyPerPaymentNotAttempt).toBe(true);
    expect(p.explainableDecisions).toBe(true);
    expect(p.movesValue).toBe(false);
  });
});

describe('routing.policy route (pay.routing honesty door)', () => {
  it('router mounts describeRoutingPolicy on routing.policy', async () => {
    // A public read: a caller with no principal gets the board. The door answers routing/routing-policy.ts's board (the
    // smart-routing one), not this file's describeRoutingPolicy, which the tracker mount reads (routing/mount-vs-tracker.ts).
    const router = createPayRouter({} as PayService, new RailRegistry([]), {} as UserMoneyService);
    const caller = router.createCaller({ principal: null, service: null, region: 'DE', requestId: 'routing-policy' } as Context);
    await expect(caller.routing.policy()).resolves.toEqual(describeMountedRoutingPolicy());
    expect(describeMountedRoutingPolicy()).toMatchObject({ inventsApprovalRates: false, inventsCostWeights: false, movesMoney: false });
  });
});
