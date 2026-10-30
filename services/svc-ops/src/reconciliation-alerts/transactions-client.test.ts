import { describe, expect, it } from 'vitest';
import { createCorrectiveTxClient } from './transactions-client.js';

const SECRET = 'x'.repeat(40);
const T1 = '7a000000-0000-4000-8000-000000000001';
const T2 = '7a000000-0000-4000-8000-000000000002';

function client(answer: () => Response | Promise<Response>) {
  const calls: Array<{ url: string; body: string; headers: Record<string, string> }> = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: String(init.body), headers: init.headers as Record<string, string> });
    return answer();
  }) as unknown as typeof fetch;
  return { calls, port: createCorrectiveTxClient({ ledgerUrl: 'http://ledger.test/', secret: SECRET, fetcher }) };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe('ledger corrective transaction client', () => {
  it('is unconfigured without a URL or a credential, and never asks', async () => {
    for (const options of [{ secret: SECRET }, { ledgerUrl: 'http://ledger.test' }, { ledgerUrl: 'ftp://ledger.test', secret: SECRET }]) {
      const port = createCorrectiveTxClient(options);
      expect(port.configured).toBe(false);
      expect(await port.exist([T1])).toMatchObject({ ok: false, message: expect.stringContaining('not wired') });
    }
  });

  it('signs a POST to the one door and returns the booked ids', async () => {
    const { calls, port } = client(() => json({ found: [T1] }));
    expect(await port.exist([T1, T2])).toEqual({ ok: true, found: [T1] });
    expect(calls[0]!.url).toBe('http://ledger.test/trpc/transactionsExist');
    expect(JSON.parse(calls[0]!.body)).toEqual({ txIds: [T1, T2] });
    expect(Object.keys(calls[0]!.headers).some((name) => name.toLowerCase().startsWith('x-intafaced'))).toBe(true);
  });

  it('turns a refusal, a bad shape, a thrown fetch and an id that was not asked into a failure, never "none found"', async () => {
    for (const answer of [
      () => json({ found: [] }, 403),
      () => json({ found: 'nope' }),
      () => Promise.reject(new Error('connect ECONNREFUSED')),
      () => json({ found: [T2] }),
    ]) {
      const { port } = client(answer);
      expect(await port.exist([T1])).toMatchObject({ ok: false });
    }
  });
});
