import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UPLOAD_TRANSPORT_BYTES } from '@/lib/support/files';
import { POST } from './route';

const gate = vi.hoisted(() => ({ session: vi.fn<() => Promise<unknown>>() }));
vi.mock('@/lib/admin-bff-gate', () => ({ adminBffSession: gate.session }));

const TICKET = '22222222-2222-4222-8222-222222222222';
const FILE = '44444444-4444-4444-8444-444444444444';
const OWNER = '33333333-3333-4333-8333-333333333333';
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
const row = (over: Record<string, unknown> = {}) => ({
  id: FILE,
  ticketId: TICKET,
  ownerId: OWNER,
  contentType: 'text/plain',
  byteLength: 3,
  scanState: 'clean',
  uploadedBy: FOUNDER,
  createdAt: '2026-10-20T10:00:00.000Z',
  ...over,
});
const post = (opts: { id?: string | null; key?: string | null; type?: string | null; body?: BodyInit | null } = {}) => {
  const q = new URLSearchParams();
  if (opts.id !== null) q.set('id', opts.id ?? TICKET);
  if (opts.key !== null) q.set('key', opts.key ?? 'admin-attach:t:abc');
  const headers: Record<string, string> = {};
  if (opts.type !== null) headers['content-type'] = opts.type ?? 'text/plain';
  return POST(
    new Request(`http://admin.example/api/support/attachments/upload?${q}`, {
      method: 'POST',
      headers,
      // A string body gets a text type from the platform, so the no-type case sends raw bytes.
      body: opts.body === undefined ? new TextEncoder().encode('hi!') : opts.body,
    }),
  );
};

beforeEach(() => {
  gate.session.mockResolvedValue(ctx);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  gate.session.mockReset();
});

describe('POST upload', () => {
  it('sends the bytes as base64 to attachOps with the operator’s retry key, and returns the file svc-support recorded', async () => {
    const fn = vi.fn(async (_url: string, _init?: RequestInit) => ok(row()));
    vi.stubGlobal('fetch', fn);
    const res = await post();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, file: row() });
    expect(fn.mock.calls[0]![0]).toContain('/api/support/trpc/attachOps');
    expect(JSON.parse(String(fn.mock.calls[0]![1]!.body))).toEqual({
      ticketId: TICKET,
      clientRequestId: 'admin-attach:t:abc',
      contentType: 'text/plain',
      bodyBase64: Buffer.from('hi!').toString('base64'),
    });
  });
  it('writes an audit line with who, which ticket and which file, never the bytes', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ok(row())),
    );
    await post();
    const line = String(vi.mocked(console.warn).mock.calls[0]![0]);
    expect(JSON.parse(line)).toMatchObject({
      audit: 'admin.support_file_upload',
      founder: FOUNDER,
      ticket: TICKET,
      file: FILE,
      outcome: 'ok',
    });
    expect(line).not.toContain(Buffer.from('hi!').toString('base64'));
  });
  it('refuses a request that names no ticket, no key or no media type, and sends nothing', async () => {
    const fn = vi.fn();
    vi.stubGlobal('fetch', fn);
    for (const bad of [{ id: null }, { key: null }, { type: null }, { type: 'image/*' }, { id: 'nope' }]) {
      const res = await post(bad);
      expect(res.status).toBe(400);
      expect((await res.json()).ok).toBe(false);
    }
    expect(fn).not.toHaveBeenCalled();
  });
  it('refuses an empty body and one over the transport guard, and sends nothing', async () => {
    const fn = vi.fn();
    vi.stubGlobal('fetch', fn);
    expect((await post({ body: '' })).status).toBe(400);
    expect((await post({ body: null })).status).toBe(400);
    const big = await post({ body: new Uint8Array(UPLOAD_TRANSPORT_BYTES + 1) });
    expect(big.status).toBe(413);
    expect((await big.json()).refusal.code).toBe('admin.body_too_large');
    expect(fn).not.toHaveBeenCalled();
  });
  it('refuses an answer that is not the new file on this ticket under the operator’s name', async () => {
    for (const bad of [
      row({ ticketId: '55555555-5555-4555-8555-555555555555' }),
      row({ uploadedBy: null }),
      row({ storeKey: 'k' }),
      'ok',
    ]) {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => ok(bad)),
      );
      const res = await post();
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect((await res.json()).ok).toBe(false);
    }
  });
  it.each([
    ['support.attachments_unconfigured', 412, 'The desk cannot take files yet'],
    ['support.attachment_too_large', 413, 'That file is too large'],
    ['support.attachment_type_refused', 415, 'That type of file is not allowed'],
    ['support.attachment_count_reached', 409, 'already holds its limit'],
    ['support.attachment_scan_refused', 422, 'The scan refused this file'],
    ['support.attachment_scan_unknown', 412, 'The scan has not finished'],
  ])('says %s in words and never shows the code as the message', async (code, status, title) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => trpcErr(status, code)),
    );
    const res = await post();
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.refusal.title).toContain(title);
    expect(body.refusal.code).toBe(code);
  });
  it('says a ticket that is not theirs is not found, and a held file may have been recorded', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => trpcErr(404, 'support.not_found', 'NOT_FOUND')),
    );
    const res = await post();
    expect(res.status).toBe(404);
    expect((await res.json()).refusal.title).toContain('not yours to add to');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => trpcErr(412, 'support.attachment_scan_unknown', 'PRECONDITION_FAILED')),
    );
    expect((await (await post()).json()).refusal.changed).toBe('unknown');
  });
  it('returns the gate’s answer unchanged when there is no session', async () => {
    gate.session.mockResolvedValue(new Response('no', { status: 401 }));
    const fn = vi.fn();
    vi.stubGlobal('fetch', fn);
    expect((await post()).status).toBe(401);
    expect(fn).not.toHaveBeenCalled();
  });
});
