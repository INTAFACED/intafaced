import { describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import type { Context } from '@intafaced/contracts';
import { setPreferences } from './preferences.js';
import { HOME_TILES_NAMESPACE, parseHomeTiles } from './home-tiles.js';

const context = { principal: { userId: 'U-1' }, service: null } as unknown as Context;
/** Anything that reaches the database fails the test: these paths must refuse first. */
const noDatabase = new Proxy(() => undefined, {
  apply() {
    throw new Error('the database was reached');
  },
}) as unknown as Sql;

describe('home.tiles value (HM-widgets-01)', () => {
  it('keeps an order and a hidden set as they are', () => {
    const layout = { order: ['activity', 'markets'], hidden: ['markets'] };
    expect(parseHomeTiles(layout)).toEqual(layout);
    expect(parseHomeTiles({ order: [], hidden: [] })).toEqual({ order: [], hidden: [] });
  });

  it('refuses a repeated tile, a bad id, a missing list, an extra field and a non-object', () => {
    for (const bad of [
      { order: ['markets', 'markets'], hidden: [] },
      { order: ['Markets'], hidden: [] },
      { order: [] },
      { order: [], hidden: [], balance: '1.00' },
      'markets',
      null,
    ]) {
      expect(() => parseHomeTiles(bad)).toThrow('identity.preferences_value_invalid');
    }
  });

  it('checks a home.tiles write before it touches the database', async () => {
    const input = { namespace: HOME_TILES_NAMESPACE, ifVersion: 0, clientRequestId: 'home-tiles:u-1:0' };
    await expect(setPreferences(noDatabase, context, { ...input, value: { order: ['a', 'a'], hidden: [] } })).rejects.toMatchObject({
      code: 'identity.preferences_value_invalid',
    });
  });
});
