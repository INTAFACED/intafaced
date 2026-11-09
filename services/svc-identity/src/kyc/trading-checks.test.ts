/**
 * The trading checks' list and screen (J-cex-spot-01 #3, OWNER 258 (4)), without a database: what the owner's list must
 * look like, that a blank one is no list, that a TEST list is refused outside a test stack, and what counts as a hit.
 */
import { describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import {
  TradingChecksDesk,
  parseSanctionsPersonsList,
  screenPerson,
  screeningCountry,
  screeningName,
  tradingCheckKey,
} from './trading-checks.js';

const TEST_LIST = JSON.stringify({
  label: 'TEST: the local test stack only',
  entries: [{ legalName: 'TEST Listed Person', dateOfBirth: '1970-01-01', country: 'DE' }],
});

describe('the sanctions list of persons (IDENTITY_SANCTIONS_PERSONS_LIST)', () => {
  it('is no list when unset or blank: nothing is invented', () => {
    expect(parseSanctionsPersonsList(undefined, 'test')).toBeNull();
    expect(parseSanctionsPersonsList('  ', 'test')).toBeNull();
  });

  it('reads a labelled list, folding each name as the screen compares it', () => {
    const list = parseSanctionsPersonsList(TEST_LIST, 'test')!;
    expect(list.label).toBe('TEST: the local test stack only');
    expect(list.entries).toEqual([{ legalName: 'test listed person', dateOfBirth: '1970-01-01', country: 'DE' }]);
  });

  it('refuses a TEST list outside APP_ENV dev or test, so it never screens real people', () => {
    expect(() => parseSanctionsPersonsList(TEST_LIST, 'production')).toThrow(/TEST list/);
    expect(() => parseSanctionsPersonsList(TEST_LIST, undefined)).toThrow(/TEST list/);
    expect(parseSanctionsPersonsList(TEST_LIST, 'dev')).not.toBeNull();
  });

  it('stops on a list with no entries, no label, a malformed entry or malformed JSON', () => {
    expect(() => parseSanctionsPersonsList(JSON.stringify({ label: 'x', entries: [] }), 'test')).toThrow(/at least one/);
    expect(() => parseSanctionsPersonsList(JSON.stringify({ entries: [{}] }), 'test')).toThrow(/label/);
    const bad = (entry: object) => JSON.stringify({ label: 'TEST', entries: [entry] });
    expect(() => parseSanctionsPersonsList(bad({ legalName: 'A B', dateOfBirth: '1970-1-1', country: 'DE' }), 'test')).toThrow(/entry 1/);
    expect(() => parseSanctionsPersonsList(bad({ legalName: 'A B', dateOfBirth: '1970-01-01', country: 'ZZ' }), 'test')).toThrow(/entry 1/);
    expect(() => parseSanctionsPersonsList(bad({ dateOfBirth: '1970-01-01', country: 'DE' }), 'test')).toThrow(/entry 1/);
    expect(() => parseSanctionsPersonsList('{', 'test')).toThrow(/JSON/);
  });
});

describe('the screen', () => {
  const list = parseSanctionsPersonsList(TEST_LIST, 'test')!;
  const listed = { legalName: 'TEST Listed Person', dateOfBirth: '1970-01-01', country: 'DE' };

  it('is a hit on the same name, date of birth and country, however the name is cased, spaced or accented', () => {
    expect(screenPerson(list, listed)).toBe('hit');
    expect(screenPerson(list, { ...listed, legalName: '  test   listed-person ' })).toBe('hit');
    expect(screenPerson(list, { ...listed, legalName: 'TEST Lísted Person', country: 'de' })).toBe('hit');
    expect(screeningName('Zoë  O’Brien')).toBe('zoe o brien');
  });

  it('is clear when the name, the date of birth or the country differs', () => {
    expect(screenPerson(list, { ...listed, legalName: 'TEST Trader jt1' })).toBe('clear');
    expect(screenPerson(list, { ...listed, dateOfBirth: '1990-05-01' })).toBe('clear');
    expect(screenPerson(list, { ...listed, country: 'FR' })).toBe('clear');
  });

  it('keys each person once, by a business key', () => {
    expect(tradingCheckKey('00000000-0000-4000-8000-000000000001')).toBe('kyc:trading-checks:00000000-0000-4000-8000-000000000001');
  });
});

describe('the country screened is the one recorded at sign-up', () => {
  it('a submitted country that differs is refused kyc.country_mismatch; no recorded country is kyc.country_unknown', () => {
    expect(screeningCountry('DE', 'de')).toBe('DE');
    expect(() => screeningCountry('DE', 'FR')).toThrow(expect.objectContaining({ code: 'kyc.country_mismatch' }));
    expect(() => screeningCountry(null, 'DE')).toThrow(expect.objectContaining({ code: 'kyc.country_unknown' }));
    expect(() => screeningCountry('', 'DE')).toThrow(expect.objectContaining({ code: 'kyc.country_unknown' }));
  });

  /** A database that answers what the check reads and records every statement, so a refusal is seen to write nothing. */
  function fakeSql(region: string) {
    const statements: string[] = [];
    const tag = (strings: TemplateStringsArray) => {
      const text = strings.join('?').replace(/\s+/g, ' ').trim();
      statements.push(text);
      if (text.startsWith('SELECT region FROM profiles')) return Promise.resolve([{ region }]);
      if (text.startsWith('INSERT')) return Promise.resolve([{ id: 'r1', created_at: new Date() }]);
      return Promise.resolve([]);
    };
    const sql = Object.assign(tag, { begin: async (_mode: string, fn: (tx: unknown) => unknown) => fn(tag) });
    return { sql: sql as unknown as Sql, writes: () => statements.filter((s) => /^(INSERT|UPDATE|DELETE)/.test(s)) };
  }

  const LISTED = parseSanctionsPersonsList(TEST_LIST, 'test')!;
  const desk = (sql: Sql) =>
    new TradingChecksDesk(sql, {
      key: Buffer.alloc(32, 7),
      list: LISTED,
      capabilities: {} as never,
      kycTier: async () => 'none',
    });

  it('a person recorded in DE who types FR is refused and nothing is written or granted', async () => {
    const db = fakeSql('DE');
    await expect(desk(db.sql).run('u1', { legalName: 'TEST Trader', country: 'FR', confirmed: true })).rejects.toMatchObject({
      code: 'kyc.country_mismatch',
    });
    expect(db.writes()).toEqual([]);
  });

  it('a listed person who types another country is never cleared: refused, and held on the recorded one', async () => {
    const db = fakeSql('DE');
    // The listed entry is DE; typing FR (where the screen would read clear) is refused before any screen or write.
    await expect(desk(db.sql).run('u2', { legalName: 'TEST Listed Person', country: 'FR', confirmed: true })).rejects.toMatchObject({
      code: 'kyc.country_mismatch',
    });
    expect(db.writes()).toEqual([]);
    expect(
      screenPerson(LISTED, { legalName: 'TEST Listed Person', dateOfBirth: '1970-01-01', country: screeningCountry('DE', 'DE') }),
    ).toBe('hit');
  });
});
