import { describe, expect, it } from 'vitest';
import {
  isSupportTierGateOk,
  supportTierGate,
  supportTierGateBoardCard,
  supportTierGateStatusLine,
  type SupportTierLaw,
} from './tier-gate.js';

const published: SupportTierLaw = {
  published: true,
  matrix: { free: ['support.kb.search'], premium: ['support.kb.search', 'support.ticket.read'] },
};

describe('support Stage-2 tier gate', () => {
  it('refuses closed when no law is supplied — never a default grant', () => {
    for (const law of [null, undefined, { published: false } as const]) {
      expect(supportTierGate({ law, userTier: 'premium' })).toEqual({
        status: 'refuse',
        reason: 'tier_law_blank',
        userMessageKey: 'agents.support.tier_closed',
      });
    }
  });

  it('a published-but-empty matrix is still blank law', () => {
    expect(supportTierGate({ law: { published: true, matrix: {} }, userTier: 'free' }).status).toBe('refuse');
    expect(supportTierGate({ law: { published: true, matrix: {} }, userTier: 'free' })).toMatchObject({
      reason: 'tier_law_blank',
    });
  });

  it('refuses a tier the matrix does not name, and a blank tier', () => {
    expect(supportTierGate({ law: published, userTier: 'staked' })).toMatchObject({ reason: 'tier_not_granted' });
    expect(supportTierGate({ law: published, userTier: '   ' })).toMatchObject({ reason: 'tier_not_granted' });
  });

  it('grants exactly the tools the matrix lists — nothing widened', () => {
    const result = supportTierGate({ law: published, userTier: 'free' });
    expect(isSupportTierGateOk(result)).toBe(true);
    expect(result).toEqual({ status: 'ok', userTier: 'free', allowedTools: ['support.kb.search'] });
  });

  it('refuses a userTier that is only an Object.prototype name', () => {
    const refused = {
      status: 'refuse' as const,
      reason: 'tier_not_granted' as const,
      userMessageKey: 'agents.support.tier_closed' as const,
    };

    const toStringResult = supportTierGate({ law: published, userTier: 'toString' });
    expect(toStringResult).toEqual(refused);
    expect(toStringResult.status).not.toBe('ok');
    expect(toStringResult).not.toHaveProperty('allowedTools', Object.prototype.toString);

    const constructorResult = supportTierGate({ law: published, userTier: 'constructor' });
    expect(constructorResult).toEqual(refused);
    expect(constructorResult.status).not.toBe('ok');
    expect(constructorResult).not.toHaveProperty('allowedTools', Object.prototype.constructor);
  });

  it('board card and status line report the refusal reason', () => {
    const refuse = supportTierGate({ law: null, userTier: 'free' });
    expect(supportTierGateBoardCard(refuse)).toEqual({ ok: false, reason: 'tier_law_blank', toolCount: 0 });
    expect(supportTierGateStatusLine(refuse)).toBe('ok=0 tools=0 reason=tier_law_blank');
    expect(supportTierGateStatusLine(supportTierGate({ law: published, userTier: 'premium' }))).toBe('ok=1 tools=2 reason=-');
  });
});
