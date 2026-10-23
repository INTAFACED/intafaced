import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  formatAmount,
  MemoryLedger,
  parseAmount as amt,
  recipes,
  subAccountAvailable,
  userAvailable,
  type PostRequest,
} from '@intafaced/ledger-client';
import { serviceAuthHeaders, verifyServiceHeaders } from '@intafaced/contracts';
import { createLedgerClient, createLedgerHistory, createLedgerHistoryPages } from './ledger-client.js';
import { fakeLedgerDoor, type DoorCall } from './ledger-door-fake.js';

function retained(body: string) {
  return { retained: true as const, bytes: Buffer.from(body, 'utf8') };
}

/**
 * THE WIRE SHAPE.
 *
 * `createLedgerClient` is a thin wrapper over the shared `createHttpLedgerClient` (signed as `svc-bank`, bounded timeouts
 * and retries); the history and paged-history adapters sit on the shared transport. This client is the only way svc-bank
 * touches a balance (§2, Doctrine §0.6), and the whole of its job is a translation: scaled bigint in memory, decimal
 * string on the wire. These tests pin the shape so that a "simplification" fails a test instead of shipping.
 */

const USER = '11111111-1111-4111-8111-111111111111';
const SPACE = '33333333-3333-4333-8333-333333333333';
const TX_ID = '9d2a8a4e-6f31-4c0e-9a55-0d7f4b1c2e10';

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
  respond = () => ({ status: 200, body: { found: false } });
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
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

const transfer = (amount: string, transferId = 't-1'): PostRequest =>
  recipes.bankTransfer({
    transferId,
    occurrence: 0,
    from: userAvailable(USER, 'USDT'),
    to: subAccountAvailable(SPACE, 'USDT'),
    amount: amt(amount),
    kind: 'manual',
    lane: 'own',
  });

const ACK = { txId: 'tx-1', hash: 'h1', postedAt: '2026-07-27T12:00:00.000Z' };

describe('post — amounts leave as decimal strings', () => {
  it('serialises every entry amount as a decimal string', async () => {
    respond = () => ({ status: 200, body: ACK });
    await client().post(transfer('100.5'));

    const body = sent[0]!.body as { entries: Array<{ amount: unknown }> };
    expect(body.entries).toHaveLength(2);
    for (const entry of body.entries) {
      expect(typeof entry.amount).toBe('string');
      expect(entry.amount).toBe('100.5');
    }
  });

  it('puts NO number anywhere in the payload — not one', async () => {
    respond = () => ({ status: 200, body: ACK });
    await client().post(transfer('1000'));
    // A blanket check rather than a per-field one: a future field carrying a number would otherwise slip in unnoticed.
    // `meta` is the recipe's own bookkeeping (the occurrence counter is a plain integer there), not money.
    const { meta, ...money } = sent[0]!.body as { meta: Record<string, unknown> };
    expect(meta).toEqual({ transferId: 't-1', occurrence: 0 });
    expect(numbersIn(money)).toEqual([]);
  });

  it('preserves 18 decimal places exactly, and a value far beyond what a double can represent', async () => {
    respond = () => ({ status: 200, body: ACK });
    await client().post(transfer('0.000000000000000001', 't-tiny'));
    await client().post(transfer('90071992547409930.123456789012345678', 't-huge'));

    const amounts = sent.map((s) => (s.body as { entries: Array<{ amount: string }> }).entries[0]!.amount);
    expect(amounts).toEqual(['0.000000000000000001', '90071992547409930.123456789012345678']);
  });

  it('sends the business key, module and reason the recipe decided', async () => {
    respond = () => ({ status: 200, body: ACK });
    await client().post(transfer('1'));
    const body = sent[0]!.body as PostRequest;
    expect(body.idempotencyKey).toBe('bank.transfer.own:t-1:0');
    expect(body.module).toBe('bank');
    expect(body.reason).toBe('bank.transfer.manual');
  });

  it('posts to the ledger, as JSON, and nowhere else', async () => {
    respond = () => ({ status: 200, body: ACK });
    await client().post(transfer('1'));
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe('http://ledger.test/trpc/post');
    expect(sent[0]!.method).toBe('POST');
    expect(sent[0]!.headers['content-type']).toBe('application/json');
  });

  /**
   * The credential actually leaves the process (§2). The failure mode is silent in the wrong direction: a client that
   * quietly omits these still works against a ledger that is not yet enforcing, and breaks only where it matters.
   */
  it('presents service credentials on every call, as svc-bank, bound to the body', async () => {
    respond = () => ({ status: 200, body: ACK });
    await client().post(transfer('1'));

    const headers = sent[0]!.headers;
    expect(headers['x-intafaced-service']).toBe('svc-bank');
    expect(headers['x-intafaced-service-sig']).toMatch(/^[0-9a-f]{64}$/);
    expect(headers['x-intafaced-service-body']).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyServiceHeaders(headers, SECRET, { rawBody: retained(sent[0]!.raw), mode: 'require' })).toEqual({
      service: 'svc-bank',
      rejected: null,
      scheme: 'v2',
    });
  });

  /**
   * T-04 / L2-6. v1 signed identity and a timestamp only: a captured header plus a mutated amount still authenticated for
   * 300 seconds, and a ledger on accept-both still admits that. Bank must not send that shape.
   */
  it('binds /trpc/post to the body so a captured v1 header with a mutated amount is not what bank sends', async () => {
    respond = () => ({ status: 200, body: ACK });
    await client().post(transfer('1'));

    const captured = sent[0]!;
    const honest = captured.raw;
    const mutated = honest.replaceAll('"amount":"1"', '"amount":"99999"');
    expect(mutated).not.toBe(honest);

    expect(verifyServiceHeaders(captured.headers, SECRET, { rawBody: retained(honest), mode: 'require' })).toEqual({
      service: 'svc-bank',
      rejected: null,
      scheme: 'v2',
    });
    expect(verifyServiceHeaders(captured.headers, SECRET, { rawBody: retained(mutated), mode: 'accept-both' }).rejected).toBe(
      'body-mismatch',
    );

    const v1 = serviceAuthHeaders('svc-bank', SECRET);
    expect(v1['x-intafaced-service-body']).toBeUndefined();
    expect(verifyServiceHeaders(v1, SECRET, { rawBody: retained(mutated), mode: 'accept-both' }).scheme).toBe('v1');
    expect(captured.headers['x-intafaced-service-sig']).not.toBe(v1['x-intafaced-service-sig']);
  });

  it('normalises a trailing slash on the base URL rather than doubling it', async () => {
    respond = () => ({ status: 200, body: ACK });
    await createLedgerClient('http://ledger.test/', SECRET).post(transfer('1'));
    expect(sent[0]!.url).toBe('http://ledger.test/trpc/post');
  });

  it('returns the ledger transaction with its own id and hash', async () => {
    respond = () => ({ status: 200, body: ACK });
    const tx = await client().post(transfer('1'));
    expect(tx.id).toBe('tx-1');
    expect(tx.hash).toBe('h1');
    expect(tx.idempotencyKey).toBe('bank.transfer.own:t-1:0');
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

  it('sends the account reference the recipe would have used', async () => {
    respond = () => ({ status: 200, body: { accountId: 'acc-3', amount: '0' } });
    await client().balance(subAccountAvailable(SPACE, 'USDT'));
    expect(sent[0]!.body).toEqual(subAccountAvailable(SPACE, 'USDT'));
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
    respond = () => ({ status: 200, body: { accountId: 'acc-4', amount: '97.5e2' } });
    await expect(client().balance(userAvailable(USER, 'USDT'))).rejects.toThrow();
  });
});

describe('errors', () => {
  it('preserves the ledger’s own error code rather than collapsing it', async () => {
    respond = () => ({ status: 422, body: 'ledger.insufficient_funds' });
    await expect(client().post(transfer('1'))).rejects.toThrow(/ledger\.insufficient_funds/);
  });

  it('names the path and the status when the ledger refuses', async () => {
    respond = () => ({ status: 503, body: 'ledger.frozen' });
    await expect(client().balance(userAvailable(USER, 'USDT'))).rejects.toThrow(/\/trpc\/balance failed \(503\)/);
  });

  it('gives reads a smaller budget than posts: one retry, not two', async () => {
    // Reads run inside earn.withdraw's transaction (stake pot, then the post), so they are bounded tighter than the post.
    respond = () => ({ status: 503, body: 'busy' });
    await expect(client().balance(userAvailable(USER, 'USDT'))).rejects.toThrow();
    expect(sent).toHaveLength(2);
    sent.length = 0;
    await expect(client().getTxByKey('bank.transfer:t-1:0')).rejects.toThrow();
    expect(sent).toHaveLength(2);
  });

  it('never retries a refusal: a 4xx is the ledger’s answer, sent once', async () => {
    respond = () => ({ status: 422, body: 'ledger.insufficient_funds' });
    await expect(client().balance(userAvailable(USER, 'USDT'))).rejects.toThrow(/insufficient_funds/);
    expect(sent).toHaveLength(1);
  });
});

/**
 * The shared transport's bounded retries, as svc-bank sees them (earn withdraw and a scheduled transfer post while a bank
 * transaction is open). A post is safe to retry because the ledger answers a reused key with the original transaction.
 */
describe('retries — bounded, same body, re-signed', () => {
  it('retries a 503 with the identical bytes and a fresh, valid signature each attempt', async () => {
    let attempts = 0;
    respond = () => {
      attempts += 1;
      return attempts === 1 ? { status: 503, body: 'busy' } : { status: 200, body: { ...ACK, txId: 'tx-r', hash: 'hr' } };
    };

    const tx = await client().post(transfer('1'));

    expect(tx.id).toBe('tx-r');
    expect(sent).toHaveLength(2);
    expect(sent[1]!.raw).toBe(sent[0]!.raw);
    for (const attempt of sent) {
      expect(verifyServiceHeaders(attempt.headers, SECRET, { rawBody: retained(attempt.raw), mode: 'require' })).toEqual({
        service: 'svc-bank',
        rejected: null,
        scheme: 'v2',
      });
    }
  });

  it('gives up after two retries (three attempts) and throws the ledger’s refusal', async () => {
    respond = () => ({ status: 502, body: 'bad gateway' });
    await expect(client().post(transfer('1'))).rejects.toThrow(/\/trpc\/post failed \(502\)/);
    expect(sent).toHaveLength(3);
  });

  it('refuses a malformed acknowledgement as an unknown outcome, never a success', async () => {
    respond = () => ({ status: 200, body: { txId: '', hash: 'h', postedAt: 'invalid' } });
    await expect(client().post(transfer('1'))).rejects.toThrow('svc-ledger invalid post acknowledgement; outcome unknown');
  });
});

/**
 * THE CONTRACT END TO END. A fake svc-ledger door over the in-memory ledger: it verifies the signature against the exact
 * bytes it receives and answers as svc-ledger does, so what comes back is what the real ledger would have booked.
 */
describe('against a fake ledger door', () => {
  const DOOR_SECRET = 'door-internal-service-secret-32-chars!!';
  let book: MemoryLedger;
  let calls: DoorCall[];

  beforeEach(async () => {
    book = new MemoryLedger();
    calls = [];
    globalThis.fetch = fakeLedgerDoor(book, DOOR_SECRET, calls);
    await book.post(recipes.deposit({ userId: USER, assetId: 'USDT', amount: amt('500'), rail: 'test', railRef: 'seed' }));
  });

  const door = () => createLedgerClient('http://ledger.test', DOOR_SECRET);

  it('authenticates as exactly svc-bank on every call (a wrong secret would be a 401)', async () => {
    const request = transfer('10');
    await door().post(request);
    await door().getTxByKey(request.idempotencyKey);
    await door().balance(userAvailable(USER, 'USDT'));
    expect(calls.map((c) => [c.path, c.service])).toEqual([
      ['/trpc/post', 'svc-bank'],
      ['/trpc/txByKey', 'svc-bank'],
      ['/trpc/txById', 'svc-bank'],
      ['/trpc/balance', 'svc-bank'],
    ]);
    await expect(
      createLedgerClient('http://ledger.test', 'a-different-secret-of-32-characters!!').balance(userAvailable(USER, 'USDT')),
    ).rejects.toThrow(/401|unauthenticated/);
  });

  it('returns the entries the ledger booked on the post receipt, as scaled bigints', async () => {
    const request = transfer('12.5');
    const tx = await door().post(request);

    expect(tx.entries).toHaveLength(request.entries.length);
    expect(tx.entries.every((e) => e.txId === tx.id)).toBe(true);
    expect(tx.entries.map((e) => [e.assetId, e.direction, e.amount]).sort()).toEqual(
      request.entries.map((e) => ['USDT', e.direction, e.amount]).sort(),
    );
    for (const entry of tx.entries) expect(typeof entry.amount).toBe('bigint');
  });

  it('reads a booked transaction back by id and by key, with the same legs', async () => {
    const request = transfer('10');
    const posted = await door().post(request);

    const byId = await door().getTx(posted.id);
    const byKey = await door().getTxByKey(request.idempotencyKey);

    for (const read of [byId, byKey]) {
      expect(read).toMatchObject({ id: posted.id, idempotencyKey: request.idempotencyKey, module: 'bank', hash: posted.hash });
      expect(read!.entries.map((e) => [e.accountId, e.direction, e.amount]).sort()).toEqual(
        posted.entries.map((e) => [e.accountId, e.direction, e.amount]).sort(),
      );
    }
  });

  it('answers null for an unbooked key and an unbooked id', async () => {
    await expect(door().getTxByKey('bank.transfer:never:0')).resolves.toBeNull();
    await expect(door().getTx(TX_ID)).resolves.toBeNull();
  });

  it('a retry of the same key returns the original booking, not a second one', async () => {
    const request = transfer('10');
    const first = await door().post(request);
    const again = await door().post(request);
    expect(again.id).toBe(first.id);
    expect((await book.balance(subAccountAvailable(SPACE, 'USDT'))).amount).toBe(amt('10'));
  });

  it('rehydrates a ledger refusal with its own error text', async () => {
    // The same key with a different body is the ledger refusing, not an outage.
    await door().post(transfer('10'));
    await expect(door().post(transfer('20'))).rejects.toThrow(/already booked a different movement/);
  });

  it('never leaks the raw secret: not in a header, a body, or an error', async () => {
    const seen: string[] = [];
    const spy = fakeLedgerDoor(book, DOOR_SECRET, calls);
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      seen.push(JSON.stringify(init?.headers ?? {}), String(init?.body ?? ''));
      return spy(input, init);
    }) as typeof fetch;

    await door().post(transfer('10'));
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
 * The two reads svc-bank's money paths make before they post. Both used to throw "not exposed over the internal ledger
 * API", so every immediate business transfer and every card cashback settle failed on a real deployment while the
 * in-memory ledger in the suites answered them (#4694). They call svc-ledger's read-only, service-signed `/trpc/txByKey`
 * (#4692) and `/trpc/txById` doors; a key hit is chained to txById so the result carries the real entries.
 */
describe('getTxByKey — the txByKey door, chained to txById', () => {
  const KEY_TX = '9d2a8a4e-6f31-4c0e-9a55-0d7f4b1c2e11';
  const keyHit = { found: true, txId: KEY_TX, hash: 'h9', postedAt: '2026-10-14T01:02:03.000Z', module: 'bank', reason: 'bank.transfer' };
  const byId = (idempotencyKey: string) => ({
    found: true,
    txId: KEY_TX,
    idempotencyKey,
    hash: 'h9',
    postedAt: '2026-10-14T01:02:03.000Z',
    module: 'bank',
    reason: 'bank.transfer',
    entries: [
      { accountId: 'a-1', assetId: 'USDT', direction: 'credit', amount: '10' },
      { accountId: 'a-2', assetId: 'USDT', direction: 'debit', amount: '10' },
    ],
  });

  it('asks /trpc/txByKey with the key alone, signed over the exact bytes, as svc-bank', async () => {
    respond = () => ({ status: 200, body: { found: false } });
    await client().getTxByKey('bank.transfer:t-1:0');

    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe('http://ledger.test/trpc/txByKey');
    expect(sent[0]!.method).toBe('POST');
    expect(sent[0]!.headers['content-type']).toBe('application/json');
    expect(sent[0]!.body).toEqual({ idempotencyKey: 'bank.transfer:t-1:0' });
    expect(verifyServiceHeaders(sent[0]!.headers, SECRET, { rawBody: retained(sent[0]!.raw), mode: 'require' })).toEqual({
      service: 'svc-bank',
      rejected: null,
      scheme: 'v2',
    });
  });

  it('answers null for a key the ledger has not booked', async () => {
    respond = () => ({ status: 200, body: { found: false } });
    await expect(client().getTxByKey('bank.transfer:never:0')).resolves.toBeNull();
  });

  it('answers the booked transaction for a key it has, with its entries from /trpc/txById', async () => {
    respond = (path) => ({ status: 200, body: path === '/trpc/txByKey' ? keyHit : byId('bank.transfer:t-1:0') });
    const tx = await client().getTxByKey('bank.transfer:t-1:0');
    expect(sent.map((c) => new URL(c.url).pathname)).toEqual(['/trpc/txByKey', '/trpc/txById']);
    expect(sent[1]!.body).toEqual({ txId: KEY_TX });
    expect(tx).toMatchObject({
      id: KEY_TX,
      idempotencyKey: 'bank.transfer:t-1:0',
      hash: 'h9',
      module: 'bank',
      reason: 'bank.transfer',
    });
    // Before the shared client this was `entries: []`: a receipt read by key carried no legs to compare.
    expect(tx?.entries).toHaveLength(2);
    expect(tx?.postedAt.toISOString()).toBe('2026-10-14T01:02:03.000Z');
  });

  it('throws when the key is found but its transaction is not, or was booked under another key', async () => {
    respond = (path) => ({ status: 200, body: path === '/trpc/txByKey' ? keyHit : { found: false } });
    await expect(client().getTxByKey('bank.transfer:t-1:0')).rejects.toThrow(/inconsistent/);
    respond = (path) => ({ status: 200, body: path === '/trpc/txByKey' ? keyHit : byId('some-other-key') });
    await expect(client().getTxByKey('bank.transfer:t-1:0')).rejects.toThrow(/another key/);
  });

  it('throws on an answer with no found verdict, rather than reading it as "not booked"', async () => {
    respond = () => ({ status: 200, body: { txId: 'tx-1', hash: 'h1', postedAt: '2026-10-14T00:00:00.000Z' } });
    await expect(client().getTxByKey('bank.transfer:t-1:0')).rejects.toThrow(/malformed/);
    await expect(client().getTx(TX_ID)).rejects.toThrow(/malformed/);
  });

  it('throws when the ledger cannot answer, rather than reading it as "not booked"', async () => {
    respond = () => ({ status: 503, body: 'down' });
    await expect(client().getTxByKey('bank.transfer:t-1:0')).rejects.toThrow(/\/trpc\/txByKey failed \(503\)/);
  });
});

describe('getTx — the txById door', () => {
  it('asks /trpc/txById with the id alone, signed over the exact bytes, as svc-bank', async () => {
    respond = () => ({ status: 200, body: { found: false } });
    await client().getTx(TX_ID);

    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe('http://ledger.test/trpc/txById');
    expect(sent[0]!.method).toBe('POST');
    expect(sent[0]!.body).toEqual({ txId: TX_ID });
    expect(verifyServiceHeaders(sent[0]!.headers, SECRET, { rawBody: retained(sent[0]!.raw), mode: 'require' })).toEqual({
      service: 'svc-bank',
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
        idempotencyKey: 'bank.transfer:t-1:0',
        hash: 'h1',
        postedAt: '2026-10-14T01:02:03.000Z',
        module: 'bank',
        reason: 'bank.transfer',
        entries: [
          { accountId: 'a-1', assetId: 'USDT', direction: 'credit', amount: '10.000000000000000001' },
          { accountId: 'a-2', assetId: 'USDT', direction: 'debit', amount: '10.000000000000000001' },
        ],
      },
    });
    const tx = await client().getTx(TX_ID);
    expect(tx?.id).toBe(TX_ID);
    expect(tx?.idempotencyKey).toBe('bank.transfer:t-1:0');
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

/**
 * The two history adapters ride the shared transport with their own, more patient read budget (a range scan, no
 * transaction open). They keep the §13 rule: a failure is thrown, never an empty answer.
 */
describe('history adapters — signed as svc-bank, bounded, never empty on failure', () => {
  const range = { from: new Date('2026-01-01T00:00:00Z'), to: new Date('2026-02-01T00:00:00Z') };
  const entry = {
    txId: 't1',
    module: 'bank',
    reason: 'bank.transfer.manual',
    direction: 'debit',
    amount: '10.5',
    postedAt: '2026-01-02T00:00:00.000Z',
  };

  it('entriesFor posts to /trpc/history signed over the exact bytes, and parses amounts to bigints', async () => {
    respond = () => ({ status: 200, body: [entry] });
    const out = await createLedgerHistory('http://ledger.test/', SECRET).entriesFor(userAvailable(USER, 'USDT'), range);

    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe('http://ledger.test/trpc/history');
    expect(sent[0]!.body).toEqual({
      account: userAvailable(USER, 'USDT'),
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-02-01T00:00:00.000Z',
    });
    expect(verifyServiceHeaders(sent[0]!.headers, SECRET, { rawBody: retained(sent[0]!.raw), mode: 'require' }).service).toBe('svc-bank');
    expect(out).toEqual([{ ...entry, amount: amt('10.5'), postedAt: new Date('2026-01-02T00:00:00.000Z') }]);
  });

  it('historyPage posts to /trpc/historyPage signed as svc-bank', async () => {
    respond = () => ({ status: 200, body: { entries: [], nextCursor: null } });
    await createLedgerHistoryPages('http://ledger.test', SECRET).page({ ownerType: 'user', ownerId: USER, kind: 'available', limit: 5 });

    expect(sent[0]!.url).toBe('http://ledger.test/trpc/historyPage');
    expect(verifyServiceHeaders(sent[0]!.headers, SECRET, { rawBody: retained(sent[0]!.raw), mode: 'require' }).service).toBe('svc-bank');
  });

  it('retries a 503 once with the same bytes, then answers; a second 503 is thrown, not an empty list', async () => {
    let attempts = 0;
    respond = () => {
      attempts += 1;
      return attempts === 1 ? { status: 503, body: 'busy' } : { status: 200, body: [entry] };
    };
    const history = createLedgerHistory('http://ledger.test', SECRET);
    await expect(history.entriesFor(userAvailable(USER, 'USDT'), range)).resolves.toHaveLength(1);
    expect(sent).toHaveLength(2);
    expect(sent[1]!.raw).toBe(sent[0]!.raw);

    sent.length = 0;
    respond = () => ({ status: 503, body: 'busy' });
    await expect(history.entriesFor(userAvailable(USER, 'USDT'), range)).rejects.toThrow(/\/trpc\/history failed \(503\)/);
    expect(sent).toHaveLength(2);
  });

  it('never retries a refusal or a missing procedure: a 404 is sent once and thrown', async () => {
    respond = () => ({ status: 404, body: { message: 'procedure not found', code: 'NOT_FOUND' } });
    await expect(createLedgerHistory('http://ledger.test', SECRET).entriesFor(userAvailable(USER, 'USDT'), range)).rejects.toThrow();
    expect(sent).toHaveLength(1);
  });
});
