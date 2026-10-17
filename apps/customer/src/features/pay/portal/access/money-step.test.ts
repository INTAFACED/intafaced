import { describe, expect, it } from 'vitest';
import { moneyReason } from './money-step';
import { scopesOfAccessToken } from './session-scopes';

// TEST data only. A token shaped like identity's: header.payload.signature, the payload carrying `scopes`.
const token = (payload: unknown) =>
  `${btoa('{"alg":"HS256"}')}.${btoa(JSON.stringify(payload)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}.sig`;

describe('the scopes a session carries', () => {
  it('reads them from the access token', () => {
    expect([...scopesOfAccessToken(token({ sub: 'u', scopes: ['pay:read', 'pay:write'] }))!]).toEqual(['pay:read', 'pay:write']);
  });
  it('holds nothing when the token cannot be read', () => {
    for (const bad of [undefined, null, '', 'portal-test-only', 'a.b.c', token({ sub: 'u' }), token({ scopes: 'pay:refund' })])
      expect(scopesOfAccessToken(bad as string | null | undefined), String(bad)).toBeNull();
  });
});

describe('the reason a money control is off', () => {
  const owner = new Set(['pay:read', 'pay:write', 'pay:onboard']);
  it('is a present-tense sentence when the session lacks the scope, and null when it has it', () => {
    expect(moneyReason('refund', owner)).toBe('Refunding needs a confirmed sign-in step that this deployment does not offer.');
    expect(moneyReason('payout', owner)).toBe('Paying out needs a confirmed sign-in step that this deployment does not offer.');
    expect(moneyReason('refund', new Set([...owner, 'pay:refund']))).toBeNull();
    expect(moneyReason('payout', new Set([...owner, 'pay:refund']))).not.toBeNull();
    expect(moneyReason('payout', ['pay:payout'])).toBeNull();
  });
  it('fails closed when the scopes are unknown', () => {
    expect(moneyReason('refund', null)).not.toBeNull();
    expect(moneyReason('payout', undefined)).not.toBeNull();
  });
});
