import { describe, expect, it } from 'vitest';
import { createIdentityPublicProfile } from './public-profile.js';
import { SECRET, keyCases } from './s2s-keys-fixture.js';

/** J-p2p-02 #2, #5: the other side of an order by the handle identity holds, never a made-up one. */

const USER = '22222222-2222-4222-8222-222222222222';
const answer = (status: number, body: unknown) =>
  (async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;

describe('svc-p2p public profile from identity', () => {
  it('names the account by its handle and claims no member-since date the door does not carry', async () => {
    const profile = createIdentityPublicProfile('http://identity', SECRET, undefined, answer(200, { userId: USER, handle: 'TESTbuyer' }));
    expect(await profile.lookup(USER)).toEqual({ handle: 'TESTbuyer', memberSince: null });
  });

  it('no such account is null; a refusal, a reply for another account or a malformed reply throws', async () => {
    expect(await createIdentityPublicProfile('http://identity', SECRET, undefined, answer(404, {})).lookup(USER)).toBeNull();
    await expect(createIdentityPublicProfile('http://identity', SECRET, undefined, answer(503, {})).lookup(USER)).rejects.toThrow();
    await expect(
      createIdentityPublicProfile('http://identity', SECRET, undefined, answer(200, { userId: 'other', handle: 'x' })).lookup(USER),
    ).rejects.toThrow();
    await expect(
      createIdentityPublicProfile('http://identity', SECRET, undefined, answer(200, { userId: USER })).lookup(USER),
    ).rejects.toThrow();
  });
});

keyCases('svc-p2p -> svc-identity public handle', 'svc-identity', async (fetchImpl, s2s) => {
  // The recorder answers `{}`, which is not a handle: only the signed request matters here.
  await createIdentityPublicProfile('http://identity', SECRET, s2s, fetchImpl)
    .lookup(USER)
    .catch(() => undefined);
});
