import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET } from './route';

const gate = vi.hoisted(() => ({ session: vi.fn<() => Promise<unknown>>() }));
vi.mock('@/lib/admin-bff-gate', () => ({ adminBffSession: gate.session }));

const FILE = '44444444-4444-4444-8444-444444444444';
const FOUNDER = '11111111-1111-4111-8111-111111111111';
const ctx = {
  session: {
    userId: FOUNDER,
    accessToken: 'a',
    refreshToken: 'r',
    expiresAt: '2030-01-01T00:00:00.000Z',
    issuedAt: '2026-01-01T00:00:00.000Z',
    csrf: 'c'.repeat(43),
  },
  config: { origin: 'https://admin.example', edgeUrl: 'http://edge:4000', key: Buffer.alloc(32, 1) },
};
const ok = (data: unknown) => Response.json({ result: { data } });
const trpcErr = (status: number, message: string, code = 'X') =>
  Response.json({ error: { message, code: -32603, data: { code, httpStatus: status } } }, { status });
const body = (over: Record<string, unknown> = {}) => ({
  id: FILE,
  contentType: 'application/octet-stream',
  disposition: 'attachment',
  byteLength: 3,
  bodyBase64: 'aGkh',
  ...over,
});
const get = (id: string | null = FILE) => GET(new Request(`http://admin.example/api/support/attachments/download${id ? `?id=${id}` : ''}`));

beforeEach(() => {
  gate.session.mockResolvedValue(ctx);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  gate.session.mockReset();
});

describe('GET download', () => {
  it('serves the bytes as a download, never inline, with a fixed type', async () => {
    const fn = vi.fn(async (_url: string, _init?: RequestInit) => ok(body()));
    vi.stubGlobal('fetch', fn);
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    expect(res.headers.get('content-disposition')).toMatch(/^attachment;/);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe('hi!');
    expect(fn.mock.calls[0]![0]).toContain('/api/support/trpc/attachmentDownloadOps');
  });
  it('refuses an answer for another file, a wrong type and a size that does not match', async () => {
    for (const bad of [body({ id: '55555555-5555-4555-8555-555555555555' }), body({ contentType: 'text/html' }), body({ byteLength: 9 })]) {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => ok(bad)),
      );
      const res = await get();
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.headers.get('content-type')).not.toBe('application/octet-stream');
    }
  });
  it('says a held or blocked file is not served, and a file not on their ticket is not found', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => trpcErr(412, 'support.attachment_scan_unknown', 'PRECONDITION_FAILED')),
    );
    expect(await (await get()).json()).toMatchObject({ ok: false, refusal: { code: 'support.attachment_scan_unknown' } });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => trpcErr(404, 'support.not_found', 'NOT_FOUND')),
    );
    const res = await get();
    expect(res.status).toBe(404);
    expect((await res.json()).refusal.title).toBe('No such file for you');
  });
  it('refuses a bad id before the network and logs who, never the bytes', async () => {
    const fn = vi.fn();
    vi.stubGlobal('fetch', fn);
    expect((await get('nope')).status).toBe(400);
    expect(fn).not.toHaveBeenCalled();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ok(body())),
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await get();
    const line = String(warn.mock.calls[0]![0]);
    expect(line).toContain(FOUNDER);
    expect(line).toContain(FILE);
    expect(line).not.toContain('aGkh');
  });
});
