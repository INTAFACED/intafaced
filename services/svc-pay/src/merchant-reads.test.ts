import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { decodeListCursor, encodeListCursor, ListQueryError, parseListFilters } from './list-page.js';
import { safeFailure } from './merchant-failure.js';
import { roleHasPermission } from './merchant-ops/roles.js';

const here = dirname(fileURLToPath(import.meta.url));
const CURSOR_AT = '2026-10-16T01:02:03.000123Z';
const ID = '44444444-4444-4444-8444-444444444444';

describe('merchant list cursors', () => {
  it('round-trips a microsecond timestamp and an id', () => {
    const encoded = encodeListCursor(CURSOR_AT, ID);
    expect(encoded).not.toContain(ID);
    expect(decodeListCursor(encoded)).toEqual({ createdAtCursor: CURSOR_AT, id: ID });
  });

  it('refuses a cursor that is not the opaque form', () => {
    expect(() => decodeListCursor('not a cursor')).toThrow(ListQueryError);
    expect(() => decodeListCursor(encodeListCursor('2026-10-16T01:02:03.000Z', ID))).toThrow(ListQueryError);
    expect(() => decodeListCursor('%%%')).toThrow(ListQueryError);
  });

  it('refuses a search, an asset, or a range that is not a list filter', () => {
    expect(() => parseListFilters({ search: 'has\nnewline' })).toThrow(expect.objectContaining({ code: 'pay.list_search_invalid' }));
    expect(() => parseListFilters({ search: '' })).toThrow(expect.objectContaining({ code: 'pay.list_search_invalid' }));
    expect(() => parseListFilters({ assetId: 'has space' })).toThrow(expect.objectContaining({ code: 'pay.list_asset_invalid' }));
    expect(() => parseListFilters({ from: '2026-10-16T00:00:00.000Z', to: '2026-10-15T00:00:00.000Z' })).toThrow(
      expect.objectContaining({ code: 'pay.list_range_invalid' }),
    );
    expect(parseListFilters({})).toEqual({ search: null, assetId: null, from: null, to: null, cursor: null });
  });
});

describe('merchant-facing failure text', () => {
  it('returns the catalog sentence for a known code and nothing for a blank', () => {
    expect(safeFailure('card.declined')).toEqual({ code: 'card.declined', message: 'The card was declined.' });
    expect(safeFailure(null)).toBeNull();
    expect(safeFailure('   ')).toBeNull();
  });

  it('collapses an unknown or secret-shaped value to the generic sentence', () => {
    const secret = 'sk_live_provider_secret_do_not_echo';
    const failure = safeFailure(secret);
    expect(failure).toEqual({ code: 'pay.failed', message: 'The payment could not be completed.' });
    expect(JSON.stringify(failure)).not.toContain(secret);
    expect(JSON.stringify(safeFailure('Error: at /internal/stack'))).not.toContain('stack');
  });
});

describe('team read permissions', () => {
  it('gives every stored role the payment, settlement, and halt reads', () => {
    for (const role of ['admin', 'finance', 'developer', 'viewer'] as const) {
      expect(roleHasPermission(role, 'payments.read')).toBe(true);
      expect(roleHasPermission(role, 'settlements.read')).toBe(true);
      expect(roleHasPermission(role, 'halts.read')).toBe(true);
    }
  });

  it('does not give a viewer or a developer payout approval', () => {
    expect(roleHasPermission('viewer', 'payout.approve')).toBe(false);
    expect(roleHasPermission('developer', 'payout.approve')).toBe(false);
    expect(roleHasPermission('finance', 'payout.approve')).toBe(true);
  });
});

describe('pricing snapshot read', () => {
  it('does not recompute a fee from the pricing engine', () => {
    const src = readFileSync(join(here, 'control', 'snapshots.ts'), 'utf8');
    expect(src).not.toContain('computePricing');
    expect(src).toContain('control_pricing_snapshots');
  });
});
