import { describe, expect, it } from 'vitest';
import { AdCreateTermsError, toP2pRefusal } from './ad-create-terms.js';
import { P2pError } from './p2p-service.js';
import { toTrpcError } from './router.js';

describe('ad create terms refusals through toTrpcError (P-ads-merchant-01)', () => {
  const cases = [
    ['p2p.config_unset', 'PRECONDITION_FAILED'],
    ['p2p.terms_not_accepted', 'PRECONDITION_FAILED'],
    ['p2p.insufficient_balance', 'PRECONDITION_FAILED'],
    ['p2p.invalid_input', 'BAD_REQUEST'],
  ] as const;

  for (const [code, trpc] of cases) {
    it(`${code} -> P2pError -> ${trpc}`, () => {
      const r = toP2pRefusal(new AdCreateTermsError('x', code, code === 'p2p.insufficient_balance' ? '5' : undefined));
      expect(r).toBeInstanceOf(P2pError);
      expect((r as P2pError).code).toBe(code);
      const t = toTrpcError(r);
      expect(t.code).toBe(trpc);
      expect((t.cause as P2pError).code).toBe(code);
    });
  }

  it('insufficient_balance keeps available', () => {
    const r = toP2pRefusal(new AdCreateTermsError('x', 'p2p.insufficient_balance', '12.5')) as P2pError;
    expect(r.available).toBe('12.5');
  });
});
