import { describe, expect, it } from 'vitest';
import { createWatermarkReader } from './watermark-reader.js';

const SECRET = 'a-shared-internal-secret-of-32-chars-min';
const body = (service: string) => ({
  service,
  kind: 'seq',
  position: '5',
  integrity: null,
  lastWriteAt: null,
  readAt: '2026-10-20T12:00:00.000Z',
});
const urls = { ledger: 'http://ledger:1', identity: 'http://identity:2', bank: 'http://bank:3', pay: 'http://pay:4' };

function fetcher(answer: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const seen: Array<{ url: string; method: string | undefined }> = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), method: init?.method });
    return answer(String(url), init ?? {});
  }) as unknown as typeof fetch;
  return { fn, seen };
}

describe('watermark reader', () => {
  it('asks each service at its own door', async () => {
    const f = fetcher(
      (url) =>
        new Response(
          JSON.stringify(
            body(url.includes('ledger') ? 'ledger' : url.includes('identity') ? 'identity' : url.includes('bank') ? 'bank' : 'pay'),
          ),
        ),
    );
    const reader = createWatermarkReader({ urls, secret: SECRET, fetcher: f.fn });
    for (const service of ['ledger', 'identity', 'bank', 'pay'] as const) expect(await reader.read(service)).toMatchObject({ ok: true });
    expect(f.seen).toEqual([
      { url: 'http://ledger:1/trpc/restoreWatermark', method: 'POST' },
      { url: 'http://identity:2/internal/restore/watermark', method: 'GET' },
      { url: 'http://bank:3/internal/restore/watermark', method: 'POST' },
      { url: 'http://pay:4/internal/restore/watermark', method: 'POST' },
    ]);
  });

  it('is unavailable, naming the service, for a missing url, a refusal, a bad body, another service and a throw', async () => {
    const unconfigured = createWatermarkReader({ urls: {}, secret: SECRET });
    expect(await unconfigured.read('bank')).toMatchObject({ ok: false, code: 'ops.restore_watermark_unavailable' });
    const noSecret = createWatermarkReader({ urls, secret: 'short', fetcher: fetcher(() => new Response('{}')).fn });
    expect(await noSecret.read('bank')).toMatchObject({ ok: false });
    const refused = createWatermarkReader({ urls, secret: SECRET, fetcher: fetcher(() => new Response('no', { status: 403 })).fn });
    expect(await refused.read('bank')).toMatchObject({ ok: false, message: expect.stringContaining('403') });
    const bad = createWatermarkReader({ urls, secret: SECRET, fetcher: fetcher(() => new Response(JSON.stringify({ position: 5 }))).fn });
    expect(await bad.read('pay')).toMatchObject({ ok: false });
    const wrong = createWatermarkReader({ urls, secret: SECRET, fetcher: fetcher(() => new Response(JSON.stringify(body('ledger')))).fn });
    expect(await wrong.read('pay')).toMatchObject({ ok: false, message: expect.stringContaining('not pay') });
    const throws = createWatermarkReader({
      urls,
      secret: SECRET,
      fetcher: fetcher(() => {
        throw new Error('boom');
      }).fn,
    });
    expect(await throws.read('identity')).toMatchObject({ ok: false, message: expect.stringContaining('svc-identity') });
  });
});
