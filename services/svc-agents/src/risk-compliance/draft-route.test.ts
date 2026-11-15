import { describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { createAgentsRouter } from '../router.js';
import type { AgentsRouterDeps } from '../router.js';

// This file proves the blank-list refusal. Since OWNER 258 (1) a dev or test process with no env list screens with
// the owner's unsigned rows (packages/config screening.ts), so the file keeps them out to stay on the blank list.
process.env.INTAFACED_UNSIGNED_SANCTIONS_ROWS = 'off';

const SECRET = 'an-agents-risk-compliance-draft-route-test-secret';
const USER = '11111111-1111-4111-8111-111111111111';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-agents' });

function signed() {
  const p = {
    sub: USER,
    userId: USER,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes: ['agents:read'],
    tier: 'none',
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
    id: 'req-signed',
  });
}

function stubDeps(): AgentsRouterDeps {
  return {
    runtime: {} as AgentsRouterDeps['runtime'],
    gateway: { routingTable: { routes: [] } } as unknown as AgentsRouterDeps['gateway'],
    meter: {} as AgentsRouterDeps['meter'],
    feeAssetId: 'IFC',
  };
}

describe('riskCompliance public doors', () => {
  it('draftScreening returns a typed refuse when screening env is empty — not blocked:true', async () => {
    const result = await createAgentsRouter(stubDeps())
      .createCaller(signed())
      .riskCompliance.draftScreening({ subjectId: USER, region: 'DE' });
    expect(result.status).toBe('refuse');
    if (result.status !== 'refuse') return;
    expect(result.reason).toBe('screening_unset');
    expect(result.kind).toBe('not_a_decision');
    expect(result.isDecision).toBe(false);
    expect(result.inventedBlockedList).toBe(false);
    expect(result.screeningConfigured).toBe(false);
    expect(result).not.toHaveProperty('blocked');
    expect(JSON.stringify(result)).not.toMatch(/"blocked"\s*:\s*true/);
  });

  it('draftScreening refuses missing inputs', async () => {
    const result = await createAgentsRouter(stubDeps()).createCaller(signed()).riskCompliance.draftScreening({});
    expect(result).toMatchObject({ status: 'refuse', reason: 'inputs_missing', kind: 'not_a_decision' });
  });

  it('draftScreening refuses asDecision so a draft cannot become a decision on the wire', async () => {
    const result = await createAgentsRouter(stubDeps())
      .createCaller(signed())
      .riskCompliance.draftScreening({ subjectId: USER, region: 'DE', asDecision: true });
    expect(result).toMatchObject({ status: 'refuse', reason: 'decision_forbidden' });
  });

  it('refuseKycReview never writes reviewed_by', async () => {
    const result = await createAgentsRouter(stubDeps())
      .createCaller(signed())
      .riskCompliance.refuseKycReview({ recordId: 'kyc-1', reviewerId: 'agent', decision: 'approved' });
    expect(result.status).toBe('refuse');
    expect(result.writable).toBe(false);
    expect(result.column).toBe('reviewed_by');
    expect(result).not.toHaveProperty('reviewedBy');
  });
});
