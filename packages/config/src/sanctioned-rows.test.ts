import { describe, expect, it } from 'vitest';
import {
  UnscreenedJurisdictionError,
  assertScreeningConfigured,
  checkAccess,
  checkCitizenship,
  hasSubdivisionRows,
} from './jurisdiction.js';
import {
  OFAC_SANCTIONS_PROGRAMS_URL,
  SANCTIONED_LIST_ROWS,
  SANCTIONED_ROWS_SOURCE_SIGNED,
  SANCTIONED_ROWS_SOURCE_UNSIGNED,
  SANCTIONED_ROW_READING,
  SANCTIONS_REGIONS_ENV,
  SANCTIONS_SOURCE_ENV,
  SCREENING_REVIEWED_EMPTY,
  ScreeningListError,
  UNSIGNED_SANCTIONS_ROWS_ENV,
  configuredScreeningList,
  envScreeningList,
  sanctionedRowsSigned,
  screeningListFromRows,
  type SanctionedRow,
} from './screening.js';

/**
 * The owner's sanctioned list as config rows (OWNER 258 (1)): "use Hyperliquid's own restricted list as the launch
 * default, signed by you, with counsel reviewing at launch prep. Until a list exists, the live app lets nobody in."
 */
const ROWS_LIST = screeningListFromRows();
const PRODUCTION_LIKE = ['prod', 'staging', undefined, '', 'production', 'DEV'] as const;

describe('the rows', () => {
  it('are the agreed set, one per jurisdiction, each citing OFAC and marked as the agents’ reading', () => {
    expect(SANCTIONED_LIST_ROWS.map((r) => r.region)).toEqual(['CU', 'IR', 'KP', 'SY', 'UA-43', 'UA-40', 'UA-14', 'UA-09']);
    for (const r of SANCTIONED_LIST_ROWS) {
      expect(r.sourceUrl, r.region).toBe(OFAC_SANCTIONS_PROGRAMS_URL);
      expect(r.reading, r.region).toBe(SANCTIONED_ROW_READING);
      expect(r.reason.trim(), r.region).not.toBe('');
    }
  });

  it('ship unsigned: no agent fills a signature', () => {
    expect(SANCTIONED_LIST_ROWS.every((r) => r.signature === null)).toBe(true);
    expect(sanctionedRowsSigned()).toBe(false);
  });

  it('are screening content, never business blocks', () => {
    expect(ROWS_LIST.regions.every((r) => r.authority === 'screening')).toBe(true);
    const d = checkAccess({ module: 'pay', plane: 'fiat', region: 'IR', kycTier: 'full', screening: ROWS_LIST, business: [] });
    expect(d.code).toBe('denied.region_blocked');
    expect(d.blockedBy).toBe('screening');
  });

  it('refuse a duplicate or malformed row rather than drop it', () => {
    const dup: SanctionedRow[] = [SANCTIONED_LIST_ROWS[0]!, SANCTIONED_LIST_ROWS[0]!];
    expect(() => screeningListFromRows(dup)).toThrow(ScreeningListError);
    expect(() => screeningListFromRows([{ ...SANCTIONED_LIST_ROWS[0]!, region: 'Cuba' }])).toThrow(ScreeningListError);
  });
});

describe('which list a process screens with', () => {
  it.each(['dev', 'test'])('APP_ENV=%s with no env list screens with the unsigned rows', (appEnv) => {
    const list = configuredScreeningList({ APP_ENV: appEnv });
    expect(list.declaration).toBe('listed');
    expect(list.source).toBe(SANCTIONED_ROWS_SOURCE_UNSIGNED);
    expect(list.regions.map((r) => r.region)).toEqual(SANCTIONED_LIST_ROWS.map((r) => r.region));
    expect(envScreeningList({ APP_ENV: appEnv }).source).toBe(SANCTIONED_ROWS_SOURCE_UNSIGNED);
    expect(() => assertScreeningConfigured({ APP_ENV: appEnv })).not.toThrow();
  });

  it.each(PRODUCTION_LIKE)('a production-like boot (APP_ENV=%j) refuses while the rows are unsigned and no env list is set', (appEnv) => {
    expect(configuredScreeningList({ APP_ENV: appEnv }).declaration).toBe('unset');
    expect(() => assertScreeningConfigured({ APP_ENV: appEnv })).toThrow(UnscreenedJurisdictionError);
    // And hosted access lets nobody in, not even someone from an unlisted country.
    const d = checkAccess({
      module: 'dex',
      plane: 'protocol',
      region: 'GB',
      kycTier: 'none',
      screening: configuredScreeningList({ APP_ENV: appEnv }),
    });
    expect(d.allowed).toBe(false);
    expect(d.code).toBe('denied.screening_unconfigured');
  });

  it('the refusal names the unsigned rows and OWNER 258 (1)', () => {
    expect(() => assertScreeningConfigured({ APP_ENV: 'prod' })).toThrow(/SANCTIONED_LIST_ROWS.*UNSIGNED|UNSIGNED/);
    expect(() => assertScreeningConfigured({ APP_ENV: 'prod' })).toThrow(/OWNER 258 \(1\)/);
  });

  it('signed rows apply everywhere, production included', () => {
    const signed: SanctionedRow[] = SANCTIONED_LIST_ROWS.map((r) => ({
      ...r,
      signature: { signedBy: 'TEST signer', signedAt: '2026-01-01T00:00:00Z', record: 'TEST record' },
    }));
    expect(sanctionedRowsSigned(signed)).toBe(true);
    const list = configuredScreeningList({ APP_ENV: 'prod' }, signed);
    expect(list.declaration).toBe('listed');
    expect(list.source).toBe(SANCTIONED_ROWS_SOURCE_SIGNED);
  });

  it('one unsigned row, or a blank signature field, leaves the set unsigned', () => {
    const sig = { signedBy: 'TEST signer', signedAt: '2026-01-01T00:00:00Z', record: 'TEST record' };
    const allButOne: SanctionedRow[] = SANCTIONED_LIST_ROWS.map((r, i) => ({ ...r, signature: i === 0 ? null : sig }));
    expect(configuredScreeningList({ APP_ENV: 'prod' }, allButOne).declaration).toBe('unset');
    const blank: SanctionedRow[] = SANCTIONED_LIST_ROWS.map((r) => ({ ...r, signature: { ...sig, signedBy: '  ' } }));
    expect(configuredScreeningList({ APP_ENV: 'prod' }, blank).declaration).toBe('unset');
    expect(sanctionedRowsSigned([])).toBe(false);
  });

  it('an env list replaces the rows, on test and in production', () => {
    for (const appEnv of ['test', 'prod']) {
      const list = configuredScreeningList({
        APP_ENV: appEnv,
        [SANCTIONS_REGIONS_ENV]: 'AA:TEST override',
        [SANCTIONS_SOURCE_ENV]: 'TEST record',
      });
      expect(
        list.regions.map((r) => r.region),
        appEnv,
      ).toEqual(['AA']);
      expect(list.source, appEnv).toBe('TEST record');
    }
    expect(() =>
      assertScreeningConfigured({ APP_ENV: 'prod', [SANCTIONS_REGIONS_ENV]: 'AA:TEST override', [SANCTIONS_SOURCE_ENV]: 'TEST record' }),
    ).not.toThrow();
  });

  it('`none` keeps its attribution rule and replaces the rows', () => {
    expect(() => configuredScreeningList({ APP_ENV: 'test', [SANCTIONS_REGIONS_ENV]: SCREENING_REVIEWED_EMPTY })).toThrow(
      ScreeningListError,
    );
    const list = configuredScreeningList({
      APP_ENV: 'test',
      [SANCTIONS_REGIONS_ENV]: SCREENING_REVIEWED_EMPTY,
      [SANCTIONS_SOURCE_ENV]: 'TEST record',
    });
    expect(list.declaration).toBe('reviewed-empty');
    expect(list.regions).toEqual([]);
  });

  it('INTAFACED_UNSIGNED_SANCTIONS_ROWS=off keeps dev/test unset, and never touches production or signed rows', () => {
    for (const appEnv of ['dev', 'test']) {
      expect(configuredScreeningList({ APP_ENV: appEnv, [UNSIGNED_SANCTIONS_ROWS_ENV]: ' OFF ' }).declaration, appEnv).toBe('unset');
      expect(() => assertScreeningConfigured({ APP_ENV: appEnv, [UNSIGNED_SANCTIONS_ROWS_ENV]: 'off' })).not.toThrow();
    }
    expect(configuredScreeningList({ APP_ENV: 'test', [UNSIGNED_SANCTIONS_ROWS_ENV]: 'on' }).source).toBe(SANCTIONED_ROWS_SOURCE_UNSIGNED);
    expect(configuredScreeningList({ APP_ENV: 'prod', [UNSIGNED_SANCTIONS_ROWS_ENV]: 'off' }).declaration).toBe('unset');
    const signed: SanctionedRow[] = SANCTIONED_LIST_ROWS.map((r) => ({
      ...r,
      signature: { signedBy: 'TEST signer', signedAt: '2026-01-01T00:00:00Z', record: 'TEST record' },
    }));
    expect(configuredScreeningList({ APP_ENV: 'test', [UNSIGNED_SANCTIONS_ROWS_ENV]: 'off' }, signed).source).toBe(
      SANCTIONED_ROWS_SOURCE_SIGNED,
    );
    expect(envScreeningList({ APP_ENV: 'test', [UNSIGNED_SANCTIONS_ROWS_ENV]: 'off' }).declaration).toBe('unset');
    expect(envScreeningList({ APP_ENV: 'test' }).source).toBe(SANCTIONED_ROWS_SOURCE_UNSIGNED);
  });

  it('a blank env value is not an override: the rows still decide', () => {
    expect(configuredScreeningList({ APP_ENV: 'test', [SANCTIONS_REGIONS_ENV]: '   ' }).source).toBe(SANCTIONED_ROWS_SOURCE_UNSIGNED);
    expect(configuredScreeningList({ APP_ENV: 'prod', [SANCTIONS_REGIONS_ENV]: '   ' }).declaration).toBe('unset');
  });
});

describe('residence and citizenship read the same rows', () => {
  it.each(['CU', 'IR', 'KP', 'SY', 'UA-43', 'UA-40', 'UA-14', 'UA-09'])('a citizen of %s is refused, wherever they live', (citizenship) => {
    const d = checkCitizenship({ citizenship, screening: ROWS_LIST });
    expect(d.allowed).toBe(false);
    expect(d.code).toBe('denied.region_blocked');
    expect(d.blockedBy).toBe('screening');
  });

  it('a listed country covers its subdivisions', () => {
    expect(checkAccess({ module: 'pay', plane: 'fiat', region: 'IR-01', kycTier: 'full', screening: ROWS_LIST, business: [] }).code).toBe(
      'denied.region_blocked',
    );
  });

  it('a listed subdivision covers only itself: the rest of Ukraine, and Ukraine as a whole, are served', () => {
    for (const region of ['UA-43', 'UA-40', 'UA-14', 'UA-09']) {
      expect(checkAccess({ module: 'pay', plane: 'fiat', region, kycTier: 'full', screening: ROWS_LIST, business: [] }).code, region).toBe(
        'denied.region_blocked',
      );
    }
    for (const region of ['UA', 'UA-30', 'UA-46']) {
      expect(
        checkAccess({ module: 'pay', plane: 'fiat', region, kycTier: 'full', screening: ROWS_LIST, business: [] }).allowed,
        region,
      ).toBe(true);
    }
    expect(checkCitizenship({ citizenship: 'UA', screening: ROWS_LIST }).allowed).toBe(true);
    expect(checkCitizenship({ citizenship: 'UA-30', screening: ROWS_LIST }).allowed).toBe(true);
    // Ukraine alone cannot say whether a person is served, so sign-up asks for the region.
    expect(hasSubdivisionRows('UA', ROWS_LIST, [])).toBe(true);
  });

  it('an unlisted citizenship is served', () => {
    expect(checkCitizenship({ citizenship: 'GB', screening: ROWS_LIST }).allowed).toBe(true);
  });
});
