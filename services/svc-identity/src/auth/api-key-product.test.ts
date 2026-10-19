import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ApiKeyProductError,
  apiKeyProductAllowed,
  assertProductsDelegatable,
  normalizeProduct,
  scopesWithinProducts,
} from './api-key-product.js';

const here = dirname(fileURLToPath(import.meta.url));
const indexSrc = readFileSync(join(here, '../index.ts'), 'utf8');

describe('apiKeyProductAllowed', () => {
  it('allows any / missing product when the list is empty — does not invent a default', () => {
    expect(apiKeyProductAllowed([], undefined)).toBe(true);
    expect(apiKeyProductAllowed([], null)).toBe(true);
    expect(apiKeyProductAllowed([], '')).toBe(true);
    expect(apiKeyProductAllowed([], 'trade')).toBe(true);
    expect(apiKeyProductAllowed([], 'pay')).toBe(true);
    expect([] as string[]).not.toContain('trade');
  });

  it('refuses missing or blank product when the list is set', () => {
    expect(apiKeyProductAllowed(['trade'], undefined)).toBe(false);
    expect(apiKeyProductAllowed(['trade'], null)).toBe(false);
    expect(apiKeyProductAllowed(['trade'], '')).toBe(false);
    expect(apiKeyProductAllowed(['trade'], '   ')).toBe(false);
  });

  it('matches a listed module after trim/case; rejects an unlisted product', () => {
    const list = ['trade', 'p2p'];
    expect(apiKeyProductAllowed(list, 'trade')).toBe(true);
    expect(apiKeyProductAllowed(list, '  TRADE  ')).toBe(true);
    expect(apiKeyProductAllowed(list, 'p2p')).toBe(true);
    expect(apiKeyProductAllowed(list, 'pay')).toBe(false);
    expect(apiKeyProductAllowed(list, 'spot')).toBe(false);
  });
});

describe('normalizeProduct', () => {
  it('accepts known module prefixes after trim/lowercase', () => {
    expect(normalizeProduct('trade')).toBe('trade');
    expect(normalizeProduct('  PAY  ')).toBe('pay');
    expect(normalizeProduct('identity')).toBe('identity');
  });

  it('rejects blank, wildcard, full scopes, and unknown products', () => {
    expect(normalizeProduct(undefined)).toBeNull();
    expect(normalizeProduct(null)).toBeNull();
    expect(normalizeProduct('')).toBeNull();
    expect(normalizeProduct('   ')).toBeNull();
    expect(normalizeProduct('*')).toBeNull();
    expect(normalizeProduct('trade:read')).toBeNull();
    expect(normalizeProduct('spot')).toBeNull();
    expect(normalizeProduct('futures')).toBeNull();
  });
});

describe('assertProductsDelegatable / scopesWithinProducts', () => {
  it('empty products is unset — no widen check', () => {
    expect(() => assertProductsDelegatable([], ['identity:read'])).not.toThrow();
    expect(scopesWithinProducts(['trade:read', 'p2p:read'], [])).toBe(true);
  });

  it('refuses a product the grantor does not hold', () => {
    expect(() => assertProductsDelegatable(['pay'], ['identity:read', 'trade:read'])).toThrow(ApiKeyProductError);
    try {
      assertProductsDelegatable(['pay'], ['identity:read', 'trade:read']);
    } catch (err) {
      expect(err).toMatchObject({ code: 'auth.product_widen' });
    }
  });

  it('accepts a product the grantor holds via implied write→read', () => {
    expect(() => assertProductsDelegatable(['trade'], ['trade:write'])).not.toThrow();
  });

  it('refuses key scopes outside the product list; subset is ok', () => {
    expect(scopesWithinProducts(['trade:read'], ['trade'])).toBe(true);
    expect(scopesWithinProducts(['trade:read', 'p2p:read'], ['trade'])).toBe(false);
    expect(scopesWithinProducts(['trade:read'], ['trade', 'p2p'])).toBe(true);
  });
});

describe('product scope mint/bind is mounted (not helper-only)', () => {
  it('mergeRouters includes createApiKeyProductRouter and the exchange wrap', () => {
    expect(indexSrc).toMatch(/createApiKeyProductRouter\(sql, auth, auth\)/);
    expect(indexSrc).toMatch(/from ['"]\.\/api-key-product-router\.js['"]/);
    expect(indexSrc).toMatch(/installApiKeyProductExchange\(auth, sql\)/);
  });
});
