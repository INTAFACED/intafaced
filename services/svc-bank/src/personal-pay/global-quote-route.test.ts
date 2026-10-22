import { describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { createBankRouter } from '../router.js';
import type { BankServices } from '../bank-service.js';
import { GlobalSendService, parseOurFees } from './global.js';
import { personalPayError } from './errors.js';
import { emptyGlobalPorts, type FxQuote } from './ports.js';

/**
 * BK-xfer-03 DR5: `global.quote` through the router (D85). The customer route does NOT take a charge bearer yet
 * (OUR is quote-only in the service until send charges it), and an OUR refusal maps to PRECONDITION_FAILED.
 */
const EDGE = 'a-bank-global-quote-edge-secret-long-enough';
const ALICE = '11111111-1111-4111-8111-111111111111';
const quoted: FxQuote = {
  rate: '0.92',
  fee: '1.50',
  feeAsset: 'USDT',
  receiveAmount: '90.62',
  validUntil: '2999-01-01T00:00:00Z',
  eta: '2999-01-02T00:00:00Z',
};

function caller(globalSend: unknown) {
  const principal = {
    sub: ALICE,
    userId: ALICE,
    sid: '44444444-4444-4444-8444-444444444444',
    scopes: ['bank:read', 'bank:write'],
    tier: 'full',
    mfa: true,
    expiresAt: new Date(Date.now() + 60_000),
  } as Principal;
  const raw = encodePrincipal(principal);
  return createBankRouter({ globalSend } as unknown as BankServices).createCaller(
    createEdgeContext({ secret: EDGE, serviceName: 'svc-bank' })({
      headers: {
        'x-intafaced-principal': raw,
        'x-intafaced-principal-sig': signPrincipalHeader(raw, EDGE, 'DE'),
        'x-intafaced-region': 'DE',
      },
      id: 'req',
    }),
  );
}
const live = {
  ...emptyGlobalPorts(),
  fx: { status: () => 'live' as const, quote: async () => quoted },
};
const input = { asset: 'USDT', amount: '100', toCurrency: 'EUR' };

describe('global.quote route (BK-xfer-03 DR5)', () => {
  it('quotes through the router with the provider figures and no charge-bearer fields', async () => {
    const svc = new GlobalSendService(null as never, null as never, null as never, live);
    const out = await caller(svc).global.quote(input);
    expect(out).toEqual(quoted);
  });

  it('the customer route refuses chargeBearer (strict input): OUR is not offered until send charges it', async () => {
    const svc = new GlobalSendService(null as never, null as never, null as never, live);
    for (const chargeBearer of ['OUR', 'SHA'])
      await expect(caller(svc).global.quote({ ...input, chargeBearer } as never)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('bank.our_fee_unset maps to PRECONDITION_FAILED over tRPC', async () => {
    const svc = {
      async quote() {
        throw personalPayError('bank.our_fee_unset', 'EUR');
      },
    };
    await expect(caller(svc).global.quote(input)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });
});

describe('OUR fee table hardening (DR5 minors)', () => {
  it('a zero fee is not a published price: the table is unset', () => {
    for (const fee of ['0', '0.00', '000.0']) expect(parseOurFees(JSON.stringify([{ currency: 'EUR', fee, feeAsset: 'USDT' }]))).toBeNull();
    expect(parseOurFees(JSON.stringify([{ currency: 'EUR', fee: '0.01', feeAsset: 'USDT' }]))?.get('EUR')?.fee).toBe('0.01');
  });

  it('an OUR row in a different asset from the one being sent refuses bank.our_fee_unset before the provider is asked', async () => {
    let asked = 0;
    const ports = { ...emptyGlobalPorts(), fx: { status: () => 'live' as const, quote: async () => (asked++, quoted) } };
    const svc = new GlobalSendService(
      null as never,
      null as never,
      null as never,
      ports,
      undefined,
      undefined,
      undefined,
      JSON.stringify([{ currency: 'EUR', fee: '25.00', feeAsset: 'USDC' }]),
    );
    await expect(svc.quote({ ...input, chargeBearer: 'OUR' })).rejects.toMatchObject({ code: 'bank.our_fee_unset' });
    expect(asked).toBe(0);
  });
});
