import { describe, expect, it } from 'vitest';
import { AdCreateTermsError, toP2pRefusal } from './ad-create-terms.js';
import { P2pError } from './p2p-service.js';

describe('toP2pRefusal (P-ads-merchant-01 typed refusal)', () => {
  it('config_unset maps to P2pError with the same code', () => {
    const r = toP2pRefusal(new AdCreateTermsError('x', 'p2p.config_unset'));
    expect(r).toBeInstanceOf(P2pError);
    expect((r as P2pError).code).toBe('p2p.config_unset');
  });
  it('the other codes keep exactly one p2p code and a status class', () => {
    expect(toP2pRefusal(new AdCreateTermsError('x', 'p2p.terms_not_accepted'))).toEqual({
      code: 'p2p.terms_not_accepted',
      status: 'PRECONDITION_FAILED',
    });
    expect(toP2pRefusal(new AdCreateTermsError('x', 'p2p.invalid_input'))).toEqual({
      code: 'p2p.invalid_input',
      status: 'BAD_REQUEST',
    });
    expect(toP2pRefusal(new AdCreateTermsError('x', 'p2p.insufficient_balance', '5'))).toEqual({
      code: 'p2p.insufficient_balance',
      status: 'PRECONDITION_FAILED',
      available: '5',
    });
  });
  it('a non-AdCreateTermsError passes through unchanged', () => {
    const e = new Error('boom');
    expect(toP2pRefusal(e)).toBe(e);
  });
});
