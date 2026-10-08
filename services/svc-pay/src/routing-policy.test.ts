import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FORBIDDEN_ROUTING_SCORE_FIELDS } from './routing-inputs.js';
import {
  REFERENCE_PROFILE_RAIL_IDS,
  ROUTING_DECISION_KIND,
  ROUTING_INPUT_MISSING,
  ROUTING_NO_RAIL,
  ROUTING_REQUIRED_DIMENSIONS,
  describeRoutingPolicy,
} from './routing-policy.js';

const here = dirname(fileURLToPath(import.meta.url));
const routerSource = readFileSync(join(here, 'router.ts'), 'utf8');

describe('describeRoutingPolicy', () => {
  it('states mechanism honesty without inventing approval rates or payer rails', () => {
    const p = describeRoutingPolicy();
    expect(p.requiredDimensions).toEqual([...ROUTING_REQUIRED_DIMENSIONS]);
    expect(p.refuseCodes).toEqual([
      ROUTING_INPUT_MISSING,
      ROUTING_NO_RAIL,
      'pay.routing_approval_rate_unset',
    ]);
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
  it('router mounts describeRoutingPolicy on routing.policy', () => {
    expect(routerSource).toMatch(/policy:\s*publicProcedure\.query\(\(\)\s*=>\s*describeRoutingPolicy\(\)\)/);
  });
});
