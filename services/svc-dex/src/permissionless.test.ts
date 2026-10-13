import { describe, expect, it } from 'vitest';
import { checkAccess, parseScreeningList, SCREENING_REVIEWED_EMPTY, UNSET_SCREENING_LIST } from '@intafaced/config';

/** Attributed empty decision. Not a region list. */
const attributedEmpty = parseScreeningList(SCREENING_REVIEWED_EMPTY, 'counsel-memo-ref');

/**
 * THE ZERO-KYC CLAIM, TESTED.
 *
 * §503 says no-KYC exists on the Protocol Plane "because there is nothing to
 * KYC". That is an architectural claim, and an architectural claim that nothing
 * verifies is marketing.
 *
 * These assert the mechanism actually behaves that way — that `checkAccess`
 * really does admit an unverified caller to the DEX and really does refuse the
 * same caller at the custodial venue. If someone later "tidies" the
 * permissionless branch out of `checkAccess`, the DEX silently acquires a KYC
 * gate and the product claim quietly becomes false. This is what fails first.
 */
describe('the DEX is permissionless — and the custodial venue is not', () => {
  it('admits a caller with no verification at all', () => {
    const decision = checkAccess({
      module: 'dex',
      plane: 'protocol',
      region: 'GB',
      kycTier: 'none',
      screening: attributedEmpty,
    });
    expect(decision.allowed).toBe(true);
  });

  it('refuses the SAME caller at the custodial spot venue', () => {
    // The contrast is the point. One platform, two planes, one difference:
    // whether we are holding the asset.
    const decision = checkAccess({ module: 'trade', plane: 'fiat', region: 'GB', kycTier: 'none', screening: attributedEmpty });
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe('denied.kyc_required');
  });

  it('admits every tier equally — there is no tier ladder to climb', () => {
    for (const kycTier of ['none', 'basic', 'full', 'institutional'] as const) {
      expect(checkAccess({ module: 'dex', plane: 'protocol', region: 'GB', kycTier, screening: attributedEmpty }).allowed, kycTier).toBe(
        true,
      );
    }
  });

  /**
   * The line that separates sovereignty from evasion.
   *
   * Not holding the asset removes the identity requirement. It does not remove
   * sanctions law — §24 Lane A: "Sanctions-screening on the hosted front-end
   * per applicable law; the contracts themselves are permissionless
   * infrastructure."
   *
   * The shipped sanctions list is blank. A blank list stays blank: this call
   * refuses closed with a typed code, and it does not invent a region entry
   * to get there. Counsel supplies the list later; an engineer does not.
   */
  it('refuses hosted DEX access while the sanctions list is blank', () => {
    const kp = checkAccess({
      module: 'dex',
      plane: 'protocol',
      region: 'KP',
      kycTier: 'none',
      screening: UNSET_SCREENING_LIST,
      screeningFailClosed: true,
    });

    expect(kp.allowed).toBe(false);
    expect(kp.code).toBe('denied.screening_unconfigured');
    expect(kp.screening.listConfigured).toBe(false);
    expect(kp.screening.declaration).toBe('unset');
    expect(kp.screening.blockedRegionCount).toBe(0);
  });

  it('refuses a blocked region on the CUSTODIAL plane, proving the mechanism works', () => {
    // Same empty blocklist, so this is about the code path rather than the
    // data: a custodial module in an unknown region still demands a tier.
    const decision = checkAccess({ module: 'trade', plane: 'fiat', region: 'KP', kycTier: 'none', screening: attributedEmpty });
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe('denied.kyc_required');
  });
});
