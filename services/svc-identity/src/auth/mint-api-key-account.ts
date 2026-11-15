/**
 * Mint an API key already bound to one account.
 * Empty account id refuses before create — no leftover unbound key.
 * Foreign / revoked / missing account refuses before create.
 */
import type { Sql } from 'postgres';
import { ApiKeyAccountError, requireAccountId } from './api-key-account.js';
import { assertPortfolioKeyRoom, bindApiKeyAccount } from './bind-api-key-account.js';
import type { ApiKeyMinter } from './mint-api-key-ip.js';

export async function mintApiKeyBoundToAccount(
  minter: ApiKeyMinter,
  sql: Sql,
  input: {
    userId: string;
    name: string;
    scopes: string[];
    grantorScopes: readonly string[];
    grantorKid?: string | null;
    accountId: string | null | undefined;
    domainWhitelist?: string[];
    expiresAt?: Date;
    mode?: 'live' | 'sandbox';
    /** The owner's `IDENTITY_PORTFOLIO_KEYS_MAX`; blank (null) refuses before any key is made. */
    portfolioKeyCap: number | null;
  },
): Promise<{ id: string; key: string; prefix: string; mode: 'live' | 'sandbox'; accountId: string }> {
  const accountId = requireAccountId(input.accountId);
  const owned = await sql<Array<{ id: string; parent_user_id: string; revoked: boolean }>>`
    SELECT id, parent_user_id, revoked FROM sub_accounts WHERE id = ${accountId} LIMIT 1
  `;
  const acc = owned[0];
  if (!acc || acc.parent_user_id !== input.userId) {
    throw new ApiKeyAccountError('Account not found or not owned by caller', 'auth.account_denied');
  }
  if (acc.revoked) {
    throw new ApiKeyAccountError('Account is revoked', 'auth.account_revoked');
  }
  await assertPortfolioKeyRoom(sql, input.userId, accountId, input.portfolioKeyCap);

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
    const bound = await bindApiKeyAccount(sql, input.userId, minted.id, accountId);
    return { ...minted, accountId: bound.accountId };
  } catch (err) {
    await minter.revokeApiKey(input.userId, minted.id, 'system');
    throw err;
  }
}
