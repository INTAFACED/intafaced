import { describe, expect, it } from 'vitest';
import {
  ADDRESS_WATCHES_NAMESPACE,
  addressWatchesValueSchema,
  mergeTokenWatchlists,
  protocolWatchRequestId,
  PROTOCOL_WATCH_MAX,
  TOKEN_WATCHLIST_NAMESPACE,
  tokenWatchlistValueSchema,
  upsertAddressWatch,
} from './protocol-watch-preferences.js';

const A = `0x${'a'.repeat(40)}`;
const B = `0x${'b'.repeat(40)}`;

describe('protocol watch preferences', () => {
  it('holds lower-case addresses once each, within the guard', () => {
    expect(tokenWatchlistValueSchema.safeParse([A, B]).success).toBe(true);
    expect(tokenWatchlistValueSchema.safeParse([A, A]).success).toBe(false);
    expect(tokenWatchlistValueSchema.safeParse([A.toUpperCase().replace('0X', '0x')]).success).toBe(false);
    expect(tokenWatchlistValueSchema.safeParse(['0x1234']).success).toBe(false);
    const many = Array.from({ length: PROTOCOL_WATCH_MAX + 1 }, (_, index) => `0x${index.toString(16).padStart(40, '0')}`);
    expect(tokenWatchlistValueSchema.safeParse(many).success).toBe(false);
  });
  it('holds one watch per address with a tag and a note, refusing a blank tag or an unknown field', () => {
    expect(addressWatchesValueSchema.safeParse([{ address: A, tag: 'TEST cold wallet', note: 'TEST note' }]).success).toBe(true);
    expect(addressWatchesValueSchema.safeParse([{ address: A, tag: '  ', note: '' }]).success).toBe(false);
    expect(addressWatchesValueSchema.safeParse([{ address: A, tag: 'x', note: '', extra: 1 }]).success).toBe(false);
    expect(
      addressWatchesValueSchema.safeParse([
        { address: A, tag: 'one', note: '' },
        { address: A, tag: 'two', note: '' },
      ]).success,
    ).toBe(false);
  });
  it('merges a browser list into the account list without repeats, keeping the account order', () => {
    expect(mergeTokenWatchlists([B], [A.toUpperCase().replace('0X', '0x'), B, 'junk'])).toEqual([B, A]);
  });
  it('watches an address once: the same watch again changes nothing, a new tag replaces the old', () => {
    const once = upsertAddressWatch([], { address: A.toUpperCase().replace('0X', '0x'), tag: ' TEST ', note: 'n' });
    expect(once).toEqual([{ address: A, tag: 'TEST', note: 'n' }]);
    expect(upsertAddressWatch(once, { address: A, tag: 'TEST', note: 'n' })).toEqual(once);
    expect(upsertAddressWatch(once, { address: A, tag: 'Other', note: '' })).toEqual([{ address: A, tag: 'Other', note: '' }]);
  });
  it('names a write by its business key, the same for the same write', () => {
    const one = protocolWatchRequestId('User-1', TOKEN_WATCHLIST_NAMESPACE, 3, [A]);
    expect(one).toBe(protocolWatchRequestId('user-1', TOKEN_WATCHLIST_NAMESPACE, 3, [A]));
    expect(one).not.toBe(protocolWatchRequestId('user-1', TOKEN_WATCHLIST_NAMESPACE, 4, [A]));
    expect(one).not.toBe(protocolWatchRequestId('user-1', ADDRESS_WATCHES_NAMESPACE, 3, [A]));
    expect(one.length).toBeLessThan(200);
  });
});
