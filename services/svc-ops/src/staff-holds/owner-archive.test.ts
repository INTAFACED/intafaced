import { describe, expect, it } from 'vitest';
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
    ];
    for (const reader of cases) expect(await reader.archived(USER)).toBe('unreadable');
  });
});
