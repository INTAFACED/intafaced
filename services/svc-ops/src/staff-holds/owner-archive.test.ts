import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createServiceSigner, createServiceVerifier, verifyServiceRequest, type Keyring } from '@intafaced/contracts';
import { createHoldOwnerArchive } from './owner-archive.js';

const USER = '11111111-1111-4111-8111-111111111111';
const IDENTITY = 'http://identity.internal:4002';
const SECRET = 's'.repeat(32);

function answering(status: number, body: unknown, seen: string[] = []): typeof fetch {
  return (async (url: string | URL | Request) => {
    seen.push(String(url));
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  }) as typeof fetch;
}

const state = (over: Record<string, unknown> = {}) => ({ userId: USER, status: 'closed', kycTier: 'none', archived: true, ...over });

describe("a hold owner's archive state, from identity's account door", () => {
  it('reads archived and not archived for the user asked about', async () => {
    const seen: string[] = [];
    expect(
      await createHoldOwnerArchive({ identityUrl: IDENTITY, secret: SECRET, fetcher: answering(200, state(), seen) }).archived(USER),
    ).toBe(true);
    expect(seen).toEqual([`${IDENTITY}/internal/account/${USER}`]);
    const open = createHoldOwnerArchive({
      identityUrl: IDENTITY,
      secret: SECRET,
      fetcher: answering(200, state({ archived: false, status: 'active' })),
    });
    expect(await open.archived(USER)).toBe(false);
  });

  it('never reads a missing, refused, failed, misshapen, other-user or field-less answer as not archived', async () => {
    const thrower = (async () => {
      throw new Error('connect ECONNREFUSED');
    }) as typeof fetch;
    const cases = [
      createHoldOwnerArchive({ identityUrl: undefined, secret: SECRET, fetcher: answering(200, state({ archived: false })) }),
      createHoldOwnerArchive({ identityUrl: IDENTITY, fetcher: answering(200, state({ archived: false })) }),
      createHoldOwnerArchive({ identityUrl: 'ftp://identity', secret: SECRET, fetcher: answering(200, state({ archived: false })) }),
      createHoldOwnerArchive({ identityUrl: IDENTITY, secret: SECRET, fetcher: answering(404, { code: 'identity.account_not_found' }) }),
      createHoldOwnerArchive({ identityUrl: IDENTITY, secret: SECRET, fetcher: answering(200, 'not json') }),
      createHoldOwnerArchive({ identityUrl: IDENTITY, secret: SECRET, fetcher: answering(200, { archived: false }) }),
      createHoldOwnerArchive({
        identityUrl: IDENTITY,
        secret: SECRET,
        fetcher: answering(200, state({ archived: false, userId: '22222222-2222-4222-8222-222222222222' })),
      }),
      createHoldOwnerArchive({
        identityUrl: IDENTITY,
        secret: SECRET,
        fetcher: answering(200, { userId: USER, status: 'closed', kycTier: 'none' }),
      }),
      createHoldOwnerArchive({ identityUrl: IDENTITY, secret: SECRET, fetcher: thrower }),
      createHoldOwnerArchive({ identityUrl: IDENTITY, secret: SECRET, fetcher: answering(401, { code: 'unauthorized' }) }),
    ];
    for (const reader of cases) expect(await reader.archived(USER)).toBe('unreadable');
  });

  it('gives up after its timeout and reads unreadable, so a silent identity holds no confirm', async () => {
    vi.useFakeTimers();
    try {
      let aborted = false;
      const silent = ((_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            aborted = true;
            reject(new Error('aborted'));
          });
        })) as typeof fetch;
      const answer = createHoldOwnerArchive({ identityUrl: IDENTITY, secret: SECRET, fetcher: silent }).archived(USER);
      await vi.advanceTimersByTimeAsync(5000);
      expect(await answer).toBe('unreadable');
      expect(aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("signs with svc-ops's own key when only the keypair is set, and identity's verifier accepts it", async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const keyring: Keyring = [
      {
        kid: 'svc-ops.a',
        svc: 'svc-ops',
        use: 's2s',
        x: publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url'),
      },
    ];
    const signer = createServiceSigner({
      service: 'svc-ops',
      kid: 'svc-ops.a',
      privateKey: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url'),
      keyring,
    });
    let sent: { url: URL; headers: Record<string, string> } | undefined;
    const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
      sent = { url: new URL(String(url)), headers: init?.headers as Record<string, string> };
      return new Response(JSON.stringify(state({ archived: false })), { status: 200 });
    }) as typeof fetch;
    expect(await createHoldOwnerArchive({ identityUrl: IDENTITY, s2s: { signer, mode: 'keypair' }, fetcher }).archived(USER)).toBe(false);
    const verdict = verifyServiceRequest(
      { method: 'GET', url: sent!.url.pathname, headers: sent!.headers, body: '' },
      { verifier: createServiceVerifier({ self: 'svc-identity', keyring, bootSecond: 0 }), legacySecret: '', mode: 'keypair' },
    );
    expect(verdict).toEqual({ service: 'svc-ops', scheme: 'keypair', rejected: null });
  });
});
