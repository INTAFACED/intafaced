/**
 * Unbind one product from an API key list. Module name after trim/lowercase.
 * The rest of the list stays. Empty after unbind stays unset (no default product).
 */
import type { Queryable } from '@intafaced/db';
import { ApiKeyProductError, normalizeProduct } from './api-key-product.js';

export async function unbindApiKeyProductScope(
  sql: Queryable,
  userId: string,
  keyId: string,
  rawProduct: string,
): Promise<{ id: string; productScopes: string[] }> {
  const product = normalizeProduct(rawProduct);
  if (!product) throw new ApiKeyProductError('Invalid product', 'auth.product_invalid');

  const current = await sql<Array<{ id: string; product_scopes: string[] }>>`
    SELECT id, product_scopes FROM api_keys
    WHERE id = ${keyId} AND user_id = ${userId} AND revoked = false
  `;
  const row = current[0];
  if (!row) throw new ApiKeyProductError('API key not found', 'auth.not_found');

  const list = row.product_scopes ?? [];
  const next = list.filter((entry) => normalizeProduct(entry) !== product);
  if (next.length === list.length) {
    throw new ApiKeyProductError('Product is not on the API key', 'auth.not_found');
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
