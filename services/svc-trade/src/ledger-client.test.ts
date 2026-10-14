import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  formatAmount,
  MemoryLedger,
  parseAmount as amt,
  orderHoldAccount,
  recipes,
  userAvailable,
  type PostRequest,
} from '@intafaced/ledger-client';
import { serviceAuthHeaders, verifyServiceHeaders } from '@intafaced/contracts';
import { createLedgerClient } from './ledger-client.js';
import { fakeLedgerDoor, type DoorCall } from './ledger-door-fake.js';

function retained(body: string) {
  return { retained: true as const, bytes: Buffer.from(body, 'utf8') };
}

/**
 * THE WIRE SHAPE.
 *
 * `createLedgerClient` is a thin wrapper over the shared `createHttpLedgerClient` (signed as `svc-trade`, bounded
 * timeouts and retries). This client is the only way svc-trade touches a balance (§2, Doctrine §0.6), and the whole of
 * its job is a translation: scaled bigint in memory, decimal string on the wire.
 *
 * The failure mode is loud today: `JSON.stringify` throws on a bigint, so a missed conversion crashes rather than
 * corrupts. The temptation, faced with a stack trace about bigints, is `Number(amount)`, which makes the crash go away
 * and replaces it with a float that silently loses precision above 2^53. These tests pin the shape so that
 * "simplification" fails a test instead of shipping.
 */

const USER = '11111111-1111-4111-8111-111111111111';
const ORDER = '33333333-3333-4333-8333-333333333333';

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

  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
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

/** An order hold: the post svc-trade makes for every placed order. */
const hold = (orderId = ORDER, amount = amt('100.5')) => recipes.orderHold({ orderId, userId: USER, assetId: 'USDT', amount });

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
    await client().post(hold());

    const body = sent[0]!.body as { entries: Array<{ amount: unknown; account: unknown; direction: string }> };
    expect(body.entries).toHaveLength(2);
    for (const entry of body.entries) {
      expect(typeof entry.amount).toBe('string');
      expect(entry.amount).toBe('100.5');
    }
  });

  it('puts NO number anywhere in the payload — not one', async () => {
    await client().post(recipes.orderHoldRelease({ orderId: ORDER, userId: USER, assetId: 'USDT', amount: amt('25'), sequence: 3 }));

    // A blanket check rather than a per-field one: a future field carrying a number would otherwise slip in unnoticed.
    expect(numbersIn(sent[0]!.body)).toEqual([]);
  });

  it('survives JSON at all — a leaked bigint would throw before the request went out', async () => {
    await expect(client().post(hold(ORDER, amt('40')))).resolves.toBeDefined();
    expect(sent[0]!.raw).toContain('"amount":"40"');
  });

  it('preserves 18 decimal places exactly, where a float would not', async () => {
    const dust = '0.000000000000000001';
    await client().post(hold(ORDER, amt(dust)));

    const body = sent[0]!.body as { entries: Array<{ amount: string }> };
    expect(body.entries[0]!.amount).toBe(dust);
    // Round-trips back to the same scaled bigint — the property a float breaks.
    expect(amt(body.entries[0]!.amount)).toBe(amt(dust));
  });

  it('preserves a value far beyond what a double can represent', async () => {
    // 2^53 is where Number stops being able to count. The ledger carries 38 digits.
    const huge = '9007199254740993.000000000000000001';
    await client().post(hold(ORDER, amt(huge)));

    const body = sent[0]!.body as { entries: Array<{ amount: string }> };
    expect(body.entries[0]!.amount).toBe(huge);
    expect(Number(body.entries[0]!.amount).toString()).not.toBe(huge); // the float would have lost it
  });

  it('sends the business key, module, reason and meta the recipe decided', async () => {
    const request = hold();

    await client().post(request);

    const body = sent[0]!.body as PostRequest;
    expect(body.idempotencyKey).toBe(`order.hold:${ORDER}`);
    expect(body.module).toBe('trade');
    expect(body.reason).toBe('order.hold');
    expect(body.meta).toEqual({ orderId: ORDER });
  });

  it('posts to the ledger, as JSON, and nowhere else', async () => {
    await client().post(hold());

    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe('http://ledger.test/trpc/post');
    expect(sent[0]!.method).toBe('POST');
    expect(sent[0]!.headers['content-type']).toBe('application/json');
  });

  /**
   * The credential actually leaves the process (§2). Worth its own assertion because the failure mode is silent in the
   * wrong direction: a client that quietly omits these still works against a ledger that is not yet enforcing.
   */
  it('presents service credentials on every call', async () => {
    await client().post(hold());

    const headers = sent[0]!.headers;
    expect(headers['x-intafaced-service']).toBe('svc-trade');
    expect(headers['x-intafaced-service-sig']).toMatch(/^[0-9a-f]{64}$/);
    // v2 marker. A v1 pin (identity + timestamp, no body) used to pass here via verifyServiceCall without a digest.
    expect(headers['x-intafaced-service-body']).toMatch(/^[0-9a-f]{64}$/);

    // Verified as the ledger will after INTERNAL_SERVICE_BODY_BIND=require, against the exact bytes that left the process.
    expect(verifyServiceHeaders(headers, SECRET, { rawBody: retained(sent[0]!.raw), mode: 'require' })).toEqual({
      service: 'svc-trade',
      rejected: null,
      scheme: 'v2',
    });
  });

  /**
   * v1 signed identity and a timestamp only. A captured header plus a mutated amount still authenticated for 300
   * seconds, and ledger accept-both still admits that. Trade must not send that shape: /trpc/post carries a body digest.
   */
  it('binds /trpc/post to the body so a captured v1 header with a mutated amount is not what trade sends', async () => {
    await client().post(hold(ORDER, amt('1')));

    const captured = sent[0]!;
    expect(captured.url).toBe('http://ledger.test/trpc/post');
    expect(captured.headers['x-intafaced-service-body']).toMatch(/^[0-9a-f]{64}$/);

    const honest = captured.raw;
    const mutated = honest.replaceAll('"amount":"1"', '"amount":"99999"');
    expect(mutated).not.toBe(honest);

    expect(verifyServiceHeaders(captured.headers, SECRET, { rawBody: retained(honest), mode: 'require' })).toEqual({
      service: 'svc-trade',
      rejected: null,
      scheme: 'v2',
    });

    // Same headers, different amount — refused even under accept-both, because the bytes disagree with a checkable digest.
    expect(verifyServiceHeaders(captured.headers, SECRET, { rawBody: retained(mutated), mode: 'accept-both' }).rejected).toBe(
      'body-mismatch',
    );

    // A captured v1 header replayed with that mutated amount still verifies under accept-both. That is the hole. It is not what trade sent.
    const v1 = serviceAuthHeaders('svc-trade', SECRET);
    expect(v1['x-intafaced-service-body']).toBeUndefined();
    expect(verifyServiceHeaders(v1, SECRET, { rawBody: retained(mutated), mode: 'accept-both' }).scheme).toBe('v1');
    expect(captured.headers['x-intafaced-service-sig']).not.toBe(v1['x-intafaced-service-sig']);
  });

  it('normalises a trailing slash on the base URL rather than doubling it', async () => {
    await createLedgerClient('http://ledger.test/', SECRET).post(hold());
    expect(sent[0]!.url).toBe('http://ledger.test/trpc/post');
  });

  it('returns the ledger transaction with its own id and hash', async () => {
    const tx = await client().post(hold());

    expect(tx.id).toBe('tx-1');
    expect(tx.hash).toBe('h1');
    expect(tx.idempotencyKey).toBe(`order.hold:${ORDER}`);
    expect(tx.postedAt).toEqual(new Date('2026-07-27T12:00:00.000Z'));
  });

  it('sees a fetch installed AFTER the client was built (resolved per call, not captured)', async () => {
    const built = client();
    const seen: string[] = [];
    const inner = globalThis.fetch;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      seen.push(new URL(String(input)).pathname);
      return inner(input, init);
    }) as typeof fetch;

    await built.post(hold());
    expect(seen).toEqual(['/trpc/post']);
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

  it('parses a balance at full precision', async () => {
    respond = () => ({ status: 200, body: { accountId: 'acc-2', amount: '0.000000000000000001' } });
    const balance = await client().balance(userAvailable(USER, 'USDT'));
    expect(balance.amount).toBe(1n);
  });

  it('sends the account reference the recipe would have used', async () => {
    respond = () => ({ status: 200, body: { accountId: 'acc-3', amount: '0' } });
    await client().balance(orderHoldAccount(USER, 'USDT', ORDER));

    expect(sent[0]!.body).toEqual({ ...orderHoldAccount(USER, 'USDT', ORDER) });
    expect(sent[0]!.url).toBe('http://ledger.test/trpc/balance');
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
    // A ledger that answered with a float would be a bug in the ledger; the client's job is to refuse it.
    respond = () => ({ status: 200, body: { accountId: 'acc-4', amount: '97.5e2' } });
    await expect(client().balance(userAvailable(USER, 'USDT'))).rejects.toThrow();
  });
});

describe('errors', () => {
  it('preserves the ledger’s own error code rather than collapsing it', async () => {
    respond = () => ({ status: 422, body: 'ledger.insufficient_funds' });

    // Liquidation, amend and place all branch on this: insufficient funds and frozen mean very different things.
    await expect(client().post(hold())).rejects.toThrow(/ledger\.insufficient_funds/);
  });

  it('rebuilds a typed funds refusal that the liquidation rung code branches on (`err.code`)', async () => {
    respond = () => ({
      status: 400,
      body: {
        message: 'Insufficient USDT: requested 10, available 3',
        code: 'ledger.insufficient_funds',
        accountId: 'acct-1',
        assetId: 'USDT',
        requested: '10',
        availableBalance: '3',
      },
    });
    const error = (await client()
      .post(hold())
      .catch((e: unknown) => e)) as { code?: string; availableBalance?: string };
    expect(error.code).toBe('ledger.insufficient_funds');
    expect(error.availableBalance).toBe('3');
  });

  it('names the path and the status when the ledger refuses', async () => {
    respond = () => ({ status: 503, body: 'ledger.frozen' });
    await expect(client().balance(userAvailable(USER, 'USDT'))).rejects.toThrow(/\/trpc\/balance failed \(503\)/);
  });

  it('gives reads a smaller budget than posts: one retry, not two', async () => {
    respond = () => ({ status: 503, body: 'busy' });
    await expect(client().balance(userAvailable(USER, 'USDT'))).rejects.toThrow();
    expect(sent).toHaveLength(2);
    sent.length = 0;
    await expect(client().getTxByKey('order.release:o-1:0')).rejects.toThrow();
    expect(sent).toHaveLength(2);
  });

  it('never retries a refusal: a 4xx is the ledger’s answer, sent once', async () => {
    respond = () => ({ status: 422, body: 'ledger.insufficient_funds' });
    await expect(client().balance(userAvailable(USER, 'USDT'))).rejects.toThrow(/insufficient_funds/);
    expect(sent).toHaveLength(1);
    sent.length = 0;
    await expect(client().post(hold())).rejects.toThrow(/insufficient_funds/);
    expect(sent).toHaveLength(1);
  });
});

/**
 * The shared transport's bounded retries, as svc-trade sees them. A post is safe to retry because the ledger answers a
 * reused key with the original transaction.
 */
describe('retries — bounded, same body, re-signed', () => {
  it('retries a 503 with the identical bytes and a fresh, valid signature each attempt', async () => {
    let attempts = 0;
    respond = () => {
      attempts += 1;
      return attempts === 1
        ? { status: 503, body: 'busy' }
        : { status: 200, body: { txId: 'tx-r', hash: 'hr', postedAt: '2026-07-27T12:00:00.000Z' } };
    };

    const tx = await client().post(hold());

    expect(tx.id).toBe('tx-r');
    expect(sent).toHaveLength(2);
    expect(sent[1]!.raw).toBe(sent[0]!.raw);
    for (const attempt of sent) {
      expect(verifyServiceHeaders(attempt.headers, SECRET, { rawBody: retained(attempt.raw), mode: 'require' })).toEqual({
        service: 'svc-trade',
        rejected: null,
        scheme: 'v2',
      });
    }
  });

  it('gives up after two retries (three attempts) and throws the ledger’s refusal', async () => {
    respond = () => ({ status: 502, body: 'bad gateway' });
    await expect(client().post(hold())).rejects.toThrow(/\/trpc\/post failed \(502\)/);
    expect(sent).toHaveLength(3);
  });

  it('refuses a malformed acknowledgement as an unknown outcome, never a success', async () => {
    respond = () => ({ status: 200, body: { txId: '', hash: 'h', postedAt: 'invalid' } });
    await expect(client().post(hold())).rejects.toThrow('svc-ledger invalid post acknowledgement; outcome unknown');
  });
});

/**
 * THE CONTRACT END TO END. A fake svc-ledger door over the in-memory ledger: it verifies the signature against the
 * exact bytes it receives and answers as svc-ledger does, so what comes back is what the real ledger would have booked.
 */
describe('against a fake ledger door', () => {
  const DOOR_SECRET = 'door-internal-service-secret-32-chars!!';
  let book: MemoryLedger;
  let calls: DoorCall[];

  beforeEach(async () => {
    book = new MemoryLedger();
    calls = [];
    globalThis.fetch = fakeLedgerDoor(book, DOOR_SECRET, calls);
    await book.post(recipes.deposit({ userId: USER, assetId: 'USDT', amount: amt('1000'), rail: 'test', railRef: 'trade-door' }));
  });

  const door = () => createLedgerClient('http://ledger.test', DOOR_SECRET);

  it('authenticates as exactly svc-trade on every call (a wrong secret would be a 401)', async () => {
    const request = hold();
    await door().post(request);
    await door().getTxByKey(request.idempotencyKey);
    await door().balance(userAvailable(USER, 'USDT'));
    expect(calls.map((c) => [c.path, c.service])).toEqual([
      ['/trpc/post', 'svc-trade'],
      ['/trpc/txByKey', 'svc-trade'],
      ['/trpc/txById', 'svc-trade'],
      ['/trpc/balance', 'svc-trade'],
    ]);
    await expect(
      createLedgerClient('http://ledger.test', 'a-different-secret-of-32-characters!!').balance(userAvailable(USER, 'USDT')),
    ).rejects.toThrow(/401|unauthenticated/);
  });

  it('returns the entries the ledger booked on the post receipt, as scaled bigints', async () => {
    const request = hold();
    const tx = await door().post(request);

    expect(tx.entries).toHaveLength(request.entries.length);
    expect(tx.entries.every((e) => e.txId === tx.id)).toBe(true);
    expect(tx.entries.map((e) => [e.assetId, e.direction, e.amount]).sort()).toEqual(
      request.entries.map((e) => ['USDT', e.direction, e.amount]).sort(),
    );
    for (const entry of tx.entries) expect(typeof entry.amount).toBe('bigint');
  });

  it('reads a booked transaction back by id and by key, with the same legs', async () => {
    const request = hold();
    const posted = await door().post(request);

    const byId = await door().getTx(posted.id);
    const byKey = await door().getTxByKey(request.idempotencyKey);

    for (const read of [byId, byKey]) {
      expect(read).toMatchObject({ id: posted.id, idempotencyKey: request.idempotencyKey, module: 'trade', hash: posted.hash });
      expect(read!.entries.map((e) => [e.accountId, e.direction, e.amount]).sort()).toEqual(
        posted.entries.map((e) => [e.accountId, e.direction, e.amount]).sort(),
      );
    }
  });

  it('answers null for an unbooked key and an unbooked id', async () => {
    await expect(door().getTxByKey('order.release:never:0')).resolves.toBeNull();
    await expect(door().getTx('9d2a8a4e-6f31-4c0e-9a55-0d7f4b1c2e10')).resolves.toBeNull();
  });

  it('a retry of the same key returns the original booking, not a second one', async () => {
    const request = hold();
    const first = await door().post(request);
    const again = await door().post(request);
    expect(again.id).toBe(first.id);
    expect((await book.balance(orderHoldAccount(USER, 'USDT', ORDER))).amount).toBe(amt('100.5'));
  });

  it('rehydrates a ledger refusal with its own error text', async () => {
    // The same key with a different body is the ledger refusing, not an outage.
    await door().post(hold());
    await expect(door().post(hold(ORDER, amt('99')))).rejects.toThrow(/already booked a different movement/);
  });

  it('rebuilds a typed funds refusal from the door (what the liquidation rungs and amend branch on)', async () => {
    const error = (await door()
      .post(hold(ORDER, amt('5000')))
      .catch((e: unknown) => e)) as { code?: string };
    expect(error.code).toBe('ledger.insufficient_funds');
  });

  it('never leaks the raw secret: not in a header, a body, or an error', async () => {
    const seen: string[] = [];
    const spy = fakeLedgerDoor(book, DOOR_SECRET, calls);
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      seen.push(JSON.stringify(init?.headers ?? {}), String(init?.body ?? ''));
      return spy(input, init);
    }) as typeof fetch;

    await door().post(hold());
    const failure = await createLedgerClient('http://ledger.test', DOOR_SECRET + 'x')
      .balance(userAvailable(USER, 'USDT'))
      .catch((e: Error) => e);

    expect(failure).toBeInstanceOf(Error);
    expect(seen.length).toBeGreaterThan(0);
    for (const text of seen) {
      expect(text).not.toContain(DOOR_SECRET);
      expect(text).not.toContain(DOOR_SECRET + 'x');
    }
    expect(String((failure as Error).message)).not.toContain(DOOR_SECRET);
  });
});

/**
 * The read Convert settle makes before every post (`getTxByKey`, #4678). It used to answer identifying fields only and
 * an empty entry list; it now chains `/trpc/txByKey` to `/trpc/txById`, so a found transaction carries its real legs.
 */
describe('getTxByKey — the txByKey door, chained to txById', () => {
  const KEY_TX = '9d2a8a4e-6f31-4c0e-9a55-0d7f4b1c2e11';
  const keyHit = {
    found: true,
    txId: KEY_TX,
    hash: 'h9',
    postedAt: '2026-10-14T01:02:03.000Z',
    module: 'trade',
    reason: 'order.hold.released',
  };
  const byId = (idempotencyKey: string, txId = KEY_TX) => ({
    ...keyHit,
    txId,
    idempotencyKey,
    entries: [
      { accountId: 'a-1', assetId: 'USDT', direction: 'credit', amount: '10' },
      { accountId: 'a-2', assetId: 'USDT', direction: 'debit', amount: '10' },
    ],
  });

  it('asks /trpc/txByKey with the key alone, signed over the exact bytes, as svc-trade', async () => {
    respond = () => ({ status: 200, body: { found: false } });
    await client().getTxByKey('order.release:o-1:0');

    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe('http://ledger.test/trpc/txByKey');
    expect(sent[0]!.method).toBe('POST');
    expect(sent[0]!.body).toEqual({ idempotencyKey: 'order.release:o-1:0' });
    expect(verifyServiceHeaders(sent[0]!.headers, SECRET, { rawBody: retained(sent[0]!.raw), mode: 'require' })).toEqual({
      service: 'svc-trade',
      rejected: null,
      scheme: 'v2',
    });
  });

  it('answers null for a key the ledger has not booked', async () => {
    respond = () => ({ status: 200, body: { found: false } });
    await expect(client().getTxByKey('order.release:never:0')).resolves.toBeNull();
  });

  it('answers the booked transaction for a key it has, with its entries from /trpc/txById', async () => {
    respond = (path) => ({ status: 200, body: path === '/trpc/txByKey' ? keyHit : byId('order.release:o-1:0') });
    const tx = await client().getTxByKey('order.release:o-1:0');
    expect(sent.map((c) => new URL(c.url).pathname)).toEqual(['/trpc/txByKey', '/trpc/txById']);
    expect(sent[1]!.body).toEqual({ txId: KEY_TX });
    expect(tx).toMatchObject({
      id: KEY_TX,
      idempotencyKey: 'order.release:o-1:0',
      hash: 'h9',
      module: 'trade',
      reason: 'order.hold.released',
    });
    expect(tx?.entries).toHaveLength(2);
    expect(tx?.postedAt.toISOString()).toBe('2026-10-14T01:02:03.000Z');
  });

  it('throws when the key is found but its transaction is not, or was booked under another key', async () => {
    respond = (path) => ({ status: 200, body: path === '/trpc/txByKey' ? keyHit : { found: false } });
    await expect(client().getTxByKey('order.release:o-1:0')).rejects.toThrow(/inconsistent/);
    respond = (path) => ({ status: 200, body: path === '/trpc/txByKey' ? keyHit : byId('some-other-key') });
    await expect(client().getTxByKey('order.release:o-1:0')).rejects.toThrow(/another key/);
  });

  it('throws on an answer with no found verdict, rather than reading it as "not booked"', async () => {
    respond = () => ({ status: 200, body: { txId: 'tx-1', hash: 'h1', postedAt: '2026-10-14T00:00:00.000Z' } });
    await expect(client().getTxByKey('order.release:o-1:0')).rejects.toThrow(/malformed/);
    await expect(client().getTx('9d2a8a4e-6f31-4c0e-9a55-0d7f4b1c2e10')).rejects.toThrow(/malformed/);
  });

  it('throws when the ledger cannot answer, rather than reading it as "not booked"', async () => {
    respond = () => ({ status: 503, body: 'down' });
    await expect(client().getTxByKey('order.release:o-1:0')).rejects.toThrow(/\/trpc\/txByKey failed \(503\)/);
  });
});

describe('getTx — the txById door', () => {
  const TX_ID = '9d2a8a4e-6f31-4c0e-9a55-0d7f4b1c2e10';

  it('asks /trpc/txById with the id alone, signed over the exact bytes, as svc-trade', async () => {
    respond = () => ({ status: 200, body: { found: false } });
    await client().getTx(TX_ID);

    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe('http://ledger.test/trpc/txById');
    expect(sent[0]!.body).toEqual({ txId: TX_ID });
    expect(verifyServiceHeaders(sent[0]!.headers, SECRET, { rawBody: retained(sent[0]!.raw), mode: 'require' })).toEqual({
      service: 'svc-trade',
      rejected: null,
      scheme: 'v2',
    });
  });

  it('answers null for an id the ledger has not booked, and no longer throws "not exposed"', async () => {
    respond = () => ({ status: 200, body: { found: false } });
    await expect(client().getTx(TX_ID)).resolves.toBeNull();
  });

  it('throws when the ledger refuses, rather than reading it as "not booked"', async () => {
    respond = () => ({ status: 400, body: { message: 'txId must be a uuid', code: 'BAD_REQUEST' } });
    await expect(client().getTx('nope')).rejects.toThrow();
  });
});
