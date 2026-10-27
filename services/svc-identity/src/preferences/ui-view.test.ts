import { describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import type { Context } from '@intafaced/contracts';
import { getPreferences, setPreferences } from './preferences.js';
import { UI_VIEW_NAMESPACE, parseUiView } from './ui-view.js';

const context = { principal: { userId: 'U-1' }, service: null } as unknown as Context;
/** Anything that reaches the database fails the test: these paths must refuse first. */
const noDatabase = new Proxy(() => undefined, {
  apply() {
    throw new Error('the database was reached');
  },
}) as unknown as Sql;

describe('ui.view value', () => {
  it('keeps a full record and an empty one as they are', () => {
    const full = { layoutMode: 'simple', hideBalances: true, displayCurrency: 'BTC', theme: 'system', activeProfile: 'business:acme-1' };
    expect(parseUiView(full)).toEqual(full);
    expect(parseUiView({})).toEqual({});
  });

  it('refuses an unknown field, a value outside its list, a bad profile and a non-object', () => {
    for (const bad of [
      { layoutMode: 'expert' },
      { theme: 'sepia' },
      { displayCurrency: 'JPY' },
      { hideBalances: 'yes' },
      { activeProfile: 'business:' },
      { activeProfile: 'admin' },
      { balance: '1.00' },
      'simple',
      null,
    ]) {
      expect(() => parseUiView(bad)).toThrow('identity.preferences_value_invalid');
    }
  });
});

describe('preference namespaces', () => {
  it('refuses a namespace nobody registered, including inherited object keys', async () => {
    for (const namespace of ['ui.views', 'constructor', '__proto__', 'toString']) {
      await expect(getPreferences(noDatabase, context, namespace)).rejects.toMatchObject({
        code: 'identity.preferences_namespace_unknown',
      });
    }
  });

  it('checks a ui.view write before it touches the database', async () => {
    const input = { namespace: UI_VIEW_NAMESPACE, ifVersion: 0, clientRequestId: 'ui-view:u-1:0' };
    await expect(setPreferences(noDatabase, context, { ...input, value: { theme: 'sepia' } })).rejects.toMatchObject({
      code: 'identity.preferences_value_invalid',
    });
    await expect(setPreferences(noDatabase, context, { ...input, value: 'dark' })).rejects.toMatchObject({
      code: 'identity.preferences_value_invalid',
    });
  });
});
