import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdminSessionError, type AdminSessionConfig } from './founder-session';
import { parseStepUpProof, withStepUp } from './step-up';

const config: AdminSessionConfig = { origin: 'https://admin.example', edgeUrl: 'http://edge:4000', key: randomBytes(32) };
const session = { accessToken: 'founder-access-token' };
const reply = (data: unknown) => Response.json({ result: { data } });
const assertion = {
  id: 'cred',
  rawId: 'cred',
  type: 'public-key',
  response: { clientDataJSON: 'a', authenticatorData: 'b', signature: 'c', userHandle: null },
  clientExtensionResults: {},
};

afterEach(() => vi.unstubAllGlobals());

describe('parseStepUpProof', () => {
  it('accepts a 6-digit code, a recovery code and a passkey assertion', () => {
    expect(parseStepUpProof({ totpCode: '123456' })).toEqual({ totpCode: '123456' });
    expect(parseStepUpProof({ totpCode: 'ABCDE-01234' })).toEqual({ totpCode: 'ABCDE-01234' });
    expect(parseStepUpProof({ webauthn: assertion })).toEqual({ webauthn: assertion });
  });
  it('keeps only the known passkey fields', () => {
    const parsed = parseStepUpProof({ webauthn: { ...assertion, extra: 'x', response: { ...assertion.response, more: 'y' } } });
    expect(parsed).toEqual({ webauthn: assertion });
  });
  it.each([
    ['nothing', undefined],
    ['an array', []],
    ['an empty proof', {}],
    ['a short code', { totpCode: '12345' }],
    ['a long code', { totpCode: '1234567' }],
    ['a padded code', { totpCode: ' 123456' }],
    ['a number', { totpCode: 123456 }],
    ['both factors', { totpCode: '123456', webauthn: assertion }],
    ['an unknown key', { totpCode: '123456', extra: 1 }],
    ['a non-public-key credential', { webauthn: { ...assertion, type: 'password' } }],
    ['a missing signature', { webauthn: { ...assertion, response: { ...assertion.response, signature: '' } } }],
    ['an oversized field', { webauthn: { ...assertion, response: { ...assertion.response, signature: 'x'.repeat(5000) } } }],
    ['a non-object assertion', { webauthn: 'cred' }],
  ])('refuses %s', (_name, value) => {
    expect(() => parseStepUpProof(value)).toThrowError(expect.objectContaining({ code: 'admin.proof_input', status: 400 }));
  });
});

describe('withStepUp', () => {
  it('asks for the step-up token with the founder token, hands it only to the action, and does not return it', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply({ accessToken: 'step-up-token', expiresAt: 'x', scopes: [] }));
    vi.stubGlobal('fetch', fetcher);
    const seen: string[] = [];
    const result = await withStepUp(config, session, { totpCode: '123456' }, async (token) => {
      seen.push(token);
      return { ok: true };
    });
    expect(seen).toEqual(['step-up-token']);
    expect(JSON.stringify(result)).not.toContain('step-up-token');
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe('http://edge:4000/api/identity/trpc/auth.stepUp');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer founder-access-token');
    expect(init?.body).toBe(JSON.stringify({ totpCode: '123456' }));
  });
  it('never runs the action when the proof is refused, and carries the upstream code', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json(
          { error: { message: 'x', code: 'UNAUTHORIZED', data: { httpStatus: 401, intafacedCode: 'auth.invalid_credentials' } } },
          { status: 401 },
        ),
      );
    vi.stubGlobal('fetch', fetcher);
    const action = vi.fn();
    const failure = await withStepUp(config, session, { totpCode: '000000' }, action).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AdminSessionError);
    expect(failure).toMatchObject({ status: 401, upstreamCode: 'auth.invalid_credentials' });
    expect(action).not.toHaveBeenCalled();
  });
  it('refuses a step-up answer with no token', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValueOnce(reply({ expiresAt: 'x' })));
    const action = vi.fn();
    await expect(withStepUp(config, session, { totpCode: '123456' }, action)).rejects.toMatchObject({ code: 'admin.upstream_invalid' });
    expect(action).not.toHaveBeenCalled();
  });
  it('sends a recovery code upper-cased, and leaves a 6-digit code alone', () => {
    expect(parseStepUpProof({ totpCode: 'abcde-1f2e3' })).toEqual({ totpCode: 'ABCDE-1F2E3' });
    expect(parseStepUpProof({ totpCode: 'ABCDE-12345' })).toEqual({ totpCode: 'ABCDE-12345' });
    expect(parseStepUpProof({ totpCode: '123456' })).toEqual({ totpCode: '123456' });
  });
  it('passes a passkey assertion through unchanged', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply({ accessToken: 't', expiresAt: 'x', scopes: [] }));
    vi.stubGlobal('fetch', fetcher);
    await withStepUp(config, session, { webauthn: assertion as never }, async () => 1);
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]?.body))).toEqual({ webauthn: assertion });
  });
});
