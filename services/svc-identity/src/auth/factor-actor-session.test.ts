import { describe, expect, it } from 'vitest';
import { factorActor } from './factor-gate.js';

describe('factorActor carries the enrolling session (L231)', () => {
  it('maps the access token sid so TOTP enrolment can keep exactly that session', () => {
    const sid = '11111111-1111-4111-8111-111111111111';
    const actor = factorActor({ userId: 'u', mfa: false, scopes: [], sid });
    expect(actor.sessionId).toBe(sid);
  });
});
