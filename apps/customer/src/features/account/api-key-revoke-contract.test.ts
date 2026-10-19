import { describe, expect, it, vi } from 'vitest';
import { createApiClient } from '../../shared/api';
import {
  apiKeyRevokeStorageKey,
  canReviewApiKeyRevoke,
  createApiKeyRevokeJournal,
  decodeApiKeyRevokeOriginal,
  directApiKeyRevokeProof,
  revokeApiKey,
} from './api-key-revoke-contract';

const owner = '11111111-1111-4111-8111-111111111111';
const otherOwner = '22222222-2222-4222-8222-222222222222';
const keyId = '33333333-3333-4333-8333-333333333333';
const original = {
  kind: 'api-key-revoke',
  owner,
  keyId,
  originalId: '44444444-4444-4444-8444-444444444444',
  createdAt: '2026-10-10T08:00:00.000Z',
};
const record = {
  id: keyId,
  name: 'Private name',
  prefix: 'private_prefix',
  scopes: ['identity:read'],
  lastUsedAt: null,
  revoked: false,
  mode: 'live' as const,
  requireSignature: false,
  requireNonEmptyIpAllowlist: false,
  ipAllowlist: [] as string[],
};

describe('API-key revoke target and original boundaries', () => {
  it('allows an exact unrevoked UUID, without coercing arbitrary list IDs or recorded revocation', () => {
    expect(canReviewApiKeyRevoke(record)).toBe(true);
    for (const id of ['owner-key/not-a-uuid/01', ` ${keyId}`, `${keyId} `, ''])
      expect(canReviewApiKeyRevoke({ ...record, id })).toBe(false);
    expect(canReviewApiKeyRevoke({ ...record, revoked: true })).toBe(false);
  });
  it('decodes minimal same-owner references without accepting private terms or calendar rollovers', () => {
    const raw = `  ${JSON.stringify(original)}\n`;
    expect(decodeApiKeyRevokeOriginal(raw, owner)).toEqual(original);
    expect(Object.isFrozen(decodeApiKeyRevokeOriginal(raw, owner))).toBe(true);
    for (const value of [
      { ...original, owner: otherOwner },
      { ...original, name: 'Private name' },
      { ...original, secret: 'secret' },
      { ...original, createdAt: '2026-02-31T08:00:00.000Z' },
      { ...original, createdAt: '2026-10-10' },
      { ...original, keyId: ` ${keyId}` },
      [original],
    ])
      expect(() => decodeApiKeyRevokeOriginal(JSON.stringify(value), owner)).toThrow();
  });
  it('keeps unreadable and foreign originals refused under the feature-owned journal', () => {
    const unreadable = createApiKeyRevokeJournal(owner, {
      durable: () => ({
        getItem() {
          throw new Error('Read unavailable');
        },
        setItem: vi.fn(),
        removeItem: vi.fn(),
      }),
      locks: () => undefined,
    });
    expect(unreadable.read()).toEqual({ status: 'unreadable', reason: 'read' });
    const raw = JSON.stringify({ ...original, owner: otherOwner });
    const removeItem = vi.fn(),
      setItem = vi.fn();
    const foreign = createApiKeyRevokeJournal(owner, {
      durable: () => ({ getItem: () => raw, removeItem, setItem }),
      locks: () => undefined,
    });
    expect(foreign.read()).toEqual({ status: 'unreadable', reason: 'parse' });
    expect(removeItem).not.toHaveBeenCalled();
    expect(setItem).not.toHaveBeenCalled();
    expect(apiKeyRevokeStorageKey(owner)).toBe(`intafaced.customer.api-key-revoke.v1:${owner}`);
  });
});

describe('mounted direct API-key revoke response proof', () => {
  it.each([true, false])('sends only the exact keyId and distinguishes current revoked=%s', async (revoked) => {
    const fetch = vi.fn(
      async (_url: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ result: { data: { revoked } } }), { status: 200 }),
    );
    const result = await revokeApiKey(createApiClient({ fetch }), keyId, new AbortController().signal);
    expect(directApiKeyRevokeProof(result)).toBe(revoked ? 'marked-revoked' : 'no-matching-change');
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, options] = fetch.mock.calls[0]!;
    expect(url).toBe('/api/identity/trpc/apiKeys.revoke');
    expect(options?.method).toBe('POST');
    expect(JSON.parse(String(options?.body))).toEqual({ keyId });
    expect(options?.headers).not.toHaveProperty('Idempotency-Key');
  });
  it('rejects an invalid target before transport and keeps malformed success uncertain', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ result: { data: { revoked: 'true' } } }), { status: 200 }));
    const api = createApiClient({ fetch });
    await expect(revokeApiKey(api, ` ${keyId}`, new AbortController().signal)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
    const result = await revokeApiKey(api, keyId, new AbortController().signal);
    expect(result).toMatchObject({ ok: false, reason: 'uncertain' });
    expect(directApiKeyRevokeProof(result)).toBeNull();
  });
  it.each([
    [403, 'scope.denied', 'denied-before-effect'],
    [401, 'scope.denied', null],
    [403, 'FORBIDDEN', null],
    [404, 'scope.denied', null],
    [500, 'scope.denied', null],
    [403, 'identity.something_else', null],
  ] as const)('binds pre-effect proof to the actual typed status/code %s/%s', async (status, intafacedCode, proof) => {
    const api = createApiClient({
      fetch: async () => new Response(JSON.stringify({ error: { message: 'Service refusal', data: { intafacedCode } } }), { status }),
    });
    const result = await revokeApiKey(api, keyId, new AbortController().signal);
    expect(directApiKeyRevokeProof(result)).toBe(proof);
  });
});
