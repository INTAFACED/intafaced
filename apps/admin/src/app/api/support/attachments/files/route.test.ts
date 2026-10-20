import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET } from './route';

const gate = vi.hoisted(() => ({ session: vi.fn<() => Promise<unknown>>() }));
vi.mock('@/lib/admin-bff-gate', () => ({ adminBffSession: gate.session }));

const T = '22222222-2222-4222-8222-222222222222';
const ctx = {
  session: {
    userId: '11111111-1111-4111-8111-111111111111',
    accessToken: 'a',
    refreshToken: 'r',
    expiresAt: '2030-01-01T00:00:00.000Z',
    issuedAt: '2026-01-01T00:00:00.000Z',
    csrf: 'c'.repeat(43),
  },
  config: { origin: 'https://admin.example', edgeUrl: 'http://edge:4000', key: Buffer.alloc(32, 1) },
};
const ok = (data: unknown) => Response.json({ result: { data } });
const file = (over: Record<string, unknown> = {}) => ({
  id: '44444444-4444-4444-8444-444444444444',
  ticketId: T,
  ownerId: '11111111-1111-4111-8111-111111111111',
  contentType: 'image/png',
  byteLength: 3,
  scanState: 'clean',
  createdAt: '2026-10-20T10:00:00.000Z',
  ...over,
});
const get = (id: string | null = T) => GET(new Request(`http://admin.example/api/support/attachments/files${id ? `?id=${id}` : ''}`));

beforeEach(() => gate.session.mockResolvedValue(ctx));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  gate.session.mockReset();
});

describe('GET ticket files', () => {
  it('asks for a page size and returns the files with an as-of time', async () => {
    const fn = vi.fn(async (_url: string, _init?: RequestInit) => ok([file()]));
    vi.stubGlobal('fetch', fn);
    const json = await (await get()).json();
    expect(json.files).toMatchObject({ kind: 'ok', data: [{ scanState: 'clean' }] });
    expect(Number.isFinite(Date.parse(json.asOf))).toBe(true);
    const url = decodeURIComponent(fn.mock.calls[0]![0]);
    expect(url).toContain('/api/support/trpc/ticketAttachments');
    expect(url).toContain('"limit":100');
  });
  it('a row on another ticket or with a store key makes the read a failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ok([file({ ticketId: '33333333-3333-4333-8333-333333333333' })])),
    );
    expect((await (await get()).json()).files).toMatchObject({ kind: 'failed' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ok([file({ storeKey: 'k' })])),
    );
    expect((await (await get()).json()).files).toMatchObject({ kind: 'failed' });
  });
  it('refuses a bad id before the network and a refused session before anything', async () => {
    const fn = vi.fn();
    vi.stubGlobal('fetch', fn);
    expect((await get('nope')).status).toBe(400);
    expect((await get(null)).status).toBe(400);
    gate.session.mockResolvedValueOnce(Response.json({ code: 'admin.session_required' }, { status: 401 }));
    expect((await get()).status).toBe(401);
    expect(fn).not.toHaveBeenCalled();
  });
});
