import { describe, expect, it } from 'vitest';
import { createEvaluationFeedClient, micros } from './feed-client.js';

const SECRET = 'x'.repeat(40);
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function row(n: number, finishedAt: string) {
  return {
    run: {
      id: id(n),
      controlId: id(99),
      status: 'PASS',
      phase: { status: 'unset' },
      errorCode: { status: 'unset' },
      asOf: '2026-10-29T10:00:00.000Z',
      readAt: '2026-10-29T10:00:00.000Z',
      margin: { status: 'unset' },
      sources: { ledger: { asOf: '2026-10-29T10:00:00.000Z' }, outside: { asOf: 'unset' }, parity: { asOf: 'unset' } },
      outsideSide: 'not_applicable',
      periodStart: '2026-10-29T00:00:00.000Z',
      periodEnd: '2026-10-30T00:00:00.000Z',
      assets: [],
    },
    finishedAt,
    severity: { status: 'unset' },
  };
}

function client(body: unknown, status = 200) {
  const calls: Array<{ url: string; body: string; headers: Record<string, string> }> = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: String(init.body), headers: init.headers as Record<string, string> });
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { calls, feed: createEvaluationFeedClient({ ledgerUrl: 'http://ledger.test/', secret: SECRET, fetcher }) };
}

describe('ledger evaluation feed client', () => {
  it('orders by microseconds, not milliseconds', () => {
    expect(micros('2026-10-29T10:00:00.123457Z') > micros('2026-10-29T10:00:00.123456Z')).toBe(true);
    expect(micros('2026-10-29T10:00:00Z')).toBe(BigInt(Date.parse('2026-10-29T10:00:00Z')) * 1000n);
  });

  it('is unconfigured without a URL or a credential, and never reads', async () => {
    for (const options of [{ secret: SECRET }, { ledgerUrl: 'http://ledger.test' }, { ledgerUrl: 'ftp://ledger.test', secret: SECRET }]) {
      const feed = createEvaluationFeedClient(options);
      expect(feed.configured).toBe(false);
      expect(await feed.read({ after: null, limit: 5 })).toMatchObject({ ok: false, message: expect.stringContaining('not wired') });
    }
  });

  it('signs a POST to the one door and returns an in-order page', async () => {
    const page = {
      evaluations: [row(1, '2026-10-29T10:00:00.000001Z'), row(2, '2026-10-29T10:00:00.000002Z')],
      next: { finishedAt: '2026-10-29T10:00:00.000002Z', id: id(2) },
    };
    const { calls, feed } = client(page);
    expect(await feed.read({ after: null, limit: 5 })).toEqual({ ok: true, value: page });
    expect(calls[0]!.url).toBe('http://ledger.test/trpc/reconciliationEvaluations');
    expect(JSON.parse(calls[0]!.body)).toEqual({ after: null, limit: 5 });
    expect(Object.keys(calls[0]!.headers).some((name) => name.startsWith('x-intafaced'))).toBe(true);
  });

  it('refuses a refusal, a malformed body, an oversized or out-of-order page and a wrong next', async () => {
    const after = { finishedAt: '2026-10-29T10:00:00.000005Z', id: id(5) };
    const cases: Array<[unknown, number, string]> = [
      [{}, 403, 'refused'],
      [{ evaluations: 'no' }, 200, 'shape'],
      [{ evaluations: [row(1, 'a')], next: null }, 200, 'shape'],
      [
        {
          evaluations: [row(1, '2026-10-29T10:00:00.000001Z'), row(2, '2026-10-29T10:00:00.000002Z')],
          next: { finishedAt: '2026-10-29T10:00:00.000002Z', id: id(2) },
        },
        200,
        'more',
      ],
      [
        { evaluations: [row(4, '2026-10-29T10:00:00.000004Z')], next: { finishedAt: '2026-10-29T10:00:00.000004Z', id: id(4) } },
        200,
        'follow',
      ],
      [{ evaluations: [row(6, '2026-10-29T10:00:00.000006Z')], next: after }, 200, 'follow'],
      [{ evaluations: [], next: null }, 200, 'follow'],
    ];
    for (const [body, status, word] of cases) {
      const { feed } = client(body, status);
      const limit = word === 'more' ? 1 : 5;
      expect(await feed.read({ after, limit })).toMatchObject({ ok: false, message: expect.stringContaining(word) });
    }
  });

  it('reads an empty page that keeps the cursor', async () => {
    const after = { finishedAt: '2026-10-29T10:00:00.000005Z', id: id(5) };
    const { feed } = client({ evaluations: [], next: after });
    expect(await feed.read({ after, limit: 5 })).toEqual({ ok: true, value: { evaluations: [], next: after } });
  });
});
