import { afterEach, describe, expect, it, vi } from 'vitest';
import { identityKeysExecute, loadKeys } from './keys-server';

const ctx = {
  session: {
    userId: '11111111-1111-4111-8111-111111111111',
    accessToken: 'founder-access-token',
    refreshToken: 'r',
    expiresAt: '2030-01-01T00:00:00.000Z',
    issuedAt: '2026-01-01T00:00:00.000Z',
    csrf: 'c'.repeat(43),
  },
  config: { origin: 'https://admin.example', edgeUrl: 'http://edge:4000', key: Buffer.alloc(32, 1) },
};
const ids = { approvalId: 'appr_1', operationId: 'op_1' };
const state = (active: string, previous: string[]) => ({
  activeKeyId: active,
  previousKeyIds: previous,
  activatedAt: null,
  nextRemoval: previous.length ? previous : null,
  availableKeyIds: ['legacy', 'k2'],
});
const ok = (data: unknown) => Response.json({ result: { data } });
const err = (status: number, message: string) =>
  Response.json({ error: { message, code: -32603, data: { code: 'BAD_REQUEST', httpStatus: status } } }, { status });

afterEach(() => vi.unstubAllGlobals());

describe('identity keys desk', () => {
  it('reads the state as the founder and stamps the read time', async () => {
    const fn = vi.fn(async (_u: string, _i?: RequestInit) => ok(state('legacy', [])));
    vi.stubGlobal('fetch', fn);
    const view = await loadKeys(ctx);
    expect(fn.mock.calls[0]![0]).toBe('http://edge:4000/api/identity/trpc/authKeys.state');
    expect((fn.mock.calls[0]![1]!.headers as Record<string, string>).authorization).toBe('Bearer founder-access-token');
    expect(view.state).toEqual({ kind: 'ok', data: expect.objectContaining({ activeKeyId: 'legacy' }) });
    expect(Number.isFinite(Date.parse(view.asOf))).toBe(true);
  });

  it('a malformed answer is a failed read, not an empty state', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ok({ activeKeyId: 5 })),
    );
    expect((await loadKeys(ctx)).state.kind).toBe('failed');
  });

  it('rotate sends the key id and both approval ids, and reports done only when the returned signer is the new key', async () => {
    const fn = vi.fn(async (_u: string, _i?: RequestInit) => ok(state('k2', ['legacy'])));
    vi.stubGlobal('fetch', fn);
    const result = await identityKeysExecute(ctx)({ kind: 'identity.auth_key.rotate', keyId: 'k2' }, ids);
    expect(result.ok).toBe(true);
    expect(fn.mock.calls[0]![0]).toBe('http://edge:4000/api/identity/trpc/authKeys.rotate');
    expect(JSON.parse(String(fn.mock.calls[0]![1]!.body))).toEqual({ keyId: 'k2', ...ids });
  });

  it('a 200 that does not show the change is outcome unknown, never a success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ok(state('legacy', []))),
    );
    const rotate = await identityKeysExecute(ctx)({ kind: 'identity.auth_key.rotate', keyId: 'k2' }, ids);
    expect(rotate).toMatchObject({ ok: false, refusal: { changed: 'unknown' } });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ok(state('k2', ['legacy']))),
    );
    const remove = await identityKeysExecute(ctx)({ kind: 'identity.auth_key.remove_old', keyIds: 'legacy' }, ids);
    expect(remove).toMatchObject({ ok: false, refusal: { changed: 'unknown' } });
  });

  it('remove-old sends only the approval ids', async () => {
    const fn = vi.fn(async (_u: string, _i?: RequestInit) => ok(state('k2', [])));
    vi.stubGlobal('fetch', fn);
    const result = await identityKeysExecute(ctx)({ kind: 'identity.auth_key.remove_old', keyIds: 'legacy' }, ids);
    expect(result.ok).toBe(true);
    expect(fn.mock.calls[0]![0]).toBe('http://edge:4000/api/identity/trpc/authKeys.removeOld');
    expect(JSON.parse(String(fn.mock.calls[0]![1]!.body))).toEqual(ids);
  });

  it('explains identity’s typed refusals in words and says nothing changed', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => err(400, 'auth_key.material_missing')),
    );
    const result = await identityKeysExecute(ctx)({ kind: 'identity.auth_key.rotate', keyId: 'k9' }, ids);
    expect(result).toMatchObject({ ok: false, refusal: { code: 'auth_key.material_missing', changed: 'no' } });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => err(412, 'auth_key.approval_required')),
    );
    expect(await identityKeysExecute(ctx)({ kind: 'identity.auth_key.remove_old', keyIds: 'legacy' }, ids)).toMatchObject({
      ok: false,
      refusal: { code: 'auth_key.approval_required', changed: 'no' },
    });
  });

  it('a dropped connection on a write is outcome unknown', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new Error('socket'))),
    );
    expect(await identityKeysExecute(ctx)({ kind: 'identity.auth_key.rotate', keyId: 'k2' }, ids)).toMatchObject({
      ok: false,
      refusal: { changed: 'unknown' },
    });
  });

  it('refuses a request kind that is not a key change', async () => {
    expect(await identityKeysExecute(ctx)({ kind: 'ledger.unfreeze', version: 'v' }, ids)).toMatchObject({ ok: false });
  });
});
