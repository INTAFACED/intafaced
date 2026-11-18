import { describe, expect, it } from 'vitest';
import { apiKeyAccountAllowed } from './api-key-account.js';
import { mintApiKeyBoundToAccount } from './mint-api-key-account.js';
import type { ApiKeyMinter } from './mint-api-key-ip.js';

function fakeSql(queue: unknown[][]) {
  let i = 0;
  const fn = async () => {
    const rows = queue[i] ?? [];
    i += 1;
    return rows;
  };
  return fn as unknown as Parameters<typeof mintApiKeyBoundToAccount>[1];
}

function makeMinter() {
  const created: unknown[] = [];
  const revoked: string[] = [];
  const minter: ApiKeyMinter = {
    async createApiKey(input) {
      created.push(input);
      return { id: 'k1', key: 'ifk_live_secret', prefix: 'ifk_live', mode: input.mode ?? 'live' };
    },
    async revokeApiKey(_userId, keyId) {
      revoked.push(keyId);
      return true;
    },
  };
  return { minter, created, revoked };
}

const ACC = 'acc-a';
const OTHER = 'acc-b';
const base = {
  userId: 'u',
  name: 'desk',
  scopes: ['identity:read'],
  grantorScopes: ['identity:read', 'identity:write'],
  portfolioKeyCap: 2,
};

describe('mintApiKeyBoundToAccount', () => {
  it('refuses empty accountId before create', async () => {
    const { minter, created } = makeMinter();
    await expect(mintApiKeyBoundToAccount(minter, fakeSql([]), { ...base, accountId: '' })).rejects.toMatchObject({
      code: 'auth.account_required',
    });
    await expect(mintApiKeyBoundToAccount(minter, fakeSql([]), { ...base, accountId: undefined })).rejects.toMatchObject({
      code: 'auth.account_required',
    });
    expect(created).toEqual([]);
  });

  it('refuses a foreign account before create', async () => {
    const { minter, created } = makeMinter();
    await expect(
      mintApiKeyBoundToAccount(minter, fakeSql([[{ id: OTHER, parent_user_id: 'stranger', revoked: false }]]), {
        ...base,
        accountId: OTHER,
      }),
    ).rejects.toMatchObject({ code: 'auth.account_denied' });
    expect(created).toEqual([]);
  });

  it('binds the account so another account is refused from the first call', async () => {
    const { minter, created, revoked } = makeMinter();
    const live = [{ id: ACC, parent_user_id: 'u', revoked: false }];
    const minted = await mintApiKeyBoundToAccount(minter, fakeSql([live, [{ n: 1 }], live, [{ id: 'k1', account_id: ACC }]]), {
      ...base,
      accountId: ` ${ACC} `,
    });
    expect(minted.accountId).toBe(ACC);
    expect(created).toHaveLength(1);
    expect(revoked).toEqual([]);
    expect(apiKeyAccountAllowed(minted.accountId, OTHER)).toBe(false);
    expect(apiKeyAccountAllowed(minted.accountId, undefined)).toBe(false);
    expect(apiKeyAccountAllowed(minted.accountId, ACC)).toBe(true);
  });

  it('keeps the owner’s sub-account key cap: blank or full refuses before any key is made', async () => {
    const { minter, created } = makeMinter();
    const live = [{ id: ACC, parent_user_id: 'u', revoked: false }];
    await expect(
      mintApiKeyBoundToAccount(minter, fakeSql([live]), { ...base, accountId: ACC, portfolioKeyCap: null }),
    ).rejects.toMatchObject({ code: 'identity.portfolio_key_cap_unset' });
    await expect(mintApiKeyBoundToAccount(minter, fakeSql([live, [{ n: 2 }]]), { ...base, accountId: ACC })).rejects.toMatchObject({
      code: 'identity.portfolio_key_cap_reached',
    });
    expect(created).toEqual([]);
  });

  it('revokes the minted key if bind fails', async () => {
    const { minter, revoked } = makeMinter();
    const live = [{ id: ACC, parent_user_id: 'u', revoked: false }];
    await expect(
      mintApiKeyBoundToAccount(minter, fakeSql([live, [{ n: 0 }], live, []]), { ...base, accountId: ACC }),
    ).rejects.toMatchObject({
      code: 'auth.not_found',
    });
    expect(revoked).toEqual(['k1']);
  });
});
