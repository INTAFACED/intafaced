import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchDesk, fetchPage, fetchTransfer } from './browser';
import { ownServerFailureText } from './own-server';

afterEach(() => vi.unstubAllGlobals());

const OUTCOME = {
  id: 'pay.transfer-detail',
  asOf: '2026-10-18T03:00:00.000Z',
  part: { kind: 'failed', message: 'x', code: 'bank.ops_transfer_not_found', notBuilt: false, forbidden: false },
};
const reply = (body: unknown, status = 200) => vi.fn(async (_url: string, _init?: RequestInit) => Response.json(body, { status }));

describe('fetchTransfer', () => {
  it('asks the console’s own server for the id, encoded, without caching', async () => {
    const fn = reply(OUTCOME);
    vi.stubGlobal('fetch', fn);
    expect(await fetchTransfer('a b/c')).toEqual({ ok: true, outcome: OUTCOME });
    const [url, init] = fn.mock.calls[0]!;
    expect(url).toBe('/api/pay-ops/transfer?id=a%20b%2Fc');
    expect(init).toMatchObject({ cache: 'no-store', credentials: 'same-origin' });
  });
  it('keeps what the server answered when it is not an outcome: the status and the code', async () => {
    vi.stubGlobal('fetch', reply({ error: 'transfer_id_invalid' }, 400));
    expect(await fetchTransfer('x')).toEqual({ ok: false, status: 400, code: 'transfer_id_invalid' });
    vi.stubGlobal('fetch', reply({ code: 'admin.session_required' }, 401));
    expect(await fetchTransfer('x')).toEqual({ ok: false, status: 401, code: 'admin.session_required' });
    vi.stubGlobal('fetch', reply({ error: 'not_found' }, 404));
    expect(await fetchTransfer('x')).toEqual({ ok: false, status: 404, code: 'not_found' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<html>bad gateway</html>', { status: 502 })),
    );
    expect(await fetchTransfer('x')).toEqual({ ok: false, status: 502, code: null });
  });
  it('a 200 that is not an outcome, or no reply at all, has no status', async () => {
    vi.stubGlobal('fetch', reply({ ...OUTCOME, part: { kind: 'maybe' } }));
    expect(await fetchTransfer('x')).toEqual({ ok: false, status: null, code: null });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new Error('offline'))),
    );
    expect(await fetchTransfer('x')).toEqual({ ok: false, status: null, code: null });
  });
});

describe('fetchPage', () => {
  it('asks for the read and the marker, both encoded', async () => {
    const fn = reply(OUTCOME);
    vi.stubGlobal('fetch', fn);
    expect((await fetchPage('pay.failed-standing', 'abc_-')).ok).toBe(true);
    expect(fn.mock.calls[0]![0]).toBe('/api/pay-ops/page?read=pay.failed-standing&cursor=abc_-');
  });
});

describe('what a failed on-request read says', () => {
  const failure = (status: number | null) => ({ ok: false as const, status, code: null });
  it('an ended session says to sign in again', () => {
    expect(ownServerFailureText(failure(401), 'transfer')).toContain('Your founder session has ended; sign in again');
  });
  it('a 403 says what was refused: another page, or a founder no longer allowed', () => {
    expect(ownServerFailureText({ ok: false, status: 403, code: 'not_same_origin' }, 'transfer')).toContain(
      'did not come from this console',
    );
    expect(ownServerFailureText({ ok: false, status: 403, code: 'admin.session_origin' }, 'transfer')).toContain(
      'did not come from this console',
    );
    expect(ownServerFailureText({ ok: false, status: 403, code: null }, 'transfer')).toContain('no longer allowed to read this');
  });
  it('a bad id says it is not an id this desk can look up', () => {
    expect(ownServerFailureText(failure(400), 'transfer')).toContain('isn’t a transfer id this desk can look up');
    expect(ownServerFailureText(failure(400), 'page')).toContain('isn’t a page marker this desk can read');
  });
  it('a switched-off desk says so', () => {
    expect(ownServerFailureText(failure(404), 'transfer')).toContain('This desk is switched off');
  });
  it('a server error says the console’s own server failed; no reply says it could not reach it', () => {
    for (const status of [500, 502, 503])
      expect(ownServerFailureText(failure(status), 'transfer')).toContain('own server failed on this read');
    expect(ownServerFailureText(failure(null), 'transfer')).toContain('could not reach its own server');
  });
});

describe('fetchDesk', () => {
  it('reads the whole desk, or only the sections a part-desk page shows', async () => {
    const fn = reply({ deskId: 'more', asOf: '2026-10-22T23:00:00.000Z', reads: {} });
    vi.stubGlobal('fetch', fn);
    expect(await fetchDesk('more')).not.toBeNull();
    expect(await fetchDesk('more', undefined, ['mining'])).not.toBeNull();
    expect(fn.mock.calls.map((c) => c[0])).toEqual(['/api/more-ops', '/api/more-ops?section=mining']);
  });
});
