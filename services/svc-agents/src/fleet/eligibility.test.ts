import { describe, expect, it } from 'vitest';
import { agentEligibility } from './eligibility.js';
import { NO_TIER_LAWS, parseTierLaws } from '../tier-laws.js';
import { navigatorTierGate } from '../navigator/tier-gate.js';

const laws = parseTierLaws(
  JSON.stringify({
    navigator: { published: true, matrix: { basic: ['trade.quote'], full: ['trade.quote'] } },
    support: { published: false },
    scanner: { published: true, matrix: { full: { maxSignals: 5, tools: ['trade.ticker'] } } },
  }),
);

describe('agent eligibility (J-agents-01 #2)', () => {
  it('grants a plan the published law names, and names the plans', () => {
    expect(agentEligibility('navigator', laws, 'basic')).toEqual({
      rule: 'plan',
      published: true,
      plans: ['basic', 'full'],
      yourPlan: 'basic',
      eligible: true,
      reason: null,
      code: null,
    });
  });
  it('leaves out an unverified person with the plan as the reason and the door’s own refusal code', () => {
    const verdict = agentEligibility('navigator', laws, 'none');
    expect(verdict).toMatchObject({ rule: 'plan', eligible: false, reason: 'plan', code: 'agents.tier_not_granted', yourPlan: 'none' });
    // The same answer the door itself gives this person.
    expect(navigatorTierGate({ law: laws.navigator, userTier: 'none' })).toMatchObject({ status: 'refuse', reason: 'tier_not_granted' });
  });
  it('an unpublished law grants no plan, so no one is eligible', () => {
    expect(agentEligibility('support', laws, 'full')).toMatchObject({
      rule: 'plan',
      published: false,
      plans: [],
      eligible: false,
      code: 'agents.tier_law_blank',
    });
    expect(agentEligibility('navigator', NO_TIER_LAWS, 'full')).toMatchObject({ published: false, eligible: false });
  });
  it('the scanner follows its own law', () => {
    expect(agentEligibility('scanner', laws, 'full').eligible).toBe(true);
    expect(agentEligibility('scanner', laws, 'basic')).toMatchObject({ eligible: false, code: 'agents.tier_not_granted' });
  });
  it('an agent with no tier-gated door has no plan, age or region rule', () => {
    for (const id of ['merchant', 'copy-intel', 'coach', 'portfolio', 'constructor'])
      expect(agentEligibility(id, laws, 'none')).toEqual({ rule: 'none', eligible: true, reason: null, code: null, yourPlan: 'none' });
  });
});

describe('agent eligibility when the published limits for a plan are not valid', () => {
  it('keeps the scanner door’s own depth_invalid code', () => {
    const bad = parseTierLaws(JSON.stringify({ scanner: { published: true, matrix: { full: { maxSignals: 0, tools: [] } } } }));
    expect(agentEligibility('scanner', bad, 'full')).toMatchObject({ eligible: false, plans: ['full'], code: 'agents.depth_invalid' });
  });
});
