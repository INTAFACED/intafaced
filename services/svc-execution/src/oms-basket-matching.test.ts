import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SERVICE_BODY_DIGEST_HEADER,
  SERVICE_HEADER,
  SERVICE_SIGNATURE_HEADER,
  SERVICE_TIMESTAMP_HEADER,
  verifyServiceHeaders,
} from '@intafaced/contracts';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import { createMarketLifecycleAdmissionProof } from '@intafaced/exchange-contract';
import { startBasketParent } from './oms-basket-start.js';
import { killBasketMatchingChildren, MATCHING_SERVICE_NAME, postBasketChildrenToMatching } from './oms-basket-matching.js';

const SERVICE_SECRET = 'a'.repeat(32);

const OP = '33333333-3333-4333-8333-333333333333';
const MATCHING_OPEN = { venueHalted: false } as const;
const JOBS_ON = { enabled: true } as const;
const NOW = new Date('2026-09-01T12:00:00.000Z');
const BTC_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ETH_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function proofFor(marketId: string) {
  const observedAt = '2026-09-01T12:00:00.000Z';
  return createMarketLifecycleAdmissionProof(
    {
      marketId,
      ruleVersion: 'test.rules.v1',
      instrumentId: marketId,
      instrumentVersion: 'test.instrument.v1',
      state: 'OPEN',
      reasonCategory: 'NORMAL',
      reasonCode: 'trade.lifecycle.ready',
      effectiveAt: observedAt,
      observedAt,
      lastGoodState: 'OPEN',
      allowedActions: ['PLACE', 'PLACE_POST_ONLY'],
      transitionId: 'test.transition',
      evidenceRefs: ['test.evidence'],
    },
    'PLACE',
  );
}

function started() {
  const result = startBasketParent({
    parentClientOrderId: 'p-basket',
    kind: 'basket',
    approved: true,
    legs: [
      { name: 'BTC', qty: '0.5' },
      { name: 'ETH', qty: '2' },
    ],
    partialFailurePolicy: 'refuse_all',
    credit: '100',
    remaining: '1.25',
    operatorId: OP,
    jobs: JOBS_ON,
    matchingVenueHalt: MATCHING_OPEN,
    now: NOW,
  });
  if (!result.ok) throw new Error(result.reason);
  return result;
}

function legs() {
  return [
    {
      name: 'BTC',
      qty: '0.5',
      marketId: 'BTC-USDT',
      orderId: BTC_ID,
      side: 'buy',
      type: 'limit',
      tif: 'GTC',
      price: '100.25',
      accountId: 'acct-desk',
      lifecycleProof: proofFor('BTC-USDT'),
    },
    {
      name: 'ETH',
      qty: '2',
      marketId: 'ETH-USDT',
      orderId: ETH_ID,
      side: 'sell',
      type: 'limit',
      tif: 'GTC',
      price: '10',
      accountId: 'acct-desk',
      lifecycleProof: proofFor('ETH-USDT'),
    },
  ] as const;
}

type Recorded = { method: string; url: string; body: string; headers: IncomingHttpHeaders };

let server: Server | undefined;
const recorded: Recorded[] = [];

afterEach(async () => {
  recorded.length = 0;
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
});

async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>): Promise<string> {
  server = createServer((req, res) => {
    void handler(req, res);
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (typeof address === 'string' || address === null) throw new Error('no port');
  return `http://127.0.0.1:${address.port}`;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function capture(req: IncomingMessage, res: ServerResponse, status: number, body: unknown): Promise<void> {
  const text = await readBody(req);
  recorded.push({ method: req.method ?? '', url: req.url ?? '', body: text, headers: req.headers });
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

function liveAuth(extra: { matchingUrl: string } & Record<string, unknown> = { matchingUrl: '' }) {
  return { internalServiceSecret: SERVICE_SECRET, ...extra };
}

describe('postBasketChildrenToMatching', () => {
  it('blank matching URL refuses matching_unconfigured — no invent host, no ledger', async () => {
    const out = await postBasketChildrenToMatching({
      parent: started(),
      legs: legs(),
      matchingUrl: '   ',
    });
    expect(out).toMatchObject({ ok: false, reason: 'matching_unconfigured' });
    expect(recorded).toHaveLength(0);
  });

  it('missing market / account / uuid / tif / proof refuse before POST', async () => {
    expect(
      await postBasketChildrenToMatching({
        parent: started(),
        legs: [{ ...legs()[0], marketId: '   ' }, legs()[1]],
        matchingUrl: 'http://matching.example',
      }),
    ).toMatchObject({ ok: false, reason: 'missing_market' });
    expect(
      await postBasketChildrenToMatching({
        parent: started(),
        legs: [{ ...legs()[0], accountId: '' }, legs()[1]],
        matchingUrl: 'http://matching.example',
      }),
    ).toMatchObject({ ok: false, reason: 'missing_account' });
    expect(
      await postBasketChildrenToMatching({
        parent: started(),
        legs: [{ ...legs()[0], orderId: 'not-a-uuid' }, legs()[1]],
        matchingUrl: 'http://matching.example',
      }),
    ).toMatchObject({ ok: false, reason: 'missing_order_id' });
    expect(
      await postBasketChildrenToMatching({
        parent: started(),
        legs: [{ ...legs()[0], tif: undefined }, legs()[1]],
        matchingUrl: 'http://matching.example',
      }),
    ).toMatchObject({ ok: false, reason: 'missing_tif' });
    expect(
      await postBasketChildrenToMatching({
        parent: started(),
        legs: [{ ...legs()[0], lifecycleProof: undefined }, legs()[1]],
        matchingUrl: 'http://matching.example',
      }),
    ).toMatchObject({ ok: false, reason: 'missing_lifecycle_proof' });
  });

  it('POSTs each child to matching with decimal qty strings — not JSON numbers, no fills minted', async () => {
    const base = await listen(async (req, res) => {
      await capture(req, res, 200, { accepted: true, sequence: 7, fills: [{ last: 99.5 }], last: 99.5 });
    });
    const out = await postBasketChildrenToMatching({
      parent: started(),
      legs: legs(),
      ...liveAuth({ matchingUrl: base }),
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.children).toEqual([
      {
        name: 'BTC',
        qty: formatAmount(parseAmount('0.5')),
        marketId: 'BTC-USDT',
        orderId: BTC_ID,
        matching: { accepted: true, sequence: 7 },
      },
      {
        name: 'ETH',
        qty: formatAmount(parseAmount('2')),
        marketId: 'ETH-USDT',
        orderId: ETH_ID,
        matching: { accepted: true, sequence: 7 },
      },
    ]);
    expect(recorded.map((r) => r.method)).toEqual(['POST', 'POST']);
    expect(recorded[0]?.url).toBe('/markets/BTC-USDT/orders');
    expect(recorded[1]?.url).toBe('/markets/ETH-USDT/orders');
    const first = JSON.parse(recorded[0]?.body ?? '{}') as Record<string, unknown>;
    expect(typeof first.qty).toBe('string');
    expect(first.qty).toBe(formatAmount(parseAmount('0.5')));
    expect(typeof first.price).toBe('string');
    expect(first).not.toHaveProperty('last');
    expect(out).not.toHaveProperty('paper');
    expect(out).not.toHaveProperty('fills');
    expect(out).not.toHaveProperty('ledger');
  });

  it('signs matching POSTs with v2 svc-execution service-auth headers', async () => {
    const base = await listen(async (req, res) => {
      await capture(req, res, 200, { accepted: true, sequence: 7 });
    });
    const out = await postBasketChildrenToMatching({
      parent: started(),
      legs: legs(),
      ...liveAuth({ matchingUrl: base }),
    });
    expect(out.ok).toBe(true);
    expect(recorded).toHaveLength(2);
    for (const hit of recorded) {
      expect(hit.headers[SERVICE_HEADER]).toBe(MATCHING_SERVICE_NAME);
      expect(hit.headers[SERVICE_BODY_DIGEST_HEADER]).toMatch(/^[0-9a-f]{64}$/);
      expect(hit.headers[SERVICE_SIGNATURE_HEADER]).toMatch(/^[0-9a-f]{64}$/);
      expect(hit.headers[SERVICE_TIMESTAMP_HEADER]).toMatch(/^\d+$/);
      expect(
        verifyServiceHeaders(hit.headers, SERVICE_SECRET, {
          rawBody: { retained: true, bytes: Buffer.from(hit.body, 'utf8') },
          mode: 'require',
        }),
      ).toEqual({ service: MATCHING_SERVICE_NAME, rejected: null, scheme: 'v2' });
    }
  });

  it('blank INTERNAL_SERVICE_SECRET refuses matching_service_auth_unconfigured — no unsigned POST', async () => {
    const base = await listen(async (req, res) => {
      await capture(req, res, 200, { accepted: true, sequence: 1 });
    });
    const out = await postBasketChildrenToMatching({
      parent: started(),
      legs: legs(),
      matchingUrl: base,
      internalServiceSecret: '',
    });
    expect(out).toMatchObject({ ok: false, reason: 'matching_service_auth_unconfigured' });
    if (out.ok) return;
    expect(out.detail).toContain('unsigned');
    expect(recorded).toHaveLength(0);
  });

  it('second-leg matching reject is refuse_all — remaining not posted, no flatten', async () => {
    const base = await listen(async (req, res) => {
      const n = recorded.length;
      await capture(req, res, n === 0 ? 200 : 400, n === 0 ? { accepted: true, sequence: 1 } : { accepted: false });
    });
    const out = await postBasketChildrenToMatching({
      parent: started(),
      legs: legs(),
      ...liveAuth({ matchingUrl: base }),
    });
    expect(out).toMatchObject({ ok: false, reason: 'matching_rejected' });
    expect(recorded).toHaveLength(2);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.detail).toContain('refuse_all');
  });

  it('matching timeout is unknown — not a fill, remaining legs not posted', async () => {
    const base = await listen(async (req, res) => {
      await capture(req, res, 504, { accepted: false });
    });
    const out = await postBasketChildrenToMatching({
      parent: started(),
      legs: legs(),
      ...liveAuth({ matchingUrl: base }),
    });
    expect(out).toMatchObject({ ok: false, reason: 'matching_timeout' });
    expect(recorded).toHaveLength(1);
  });
});

describe('killBasketMatchingChildren — unknown ≠ killed', () => {
  it('HTTP 503 is not stopped and does not invent an order id', async () => {
    const base = await listen(async (req, res) => {
      await capture(req, res, 503, { cancelled: true, outcome: 'stopped', orderId: 'invented-order' });
    });
    const out = await killBasketMatchingChildren({
      ...liveAuth({ matchingUrl: base }),
      children: [{ marketId: 'BTC-USDT', orderId: BTC_ID }],
    });
    expect(out).toEqual({
      ok: true,
      killed: false,
      children: [{ marketId: 'BTC-USDT', orderId: BTC_ID, outcome: 'unknown', reason: 'cancel_failed' }],
    });
  });

  it('unknown matching cancel is killed false', async () => {
    const base = await listen(async (req, res) => {
      await capture(req, res, 503, { cancelled: false });
    });
    const out = await killBasketMatchingChildren({
      ...liveAuth({ matchingUrl: base }),
      children: [
        { marketId: 'BTC-USDT', orderId: BTC_ID },
        { marketId: 'ETH-USDT', orderId: ETH_ID },
      ],
    });
    expect(out).toMatchObject({ ok: true, killed: false });
    if (!out.ok) return;
    expect(out.children.every((c) => c.outcome === 'unknown')).toBe(true);
    expect(recorded.map((r) => r.method)).toEqual(['DELETE', 'DELETE']);
  });

  it('all matching deletes stopped is killed true', async () => {
    const base = await listen(async (req, res) => {
      await capture(req, res, 200, { cancelled: true, orderId: 'x' });
    });
    const out = await killBasketMatchingChildren({
      ...liveAuth({ matchingUrl: base }),
      children: [{ marketId: 'BTC-USDT', orderId: BTC_ID }],
    });
    expect(out).toEqual({
      ok: true,
      killed: true,
      children: [{ marketId: 'BTC-USDT', orderId: BTC_ID, outcome: 'stopped' }],
    });
  });

  it('404 is already_stopped and can still be killed true', async () => {
    const base = await listen(async (req, res) => {
      await capture(req, res, 404, { cancelled: false });
    });
    const out = await killBasketMatchingChildren({
      ...liveAuth({ matchingUrl: base }),
      children: [{ marketId: 'BTC-USDT', orderId: BTC_ID }],
    });
    expect(out).toMatchObject({ ok: true, killed: true });
    if (!out.ok) return;
    expect(out.children[0]).toMatchObject({ outcome: 'already_stopped' });
  });

  it('signs matching DELETEs with v2 svc-execution service-auth headers', async () => {
    const base = await listen(async (req, res) => {
      await capture(req, res, 200, { cancelled: true, orderId: BTC_ID });
    });
    const out = await killBasketMatchingChildren({
      ...liveAuth({ matchingUrl: base }),
      children: [{ marketId: 'BTC-USDT', orderId: BTC_ID }],
    });
    expect(out).toMatchObject({ ok: true, killed: true });
    expect(recorded).toHaveLength(1);
    const hit = recorded[0]!;
    expect(hit.method).toBe('DELETE');
    expect(hit.headers[SERVICE_HEADER]).toBe(MATCHING_SERVICE_NAME);
    expect(
      verifyServiceHeaders(hit.headers, SERVICE_SECRET, {
        rawBody: { retained: true, bytes: Buffer.from(hit.body, 'utf8') },
        mode: 'require',
      }),
    ).toEqual({ service: MATCHING_SERVICE_NAME, rejected: null, scheme: 'v2' });
  });

  it('blank INTERNAL_SERVICE_SECRET refuses matching_service_auth_unconfigured — no unsigned DELETE', async () => {
    const base = await listen(async (req, res) => {
      await capture(req, res, 200, { cancelled: true });
    });
    const out = await killBasketMatchingChildren({
      matchingUrl: base,
      internalServiceSecret: '',
      children: [{ marketId: 'BTC-USDT', orderId: BTC_ID }],
    });
    expect(out).toMatchObject({ ok: false, reason: 'matching_service_auth_unconfigured' });
    expect(recorded).toHaveLength(0);
  });
});
