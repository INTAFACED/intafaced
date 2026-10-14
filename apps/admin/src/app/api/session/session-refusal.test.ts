import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST as login } from './route';
import { POST as passkey } from './passkey/route';

const original = { ...process.env };
const refused = (status: number, intafacedCode: string) =>
  Response.json(
    { error: { message: 'x', code: 'UNAUTHORIZED', data: { httpStatus: status, intafacedCode, cause: { code: intafacedCode } } } },
    { status },
  );
const post = (handler: (request: Request) => Promise<Response>, path: string, input: unknown) =>
  handler(
    new Request(`https://admin.example${path}`, {
      method: 'POST',
      headers: { origin: 'https://admin.example', 'content-type': 'application/json' },
      body: JSON.stringify(input),
    }),
  );

beforeEach(() => {
  process.env.ADMIN_ORIGIN = 'https://admin.example';
  process.env.EDGE_URL = 'http://edge:4000';
  process.env.ADMIN_SESSION_SECRET = randomBytes(32).toString('base64url');
});
afterEach(() => {
  process.env = { ...original };
  vi.unstubAllGlobals();
});

describe('console sign-in never says which half of the credential was wrong', () => {
  it('password login refusal is exactly {code}, whichever identity code came back', async () => {
    // Identity answers wrong-password and wrong-code with the same status but different typed codes in the envelope.
    for (const code of ['auth.invalid_credentials', 'auth.mfa_invalid', 'auth.too_many_attempts']) {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => refused(401, code)),
      );
      const result = await post(login, '/api/session', {
        identifier: 'founder@example.invalid',
        password: 'a-password',
        totpCode: '123456',
      });
      expect(result.status).toBe(401);
      expect(await result.json()).toEqual({ code: 'admin.authority_refused' });
    }
  });
  it('passkey login refusal is exactly {code} too', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => refused(401, 'auth.webauthn_invalid')),
    );
    const result = await post(passkey, '/api/session/passkey', {
      action: 'options',
      identifier: 'founder@example.invalid',
    });
    expect(result.status).toBe(401);
    expect(await result.json()).toEqual({ code: 'admin.authority_refused' });
  });
  it('sends a lower-case recovery code to identity in upper case', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => refused(401, 'auth.invalid_credentials'));
    vi.stubGlobal('fetch', fetcher);
    await post(login, '/api/session', { identifier: 'founder@example.invalid', password: 'a-password', totpCode: 'abcde-1f2e3' });
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]?.body))).toMatchObject({ totpCode: 'ABCDE-1F2E3' });
  });
});
