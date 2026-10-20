import { describe, expect, it } from 'vitest';
import type { CurrentAuthorityInput } from '@intafaced/contracts';
import { createIdentityAuthorityClient } from './authority.js';
import { assertIdentitySessionPasskey } from './session-passkey.js';
import { eligibleAuthority } from '../test-support/authority.js';
import { SECRET, judged, keyCases, makeKeys, recorder, type Sent } from '../s2s-keys-fixture.js';

const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SESSION = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const KEY = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const subject: CurrentAuthorityInput = { userId: USER, credential: { kind: 'session', sessionId: SESSION } };

// The recorder's empty reply is not valid for these reads, so each client refuses after the request went out;
// only the request is judged.
keyCases('svc-ws -> svc-identity current authority', 'svc-identity', async (fetch, s2s) => {
  await createIdentityAuthorityClient({ baseUrl: 'http://identity.test', secret: SECRET, fetch, s2s })
    .read(subject, new AbortController().signal)
    .catch(() => undefined);
});

keyCases('svc-ws -> svc-identity session passkey read', 'svc-identity', async (fetch, s2s) => {
  await assertIdentitySessionPasskey({
    identityUrl: 'http://identity.test',
    userId: USER,
    identityOwnershipSecret: SECRET,
    fetch,
    s2s,
  }).catch(() => undefined);
});

describe('svc-ws -> svc-identity key ownership read (the second call of an api-key authority check)', () => {
  const apiKeySubject: CurrentAuthorityInput = { userId: USER, credential: { kind: 'api_key', apiKeyId: KEY } };
  const policy = { userId: USER, apiKeyId: KEY } as never;

  async function run(mode: 'dual' | 'keypair') {
    const k = makeKeys('svc-identity');
    const { sent } = recorder();
    const calls: Sent[] = [];
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push({
        url,
        method: init?.method ?? 'GET',
        headers: Object.fromEntries(new Headers(init?.headers)),
        body: init?.body === undefined ? '' : String(init.body),
      });
      if (calls.length === 1) return Response.json({ result: { data: eligibleAuthority(apiKeySubject) } });
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof globalThis.fetch;
    void sent;
    await createIdentityAuthorityClient({ baseUrl: 'http://identity.test', secret: SECRET, fetch, s2s: k.s2s(mode) })
      .read(apiKeySubject, new AbortController().signal, policy)
      .catch(() => undefined);
    return { calls, k };
  }

  it('signs the ownership GET for its own path, and the verifier accepts it', async () => {
    const { calls, k } = await run('keypair');
    const ownership = calls[1]!;
    expect(ownership.url.pathname).toBe(`/internal/api-keys/${KEY}`);
    expect(judged(ownership, k.verifier(), 'keypair')).toMatchObject({ service: 'svc-ws', scheme: 'keypair' });
  });

  it('a signature made for the first call is refused on the ownership path', async () => {
    const { calls, k } = await run('keypair');
    const replayed = { ...calls[1]!, headers: calls[0]!.headers };
    expect(judged(replayed, k.verifier(), 'keypair')).toMatchObject({ service: null });
  });
});
