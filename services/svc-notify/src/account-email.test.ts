import { describe, expect, it } from 'vitest';
import { AccountEmailUnavailableError, createProvedAccountEmailClient } from './account-email.js';

const USER = '66666666-6666-4666-8666-666666666666';
const SECRET = 'x'.repeat(40);

function answering(status: number, body: unknown, seen: string[] = []): typeof fetch {
  return (async (url: string | URL | Request) => {
    seen.push(String(url));
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

describe('the proved account email read from identity', () => {
  it('returns the proved address, asked of identity’s internal door for this user', async () => {
    const seen: string[] = [];
    const read = createProvedAccountEmailClient(
      'http://identity.test/',
      SECRET,
      undefined,
      answering(200, { userId: USER, email: 'a@local-test.invalid' }, seen),
    );
    await expect(read(USER)).resolves.toBe('a@local-test.invalid');
    expect(seen).toEqual([`http://identity.test/internal/proved-email/${USER}`]);
  });

  it('is null while the address is unproved', async () => {
    const read = createProvedAccountEmailClient('http://identity.test', SECRET, undefined, answering(200, { userId: USER, email: null }));
    await expect(read(USER)).resolves.toBeNull();
  });

  it('fails closed on a refusal, an unknown user, an off-contract body, another user or no answer', async () => {
    const cases: Array<typeof fetch> = [
      answering(404, { code: 'identity.account_not_found' }),
      answering(401, { code: 'identity.unauthenticated' }),
      answering(200, { userId: USER, email: 'a@local-test.invalid', extra: true }),
      answering(200, { userId: '77777777-7777-4777-8777-777777777777', email: 'b@local-test.invalid' }),
      (async () => {
        throw new Error('ECONNREFUSED');
      }) as typeof fetch,
    ];
    for (const fetchFn of cases) {
      const read = createProvedAccountEmailClient('http://identity.test', SECRET, undefined, fetchFn);
      await expect(read(USER)).rejects.toBeInstanceOf(AccountEmailUnavailableError);
    }
  });
});
