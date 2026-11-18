import { readFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SERVICE_BODY_DIGEST_HEADER,
  SERVICE_HEADER,
  SERVICE_SIGNATURE_HEADER,
  SERVICE_TIMESTAMP_HEADER,
  verifyServiceHeaders,
} from '@intafaced/contracts';
import { createMarketLifecycleAdmissionProof, MATCHING_SUBMIT_ORDER } from '@intafaced/exchange-contract';
import { afterEach, describe, expect, it } from 'vitest';
import type { AdaptResult, MatchingOrderCommand } from './command.js';
import {
  MATCHING_SERVICE_NAME,
  matchingSubmitPath,
  postAdaptedNewOrder,
  postMatchingSubmit,
  readCompIdAccountMap,
  resolveAccountId,
  fixOrderId,
  toMatchingSubmitBody,
  type MatchingPortOptions,
} from './matching-port.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const OWNER_MAP = '{"CLIENT":"acct-desk"}';
const SECRET = 'a'.repeat(32);

/** A TEST market lifecycle admission proof for BTC/USDT: svc-fix has no real source of one (see `lifecycleProof`). */
const testProof = createMarketLifecycleAdmissionProof(
  {
    marketId: 'BTC/USDT',
    ruleVersion: 'TEST-rules-1',
    instrumentId: 'TEST-instrument',
    instrumentVersion: 'TEST-v1',
    state: 'OPEN',
    reasonCategory: 'NORMAL',
    reasonCode: 'trade.lifecycle.ready',
    effectiveAt: '2026-11-18T00:00:00.000Z',
    observedAt: '2026-11-18T00:00:00.000Z',
    lastGoodState: 'OPEN',
    allowedActions: ['PLACE'],
    transitionId: 'TEST-transition',
    evidenceRefs: ['TEST-evidence'],
  },
  'PLACE',
);

function liveOpts(url: string, extra: Partial<MatchingPortOptions> = {}): MatchingPortOptions {
  return { matchingBaseUrl: url, compIdAccountJson: OWNER_MAP, internalServiceSecret: SECRET, lifecycleProof: () => testProof, ...extra };
}

const limitCmd: MatchingOrderCommand = {
  kind: 'new_order_single',
  clOrdId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  beginString: 'FIX.4.4',
  symbol: 'BTC/USDT',
  side: 'buy',
  ordType: 'limit',
  qty: '1.50',
  price: '100.25',
  senderCompId: 'CLIENT',
  tif: 'GTC',
};

const marketCmd: MatchingOrderCommand = {
  ...limitCmd,
  clOrdId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  ordType: 'market',
  price: null,
};

type Recorded = {
  method: string;
  url: string;
  body: string;
  headers: IncomingHttpHeaders;
};

const matchingHttpAck = {
  accepted: true,
  sequence: 1,
  fills: [{ price: 99.5, qty: 1.5, last: 99.5, account: 'ghost' }],
  last: 99.5,
  lastPx: 99.5,
  lastPrice: 99.5,
  account: 'ghost',
  resting: { extra: true },
  rejected: null,
  cancellations: [] as const,
  triggered: [] as const,
};

const namedAck = {
  accepted: true as const,
  sequence: 1,
};

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

describe('toMatchingSubmitBody — decimal strings, no last price', () => {
  it('maps qty and price as strings with owner account and tif', () => {
    const body = toMatchingSubmitBody(limitCmd, { accountId: 'acct-desk', tif: 'GTC', lifecycleProof: testProof });
    expect(body).toEqual({
      orderId: fixOrderId('CLIENT', limitCmd.clOrdId),
      accountId: 'acct-desk',
      type: 'limit',
      side: 'buy',
      qty: '1.50',
      price: '100.25',
      tif: 'GTC',
      lifecycleProof: testProof,
    });
    // What svc-fix sends is what matching parses: the record both sides use.
    expect(MATCHING_SUBMIT_ORDER.input.safeParse(body).success).toBe(true);
    expect(typeof body.qty).toBe('string');
    expect(typeof body.price).toBe('string');
    expect(matchingSubmitPath(limitCmd)).toBe('/markets/BTC%2FUSDT/orders');
  });

  it('keeps market price null rather than inventing last', () => {
    const body = toMatchingSubmitBody(marketCmd, { accountId: 'acct-desk', tif: 'GTC', lifecycleProof: testProof });
    expect(body.price).toBeNull();
    expect(body).not.toHaveProperty('last');
    expect(body).not.toHaveProperty('lastPx');
    expect(body).not.toHaveProperty('lastPrice');
  });
});

describe('the submit matching requires (#8847)', () => {
  it('with no lifecycle proof source, refuses by name and sends nothing', async () => {
    const url = await listen(async (req, res) => capture(req, res, 200, namedAck));
    const result = await postMatchingSubmit(limitCmd, liveOpts(url, { lifecycleProof: undefined }));
    expect(result).toMatchObject({ ok: false, error: { code: 'matching_lifecycle_proof_unavailable' } });
    expect(recorded).toHaveLength(0);
  });

  it('a client order id that is not a GUID is sent as the GUID of its session and id, the same every time', async () => {
    const url = await listen(async (req, res) => capture(req, res, 200, namedAck));
    const clientId = { ...limitCmd, clOrdId: 'ORD-2026-11-18-0001' };
    expect((await postMatchingSubmit(clientId, liveOpts(url))).ok).toBe(true);
    expect((await postMatchingSubmit(clientId, liveOpts(url))).ok).toBe(true);
    const [first, second] = recorded.map((r) => JSON.parse(r.body) as { orderId: string });
    expect(first!.orderId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(second!.orderId).toBe(first!.orderId);
    expect(fixOrderId('OTHER', clientId.clOrdId)).not.toBe(first!.orderId);
  });

  it('FIX DAY has no matching time in force: refused by name before any POST', async () => {
    const url = await listen(async (req, res) => capture(req, res, 200, namedAck));
    const result = await postMatchingSubmit({ ...limitCmd, tif: 'DAY' }, liveOpts(url));
    expect(result).toMatchObject({ ok: false, error: { code: 'tif_unsupported' } });
    expect(recorded).toHaveLength(0);
  });
});

describe('CompID JSON is OWNER-SET', () => {
  it('blank JSON refuses matching_account_unmapped', () => {
    const blank = readCompIdAccountMap('');
    expect(blank.ok).toBe(false);
    if (blank.ok) return;
    expect(blank.error.code).toBe('matching_account_unmapped');
    expect(blank.error.message).toContain('invent an account');
  });

  it('unmapped CompID refuses matching_account_unmapped', () => {
    const result = resolveAccountId('UNKNOWN', OWNER_MAP);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('matching_account_unmapped');
  });

  it('mapped CompID returns the owner account string', () => {
    const result = resolveAccountId('CLIENT', OWNER_MAP);
    expect(result).toEqual({ ok: true, accountId: 'acct-desk' });
  });
});

describe('postAdaptedNewOrder — fake matching HTTP', () => {
  it('unmapped CompID refuses matching_account_unmapped before POST', async () => {
    const url = await listen(async (req, res) => capture(req, res, 200, matchingHttpAck));
    const result = await postMatchingSubmit({ ...limitCmd, senderCompId: 'GHOST' }, liveOpts(url));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('matching_account_unmapped');
    expect(recorded).toHaveLength(0);
  });

  it('blank CompID JSON refuses matching_account_unmapped before POST', async () => {
    const url = await listen(async (req, res) => capture(req, res, 200, matchingHttpAck));
    const result = await postMatchingSubmit(limitCmd, liveOpts(url, { compIdAccountJson: '' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('matching_account_unmapped');
    expect(recorded).toHaveLength(0);
  });

  it('missing TIF refuses tif_missing before POST', async () => {
    const url = await listen(async (req, res) => capture(req, res, 200, matchingHttpAck));
    const { tif: _tif, ...withoutTif } = limitCmd;
    const result = await postMatchingSubmit(withoutTif, liveOpts(url));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('tif_missing');
    expect(result.error.message).toContain('invent GTC');
    expect(recorded).toHaveLength(0);
  });

  it('mapped CompID posts decimal qty/price with account and tif', async () => {
    const url = await listen(async (req, res) => capture(req, res, 200, matchingHttpAck));
    const result = await postAdaptedNewOrder({ ok: true, command: limitCmd }, liveOpts(url));
    expect(result).toEqual({ ok: true, ack: namedAck });
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.method).toBe('POST');
    expect(recorded[0]?.url).toBe('/markets/BTC%2FUSDT/orders');
    const posted = JSON.parse(recorded[0]?.body ?? '{}') as Record<string, unknown>;
    expect(posted.qty).toBe('1.50');
    expect(posted.price).toBe('100.25');
    expect(typeof posted.qty).toBe('string');
    expect(typeof posted.price).toBe('string');
    expect(posted.accountId).toBe('acct-desk');
    expect(posted.tif).toBe('GTC');
    expect(posted.orderId).toBe(fixOrderId('CLIENT', limitCmd.clOrdId));
    expect(MATCHING_SUBMIT_ORDER.input.safeParse(posted).success, recorded[0]?.body).toBe(true);
    expect(posted).not.toHaveProperty('lastPrice');
    expect(result.ok && result.ack).toEqual(namedAck);
    expect(result.ok && result.ack).not.toHaveProperty('fills');
    expect(result.ok && result.ack).not.toHaveProperty('last');
    expect(result.ok && result.ack).not.toHaveProperty('account');
  });

  it('signs the matching POST with v2 svc-fix service-auth headers', async () => {
    const url = await listen(async (req, res) => capture(req, res, 200, matchingHttpAck));
    const result = await postMatchingSubmit(limitCmd, liveOpts(url));
    expect(result.ok).toBe(true);
    expect(recorded).toHaveLength(1);
    const hit = recorded[0]!;
    expect(hit.headers[SERVICE_HEADER]).toBe(MATCHING_SERVICE_NAME);
    expect(hit.headers[SERVICE_BODY_DIGEST_HEADER]).toMatch(/^[0-9a-f]{64}$/);
    expect(hit.headers[SERVICE_SIGNATURE_HEADER]).toMatch(/^[0-9a-f]{64}$/);
    expect(hit.headers[SERVICE_TIMESTAMP_HEADER]).toMatch(/^\d+$/);
    expect(
      verifyServiceHeaders(hit.headers, SECRET, {
        rawBody: { retained: true, bytes: Buffer.from(hit.body, 'utf8') },
        mode: 'require',
      }),
    ).toEqual({ service: MATCHING_SERVICE_NAME, rejected: null, scheme: 'v2' });
  });

  it('blank INTERNAL_SERVICE_SECRET refuses before unsigned POST', async () => {
    const url = await listen(async (req, res) => capture(req, res, 200, matchingHttpAck));
    const result = await postMatchingSubmit(limitCmd, liveOpts(url, { internalServiceSecret: '' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('matching_service_auth_unconfigured');
    expect(result.error.message).toContain('unsigned');
    expect(recorded).toHaveLength(0);
  });

  it('passes a 200 submit ack through without inventing fills', async () => {
    const url = await listen(async (req, res) => capture(req, res, 200, matchingHttpAck));
    const result = await postAdaptedNewOrder({ ok: true, command: limitCmd }, liveOpts(url));
    expect(result).toEqual({ ok: true, ack: namedAck });
    expect(recorded).toHaveLength(1);
  });

  it('names 503 matching_unavailable and does not invent a fill', async () => {
    const url = await listen(async (req, res) => capture(req, res, 503, { error: 'down' }));
    const result = await postMatchingSubmit(limitCmd, liveOpts(url));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('matching_unavailable');
    expect(result.error.message.toLowerCase()).toContain('invent');
    expect(recorded).toHaveLength(1);
  });

  it('names timeout matching_timeout when matching never answers', async () => {
    const url = await listen(() => undefined);
    const result = await postMatchingSubmit(limitCmd, liveOpts(url, { timeoutMs: 40 }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('matching_timeout');
    expect(recorded).toHaveLength(0);
  });

  it('names 400 matching_rejected', async () => {
    const url = await listen(async (req, res) => capture(req, res, 400, { code: 'BadRequest', issues: ['accountId'] }));
    const result = await postMatchingSubmit(limitCmd, liveOpts(url));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('matching_rejected');
  });

  it('blank MATCHING_BASE_URL refuses matching_unconfigured without inventing localhost', async () => {
    const prev = process.env.MATCHING_BASE_URL;
    delete process.env.MATCHING_BASE_URL;
    try {
      const result = await postMatchingSubmit(limitCmd, liveOpts('', { matchingBaseUrl: '' }));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('matching_unconfigured');
      expect(result.error.message).not.toMatch(/localhost/i);
      expect(recorded).toHaveLength(0);
    } finally {
      if (prev === undefined) delete process.env.MATCHING_BASE_URL;
      else process.env.MATCHING_BASE_URL = prev;
    }
  });

  it('unsupported BeginString refuses before HTTP', async () => {
    const url = await listen(async (req, res) => capture(req, res, 200, matchingHttpAck));
    const adapted: AdaptResult = {
      ok: false,
      error: { code: 'unsupported_begin_string', message: 'BeginString FIX.4.0 is not FIX.4.2, FIX.4.4, FIX.5.0, or FIXT.1.1' },
    };
    const result = await postAdaptedNewOrder(adapted, liveOpts(url));
    expect(result).toEqual(adapted);
    expect(recorded).toHaveLength(0);
  });

  it('unsupported beginString on the command refuses before HTTP', async () => {
    const url = await listen(async (req, res) => capture(req, res, 200, matchingHttpAck));
    const result = await postMatchingSubmit({ ...limitCmd, beginString: 'FIX.4.0' }, liveOpts(url));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('unsupported_begin_string');
    expect(recorded).toHaveLength(0);
  });

  it('market order posts price null and never a last price', async () => {
    const url = await listen(async (req, res) => capture(req, res, 200, matchingHttpAck));
    const result = await postMatchingSubmit(marketCmd, liveOpts(url));
    expect(result.ok).toBe(true);
    const posted = JSON.parse(recorded[0]?.body ?? '{}') as Record<string, unknown>;
    expect(posted.price).toBeNull();
    expect(posted.accountId).toBe('acct-desk');
    expect(posted).not.toHaveProperty('last');
    expect(posted).not.toHaveProperty('lastPx');
    expect(JSON.stringify(posted)).not.toMatch(/lastPrice/);
  });

  it('strips extra fills, last, and account from HTTP 200 and keeps matching sequence', async () => {
    const url = await listen(async (req, res) => capture(req, res, 200, matchingHttpAck));
    const result = await postMatchingSubmit(limitCmd, liveOpts(url));
    expect(result).toEqual({ ok: true, ack: namedAck });
    if (!result.ok) return;
    expect(result.ack.sequence).toBe(1);
    expect(result.ack).not.toHaveProperty('fills');
    expect(result.ack).not.toHaveProperty('last');
    expect(result.ack).not.toHaveProperty('lastPx');
    expect(result.ack).not.toHaveProperty('lastPrice');
    expect(result.ack).not.toHaveProperty('account');
    expect(result.ack).not.toHaveProperty('resting');
    expect(JSON.stringify(result.ack)).not.toMatch(/99\.5/);
  });

  it('does not treat IEEE last or fills from HTTP 200 as money', async () => {
    const url = await listen(async (req, res) =>
      capture(req, res, 200, {
        accepted: true,
        sequence: 7,
        last: 100.25,
        fills: [{ price: 100.25, qty: 1.5 }],
      }),
    );
    const result = await postMatchingSubmit(limitCmd, liveOpts(url));
    expect(result).toEqual({ ok: true, ack: { accepted: true, sequence: 7 } });
    if (!result.ok) return;
    expect(JSON.stringify(result.ack)).not.toMatch(/100\.25/);
    expect(result.ack).not.toHaveProperty('fills');
    expect(result.ack).not.toHaveProperty('last');
  });

  it('never posts ledger and does not depend on ledger-client', async () => {
    const url = await listen(async (req, res) => capture(req, res, 200, matchingHttpAck));
    await postMatchingSubmit(limitCmd, liveOpts(url));
    expect(recorded.every((r) => !r.url.includes('ledger'))).toBe(true);
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const names = [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})];
    expect(names).not.toContain('@intafaced/ledger-client');
    const port = readFileSync(join(root, 'src/matching-port.ts'), 'utf8');
    expect(port).not.toMatch(/ledger-client/);
    expect(port).not.toMatch(/ledger\.post/);
    expect(port).not.toMatch(/\blastPrice\b/);
  });
});
