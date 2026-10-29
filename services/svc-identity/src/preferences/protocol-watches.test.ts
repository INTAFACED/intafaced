import { describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import type { Context } from '@intafaced/contracts';
import { setPreferences } from './preferences.js';
import { ADDRESS_WATCHES_NAMESPACE, parseAddressWatches, parseTokenWatchlist, TOKEN_WATCHLIST_NAMESPACE } from './protocol-watches.js';

const context = { principal: { userId: 'U-1' }, service: null } as unknown as Context;
/** Anything that reaches the database fails the test: these paths must refuse first. */
const noDatabase = new Proxy(() => undefined, {
  apply() {
    throw new Error('the database was reached');
  },
}) as unknown as Sql;
const A = `0x${'a'.repeat(40)}`;

describe('protocol.token-watchlist and protocol.address-watches values (D-portfolio-wallet-07, D-explorer-04)', () => {
  it('keeps a token list and a watch list as they are', () => {
    expect(parseTokenWatchlist([A])).toEqual([A]);
    expect(parseAddressWatches([{ address: A, tag: 'TEST cold wallet', note: 'TEST note' }])).toEqual([
      { address: A, tag: 'TEST cold wallet', note: 'TEST note' },
    ]);
  });

  it('refuses a repeated or mixed-case address, a blank tag, an extra field and a non-list', () => {
    for (const bad of [[A, A], [A.replace('a', 'A')], '0x', null])
      expect(() => parseTokenWatchlist(bad)).toThrow('identity.preferences_value_invalid');
    for (const bad of [
      [{ address: A, tag: ' ', note: '' }],
      [{ address: A, tag: 't', note: '', balance: '1.00' }],
      [
        { address: A, tag: 'a', note: '' },
        { address: A, tag: 'b', note: '' },
      ],
      {},
    ])
      expect(() => parseAddressWatches(bad)).toThrow('identity.preferences_value_invalid');
  });

  it('checks both writes before they touch the database', async () => {
    for (const namespace of [TOKEN_WATCHLIST_NAMESPACE, ADDRESS_WATCHES_NAMESPACE])
      await expect(
        setPreferences(noDatabase, context, { namespace, ifVersion: 0, clientRequestId: `${namespace}:u-1:0`, value: [A, A] }),
      ).rejects.toMatchObject({ code: 'identity.preferences_value_invalid' });
  });
});
