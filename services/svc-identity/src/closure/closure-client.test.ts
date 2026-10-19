import { describe, expect, it } from 'vitest';
import { httpClosureChecker, parseClosureCheckResponse } from './closure-client.js';

describe('closure check client', () => {
  it('reads a well-formed body and refuses a non-2xx or a malformed body', () => {
    expect(parseClosureCheckResponse(200, JSON.stringify({ asOf: '2026-10-18T00:00:00.000Z', blockers: [], balances: [] }))).toEqual({
      ok: true,
      blockers: [],
      balances: [],
    });
    expect(parseClosureCheckResponse(503, '{"blockers":[]}')).toEqual({ ok: false });
    expect(parseClosureCheckResponse(200, '{"asOf":"t","blockers":[]')).toEqual({ ok: false });
    expect(parseClosureCheckResponse(200, JSON.stringify({ asOf: 't', blockers: [{ code: 'open_order', count: 0 }] }))).toEqual({
      ok: false,
    });
  });

  it('retries once and then reports unavailable', async () => {
    let calls = 0;
    const checker = httpClosureChecker({
      url: 'http://bank.invalid',
      secret: 'secret-that-is-long-enough-for-hmac-signing',
      fetchImpl: async () => {
        calls += 1;
        return { status: 503, text: async () => '' };
      },
    });
    await expect(checker.check({ userId: '11111111-1111-4111-8111-111111111111', subAccountIds: [] })).resolves.toEqual({ ok: false });
    expect(calls).toBe(2);
  });

  it('is unavailable when the url is blank', async () => {
    const checker = httpClosureChecker({
      url: '  ',
      secret: 'secret-that-is-long-enough-for-hmac-signing',
      fetchImpl: async () => {
        throw new Error('should not be called');
      },
    });
    await expect(checker.check({ userId: '11111111-1111-4111-8111-111111111111', subAccountIds: [] })).resolves.toEqual({ ok: false });
  });
});
