import { describe, expect, it, vi } from 'vitest';
import { createApiClient } from '../../shared/api';
import { apiKeyRecordsFor, readApiKeyRecords } from './api-key-records-api';

const record = {
  id: 'key:not-a-uuid/1',
  name: 'Notebook <reader>',
  prefix: 'if_live_abc',
  scopes: ['identity:read', 'trade:write'],
  lastUsedAt: '2026-10-10T08:00:00.000Z',
  revoked: false,
  mode: 'live',
  requireSignature: false,
  requireNonEmptyIpAllowlist: false,
  ipAllowlist: [],
};
describe('owner API-key metadata wire boundary', () => {
  it('preserves arbitrary published strings and recorded metadata without authority or invented fields', () => {
    expect(
      apiKeyRecordsFor(50).parse([record, { ...record, id: 'sandbox/record', mode: 'sandbox', revoked: true, lastUsedAt: null }]),
    ).toEqual([record, { ...record, id: 'sandbox/record', mode: 'sandbox', revoked: true, lastUsedAt: null }]);
    expect(apiKeyRecordsFor(50).parse([])).toEqual([]);
  });
  it.each(['2026-02-31T08:00:00.000Z', '2026-10-10T08:00:00+24:00', 'not a date', '2026-10-10', '2026-10-10T08:00:00+00:00'])(
    'refuses malformed or noncanonical last-use %s',
    (lastUsedAt) => {
      expect(apiKeyRecordsFor(50).safeParse([record, { ...record, id: 'other', lastUsedAt }]).success).toBe(false);
    },
  );
  it('refuses whole malformed, duplicate or oversized lists, without partial rows', () => {
    for (const rows of [
      [record, record],
      [record, { ...record, id: 'other', revoked: 'false' }],
      [record, { ...record, id: 'other', secret: 'not metadata' }],
      [record, { ...record, id: 'other', signingSecret: 'ifs_secret' }],
      Array.from({ length: 51 }, (_, i) => ({ ...record, id: String(i) })),
    ])
      expect(apiKeyRecordsFor(50).safeParse(rows).success).toBe(false);
  });
  it.each([0, 201, 50.5, NaN, Infinity])('refuses an invalid window %s', (limit) => {
    expect(() => apiKeyRecordsFor(limit)).toThrow(RangeError);
  });
  it('uses the actual GET envelope and explicit limit with no owner/company argument or POST', async () => {
    const fetch = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ result: { data: [record] } }), { status: 200 }),
    );
    const api = createApiClient({ fetch });
    expect(await readApiKeyRecords(api, 100, new AbortController().signal)).toEqual({ ok: true, data: [record] });
    expect(fetch.mock.calls[0]?.[0]).toBe('/api/identity/trpc/apiKeys.list?input=%7B%22limit%22%3A100%7D');
    expect(fetch.mock.calls[0]?.[1]?.method).toBe('GET');
  });
  it('an invalid whole response is a read failure', async () => {
    const api = createApiClient({
      fetch: async () => new Response(JSON.stringify({ result: { data: [record, record] } }), { status: 200 }),
    });
    expect(await readApiKeyRecords(api, 50, new AbortController().signal)).toMatchObject({ ok: false, reason: 'invalid_response' });
  });
});
