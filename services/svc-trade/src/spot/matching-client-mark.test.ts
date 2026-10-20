import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMatchingClient, MatchingUnavailableError } from './matching-client.js';

const SECRET = 'matching-client-mark-test-secret-32-chars-x';

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(status: number, body: unknown) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
    }),
  );
  return calls;
}

describe('MatchingClient.markTrailingStops', () => {
  it('posts the mark as a decimal string to the market mark door, signed', async () => {
    const calls = stubFetch(200, { accepted: true, applied: true, rejected: null });
    const client = createMatchingClient('http://matching.test/', SECRET);
    const result = await client.markTrailingStops('BTC/USDT', '101.5');
    expect(result).toEqual({ accepted: true, applied: true, rejected: null });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('http://matching.test/markets/BTC%2FUSDT/mark');
    expect(calls[0]!.init.method).toBe('POST');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ mark: '101.5' });
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['content-type']).toBe('application/json');
    expect(Object.keys(headers)).toContain('x-intafaced-service');
  });

  it('a refused mark comes back as accepted:false, not an error', async () => {
    stubFetch(200, { accepted: false, applied: false, rejected: { code: 'market_halted', message: 'halted' } });
    const client = createMatchingClient('http://matching.test', SECRET);
    expect((await client.markTrailingStops('m-1', '100')).accepted).toBe(false);
  });

  it('a 5xx from the engine is MatchingUnavailableError', async () => {
    stubFetch(503, 'down');
    const client = createMatchingClient('http://matching.test', SECRET);
    await expect(client.markTrailingStops('m-1', '100')).rejects.toBeInstanceOf(MatchingUnavailableError);
  });
});
