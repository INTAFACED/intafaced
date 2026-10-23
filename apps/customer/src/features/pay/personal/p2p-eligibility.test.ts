import { describe, expect, it } from 'vitest';
import { eligibilityReason } from './Eligibility';
import { eligibilityCopy } from './p2p-eligibility-copy';
import { takeFailureKind, takeRefusalIsDefinite } from './p2p-model';

const { t } = eligibilityCopy.forLocale('en');

describe('P2P take requirements', () => {
  it('turns each service code into the app’s words, never the code itself', () => {
    expect(eligibilityReason(t, { id: 'verification', state: 'met', reason: 'tier.full', fix: null }, null)).toBe(
      'Verified at the full level.',
    );
    expect(eligibilityReason(t, { id: 'verification', state: 'not_met', reason: 'denied.kyc_required', fix: '/verification' }, null)).toBe(
      'P2P needs a verified identity.',
    );
    expect(eligibilityReason(t, { id: 'contact', state: 'not_met', reason: 'p2p.contact_required', fix: '/uc/account' }, null)).toContain(
      'Confirm your email address',
    );
    expect(eligibilityReason(t, { id: 'contact', state: 'unknown', reason: 'p2p.contact_unverifiable', fix: null }, null)).toContain(
      'could not be checked',
    );
    expect(eligibilityReason(t, { id: 'risk', state: 'met', reason: 'risk.accepted', fix: null }, 'TEST-v1')).toBe(
      'You accepted notice TEST-v1.',
    );
    expect(eligibilityReason(t, { id: 'risk', state: 'unknown', reason: 'p2p.risk_notice_unset', fix: null }, null)).toContain(
      'has not published',
    );
    // A refused region never shows the service's code, and an unset screening list is not blamed on the region.
    const region = (reason: string) => eligibilityReason(t, { id: 'jurisdiction', state: 'not_met', reason, fix: null }, null);
    expect(region('denied.region_blocked')).toBe('P2P is closed in your region.');
    expect(region('denied.screening_unconfigured')).toContain('screening is not set up');
    expect(region('denied.module_blocked')).toBe('The service refused this requirement.');
  });

  it('a refused take for contact or the notice is its own kind, and proof nothing was placed', () => {
    for (const [code, kind] of [
      ['p2p.contact_required', 'contact'],
      ['p2p.risk_not_accepted', 'risk'],
    ] as const) {
      expect(takeFailureKind({ reason: 'forbidden', code, status: 403 })).toBe(kind);
      expect(takeRefusalIsDefinite({ reason: 'forbidden', code, status: 403 })).toBe(true);
    }
    // A precondition refusal is normally "may have happened"; these gate codes run before anything is reserved. The
    // client reads a 412 as reason "error".
    for (const code of ['p2p.contact_unverifiable', 'p2p.risk_notice_unset', 'p2p.take_gate_unwired']) {
      expect(takeRefusalIsDefinite({ reason: 'error', code, status: 412 })).toBe(true);
      expect(takeFailureKind({ reason: 'error', code, status: 412 })).toBe('unchecked');
    }
  });
});
