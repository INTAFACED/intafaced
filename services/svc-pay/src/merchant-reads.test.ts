import type { Sql } from 'postgres';
import { describe, expect, it } from 'vitest';
import { decodeListCursor, encodeListCursor, ListQueryError, parseListFilters } from './list-page.js';
import { safeFailure } from './merchant-failure.js';
import { readPricingSnapshots } from './control/snapshots.js';
import { roleHasPermission } from './merchant-ops/roles.js';
import { scriptedSql } from './scripted-sql.testkit.js';

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

  it('lets every role read invoices and keeps invoice writes off viewer and developer', () => {
    for (const role of ['owner', 'admin', 'finance', 'developer', 'viewer'] as const) {
      expect(roleHasPermission(role, 'invoices.read')).toBe(true);
    }
    expect(roleHasPermission('finance', 'invoices.write')).toBe(true);
    expect(roleHasPermission('viewer', 'invoices.write')).toBe(false);
    expect(roleHasPermission('developer', 'invoices.write')).toBe(false);
    expect(roleHasPermission('viewer', 'disputes.respond')).toBe(false);
    expect(roleHasPermission('developer', 'disputes.respond')).toBe(false);
  });
});

describe('pricing snapshot read', () => {
  it('does not recompute a fee from the pricing engine', async () => {
    // The stored row is the answer: a fee no rule would give from 1% of anything is returned as recorded, and the only
    // question asked is of the snapshot table.
    const row = {
      subject_id: ID,
      asset_code: 'USDT',
      applied_layer: 'merchant',
      rule_id: '55555555-5555-4555-8555-555555555555',
      fee_bps: 100,
      flat_fee: null,
      spread_bps: null,
      rounding_beneficiary: 'platform',
      rounding_mode: 'ceil',
      fee: '7.77',
      bps_fee: null,
      fee_before_clamp: null,
      booked_fee: '7.77',
      reserve_amount: null,
      created_at: new Date('2026-11-01T00:00:00Z'),
    };
    const { sql, calls } = scriptedSql<Sql>(() => [row]);
    const snaps = await readPricingSnapshots(sql, 'payment', [ID]);
    expect(snaps.get(ID)).toMatchObject({ fee: '7.77', bookedFee: '7.77', feeBps: 100, ruleId: row.rule_id });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.text).toContain('FROM pay.control_pricing_snapshots');
    expect(calls[0]!.text).not.toMatch(/control_pricing_rules/);
  });
});
