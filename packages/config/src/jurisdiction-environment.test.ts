import { afterEach, describe, expect, it, vi } from 'vitest';
import { SCREENING_FAIL_CLOSED_ENV, UnscreenedJurisdictionError, assertScreeningConfigured, checkAccess } from './jurisdiction.js';
import {
  SANCTIONS_REGIONS_ENV,
  SANCTIONS_SOURCE_ENV,
  SCREENING_REVIEWED_EMPTY,
  ScreeningMoneyPostureError,
  UNSET_SCREENING_LIST,
} from './screening.js';

afterEach(() => vi.unstubAllEnvs());

describe('jurisdiction boot screening requires an explicit local environment', () => {
  it.each(['dev', 'test'])('reports the unconfigured gap without blocking explicit APP_ENV=%s', (appEnv) => {
    const status = assertScreeningConfigured({ APP_ENV: appEnv });
    expect(status.configured).toBe(false);
    expect(status.readsAsScreenedClean).toBe(false);
  });

  it.each([undefined, '', '   ', 'production', 'preview', 'DEV', ' dev '])('refuses an unconfigured list when APP_ENV is %j', (appEnv) => {
    expect(() => assertScreeningConfigured({ APP_ENV: appEnv })).toThrow(UnscreenedJurisdictionError);
  });

  it.each([undefined, '', '   ', 'production', 'preview', 'DEV', ' dev '])(
    'refuses fixture screening provenance when APP_ENV is %j',
    (appEnv) => {
      expect(() =>
        assertScreeningConfigured({
          APP_ENV: appEnv,
          [SANCTIONS_REGIONS_ENV]: SCREENING_REVIEWED_EMPTY,
          [SANCTIONS_SOURCE_ENV]: 'test-fixture-not-a-real-list',
        }),
      ).toThrow(ScreeningMoneyPostureError);
    },
  );
});

describe('jurisdiction request screening requires an explicit local environment', () => {
  it.each(['dev', 'test'])('honours screening-off flags only in explicit APP_ENV=%s and reports the gap', (appEnv) => {
    vi.stubEnv('APP_ENV', appEnv);
    for (const flag of ['0', ' FALSE ', 'No', ' off ']) {
      vi.stubEnv(SCREENING_FAIL_CLOSED_ENV, flag);
      const decision = checkAccess({
        module: 'pay',
        plane: 'fiat',
        region: 'GB',
        kycTier: 'full',
        screening: UNSET_SCREENING_LIST,
      });

      expect(decision.allowed, flag).toBe(true);
      expect(decision.screening.listConfigured, flag).toBe(false);
      expect(decision.screening.readsAsScreenedClean, flag).toBe(false);
    }
  });

  it.each([undefined, '', '   ', 'production', 'preview', 'DEV', ' dev ', 'staging', 'prod'])(
    'ignores a screening-off environment flag when APP_ENV is %j',
    (appEnv) => {
      vi.stubEnv('APP_ENV', appEnv);
      vi.stubEnv(SCREENING_FAIL_CLOSED_ENV, 'off');

      const decision = checkAccess({
        module: 'pay',
        plane: 'fiat',
        region: 'GB',
        kycTier: 'full',
        screening: UNSET_SCREENING_LIST,
      });

      expect(decision.allowed).toBe(false);
      expect(decision.code).toBe('denied.screening_unconfigured');
      expect(decision.screening.readsAsScreenedClean).toBe(false);
    },
  );
});
