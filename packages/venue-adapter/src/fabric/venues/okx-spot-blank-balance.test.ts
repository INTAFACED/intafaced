import { describe, expect, it } from 'vitest';
import { parseAmount } from '@intafaced/ledger-client/money';
import { VenueUnavailableError } from '@intafaced/venue-contracts';
import { mapOkxSpotDetails } from './okx-spot-account.js';

const NOW = new Date('2026-10-11T00:00:00.000Z');

function row(patch: Record<string, unknown>, omit: readonly string[] = []): Record<string, unknown> {
  const base: Record<string, unknown> = {
    ccy: 'USDT',
    availBal: '90',
    frozenBal: '10',
    eq: '100',
    ...patch,
  };
  for (const key of omit) delete base[key];
  return base;
}

function mapOrThrow(details: unknown): { rows?: ReturnType<typeof mapOkxSpotDetails>; error?: unknown } {
  try {
    return { rows: mapOkxSpotDetails(details, NOW) };
  } catch (error) {
    return { error };
  }
}

describe('mapOkxSpotDetails refuses a blank OKX balance field', () => {
  it('refuses an omitted frozenBal instead of inventing 0', () => {
    const { rows, error } = mapOrThrow([row({}, ['frozenBal'])]);
    expect(rows).toBeUndefined();
    expect(error).toBeInstanceOf(VenueUnavailableError);
    expect(error).toMatchObject({ reason: 'malformed', message: expect.stringMatching(/frozenBal/) });
  });

  it("parses a published frozenBal of '0' and uses the published eq", () => {
    const rows = mapOkxSpotDetails([row({ frozenBal: '0', eq: '90' })], NOW);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.asset).toBe('USDT');
    expect(rows[0]!.used).toBe(0n);
    expect(rows[0]!.total).toBe(parseAmount('90'));
    expect(rows[0]!.free).toBe(parseAmount('90'));
  });

  it('refuses an omitted eq instead of setting total to avail plus frozen', () => {
    const avail = parseAmount('90');
    const inventedFrozen = 0n;
    const { rows, error } = mapOrThrow([row({}, ['eq'])]);
    expect(rows).toBeUndefined();
    expect(rows?.[0]?.total).not.toBe(avail + inventedFrozen);
    expect(rows?.[0]?.total).not.toBe(avail + parseAmount('10'));
    expect(error).toBeInstanceOf(VenueUnavailableError);
    expect(error).toMatchObject({ reason: 'malformed', message: expect.stringMatching(/eq/) });
  });

  it.each([
    { label: 'omitted', omit: ['ccy'] as const, patch: {} },
    { label: "''", omit: [] as const, patch: { ccy: '' } },
  ])('refuses a blank ccy ($label) instead of publishing asset ""', ({ omit, patch }) => {
    const { rows, error } = mapOrThrow([row(patch, omit)]);
    expect(rows).toBeUndefined();
    expect(rows?.[0]?.asset).not.toBe('');
    expect(error).toBeInstanceOf(VenueUnavailableError);
    expect(error).toMatchObject({ reason: 'malformed', message: expect.stringMatching(/ccy/) });
  });

  it.each([
    { field: 'frozenBal', value: null },
    { field: 'frozenBal', value: '   ' },
    { field: 'eq', value: null },
    { field: 'eq', value: ' \t' },
    { field: 'ccy', value: null },
    { field: 'ccy', value: '\n' },
  ])('refuses a blank $field ($value) with reason malformed', ({ field, value }) => {
    const { rows, error } = mapOrThrow([row({ [field]: value })]);
    expect(rows).toBeUndefined();
    expect(rows?.[0]?.asset).not.toBe('');
    expect(rows?.[0]?.total).not.toBe(parseAmount('90') + 0n);
    expect(error).toBeInstanceOf(VenueUnavailableError);
    expect(error).toMatchObject({ reason: 'malformed', message: expect.stringMatching(new RegExp(field)) });
  });

  it('maps a complete row through readDecimal and the ccy string', () => {
    const rows = mapOkxSpotDetails([row({})], NOW);
    expect(rows).toEqual([
      {
        venueId: 'okx-spot',
        asset: 'USDT',
        free: parseAmount('90'),
        used: parseAmount('10'),
        total: parseAmount('100'),
        observedAt: NOW,
      },
    ]);
  });
});
