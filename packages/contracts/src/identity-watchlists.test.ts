import { describe, expect, it, vi } from 'vitest';
import {
  IDENTITY_WATCHLISTS_CALLERS,
  IDENTITY_WATCHLISTS_PROCEDURE,
  createIdentityWatchlistsClient,
  identityWatchlistsInputSchema,
  identityWatchlistsSchema,
  parseStoredWatchlists,
  verifyServiceHeaders,
  watchlistsAnswer,
} from './index.js';
import { SERVICE_NAMES } from './service-keys.js';

const SECRET = 'identity-watchlists-secret-long-enough';
const input = { userId: 'user-ada' };
const list = { id: 'majors', name: 'TEST majors', symbols: ['BTC/USDT', 'ETH/USDT'] };
const UNAVAILABLE = { state: 'unavailable', code: 'identity.watchlists_unavailable' };

const reply = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify({ result: { data } }), { status, headers: { 'content-type': 'application/json' } });

describe('identity watchlists contract', () => {
  it('names one procedure and one caller, and the caller is a real service', () => {
    expect(IDENTITY_WATCHLISTS_PROCEDURE).toBe('preferences.watchlistsFor');
    expect(IDENTITY_WATCHLISTS_CALLERS).toEqual(['svc-notify']);
    for (const caller of IDENTITY_WATCHLISTS_CALLERS) expect(SERVICE_NAMES).toContain(caller);
  });

  it('refuses a field it does not name and a blank user', () => {
    expect(identityWatchlistsInputSchema.safeParse({ ...input, extra: 1 }).success).toBe(false);
    expect(identityWatchlistsInputSchema.safeParse({ userId: '' }).success).toBe(false);
    expect(identityWatchlistsInputSchema.safeParse(input).success).toBe(true);
  });

  it('answers every section of each list, in order, and no lists for no record', () => {
    const stored = parseStoredWatchlists([
      {
        id: 'majors',
        name: 'TEST majors',
        flag: null,
        sections: [
          { id: 'a', title: 'One', collapsed: false, symbols: ['BTC/USDT'] },
          { id: 'b', title: 'Two', collapsed: true, symbols: ['ETH/USDT'] },
        ],
      },
    ]);
    expect(watchlistsAnswer(stored)).toEqual({ lists: [list] });
    expect(watchlistsAnswer(parseStoredWatchlists(null))).toEqual({ lists: [] });
  });

  it('refuses a stored record that is not the shape, rather than guessing', () => {
    expect(() => parseStoredWatchlists([{ id: 'x' }])).toThrow('identity.watchlists_record_invalid');
  });

  it('parses an answer and refuses a list with a field it does not name', () => {
    expect(identityWatchlistsSchema.parse({ lists: [list] })).toEqual({ lists: [list] });
    expect(identityWatchlistsSchema.safeParse({ lists: [{ ...list, balance: '1' }] }).success).toBe(false);
  });
});

describe('identity watchlists client', () => {
  it('signs the body as svc-notify and returns the parsed lists', async () => {
    const fetcher = vi.fn(async () => reply({ lists: [list] }));
    const client = createIdentityWatchlistsClient({ identityUrl: 'http://identity.internal:4002/', secret: SECRET, fetcher });
    await expect(client.read(input)).resolves.toEqual({ state: 'read', lists: [list] });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://identity.internal:4002/trpc/preferences.watchlistsFor');
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify(input));
    const headers = init.headers as Record<string, string>;
    expect(
      verifyServiceHeaders(headers, SECRET, { rawBody: { retained: true, bytes: Buffer.from(String(init.body)) }, mode: 'require' })
        .service,
    ).toBe('svc-notify');
  });

  it('answers unavailable, never an empty list, for every failure', async () => {
    const ok = () => vi.fn(async () => reply({ lists: [list] }));
    const cases: Array<Parameters<typeof createIdentityWatchlistsClient>[0]> = [
      { identityUrl: undefined, secret: SECRET, fetcher: ok() },
      { identityUrl: 'not a url', secret: SECRET, fetcher: ok() },
      { identityUrl: 'http://user:pw@identity.internal', secret: SECRET, fetcher: ok() },
      { identityUrl: 'http://identity.internal', secret: 'short', fetcher: ok() },
      { identityUrl: 'http://identity.internal', secret: SECRET, fetcher: vi.fn(async () => reply({ lists: [list] }, 503)) },
      { identityUrl: 'http://identity.internal', secret: SECRET, fetcher: vi.fn(async () => reply({ nope: true })) },
      {
        identityUrl: 'http://identity.internal',
        secret: SECRET,
        fetcher: vi.fn(async () => {
          throw new Error('down');
        }),
      },
    ];
    for (const options of cases) await expect(createIdentityWatchlistsClient(options).read(input)).resolves.toEqual(UNAVAILABLE);
    await expect(
      createIdentityWatchlistsClient({ identityUrl: 'http://identity.internal', secret: SECRET, fetcher: ok() }).read({ userId: '' }),
    ).resolves.toEqual(UNAVAILABLE);
  });
});
