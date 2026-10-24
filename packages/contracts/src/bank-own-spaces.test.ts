import { describe, expect, it, vi } from 'vitest';
import {
  BANK_OWN_SPACES_CALLERS,
  BANK_OWN_SPACES_PROCEDURE,
  bankOwnSpacesInputSchema,
  bankOwnSpacesSchema,
  createBankOwnSpacesClient,
  verifyServiceHeaders,
} from './index.js';
import { SERVICE_NAMES } from './service-keys.js';

const SPACE = '11111111-1111-4111-8111-111111111111';
const SECRET = 'own-spaces-secret-long-enough-for-32';
const input = { userId: 'user-ada' };
const space = { spaceId: SPACE, assetId: 'BTC', name: 'TEST cold', archived: false };
const UNAVAILABLE = { state: 'unavailable', code: 'bank.own_spaces_unavailable' };

const reply = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify({ result: { data } }), { status, headers: { 'content-type': 'application/json' } });

describe('bank own spaces contract', () => {
  it('names one procedure and one caller, and the caller is a real service', () => {
    expect(BANK_OWN_SPACES_PROCEDURE).toBe('spaces.ownedAccounts');
    expect(BANK_OWN_SPACES_CALLERS).toEqual(['svc-tax']);
    for (const caller of BANK_OWN_SPACES_CALLERS) expect(SERVICE_NAMES).toContain(caller);
  });

  it('refuses a field it does not name and a blank user', () => {
    expect(bankOwnSpacesInputSchema.safeParse({ ...input, extra: 1 }).success).toBe(false);
    expect(bankOwnSpacesInputSchema.safeParse({ userId: '' }).success).toBe(false);
    expect(bankOwnSpacesInputSchema.safeParse(input).success).toBe(true);
  });

  it('parses a list and refuses a row with a balance, a non-uuid space or a missing field', () => {
    expect(bankOwnSpacesSchema.parse({ spaces: [space] })).toEqual({ spaces: [space] });
    expect(bankOwnSpacesSchema.parse({ spaces: [] })).toEqual({ spaces: [] });
    expect(bankOwnSpacesSchema.safeParse({ spaces: [{ ...space, balance: '1' }] }).success).toBe(false);
    expect(bankOwnSpacesSchema.safeParse({ spaces: [{ ...space, spaceId: 'x' }] }).success).toBe(false);
    const { archived: _archived, ...noArchived } = space;
    expect(bankOwnSpacesSchema.safeParse({ spaces: [noArchived] }).success).toBe(false);
  });
});

describe('bank own spaces client', () => {
  it('signs the body as svc-tax and returns the parsed list', async () => {
    const fetcher = vi.fn(async () => reply({ spaces: [space] }));
    const client = createBankOwnSpacesClient({ bankUrl: 'http://bank.internal:4010/', secret: SECRET, fetcher });
    await expect(client.list(input)).resolves.toEqual({ state: 'read', spaces: [space] });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://bank.internal:4010/trpc/spaces.ownedAccounts');
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify(input));
    const headers = init.headers as Record<string, string>;
    expect(
      verifyServiceHeaders(headers, SECRET, { rawBody: { retained: true, bytes: Buffer.from(String(init.body)) }, mode: 'require' })
        .service,
    ).toBe('svc-tax');
  });

  it('returns an empty list as read, not as unavailable', async () => {
    const client = createBankOwnSpacesClient({
      bankUrl: 'http://bank.internal',
      secret: SECRET,
      fetcher: (async () => reply({ spaces: [] })) as unknown as typeof fetch,
    });
    await expect(client.list(input)).resolves.toEqual({ state: 'read', spaces: [] });
  });

  it.each([
    ['no url', { secret: SECRET }],
    ['a url with credentials', { bankUrl: 'http://u:p@bank.internal', secret: SECRET }],
    ['a url with a query', { bankUrl: 'http://bank.internal?x=1', secret: SECRET }],
    ['a non-http url', { bankUrl: 'ftp://bank.internal', secret: SECRET }],
    ['no secret', { bankUrl: 'http://bank.internal' }],
    ['a short secret', { bankUrl: 'http://bank.internal', secret: 'short' }],
  ])('answers unavailable without fetching for %s', async (_name, options) => {
    const fetcher = vi.fn();
    const client = createBankOwnSpacesClient({ ...options, fetcher: fetcher as unknown as typeof fetch });
    await expect(client.list(input)).resolves.toEqual(UNAVAILABLE);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('answers unavailable for an invalid input without fetching', async () => {
    const fetcher = vi.fn();
    const client = createBankOwnSpacesClient({
      bankUrl: 'http://bank.internal',
      secret: SECRET,
      fetcher: fetcher as unknown as typeof fetch,
    });
    await expect(client.list({ userId: '' })).resolves.toEqual(UNAVAILABLE);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    ['a non-2xx reply', async () => reply({ spaces: [space] }, 500)],
    ['a reply that does not parse', async () => reply({ spaces: [{ spaceId: SPACE }] })],
    ['an envelope with no result', async () => new Response(JSON.stringify({ error: {} }), { status: 200 })],
    ['a thrown fetch', async () => Promise.reject(new Error('down'))],
  ])('answers unavailable for %s, never an empty list', async (_name, fetcher) => {
    const client = createBankOwnSpacesClient({
      bankUrl: 'http://bank.internal',
      secret: SECRET,
      fetcher: fetcher as unknown as typeof fetch,
    });
    await expect(client.list(input)).resolves.toEqual(UNAVAILABLE);
  });

  it('answers unavailable when the bank does not reply in time', async () => {
    const fetcher = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted')))),
    );
    const client = createBankOwnSpacesClient({
      bankUrl: 'http://bank.internal',
      secret: SECRET,
      timeoutMs: 20,
      fetcher: fetcher as unknown as typeof fetch,
    });
    await expect(client.list(input)).resolves.toEqual(UNAVAILABLE);
  });
});
