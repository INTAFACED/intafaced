import { afterEach, describe, expect, it, vi } from 'vitest';
import { createParticipantClient } from './participants.js';

/** svc-identity's participant read: only the published contract about the asked account counts; anything else is null. */

const USER = '11111111-1111-4111-8111-111111111111';
const SECRET = 'a-campaigns-participant-test-secret-long-enough';
const body = { userId: USER, accountType: 'business', region: 'FR', status: 'active', kycTier: 'basic' };

function answer(status: number, json: unknown) {
  const fetch = vi.fn(async () => new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json' } }));
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('participant client', () => {
  it('reads the account from identity with service credentials', async () => {
    const fetch = answer(200, body);
    expect(await createParticipantClient('http://identity.test/', SECRET).read(USER)).toEqual(body);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`http://identity.test/internal/campaign-participant/${USER}`);
    expect(Object.keys(init.headers as Record<string, string>).length).toBeGreaterThan(1);
  });

  it('a refusal, a body off the contract, another account or a dead line is null', async () => {
    const client = createParticipantClient('http://identity.test', SECRET);
    answer(404, { code: 'identity.account_not_found' });
    expect(await client.read(USER)).toBeNull();
    answer(200, { ...body, email: 'x@example.test' });
    expect(await client.read(USER)).toBeNull();
    answer(200, { ...body, userId: '22222222-2222-4222-8222-222222222222' });
    expect(await client.read(USER)).toBeNull();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('connection refused');
      }),
    );
    expect(await client.read(USER)).toBeNull();
  });
});
