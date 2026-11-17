/**
 * Bind / refuse an API key product/module list without rewriting auth-service.ts.
 * Exchange wrap: a bound key cannot mint a JWT for a product outside the list.
 * Empty list stays unset (full grantor intersection, no default product).
 */
import type { Queryable } from '@intafaced/db';
import { AsyncLocalStorage } from 'node:async_hooks';
import { AuthError, type AuthService } from './auth-service.js';
import {
  ApiKeyProductError,
  apiKeyProductAllowed,
  assertProductsDelegatable,
  normalizeProduct,
  scopesWithinProducts,
} from './api-key-product.js';
import { hashToken } from './passwords.js';

export { ApiKeyProductError } from './api-key-product.js';

export const requestProductAls = new AsyncLocalStorage<string | undefined>();

export async function bindApiKeyProductScope(
  sql: Queryable,
  userId: string,
  keyId: string,
  products: string[],
  grantorScopes: readonly string[],
): Promise<{ id: string; productScopes: string[] }> {
  const next: string[] = [];
  for (const raw of products) {
    const product = normalizeProduct(raw);
    if (!product) throw new ApiKeyProductError('Invalid product in scope list', 'auth.product_invalid');
    next.push(product);
  }
  assertProductsDelegatable(next, grantorScopes);

  const current = await sql<Array<{ id: string; scopes: string[] }>>`
    SELECT id, scopes FROM api_keys
    WHERE id = ${keyId} AND user_id = ${userId} AND revoked = false
  `;
  const row = current[0];
  if (!row) throw new ApiKeyProductError('API key not found', 'auth.not_found');
  if (!scopesWithinProducts(row.scopes ?? [], next)) {
    throw new ApiKeyProductError('API key scopes are outside this product list', 'auth.product_outside');
  }

  const updated = await sql<Array<{ id: string; product_scopes: string[] }>>`
    UPDATE api_keys
    SET product_scopes = ${next}
    WHERE id = ${keyId} AND user_id = ${userId} AND revoked = false
    RETURNING id, product_scopes
  `;
  const out = updated[0];
  if (!out) throw new ApiKeyProductError('API key not found', 'auth.not_found');
  return { id: out.id, productScopes: out.product_scopes ?? [] };
}

/** Wrap exchange so a bound key cannot mint a JWT for a foreign / missing product. */
export function installApiKeyProductExchange(auth: AuthService, sql: Queryable): void {
  const orig = auth.exchangeApiKey.bind(auth);
  auth.exchangeApiKey = async (key: string, requestOrigin?: string | null) => {
    const rows = await sql<Array<{ product_scopes: string[] | null }>>`
      SELECT product_scopes FROM api_keys
      WHERE key_hash = ${hashToken(key)} AND revoked = false
    `;
    const row = rows[0];
    if (row && !apiKeyProductAllowed(row.product_scopes ?? [], requestProductAls.getStore())) {
      throw new AuthError('API key is not allowed for this product', 'auth.domain_not_allowed');
    }
    return orig(key, requestOrigin);
  };
}
