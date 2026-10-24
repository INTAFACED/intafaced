/**
 * CARD R-auth — session/API-key attribution mill (PTX-M01-R05).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { recipes } from '@intafaced/ledger-client';
import {
  AUTH_ATTRIBUTION_MISSING,
  AUTH_ATTRIBUTION_MISSING_MESSAGE,
  HOUSE_MM_API_KEY_ID,
  attributionFromOrder,
  attributionFromPrincipal,
  hasAuthAttribution,
  houseMmAttribution,
  requireAuthAttribution,
  stampAuthAttribution,
  withFillLedgerAttribution,
  withLedgerAttribution,
} from './auth-attribution.js';
import { TradeError } from './types.js';
import { tradeServiceSource } from './trade-service/source.testkit.js';

const here = dirname(fileURLToPath(import.meta.url));

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    sub: '11111111-1111-4111-8111-111111111111',
    userId: '11111111-1111-4111-8111-111111111111',
    scopes: ['trade:write'],
    tier: 'basic',
    mfa: false,
    sid: '99999999-9999-4999-8999-999999999999',
    expiresAt: new Date('2026-09-04T00:00:00.000Z'),
    ...overrides,
  };
}

describe('R-auth attribution mill — stamp or refuse by name', () => {
  it('stamps session from the signed principal', () => {
    expect(attributionFromPrincipal(principal())).toEqual({
      sessionId: '99999999-9999-4999-8999-999999999999',
      apiKeyId: null,
    });
  });

  it('stamps API-key id when the principal is a key', () => {
    expect(attributionFromPrincipal(principal({ kid: 'key-7' }))).toEqual({
      sessionId: '99999999-9999-4999-8999-999999999999',
      apiKeyId: 'key-7',
    });
  });

  it('blank session and key refuse — never invents a session', () => {
    expect(() => attributionFromPrincipal(principal({ sid: '  ', kid: undefined }))).toThrow(TradeError);
    try {
      attributionFromPrincipal(principal({ sid: '', kid: '' }));
      throw new Error('expected refuse');
    } catch (err) {
      expect(err).toBeInstanceOf(TradeError);
      expect((err as TradeError).code).toBe(AUTH_ATTRIBUTION_MISSING);
      expect((err as TradeError).message).toBe(AUTH_ATTRIBUTION_MISSING_MESSAGE);
    }
    expect(stampAuthAttribution({ sessionId: null, apiKeyId: null })).toEqual({ sessionId: null, apiKeyId: null });
    expect(hasAuthAttribution(stampAuthAttribution({}))).toBe(false);
    expect(() => requireAuthAttribution(stampAuthAttribution({ sessionId: ' ', apiKeyId: null }))).toThrow(TradeError);
  });

  it('fill/order without stored attribution refuse rather than storing blank', () => {
    expect(() => attributionFromOrder({ sessionId: null, apiKeyId: null })).toThrow(TradeError);
    expect(attributionFromOrder({ sessionId: 'sess-1', apiKeyId: null }).sessionId).toBe('sess-1');
  });

  it('house MM uses a named API-key id, not a minted session UUID', () => {
    expect(houseMmAttribution()).toEqual({ sessionId: null, apiKeyId: HOUSE_MM_API_KEY_ID });
    expect(HOUSE_MM_API_KEY_ID).toBe('house-mm');
  });

  it('ledger meta carries the stamp — hold and two-sided fill', () => {
    const hold = withLedgerAttribution(
      recipes.orderHold({
        orderId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        userId: '11111111-1111-4111-8111-111111111111',
        assetId: 'USDT',
        amount: 1n,
      }),
      { sessionId: 'sess-1', apiKeyId: null },
    );
    expect(hold.meta).toMatchObject({ sessionId: 'sess-1', apiKeyId: null, orderId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' });

    const fill = withFillLedgerAttribution(
      recipes.tradeFill({
        fillId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        makerId: '22222222-2222-4222-8222-222222222222',
        takerId: '11111111-1111-4111-8111-111111111111',
        makerOrderId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        takerOrderId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        baseAsset: 'BTC',
        quoteAsset: 'USDT',
        qty: 1_000_000_000_000_000_000n,
        quoteAmount: 100_000_000_000_000_000_000n,
        takerSide: 'buy',
        makerFeeBps: 10,
        takerFeeBps: 20,
      }),
      { sessionId: 'maker-sess', apiKeyId: null },
      { sessionId: null, apiKeyId: 'taker-key' },
    );
    expect(fill.meta).toMatchObject({
      makerSessionId: 'maker-sess',
      makerApiKeyId: null,
      takerSessionId: null,
      takerApiKeyId: 'taker-key',
    });
  });

  it('source never invents a session and never imports WebAuthn', () => {
    const mill = readFileSync(join(here, 'auth-attribution.ts'), 'utf8');
    expect(mill).not.toMatch(/randomUUID|simplewebauthn/);
    expect(mill).toContain(AUTH_ATTRIBUTION_MISSING);
    const service = tradeServiceSource();
    expect(service).toContain('attributionFromPrincipal');
    expect(service).toContain('insertFillLeg');
    expect(service).toContain('withFillLedgerAttribution');
  });
});
