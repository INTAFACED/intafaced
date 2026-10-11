import { describe, expect, it } from 'vitest';
import { VenueUnavailableError } from '@intafaced/venue-contracts';
import { type HttpPort, type HttpResponse } from '../transport.js';
import { BybitSpotAccount } from './bybit-spot-account.js';

class FakeHttp implements HttpPort {
  readonly requests: string[] = [];
  readonly posts: { url: string; jsonBody?: unknown; headers?: Readonly<Record<string, string>> }[] = [];
  #responses: HttpResponse[] = [];

  queue(body: unknown, status = 200, headers: Record<string, string> = {}): this {
    this.#responses.push({
      status,
      body,
      header: (name) => headers[name] ?? headers[name.toLowerCase()] ?? null,
    });
    return this;
  }

  async get(url: string): Promise<HttpResponse> {
    this.requests.push(url);
    return this.#next(url);
  }

  async post(url: string, init?: { jsonBody?: unknown; headers?: Readonly<Record<string, string>> }): Promise<HttpResponse> {
    this.requests.push(`POST ${url}`);
    this.posts.push({ url, jsonBody: init?.jsonBody, headers: init?.headers });
    return this.#next(url);
  }

  async #next(url: string): Promise<HttpResponse> {
    const next = this.#responses.shift();
    if (!next) throw new Error(`FakeHttp had no queued response for ${url}`);
    return next;
  }
}

const keys = { venueId: 'bybit-spot', apiKey: 'k', apiSecret: 's', scopes: ['read', 'trade'] as const };

describe('BybitSpotAccount wallet-balance list', () => {
  it('refuses a retCode 0 wallet read whose result list is missing or not an array', async () => {
    const bodies = [
      { retCode: 0, retMsg: 'OK' },
      { retCode: 0, retMsg: 'OK', result: { list: null } },
      { retCode: 0, retMsg: 'OK', result: { list: { accountType: 'UNIFIED' } } },
    ];
    for (const body of bodies) {
      const http = new FakeHttp().queue(body);
      const account = new BybitSpotAccount(keys, { http, clock: () => 1_700_000_000_000 });
      let resolved: unknown;
      try {
        resolved = await account.balances();
      } catch (error) {
        expect(error).toBeInstanceOf(VenueUnavailableError);
        expect((error as VenueUnavailableError).reason).toBe('malformed');
        expect((error as VenueUnavailableError).message).toContain('wallet-balance list is missing');
        expect(resolved).not.toEqual([]);
        continue;
      }
      expect.unreachable(`malformed wallet read resolved to ${JSON.stringify(resolved)}`);
    }
  });

  it('an empty wallet-balance list is an honest empty account', async () => {
    const http = new FakeHttp().queue({
      retCode: 0,
      retMsg: 'OK',
      result: { list: [] },
    });
    const account = new BybitSpotAccount(keys, { http, clock: () => 1_700_000_000_000 });
    await expect(account.balances()).resolves.toEqual([]);
  });
});
