import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertEligible, SignUpError, subdivisionCode, type SignUpStart } from './sign-up.js';

// This file proves the blank-list refusal. Since OWNER 258 (1) a dev or test process with no env list screens with
// the owner's unsigned rows (packages/config screening.ts), so the file keeps them out to stay on the blank list.
process.env.INTAFACED_UNSIGNED_SANCTIONS_ROWS = 'off';

/**
 * Sign-up's residence and citizenship check against Hyperliquid's restricted list, the launch default (OWNER 258 (1);
 * terms clause 1.6 at https://app.hyperliquid.xyz/terms, "Last updated on June 15, 2026", read 9 Nov 2026):
 * (a) residence in the US or Ontario is refused, (b) residence in a screened region is refused, (c) citizens of a
 * screened region are refused wherever they live. No database: nothing is written before this check.
 *
 * The screening list here is a TEST fixture, like the one in sign-up.pg.test.ts: sign-up takes real ISO countries
 * only, so its rows are real codes (the brief's UA-43 example, and KP as in the pg test). It is not a sanctions list
 * and ships nowhere; the shipped list is the counsel-set INTAFACED_SANCTIONS_REGIONS.
 */
const ENV = ['INTAFACED_SANCTIONS_REGIONS', 'INTAFACED_SANCTIONS_LIST_SOURCE', 'INTAFACED_SCREENING_FAIL_CLOSED', 'APP_ENV'] as const;
const saved: Record<string, string | undefined> = {};
const NOW = new Date('2026-11-09T00:00:00Z');
const DEPS = { minAgeYears: 18 };

function input(over: Partial<SignUpStart> = {}): SignUpStart {
  return {
    handle: 'eligible',
    email: 'eligible@example.test',
    password: 'not-checked-here',
    country: 'DE',
    usPerson: false,
    dateOfBirth: '1990-01-01',
    accountType: 'individual',
    ...over,
  } as SignUpStart;
}

function codeOf(over: Partial<SignUpStart>): string {
  try {
    assertEligible(DEPS, input(over), NOW);
    return 'allowed';
  } catch (e) {
    if (e instanceof SignUpError) return e.code;
    throw e;
  }
}

beforeEach(() => {
  for (const k of ENV) saved[k] = process.env[k];
  process.env.INTAFACED_SANCTIONS_REGIONS = 'UA-43:TEST fixture subdivision row,KP:TEST fixture country row';
  process.env.INTAFACED_SANCTIONS_LIST_SOURCE = 'counsel-memo-TEST for the sign-up test';
  process.env.INTAFACED_SCREENING_FAIL_CLOSED = '1';
  process.env.APP_ENV = 'test';
});
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('sign-up residence and citizenship (Hyperliquid terms 1.6, OWNER 258)', () => {
  it('takes ISO 3166-2 shapes inside a real country only', () => {
    expect(subdivisionCode('ca-on')).toBe('CA-ON');
    expect(subdivisionCode('UA-43')).toBe('UA-43');
    expect(subdivisionCode('ZZ-01')).toBeUndefined();
    expect(subdivisionCode('CA')).toBeUndefined();
    expect(subdivisionCode('CA-ONTA')).toBeUndefined();
  });

  it('refuses an Ontario resident and serves a Quebec one', () => {
    expect(codeOf({ country: 'CA', subdivision: 'CA-ON' })).toBe('identity.region_blocked');
    expect(codeOf({ country: 'CA', subdivision: 'ca-qc' })).toBe('allowed');
  });

  it('asks a Canadian for the province rather than let the bare country through', () => {
    expect(codeOf({ country: 'CA' })).toBe('identity.subdivision_required');
    expect(codeOf({ country: 'CA', subdivision: 'US-NY' })).toBe('identity.country_invalid');
    // A country with no subdivision row is not asked.
    expect(codeOf({ country: 'DE' })).toBe('allowed');
  });

  it('refuses a US resident (1.6 (a)) and, as before this change, a US citizen living outside the US (OWNER 237)', () => {
    expect(codeOf({ country: 'US' })).toBe('identity.region_blocked');
    expect(codeOf({ country: 'DE', nationality: 'US' })).toBe('identity.region_blocked');
    expect(codeOf({ country: 'CA', subdivision: 'CA-QC', nationality: 'US' })).toBe('identity.region_blocked');
    expect(codeOf({ country: 'DE', nationality: 'GB' })).toBe('allowed');
  });

  it('a subdivision row in the screening list refuses that region and its citizens', () => {
    expect(codeOf({ country: 'UA' })).toBe('identity.subdivision_required');
    expect(codeOf({ country: 'UA', subdivision: 'UA-43' })).toBe('identity.region_blocked');
    expect(codeOf({ country: 'UA', subdivision: 'UA-30' })).toBe('allowed');
    expect(codeOf({ country: 'DE', nationality: 'UA-43' })).toBe('identity.region_blocked');
    expect(codeOf({ country: 'DE', nationality: 'UA' })).toBe('allowed');
  });

  it('refuses citizens of a screened country wherever they live', () => {
    expect(codeOf({ country: 'DE', nationality: 'KP' })).toBe('identity.region_blocked');
    expect(codeOf({ country: 'CA', subdivision: 'CA-QC', nationality: 'kp' })).toBe('identity.region_blocked');
  });

  it('a blank screening list refuses with its typed error, nationality or not, before asking for a province', () => {
    delete process.env.INTAFACED_SANCTIONS_REGIONS;
    expect(codeOf({ country: 'DE' })).toBe('identity.screening_unset');
    expect(codeOf({ country: 'CA' })).toBe('identity.screening_unset');
    expect(codeOf({ country: 'DE', nationality: 'US' })).toBe('identity.screening_unset');
  });
});

describe('J-identity-01 #9: the blocked region says why, and the US-person question is answered by the person', () => {
  const refusal = (over: Partial<SignUpStart>): SignUpError => {
    try {
      assertEligible(DEPS, input(over), NOW);
    } catch (e) {
      if (e instanceof SignUpError) return e;
      throw e;
    }
    throw new Error('allowed');
  };

  it('a blocked province or territory is refused with its own reason, by either authority', () => {
    expect(refusal({ country: 'CA', subdivision: 'CA-ON' })).toMatchObject({
      code: 'identity.region_blocked',
      message: 'Ontario, Canada is not served at launch.',
    });
    expect(refusal({ country: 'UA', subdivision: 'UA-43' })).toMatchObject({
      code: 'identity.region_blocked',
      message: 'TEST fixture subdivision row',
    });
  });

  it('a US person is refused from their own answer, wherever they live, where the US is blocked', () => {
    const us = refusal({ country: 'DE', usPerson: true });
    expect(us.code).toBe('identity.us_person_blocked');
    expect(us.message).toBe(
      'We cannot open accounts for US persons (US citizens, green-card holders and US residents, wherever they live). The United States is not served at launch.',
    );
    expect(refusal({ country: 'CA', subdivision: 'CA-QC', usPerson: true }).code).toBe('identity.us_person_blocked');
    expect(codeOf({ country: 'DE', usPerson: false })).toBe('allowed');
  });

  it('an unanswered US-person question is refused, never taken as no', () => {
    expect(codeOf({ country: 'DE', usPerson: undefined })).toBe('identity.us_person_unanswered');
    expect(codeOf({ country: 'DE', usPerson: 'no' as unknown as boolean })).toBe('identity.us_person_unanswered');
  });

  it('a blank list refuses before the US-person question is read', () => {
    delete process.env.INTAFACED_SANCTIONS_REGIONS;
    expect(codeOf({ country: 'DE', usPerson: undefined })).toBe('identity.screening_unset');
    expect(codeOf({ country: 'DE', usPerson: true })).toBe('identity.screening_unset');
  });
});

describe("the owner's sign-up off switch covers a country's subdivisions", () => {
  it('refuses a residence or nationality given as a subdivision of a closed country', () => {
    const deps = { minAgeYears: 18, closedCountries: ['CA', 'DE'] };
    const code = (over: Partial<SignUpStart>): string => {
      try {
        assertEligible(deps, input(over), NOW);
        return 'allowed';
      } catch (e) {
        if (e instanceof SignUpError) return e.code;
        throw e;
      }
    };
    expect(code({ country: 'CA', subdivision: 'CA-QC' })).toBe('identity.region_blocked');
    expect(code({ country: 'FR', nationality: 'DE-BY' })).toBe('identity.region_blocked');
    expect(code({ country: 'FR', nationality: 'GB' })).toBe('allowed');
  });
});
