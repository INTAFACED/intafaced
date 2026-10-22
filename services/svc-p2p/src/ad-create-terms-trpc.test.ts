import { describe, expect, it } from 'vitest';
import { AdCreateTermsError, toP2pRefusal } from './ad-create-terms.js';
import { P2pError } from './p2p-service.js';
import { publicProcedure, router } from '@intafaced/contracts';
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

describe('ad create terms refusals through the contracts error formatter', () => {
  const probe = router({ create: publicProcedure.query(() => undefined) });
  const format = probe._def._config.errorFormatter;

  for (const code of ['p2p.config_unset', 'p2p.terms_not_accepted', 'p2p.insufficient_balance', 'p2p.invalid_input'] as const) {
    it(`${code} reaches the client as data.cause.code`, () => {
      const error = toTrpcError(toP2pRefusal(new AdCreateTermsError('x', code, code === 'p2p.insufficient_balance' ? '5' : undefined)));
      const shape = format({
        shape: { message: error.message, code: -32000, data: { code: error.code, httpStatus: 412 } },
        error,
        type: 'mutation',
        path: 'p2p.ads.create',
        input: undefined,
        ctx: undefined,
      } as never) as { data: { cause?: { code: string } } };
      expect(shape.data.cause).toEqual({ code });
    });
  }
});
