import { describe, expect, it } from 'vitest';
import { parseAmount as amt } from '@intafaced/ledger-client';
import {
  OPTIONS_PAPER_FIXING_STAMP,
  OPTIONS_SETTLEMENT_LAW_UNSET,
  assertOptionsSettlementAssetLawStamped,
  resolveOptionsListing,
} from './options-listing.js';
import { TradeError } from './types.js';

const expiry = new Date('2026-12-26T08:00:00.000Z');
/** Opaque P0-05 stamp — never a live-set / asset / matrix invent. */
const P0_05_LAW = 'd26-p0-05-adr-published';

describe('resolveOptionsListing — refuse until P0-05 + fixing + complete terms', () => {
  it('returns null for spot without inventing terms', () => {
    expect(
      resolveOptionsListing({
        kind: 'spot',
        settlementAssetLawConfigured: '',
        settlementFixingConfigured: '',
      }),
    ).toBeNull();
  });

  it('returns null for futures without inventing terms', () => {
    expect(
      resolveOptionsListing({
        kind: 'futures',
        settlementAssetLawConfigured: P0_05_LAW,
        settlementFixingConfigured: 'anything',
      }),
    ).toBeNull();
  });

  it('refuses options when P0-05 settlement asset law is unset (SOCKET §13)', () => {
    try {
      resolveOptionsListing({
        kind: 'options',
        settlementAssetLawConfigured: '',
        settlementFixingConfigured: 'owner-d7-opaque-id',
        optionType: 'call',
        strike: amt('90000'),
        expiryAt: expiry,
      });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(TradeError);
      expect((err as TradeError).code).toBe(OPTIONS_SETTLEMENT_LAW_UNSET);
      expect((err as Error).message).toContain('settlement asset is not set');
      expect((err as Error).message).toContain('fixing source alone does not turn listing on');
    }
  });

  it('pin: fixing env + complete terms cannot unlock when settlement-asset law is unset', () => {
    try {
      resolveOptionsListing({
        kind: 'options',
        settlementAssetLawConfigured: '',
        settlementFixingConfigured: 'TRADE_OPTIONS_SETTLEMENT_FIXING-would-be-set',
        optionType: 'call',
        optionStyle: 'european',
        strike: amt('90000'),
        expiryAt: expiry,
      });
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as TradeError).code).toBe(OPTIONS_SETTLEMENT_LAW_UNSET);
      expect((err as TradeError).code).not.toBe('trade.options_fixing_unconfigured');
      expect((err as TradeError).code).not.toBe('trade.options_terms_incomplete');
    }
  });

  it('pin: empty law wins over incomplete terms and empty fixing (no D7 invent)', () => {
    try {
      resolveOptionsListing({
        kind: 'options',
        settlementAssetLawConfigured: '',
        settlementFixingConfigured: '',
      });
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as TradeError).code).toBe(OPTIONS_SETTLEMENT_LAW_UNSET);
    }
  });

  it('assertOptionsSettlementAssetLawStamped refuses blank / whitespace stamps', () => {
    try {
      assertOptionsSettlementAssetLawStamped('');
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as TradeError).code).toBe(OPTIONS_SETTLEMENT_LAW_UNSET);
    }
    try {
      assertOptionsSettlementAssetLawStamped('  \n\t');
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as TradeError).code).toBe(OPTIONS_SETTLEMENT_LAW_UNSET);
    }
  });

  it('refuses options when P0-05 law is whitespace-only even if fixing is set', () => {
    try {
      resolveOptionsListing({
        kind: 'options',
        settlementAssetLawConfigured: '   \t  ',
        settlementFixingConfigured: 'owner-d7-opaque-id',
        optionType: 'put',
        strike: amt('1'),
        expiryAt: expiry,
      });
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as TradeError).code).toBe(OPTIONS_SETTLEMENT_LAW_UNSET);
    }
  });

  it('refuses options when P0-05 is stamped but settlement fixing env is empty (D7)', () => {
    try {
      resolveOptionsListing({
        kind: 'options',
        settlementAssetLawConfigured: P0_05_LAW,
        settlementFixingConfigured: '',
        optionType: 'call',
        strike: amt('90000'),
        expiryAt: expiry,
      });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(TradeError);
      expect((err as TradeError).code).toBe('trade.options_fixing_unconfigured');
      expect((err as Error).message).toContain('TRADE_OPTIONS_SETTLEMENT_FIXING');
    }
  });

  it('refuses options when fixing is whitespace-only after P0-05', () => {
    try {
      resolveOptionsListing({
        kind: 'options',
        settlementAssetLawConfigured: P0_05_LAW,
        settlementFixingConfigured: '   \t  ',
        optionType: 'put',
        strike: amt('1'),
        expiryAt: expiry,
      });
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as TradeError).code).toBe('trade.options_fixing_unconfigured');
    }
  });

  it('refuses options with law+fixing set but missing optionType (half-list)', () => {
    try {
      resolveOptionsListing({
        kind: 'options',
        settlementAssetLawConfigured: P0_05_LAW,
        settlementFixingConfigured: 'd7-placeholder-opaque',
        strike: amt('90000'),
        expiryAt: expiry,
      });
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as TradeError).code).toBe('trade.options_terms_incomplete');
      expect((err as Error).message).toMatch(/optionType/i);
    }
  });

  it('refuses options with law+fixing set but missing strike', () => {
    try {
      resolveOptionsListing({
        kind: 'options',
        settlementAssetLawConfigured: P0_05_LAW,
        settlementFixingConfigured: 'd7-placeholder-opaque',
        optionType: 'call',
        expiryAt: expiry,
      });
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as TradeError).code).toBe('trade.options_terms_incomplete');
      expect((err as Error).message).toMatch(/strike/i);
    }
  });

  it('refuses options with zero strike', () => {
    try {
      resolveOptionsListing({
        kind: 'options',
        settlementAssetLawConfigured: P0_05_LAW,
        settlementFixingConfigured: 'd7-placeholder-opaque',
        optionType: 'call',
        strike: 0n,
        expiryAt: expiry,
      });
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as TradeError).code).toBe('trade.options_terms_incomplete');
    }
  });

  it('refuses options with law+fixing set but missing expiry', () => {
    try {
      resolveOptionsListing({
        kind: 'options',
        settlementAssetLawConfigured: P0_05_LAW,
        settlementFixingConfigured: 'd7-placeholder-opaque',
        optionType: 'call',
        strike: amt('90000'),
      });
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as TradeError).code).toBe('trade.options_terms_incomplete');
      expect((err as Error).message).toMatch(/expiry/i);
    }
  });

  it('refuses option terms attached to a non-options kind', () => {
    try {
      resolveOptionsListing({
        kind: 'spot',
        settlementAssetLawConfigured: '',
        settlementFixingConfigured: '',
        optionType: 'call',
        strike: amt('90000'),
        expiryAt: expiry,
      });
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as TradeError).code).toBe('trade.options_terms_incomplete');
    }
  });

  it('accepts a complete european option listing when P0-05 law + fixing are configured', () => {
    const terms = resolveOptionsListing({
      kind: 'options',
      settlementAssetLawConfigured: `  ${P0_05_LAW}  `,
      settlementFixingConfigured: '  owner-published-fixing-id  ',
      optionType: 'call',
      strike: amt('90000'),
      expiryAt: expiry,
    });
    expect(terms).toEqual({
      optionType: 'call',
      optionStyle: 'european',
      strike: amt('90000'),
      expiryAt: expiry,
      // trimmed opaque stamp — not parsed for source/window/account
      settlementFixing: 'owner-published-fixing-id',
    });
  });

  it('accepts put with explicit european style', () => {
    const terms = resolveOptionsListing({
      kind: 'options',
      settlementAssetLawConfigured: P0_05_LAW,
      settlementFixingConfigured: 'fixing-v1',
      optionType: 'put',
      optionStyle: 'european',
      strike: amt('100'),
      expiryAt: expiry,
    });
    expect(terms?.optionType).toBe('put');
    expect(terms?.optionStyle).toBe('european');
    expect(terms?.settlementFixing).toBe('fixing-v1');
  });

  it('paper options list without inventing settlement-asset law — stamp is paper, not an asset', () => {
    const terms = resolveOptionsListing({
      kind: 'options',
      settlementAssetLawConfigured: '',
      settlementFixingConfigured: '',
      optionType: 'call',
      strike: amt('90000'),
      expiryAt: expiry,
      paper: true,
    });
    expect(terms?.optionStyle).toBe('european');
    expect(terms?.settlementFixing).toBe(OPTIONS_PAPER_FIXING_STAMP);
    expect(terms?.settlementFixing).not.toMatch(/USDT|USDC|USD/);
  });

  it('paper options still refuse half-listed terms', () => {
    try {
      resolveOptionsListing({
        kind: 'options',
        settlementAssetLawConfigured: '',
        settlementFixingConfigured: '',
        paper: true,
      });
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as TradeError).code).toBe('trade.options_terms_incomplete');
    }
  });
});
