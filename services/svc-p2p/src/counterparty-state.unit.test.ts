import { describe, expect, it } from 'vitest';
import { CounterpartyStateUnavailableError, createIdentityCounterpartyState, unconfiguredCounterpartyState } from './counterparty-state.js';

/** #4689: svc-p2p reads the ad maker's account status from identity, and anything but a clear answer is "unknown". */

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '33333333-3333-4333-8333-333333333333';
const SECRET = 'p2p-counterparty-secret-long-enough-for-tests';

function identity(answer: (url: string) => Response | Promise<Response>) {
  const asked: string[] = [];
  const fetchFn = (async (input: string | URL | Request) => {
    const url = String(input);
    asked.push(url);
    return answer(url);
  }) as typeof globalThis.fetch;
  return { port: createIdentityCounterpartyState('http://identity.test/', SECRET, undefined, fetchFn), asked };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('identity counterparty state (#4689)', () => {
  it.each(['active', 'frozen', 'closed'] as const)('reads %s from identity /internal/account/:userId', async (status) => {
    const { port, asked } = identity(() => json({ userId: USER, status, kycTier: 'basic' }));
    await expect(port.statusOf(USER)).resolves.toBe(status);
    expect(asked).toEqual([`http://identity.test/internal/account/${USER}`]);
  });

  it('reads a 404 as not_found, never as active', async () => {
    const { port } = identity(() => json({ code: 'identity.account_not_found' }, 404));
    await expect(port.statusOf(USER)).resolves.toBe('not_found');
  });

  it.each([
    ['a 500', () => json({}, 500)],
    ['a 401', () => json({}, 401)],
    ['a body that is not JSON', () => new Response('<html>', { status: 200 })],
    ['a body that fails the schema', () => json({ userId: USER, status: 'unknown' })],
    ['a body about another user', () => json({ userId: OTHER, status: 'active', kycTier: 'basic' })],
    [
      'no answer',
      () => {
        throw new TypeError('fetch failed');
      },
    ],
  ])('throws unavailable on %s', async (_why, answer) => {
    const { port } = identity(answer);
    await expect(port.statusOf(USER)).rejects.toBeInstanceOf(CounterpartyStateUnavailableError);
  });

  it('refuses every ask when IDENTITY_URL is unset', async () => {
    await expect(unconfiguredCounterpartyState().statusOf(USER)).rejects.toBeInstanceOf(CounterpartyStateUnavailableError);
  });
});
