import { describe, expect, it } from 'vitest';
import { PlaceDoor } from './place-door.js';
import { requireUserId, revokeAllApiKeys } from './revoke-all-api-keys.js';

type KeyRow = { id: string; user_id: string; revoked: boolean };

function keyStore(keys: KeyRow[]) {
  let writes = 0;
  const fn = async (_strings: TemplateStringsArray, ...values: unknown[]) => {
    writes += 1;
    const named = values[0];
    const out: Array<{ id: string }> = [];
    for (const k of keys) {
      if (k.user_id === named && k.revoked === false) {
        k.revoked = true;
        out.push({ id: k.id });
      }
    }
    return out;
  };
  return Object.assign(fn, {
    get writes() {
      return writes;
    },
    keys,
  }) as Parameters<typeof revokeAllApiKeys>[0] & { writes: number; keys: KeyRow[] };
}

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

describe('revokeAllApiKeys', () => {
  it('refuses a missing userId and does not write', async () => {
    const sql = keyStore([{ id: 'k', user_id: A, revoked: false }]);
    await expect(revokeAllApiKeys(sql, A, undefined)).rejects.toMatchObject({
      code: 'auth.user_id_missing',
    });
    await expect(revokeAllApiKeys(sql, A, '')).rejects.toMatchObject({
      code: 'auth.user_id_missing',
    });
    await expect(revokeAllApiKeys(sql, A, '   ')).rejects.toMatchObject({
      code: 'auth.user_id_missing',
    });
    expect(() => requireUserId(null)).toThrow(/userId is required/);
    expect(sql.writes).toBe(0);
    expect(sql.keys[0]?.revoked).toBe(false);
  });

  it('revokes every live key for the named user; already-revoked stay revoked', async () => {
    const sql = keyStore([
      { id: 'live-1', user_id: A, revoked: false },
      { id: 'live-2', user_id: A, revoked: false },
      { id: 'dead', user_id: A, revoked: true },
    ]);
    const out = await revokeAllApiKeys(sql, A, A);
    expect(out).toEqual({ userId: A, revoked: 2 });
    expect(sql.keys.map((k) => k.revoked)).toEqual([true, true, true]);

    const liveDoor = new PlaceDoor((async () => [{ id: 'live-1', user_id: A, revoked: true }]) as never);
    await expect(liveDoor.assertApiKeyLive('live-1')).rejects.toMatchObject({
      code: 'auth.api_key_revoked',
    });
  });

  it('does not revoke a different user’s keys', async () => {
    const sql = keyStore([
      { id: 'a-key', user_id: A, revoked: false },
      { id: 'b-key', user_id: B, revoked: false },
    ]);
    const foreign = await revokeAllApiKeys(sql, A, B);
    expect(foreign).toEqual({ userId: B, revoked: 0 });
    expect(sql.writes).toBe(0);
    expect(sql.keys.find((k) => k.id === 'b-key')?.revoked).toBe(false);

    const own = await revokeAllApiKeys(sql, A, A);
    expect(own).toEqual({ userId: A, revoked: 1 });
    expect(sql.keys.find((k) => k.id === 'a-key')?.revoked).toBe(true);
    expect(sql.keys.find((k) => k.id === 'b-key')?.revoked).toBe(false);
  });
});
