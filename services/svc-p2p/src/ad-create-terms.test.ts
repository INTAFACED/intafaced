import { describe, expect, it } from 'vitest';
import {
  AdCreateTermsError,
  assertAdvisoryBalance,
  assertTermsAccepted,
  offerCreateIdempotencyKey,
  requirePublishedTermsVersion,
} from './ad-create-terms.js';

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return e instanceof AdCreateTermsError ? e.code : 'other';
  }
  return undefined;
}

describe('P-ads-merchant-01 ad create rules', () => {
  it('blank terms version refuses p2p.config_unset', () => {
    for (const v of [null, undefined, '', '   ']) expect(code(() => requirePublishedTermsVersion(v))).toBe('p2p.config_unset');
    expect(requirePublishedTermsVersion(' 2026-10 ')).toBe('2026-10');
  });

  it('terms not accepted, or stale version, refuses p2p.terms_not_accepted', () => {
    expect(code(() => assertTermsAccepted({ published: 'v2', requested: 'v2', acceptedVersions: [] }))).toBe('p2p.terms_not_accepted');
    expect(code(() => assertTermsAccepted({ published: 'v2', requested: 'v1', acceptedVersions: ['v1', 'v2'] }))).toBe(
      'p2p.terms_not_accepted',
    );
    expect(code(() => assertTermsAccepted({ published: 'v2', requested: 'v2', acceptedVersions: ['v1'] }))).toBe('p2p.terms_not_accepted');
    expect(code(() => assertTermsAccepted({ published: '', requested: 'v2', acceptedVersions: ['v2'] }))).toBe('p2p.config_unset');
    expect(assertTermsAccepted({ published: 'v2', requested: 'v2', acceptedVersions: ['v2'] })).toBe('v2');
  });

  it('idempotency key is stable per user and client request', () => {
    expect(offerCreateIdempotencyKey('u1', 'r1')).toBe('p2p:offer-create:u1:r1');
    expect(offerCreateIdempotencyKey('u1', 'r1')).toBe(offerCreateIdempotencyKey(' u1', 'r1 '));
    expect(() => offerCreateIdempotencyKey('', 'r1')).toThrow(TypeError);
  });

  it('total above available refuses p2p.insufficient_balance with the available decimal', () => {
    expect(() => assertAdvisoryBalance('100', '100.00')).not.toThrow();
    let err: AdCreateTermsError | undefined;
    try {
      assertAdvisoryBalance('100.0000001', '100');
    } catch (e) {
      err = e as AdCreateTermsError;
    }
    expect(err?.code).toBe('p2p.insufficient_balance');
    expect(err?.available).toBe('100');
  });

  it('unreadable balance fails closed', () => {
    for (const a of [null, undefined, '', '-1', '1e3', 'NaN'])
      expect(code(() => assertAdvisoryBalance('1', a))).toBe('p2p.insufficient_balance');
    expect(code(() => assertAdvisoryBalance('abc', '10'))).toBe('p2p.insufficient_balance');
  });
});
