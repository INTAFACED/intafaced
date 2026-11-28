/**
 * Unit card — matching-client depth limit unset refuse (no invented 1)
 *
 * 1. Promise: omitted depth limit does not hit matching as ?limit=1.
 *    Owner/ticker may pass 1 explicitly (BBO).
 * 2. Break: `depth(..., limit = 1)` dressed BBO as a chosen window.
 * 3. Done bar: no `limit = 1`; unset/null throw; explicit 1 fetches ?limit=1.
 * 4. Class N
 * 5. Paths: matching-client.ts publishedMatchingDepthLimit + createMatchingClient.depth
 * 6. RED: omitting limit fetches matching with limit=1
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMatchingClient, MatchingNoBookError, publishedMatchingDepthLimit } from './matching-client.js';

const SECRET = 'matching-client-test-secret-at-least-32-chars';
const MARKET = '00000000-0000-4000-8000-000000000001';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('MatchingClient depth limit refuse-closed', () => {
  it('unset / null refuse — never invent 1', () => {
    expect(() => publishedMatchingDepthLimit(undefined)).toThrow(/refuse to invent 1/);
    expect(() => publishedMatchingDepthLimit(null)).toThrow(/refuse to invent 1/);
  });

  it('owner-explicit 1 is a published BBO window', () => {
    expect(publishedMatchingDepthLimit(1)).toBe(1);
  });

  it('omitted limit does not fetch matching', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const client = createMatchingClient('http://matching:4005', SECRET);
    await expect(client.depth(MARKET, undefined as unknown as number)).rejects.toThrow(/refuse to invent 1/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('explicit 1 hits matching as ?limit=1', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: Parameters<typeof fetch>[0]) => {
        calls.push(String(input));
        return new Response('not found', { status: 404 });
      }),
    );
    const client = createMatchingClient('http://matching:4005', SECRET);
    await expect(client.depth(MARKET, 1)).rejects.toBeInstanceOf(MatchingNoBookError);
    expect(calls[0]).toContain('limit=1');
  });
});
