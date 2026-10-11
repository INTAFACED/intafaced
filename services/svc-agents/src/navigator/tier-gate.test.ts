import { describe, expect, it } from 'vitest';
import { navigatorTierGate, isNavigatorTierGateOk, navigatorTierGateBoardCard, navigatorTierGateStatusLine } from './tier-gate.js';

describe('navigator Stage-2 tier gate', () => {
  it('refuse-closed when law is null/blank', () => {
    expect(navigatorTierGate({ law: null, userTier: 'free' })).toEqual({
      status: 'refuse',
      reason: 'tier_law_blank',
      userMessageKey: 'agents.navigator.tier_closed',
    });
    expect(navigatorTierGate({ law: { published: false }, userTier: 'free' })).toMatchObject({
      status: 'refuse',
      reason: 'tier_law_blank',
    });
    expect(navigatorTierGate({ law: { published: true, matrix: {} }, userTier: 'free' })).toMatchObject({
      status: 'refuse',
      reason: 'tier_law_blank',
    });
  });

  it('does not invent a default matrix — unpublished stays closed', () => {
    const r = navigatorTierGate({ law: undefined, userTier: 'premium' });
    expect(isNavigatorTierGateOk(r)).toBe(false);
    expect(navigatorTierGateBoardCard(r).ok).toBe(false);
    expect(navigatorTierGateStatusLine(r)).toContain('tier_law_blank');
  });

  it('opens only when caller supplies published matrix for the tier', () => {
    const r = navigatorTierGate({
      law: {
        published: true,
        matrix: {
          free: ['trade.markets.list', 'identity.session.read'],
          staked: ['trade.quote', 'trade.markets.list', 'identity.session.read'],
        },
      },
      userTier: 'free',
    });
    expect(r).toEqual({
      status: 'ok',
      userTier: 'free',
      allowedTools: ['trade.markets.list', 'identity.session.read'],
    });
  });

  it('refuses tiers absent from published matrix', () => {
    expect(
      navigatorTierGate({
        law: { published: true, matrix: { free: ['trade.quote'] } },
        userTier: 'vip',
      }),
    ).toEqual({
      status: 'refuse',
      reason: 'tier_not_granted',
      userMessageKey: 'agents.navigator.tier_closed',
    });
  });

  it('refuses a userTier that is only an Object.prototype name', () => {
    const law = {
      published: true as const,
      matrix: { free: ['trade.quote'] },
    };
    const refused = {
      status: 'refuse' as const,
      reason: 'tier_not_granted' as const,
      userMessageKey: 'agents.navigator.tier_closed' as const,
    };

    const constructorResult = navigatorTierGate({ law, userTier: 'constructor' });
    expect(constructorResult).toEqual(refused);
    expect(constructorResult.status).not.toBe('ok');
    expect(constructorResult).not.toHaveProperty('allowedTools', Object.prototype.constructor);

    const toStringResult = navigatorTierGate({ law, userTier: 'toString' });
    expect(toStringResult).toEqual(refused);
    expect(toStringResult.status).not.toBe('ok');
    expect(toStringResult).not.toHaveProperty('allowedTools', Object.prototype.toString);
  });
});
