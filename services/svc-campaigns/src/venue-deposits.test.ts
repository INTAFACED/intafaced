import { afterEach, describe, expect, it, vi } from 'vitest';
import { createVenueDepositSource } from './venue-deposits.js';

const connection = (address: string, status: 'live' | 'expired' | 'blocked') => ({
  address,
  chainId: 84532,
  connectedAt: '2026-11-01T00:00:00.000Z',
  expiresAt: '2026-12-01T00:00:00.000Z',
  status,
  holdsKey: false,
});
const source = () =>
  createVenueDepositSource({ protocolUrl: 'http://protocol:4000/', tradeUrl: 'http://trade:4000', internalSecret: 'TEST-secret' });

afterEach(() => vi.unstubAllGlobals());

describe("the person's connected wallets, read from svc-protocol's venueWallet.status record", () => {
  it('asks with the forwarded headers and keeps every wallet but a blocked one, once each, lower-cased', async () => {
    const fn = vi.fn(async (_url: string, _init?: RequestInit) =>
      Response.json({
        result: {
          data: {
            connections: [
              connection('0x00000000000000000000000000000000000A11CE', 'live'),
              connection('0x00000000000000000000000000000000000a11ce', 'expired'),
              connection('0x0000000000000000000000000000000000000b0b', 'blocked'),
            ],
          },
        },
      }),
    );
    vi.stubGlobal('fetch', fn);
    expect(await source().wallets({ 'x-intafaced-principal': 'p' })).toEqual(['0x00000000000000000000000000000000000a11ce']);
    const [url, init = {}] = fn.mock.calls[0] ?? [];
    expect(url).toBe('http://protocol:4000/trpc/venueWallet.status');
    expect(init.method).toBe('GET');
    expect(new Headers(init.headers).get('x-intafaced-principal')).toBe('p');
  });

  it('reads an answer that is not the published shape as unknown, and asks nothing without a person', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ result: { data: { connections: [{ address: 'x' }] } } })),
    );
    expect(await source().wallets({ 'x-intafaced-principal': 'p' })).toBeNull();
    const none = vi.fn();
    vi.stubGlobal('fetch', none);
    expect(await source().wallets({})).toBeNull();
    expect(none).not.toHaveBeenCalled();
  });
});
