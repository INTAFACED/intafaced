/**
 * Mint an API key with the product/module list already bound.
 * Empty list stays unset (full grantor intersection, no default product).
 * Invalid / widening / outside-list products refuse before create.
 */
import type { Sql } from 'postgres';
import { ApiKeyProductError, assertProductsDelegatable, normalizeProduct, scopesWithinProducts } from './api-key-product.js';
import { bindApiKeyProductScope } from './auth-service-product.js';
import type { ApiKeyMinter } from './mint-api-key-ip.js';

export async function mintApiKeyWithProductScope(
  minter: ApiKeyMinter,
  sql: Sql,
  input: {
    userId: string;
    name: string;
    scopes: string[];
    grantorScopes: readonly string[];
    grantorKid?: string | null;
    products: string[];
    domainWhitelist?: string[];
    expiresAt?: Date;
    mode?: 'live' | 'sandbox';
  },
): Promise<{ id: string; key: string; prefix: string; mode: 'live' | 'sandbox'; productScopes: string[] }> {
  const next: string[] = [];
  for (const raw of input.products) {
    const product = normalizeProduct(raw);
    if (!product) throw new ApiKeyProductError('Invalid product in scope list', 'auth.product_invalid');
    next.push(product);
  }
  assertProductsDelegatable(next, input.grantorScopes);
  if (!scopesWithinProducts(input.scopes, next)) {
    throw new ApiKeyProductError('API key scopes are outside this product list', 'auth.product_outside');
  }

  const minted = await minter.createApiKey({
    userId: input.userId,
    name: input.name,
    scopes: input.scopes,
    grantorScopes: input.grantorScopes,
    grantorKid: input.grantorKid,
    domainWhitelist: input.domainWhitelist,
    expiresAt: input.expiresAt,
    mode: input.mode,
  });

  try {
    const bound = await bindApiKeyProductScope(sql, input.userId, minted.id, next, input.grantorScopes);
    return { ...minted, productScopes: bound.productScopes };
  } catch (err) {
    await minter.revokeApiKey(input.userId, minted.id, 'system');
    throw err;
  }
}
