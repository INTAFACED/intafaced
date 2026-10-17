import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchTransfer } from './browser';

afterEach(() => vi.unstubAllGlobals());

const OUTCOME = {
  id: 'pay.transfer-detail',
  asOf: '2026-10-18T03:00:00.000Z',
  part: { kind: 'failed', message: 'x', code: 'bank.ops_transfer_not_found', notBuilt: false, forbidden: false },
};

describe('fetchTransfer', () => {
  it('asks the console’s own server for the id, encoded, without caching', async () => {
    const fn = vi.fn(async (_url: string, _init?: RequestInit) => Response.json(OUTCOME));
    vi.stubGlobal('fetch', fn);
    expect(await fetchTransfer('a b/c')).toEqual(OUTCOME);
    const [url, init] = fn.mock.calls[0]!;
    expect(url).toBe('/api/pay-ops/transfer?id=a%20b%2Fc');
    expect(init).toMatchObject({ cache: 'no-store', credentials: 'same-origin' });
  });
  it('a reply that is not an outcome, or no reply at all, is null (the desk then says it could not reach its server)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ error: 'transfer_id_invalid' }, { status: 400 })),
    );
    expect(await fetchTransfer('x')).toBeNull();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ ...OUTCOME, part: { kind: 'maybe' } })),
    );
    expect(await fetchTransfer('x')).toBeNull();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new Error('offline'))),
    );
    expect(await fetchTransfer('x')).toBeNull();
  });
});
