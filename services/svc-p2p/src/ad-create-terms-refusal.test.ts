import { describe, expect, it } from 'vitest';
import { AdCreateTermsError, toP2pRefusal } from './ad-create-terms.js';
import { P2pError } from './p2p-service.js';

describe('toP2pRefusal (P-ads-merchant-01 typed refusal)', () => {
  it('config_unset maps to P2pError with the same code', () => {
    const r = toP2pRefusal(new AdCreateTermsError('x', 'p2p.config_unset'));
    expect(r).toBeInstanceOf(P2pError);
    expect((r as P2pError).code).toBe('p2p.config_unset');
  });
  it('the other codes map to P2pError with exactly their code', () => {
    for (const c of ['p2p.terms_not_accepted', 'p2p.invalid_input', 'p2p.insufficient_balance'] as const) {
      const r = toP2pRefusal(new AdCreateTermsError('x', c, c === 'p2p.insufficient_balance' ? '5' : undefined));
      expect(r).toBeInstanceOf(P2pError);
      expect((r as P2pError).code).toBe(c);
    }
    expect((toP2pRefusal(new AdCreateTermsError('x', 'p2p.insufficient_balance', '5')) as P2pError).available).toBe('5');
  });
  it('a non-AdCreateTermsError passes through unchanged', () => {
    const e = new Error('boom');
    expect(toP2pRefusal(e)).toBe(e);
  });
});
