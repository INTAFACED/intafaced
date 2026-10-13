import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  formatAmount,
  parseAmount as amt,
  merchantClearing,
  railBoundary,
  recipes,
  userAvailable,
  type PostRequest,
} from '@intafaced/ledger-client';
import { serviceAuthHeaders, verifyServiceHeaders } from '@intafaced/contracts';
import { createLedgerClient } from './ledger-client.js';

function retained(body: string) {
  return { retained: true as const, bytes: Buffer.from(body, 'utf8') };
}

/**
 * THE WIRE SHAPE.
 *
 * This client is the only way svc-pay touches a balance (§2, Doctrine §0.6),
 * and the whole of its job is a translation: scaled bigint in memory, decimal
 * string on the wire.
 *
 * The failure mode is loud today — `JSON.stringify` throws on a bigint, so a
 * missed conversion crashes rather than corrupts. That is exactly why this file
 * exists. The temptation, faced with a stack trace about bigints, is to reach
 * for `Number(amount)`, which makes the crash go away and replaces it with a
 * float that silently loses precision above 2^53 and misrepresents 0.1 forever
 * after. These tests pin the shape so that "simplification" fails a test
 * instead of shipping.
 */

const USER = '11111111-1111-4111-8111-111111111111';
const MERCHANT = '55555555-5555-4555-8555-555555555555';

interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
  /** The exact bytes that went out. Not a re-serialised object. */
  raw: string;
  body: unknown;
}

const realFetch = globalThis.fetch;
let sent: Captured[];
let respond: (path: string) => { status: number; body: unknown };

beforeEach(() => {
  sent = [];
  respond = () => ({ status: 200, body: { txId: 'tx-1', hash: 'h1', postedAt: '2026-07-27T12:00:00.000Z' } });

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const raw = typeof init?.body === 'string' ? init.body : '';
    sent.push({
      url,
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      raw,
      body: raw ? JSON.parse(raw) : undefined,
    });

    const { status, body } = respond(new URL(url).pathname);
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const SECRET = 'test-internal-service-secret-32-chars';
const client = () => createLedgerClient('http://ledger.test', SECRET);

/** Walk a parsed JSON body and collect every value that is a number. */
function numbersIn(value: unknown, path = '$'): string[] {
  if (typeof value === 'number') return [path];
  if (Array.isArray(value)) return value.flatMap((v, i) => numbersIn(v, `${path}[${i}]`));
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => numbersIn(v, `${path}.${k}`));
  }
  return [];
}

describe('post — amounts leave as decimal strings', () => {
  it('serialises every entry amount as a decimal string', async () => {
    await client().post(
      recipes.paymentCapture({
        paymentId: 'p-1',
        merchantId: MERCHANT,
        assetId: 'USDT',
        amount: amt('100.5'),
        rail: 'card-sandbox',
        railRef: 'ch_1',
      }),
    );

    const body = sent[0]!.body as { entries: Array<{ amount: unknown; account: unknown; direction: string }> };
    expect(body.entries).toHaveLength(2);
    for (const entry of body.entries) {
      expect(typeof entry.amount).toBe('string');
      expect(entry.amount).toBe('100.5');
    }
  });

  it('puts NO number anywhere in the payload — not one', async () => {
    await client().post(
      recipes.merchantSettlement({
        merchantId: MERCHANT,
        merchantUserId: USER,
        window: '2026-07-27',
        assetId: 'USDT',
        gross: amt('1000'),
        fee: amt('25'),
      }),
    );

    // A blanket check rather than a per-field one: a future field carrying a
    // number would otherwise slip in unnoticed beside the ones asserted above.
    expect(numbersIn(sent[0]!.body)).toEqual([]);
  });

  it('survives JSON at all — a leaked bigint would throw before the request went out', async () => {
    // The regression this guards: dropping `formatAmount` and passing the
    // bigint straight through. `JSON.stringify` throws on bigint, so the
    // failure is loud — but only if something exercises the path.
    await expect(
      client().post(
        recipes.paymentRefund({
          refundId: 'p-1:1',
          paymentId: 'p-1',
          merchantId: MERCHANT,
          merchantUserId: USER,
          assetId: 'USDT',
          amount: amt('40'),
          rail: 'card-sandbox',
          source: 'clearing',
        }),
      ),
    ).resolves.toBeDefined();

    expect(sent[0]!.raw).toContain('"amount":"40"');
  });

  it('preserves 18 decimal places exactly, where a float would not', async () => {
    const dust = '0.000000000000000001';
    await client().post(
      recipes.paymentCapture({
        paymentId: 'p-dust',
        merchantId: MERCHANT,
        assetId: 'USDT',
        amount: amt(dust),
        rail: 'crypto-native',
        railRef: '0x1',
      }),
    );

    const body = sent[0]!.body as { entries: Array<{ amount: string }> };
    expect(body.entries[0]!.amount).toBe(dust);
    // Round-trips back to the same scaled bigint — the property a float breaks.
    expect(amt(body.entries[0]!.amount)).toBe(amt(dust));
  });

  it('preserves a value far beyond what a double can represent', async () => {
    // 2^53 is where Number stops being able to count. The ledger carries 38
    // digits, so this is an ordinary amount to it and an impossible one to a float.
    const huge = '9007199254740993.000000000000000001';
    await client().post({
      idempotencyKey: 'huge-amount-test',
      module: 'pay',
      reason: 'test',
      entries: [
        { account: railBoundary('crypto-native', 'USDT'), direction: 'credit', amount: amt(huge) },
        { account: merchantClearing(MERCHANT, 'USDT'), direction: 'debit', amount: amt(huge) },
      ],
    });

    const body = sent[0]!.body as { entries: Array<{ amount: string }> };
    expect(body.entries[0]!.amount).toBe(huge);
    expect(Number(body.entries[0]!.amount).toString()).not.toBe(huge); // the float would have lost it
  });

  it('sends the business key, module and reason the recipe decided', async () => {
    const request = recipes.merchantSettlement({
      merchantId: MERCHANT,
      merchantUserId: USER,
      window: '2026-07-27',
      assetId: 'USDT',
      gross: amt('100'),
      fee: amt('2'),
    });

    await client().post(request);

    const body = sent[0]!.body as PostRequest;
    // The asset is in the key. Two currencies in one window are two settlements.
    expect(body.idempotencyKey).toBe(`settlement:${MERCHANT}:2026-07-27:USDT`);
    expect(body.module).toBe('pay');
    expect(body.reason).toBe('pay.settled');
  });

  it('posts to the ledger, as JSON, and nowhere else', async () => {
    await client().post(
      recipes.paymentCapture({
        paymentId: 'p-2',
        merchantId: MERCHANT,
        assetId: 'USDT',
        amount: amt('1'),
        rail: 'card-sandbox',
        railRef: 'ch_2',
      }),
    );

    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe('http://ledger.test/trpc/post');
    expect(sent[0]!.method).toBe('POST');
    expect(sent[0]!.headers['content-type']).toBe('application/json');
  });

  /**
   * The credential actually leaves the process (§2).
   *
   * Worth its own assertion because the failure mode is silent in the wrong
   * direction: a client that quietly omits these still works against a ledger
   * that is not yet enforcing, and breaks only where it matters. `post` is a
   * `serviceProcedure` now — an unsigned call is refused.
   */
  it('presents service credentials on every call', async () => {
    await client().post(
      recipes.paymentCapture({
        paymentId: 'p-auth',
        merchantId: MERCHANT,
        assetId: 'USDT',
        amount: amt('1'),
        rail: 'card-sandbox',
        railRef: 'ch_auth',
      }),
    );

    const headers = sent[0]!.headers;
    expect(headers['x-intafaced-service']).toBe('svc-pay');
    expect(headers['x-intafaced-service-sig']).toMatch(/^[0-9a-f]{64}$/);
    // v2 marker. A v1 pin (identity + timestamp, no body) used to pass here
    // via verifyServiceCall without a digest — that is the hole this closes.
    expect(headers['x-intafaced-service-body']).toMatch(/^[0-9a-f]{64}$/);

    // Verified as the ledger will after INTERNAL_SERVICE_BODY_BIND=require,
    // against the exact bytes that left the process.
    expect(
      verifyServiceHeaders(headers, SECRET, {
        rawBody: retained(sent[0]!.raw),
        mode: 'require',
      }),
    ).toEqual({ service: 'svc-pay', rejected: null, scheme: 'v2' });
  });

  /**
   * THE TEST THIS CHANGE EXISTS FOR.
   *
   * v1 signed identity and a timestamp only. A captured header plus a mutated
   * amount still authenticated for 300 seconds, and ledger accept-both still
   * admits that. Pay must not send that shape: /trpc/post carries a body
   * digest, so a v1 replay of a different amount is not what left this client.
   */
  it('binds /trpc/post to the body so a captured v1 header with a mutated amount is not what pay sends', async () => {
    await client().post(
      recipes.paymentCapture({
        paymentId: 'p-bind',
        merchantId: MERCHANT,
        assetId: 'USDT',
        amount: amt('1'),
        rail: 'card-sandbox',
        railRef: 'ch_bind',
      }),
    );

    const captured = sent[0]!;
    expect(captured.url).toBe('http://ledger.test/trpc/post');
    expect(captured.headers['x-intafaced-service-body']).toMatch(/^[0-9a-f]{64}$/);

    const honest = captured.raw;
    const mutated = honest.replaceAll('"amount":"1"', '"amount":"99999"');
    expect(mutated).not.toBe(honest);

    expect(
      verifyServiceHeaders(captured.headers, SECRET, {
        rawBody: retained(honest),
        mode: 'require',
      }),
    ).toEqual({ service: 'svc-pay', rejected: null, scheme: 'v2' });

    // Same headers, different amount — refused even under accept-both, because
    // the bytes disagree with a digest we can actually check.
    expect(
      verifyServiceHeaders(captured.headers, SECRET, {
        rawBody: retained(mutated),
        mode: 'accept-both',
      }).rejected,
    ).toBe('body-mismatch');

    // A captured v1 header replayed with that mutated amount still verifies
    // under accept-both. That is the hole. It is not what pay sent.
    const v1 = serviceAuthHeaders('svc-pay', SECRET);
    expect(v1['x-intafaced-service-body']).toBeUndefined();
    expect(
      verifyServiceHeaders(v1, SECRET, {
        rawBody: retained(mutated),
        mode: 'accept-both',
      }).scheme,
    ).toBe('v1');
    expect(captured.headers['x-intafaced-service-sig']).not.toBe(v1['x-intafaced-service-sig']);
  });

  it('normalises a trailing slash on the base URL rather than doubling it', async () => {
    await createLedgerClient('http://ledger.test/', SECRET).post(
      recipes.paymentCapture({
        paymentId: 'p-3',
        merchantId: MERCHANT,
        assetId: 'USDT',
        amount: amt('1'),
        rail: 'card-sandbox',
        railRef: 'ch_3',
      }),
    );
    expect(sent[0]!.url).toBe('http://ledger.test/trpc/post');
  });

  it('returns the ledger transaction with its own id and hash', async () => {
    const tx = await client().post(
      recipes.paymentCapture({
        paymentId: 'p-4',
        merchantId: MERCHANT,
        assetId: 'USDT',
        amount: amt('1'),
        rail: 'card-sandbox',
        railRef: 'ch_4',
      }),
    );

    expect(tx.id).toBe('tx-1');
    expect(tx.hash).toBe('h1');
    expect(tx.idempotencyKey).toBe('payment.capture:p-4');
    expect(tx.postedAt).toEqual(new Date('2026-07-27T12:00:00.000Z'));
  });
});

describe('balances — amounts come back as decimal strings and become bigints', () => {
  it('parses a balance into a scaled bigint', async () => {
    respond = () => ({ status: 200, body: { accountId: 'acc-1', amount: '97.5' } });

    const balance = await client().balance(userAvailable(USER, 'USDT'));

    expect(typeof balance.amount).toBe('bigint');
    expect(balance.amount).toBe(amt('97.5'));
    expect(formatAmount(balance.amount)).toBe('97.5');
  });

  it('parses a clearing balance at full precision', async () => {
    respond = () => ({ status: 200, body: { accountId: 'acc-2', amount: '0.000000000000000001' } });
    const balance = await client().balance(merchantClearing(MERCHANT, 'USDT'));
    expect(balance.amount).toBe(1n);
  });

  it('sends the account reference the recipe would have used', async () => {
    respond = () => ({ status: 200, body: { accountId: 'acc-3', amount: '0' } });
    await client().balance(merchantClearing(MERCHANT, 'USDT'));

    expect(sent[0]!.body).toEqual({
      ownerType: 'module',
      ownerId: `pay:clearing:${MERCHANT}`,
      assetId: 'USDT',
      kind: 'available',
    });
  });

  it('parses every balance in a list', async () => {
    respond = () => ({
      status: 200,
      body: [
        { accountId: 'a', assetId: 'USDT', kind: 'available', amount: '10.5' },
        { accountId: 'b', assetId: 'USDT', kind: 'hold', amount: '2' },
      ],
    });

    const balances = await client().balances('user', USER);

    expect(balances.map((b) => formatAmount(b.amount))).toEqual(['10.5', '2']);
    for (const b of balances) expect(typeof b.amount).toBe('bigint');
    expect(balances[1]!.account).toMatchObject({ ownerType: 'user', ownerId: USER, kind: 'hold' });
  });

  it('refuses a malformed amount instead of coercing it', async () => {
    // A ledger that answered with a float would be a bug in the ledger; the
    // client's job is to refuse it, not to round it into something plausible.
    respond = () => ({ status: 200, body: { accountId: 'acc-4', amount: '97.5e2' } });
    await expect(client().balance(userAvailable(USER, 'USDT'))).rejects.toThrow();
  });
});

describe('errors', () => {
  it('preserves the ledger’s own error code rather than collapsing it', async () => {
    respond = () => ({ status: 422, body: 'ledger.insufficient_funds' });

    // On a refund these mean very different things: insufficient funds is the
    // merchant unable to cover it, frozen is an operator having stopped the
    // module. A caller that cannot tell them apart cannot act on either.
    await expect(
      client().post(
        recipes.paymentRefund({
          refundId: 'p-5:1',
          paymentId: 'p-5',
          merchantId: MERCHANT,
          merchantUserId: USER,
          assetId: 'USDT',
          amount: amt('1'),
          rail: 'card-sandbox',
          source: 'settled',
        }),
      ),
    ).rejects.toThrow(/ledger\.insufficient_funds/);
  });

  it('names the path and the status when the ledger refuses', async () => {
    respond = () => ({ status: 503, body: 'ledger.frozen' });
    await expect(client().balance(userAvailable(USER, 'USDT'))).rejects.toThrow(/\/trpc\/balance failed \(503\)/);
  });
});

/**
 * The two reads svc-pay's money paths make before they post. Both used to throw
 * "not exposed over the internal ledger API", so every first payout failed on a
 * real deployment while the in-memory ledger in the suites answered them (#4694).
 * They now call svc-ledger's read-only, service-signed `/trpc/txByKey` (#4692)
 * and `/trpc/txById` doors.
 */
describe('getTxByKey — the txByKey door', () => {
  it('asks /trpc/txByKey with the key alone, signed over the exact bytes, as svc-pay', async () => {
    respond = () => ({ status: 200, body: { found: false } });
    await client().getTxByKey('withdraw.hold:s-1:0');

    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe('http://ledger.test/trpc/txByKey');
    expect(sent[0]!.method).toBe('POST');
    expect(sent[0]!.headers['content-type']).toBe('application/json');
    expect(sent[0]!.body).toEqual({ idempotencyKey: 'withdraw.hold:s-1:0' });
    expect(verifyServiceHeaders(sent[0]!.headers, SECRET, { rawBody: retained(sent[0]!.raw), mode: 'require' })).toEqual({
      service: 'svc-pay',
      rejected: null,
      scheme: 'v2',
    });
  });

  it('answers null for a key the ledger has not booked', async () => {
    respond = () => ({ status: 200, body: { found: false } });
    await expect(client().getTxByKey('withdraw.hold:never:0')).resolves.toBeNull();
  });

  it('answers the booked transaction for a key it has', async () => {
    respond = () => ({
      status: 200,
      body: { found: true, txId: 'tx-9', hash: 'h9', postedAt: '2026-10-14T01:02:03.000Z', module: 'withdraw', reason: 'withdraw.hold' },
    });
    const tx = await client().getTxByKey('withdraw.hold:s-1:0');
    expect(tx).toMatchObject({
      id: 'tx-9',
      idempotencyKey: 'withdraw.hold:s-1:0',
      hash: 'h9',
      module: 'withdraw',
      reason: 'withdraw.hold',
      entries: [],
    });
    expect(tx?.postedAt.toISOString()).toBe('2026-10-14T01:02:03.000Z');
  });

  it('throws on an answer with no found verdict, rather than reading it as "not booked"', async () => {
    respond = () => ({ status: 200, body: { txId: 'tx-1', hash: 'h1', postedAt: '2026-10-14T00:00:00.000Z' } });
    await expect(client().getTxByKey('withdraw.hold:s-1:0')).rejects.toThrow(/found/);
    await expect(client().getTx('9d2a8a4e-6f31-4c0e-9a55-0d7f4b1c2e10')).rejects.toThrow(/found/);
  });

  it('throws when the ledger cannot answer, rather than reading it as "not booked"', async () => {
    respond = () => ({ status: 503, body: 'down' });
    await expect(client().getTxByKey('withdraw.hold:s-1:0')).rejects.toThrow(/\/trpc\/txByKey failed \(503\)/);
  });
});

describe('getTx — the txById door', () => {
  const TX_ID = '9d2a8a4e-6f31-4c0e-9a55-0d7f4b1c2e10';

  it('asks /trpc/txById with the id alone, signed over the exact bytes, as svc-pay', async () => {
    respond = () => ({ status: 200, body: { found: false } });
    await client().getTx(TX_ID);

    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe('http://ledger.test/trpc/txById');
    expect(sent[0]!.method).toBe('POST');
    expect(sent[0]!.body).toEqual({ txId: TX_ID });
    expect(verifyServiceHeaders(sent[0]!.headers, SECRET, { rawBody: retained(sent[0]!.raw), mode: 'require' })).toEqual({
      service: 'svc-pay',
      rejected: null,
      scheme: 'v2',
    });
  });

  it('answers null for an id the ledger has not booked', async () => {
    respond = () => ({ status: 200, body: { found: false } });
    await expect(client().getTx(TX_ID)).resolves.toBeNull();
  });

  it('answers the transaction with its entries, amounts as scaled bigints', async () => {
    respond = () => ({
      status: 200,
      body: {
        found: true,
        txId: TX_ID,
        idempotencyKey: 'withdraw.hold:s-1:0',
        hash: 'h1',
        postedAt: '2026-10-14T01:02:03.000Z',
        module: 'withdraw',
        reason: 'withdraw.hold',
        entries: [
          { accountId: 'a-1', assetId: 'USDT', direction: 'credit', amount: '10.000000000000000001' },
          { accountId: 'a-2', assetId: 'USDT', direction: 'debit', amount: '10.000000000000000001' },
        ],
      },
    });
    const tx = await client().getTx(TX_ID);
    expect(tx?.id).toBe(TX_ID);
    expect(tx?.idempotencyKey).toBe('withdraw.hold:s-1:0');
    expect(tx?.entries.map((e) => [e.accountId, e.assetId, e.direction, e.amount])).toEqual([
      ['a-1', 'USDT', 'credit', amt('10.000000000000000001')],
      ['a-2', 'USDT', 'debit', amt('10.000000000000000001')],
    ]);
    expect(formatAmount(tx!.entries[0]!.amount)).toBe('10.000000000000000001');
  });

  it('throws when the ledger refuses, rather than reading it as "not booked"', async () => {
    respond = () => ({ status: 400, body: { message: 'txId must be a uuid', code: 'BAD_REQUEST' } });
    await expect(client().getTx('nope')).rejects.toThrow();
  });
});
