import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  formatAmount,
  InsufficientFundsError,
  LedgerError,
  MemoryLedger,
  mintBoundary,
  parseAmount as amt,
  recipes,
  houseFees,
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
 * `createLedgerClient` is a thin wrapper over the shared `createHttpLedgerClient` (signed as `svc-agents`, bounded
 * timeouts and retries). This client is the only way svc-agents touches a balance (§2, Doctrine §0.6), and the whole of
 * its job is a translation: scaled bigint in memory, decimal string on the wire.
 *
 * The failure mode is loud today — `JSON.stringify` throws on a bigint, so a missed conversion crashes rather than
 * corrupts. That is exactly why this file exists. The temptation, faced with a stack trace about bigints, is to reach
 * for `Number(amount)`, which makes the crash go away and replaces it with a float that silently loses precision above
 * 2^53 and misrepresents 0.1 forever after. These tests pin the shape so that "simplification" fails a test instead of
 * shipping.
 */

// ── SERVICE-SPECIFIC ─────────────────────────────────────────────────────────
const SERVICE = 'svc-agents';
const ASSET = 'IFC';
const USER = '11111111-1111-4111-8111-111111111111';

/** The service's one money movement (a metered usage window), as its own recipe builds it. */
const movement = (id = 'p-1', amount = '1'): PostRequest =>
  recipes.feeCharge({
    chargeId: id,
    userId: USER,
    module: 'agents',
    mode: 'asset',
    assetId: ASSET,
    amount: amt(amount),
    reason: 'agents.usage.metered',
  });
/** The same recipe for a different window and size, for the key/module/reason assertions. */
const secondMovement = (amount = '100'): PostRequest => movement('sess-1:win-1', amount);
const MOVEMENT_KEY = (id: string) => `fee:agents:${id}`;
const SECOND_KEY = 'fee:agents:sess-1:win-1';
const SECOND_MODULE = 'agents';
const SECOND_REASON = 'agents.usage.metered';
/** An account the service could read, and the wire body that read must send. */
const READ_REF = houseFees('agents', ASSET);
const READ_BODY = { ownerType: 'house', ownerId: 'fees:agents', assetId: ASSET, kind: 'available' };
/** A movement that needs no funding: new supply enters at the mint boundary. */
const unfundedMovement = (key: string, amount: string): PostRequest => ({
  idempotencyKey: key,
  module: 'agents',
  reason: 'test',
  entries: [
    { account: mintBoundary(ASSET), direction: 'credit', amount: amt(amount) },
    { account: userAvailable(USER, ASSET), direction: 'debit', amount: amt(amount) },
  ],
});
/** Put the user in funds on a fresh book, so `movement()` can post against the in-memory ledger. */
const fund = (book: MemoryLedger) => book.post(unfundedMovement('seed:funds', '1000'));
/** Integer fields that are not amounts, allowed in the payload. */
const ALLOWED_NUMBER_PATHS: string[] = [];
// ── END SERVICE-SPECIFIC ─────────────────────────────────────────────────────

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
    await client().post(movement('p-amt', '100.5'));

    const body = sent[0]!.body as { entries: Array<{ amount: unknown; account: unknown; direction: string }> };
    expect(body.entries).toHaveLength(2);
    for (const entry of body.entries) {
      expect(typeof entry.amount).toBe('string');
      expect(entry.amount).toBe('100.5');
    }
  });

  it('puts NO number anywhere in the payload — not one', async () => {
    await client().post(secondMovement('1000'));

    // A blanket check rather than a per-field one: a future field carrying a number would otherwise slip in unnoticed
    // beside the ones asserted above.
    expect(numbersIn(sent[0]!.body).filter((path) => !ALLOWED_NUMBER_PATHS.includes(path))).toEqual([]);
  });

  it('survives JSON at all — a leaked bigint would throw before the request went out', async () => {
    // The regression this guards: dropping `formatAmount` and passing the bigint straight through. `JSON.stringify`
    // throws on bigint, so the failure is loud — but only if something exercises the path.
    await expect(client().post(movement('p-json', '40'))).resolves.toBeDefined();

    expect(sent[0]!.raw).toContain('"amount":"40"');
  });

  it('preserves 18 decimal places exactly, where a float would not', async () => {
    const dust = '0.000000000000000001';
    await client().post(movement('p-dust', dust));

    const body = sent[0]!.body as { entries: Array<{ amount: string }> };
    expect(body.entries[0]!.amount).toBe(dust);
    // Round-trips back to the same scaled bigint — the property a float breaks.
    expect(amt(body.entries[0]!.amount)).toBe(amt(dust));
  });

  it('preserves a value far beyond what a double can represent', async () => {
    // 2^53 is where Number stops being able to count. The ledger carries 38 digits, so this is an ordinary amount to it
    // and an impossible one to a float.
    const huge = '9007199254740993.000000000000000001';
    await client().post(unfundedMovement('huge-amount-test', huge));

    const body = sent[0]!.body as { entries: Array<{ amount: string }> };
    expect(body.entries[0]!.amount).toBe(huge);
    expect(Number(body.entries[0]!.amount).toString()).not.toBe(huge); // the float would have lost it
  });

  it('sends the business key, module and reason the recipe decided', async () => {
    await client().post(secondMovement('100'));

    const body = sent[0]!.body as PostRequest;
    expect(body.idempotencyKey).toBe(SECOND_KEY);
    expect(body.module).toBe(SECOND_MODULE);
    expect(body.reason).toBe(SECOND_REASON);
  });

  it('posts to the ledger, as JSON, and nowhere else', async () => {
    await client().post(movement('p-2'));

    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe('http://ledger.test/trpc/post');
    expect(sent[0]!.method).toBe('POST');
    expect(sent[0]!.headers['content-type']).toBe('application/json');
  });

  /**
   * The credential actually leaves the process (§2).
   *
   * Worth its own assertion because the failure mode is silent in the wrong direction: a client that quietly omits
   * these still works against a ledger that is not yet enforcing, and breaks only where it matters. `post` is a
   * `serviceProcedure` now — an unsigned call is refused.
   */
  it('presents service credentials on every call', async () => {
    await client().post(movement('p-auth'));

    const headers = sent[0]!.headers;
    expect(headers['x-intafaced-service']).toBe(SERVICE);
    expect(headers['x-intafaced-service-sig']).toMatch(/^[0-9a-f]{64}$/);
    // v2 marker. A v1 pin (identity + timestamp, no body) used to pass here via verifyServiceCall without a digest —
    // that is the hole this closes.
    expect(headers['x-intafaced-service-body']).toMatch(/^[0-9a-f]{64}$/);

    // Verified as the ledger will after INTERNAL_SERVICE_BODY_BIND=require, against the exact bytes that left the process.
    expect(
      verifyServiceHeaders(headers, SECRET, {
        rawBody: retained(sent[0]!.raw),
        mode: 'require',
      }),
    ).toEqual({ service: SERVICE, rejected: null, scheme: 'v2' });
  });

  /**
   * v1 signed identity and a timestamp only. A captured header plus a mutated amount still authenticated for 300
   * seconds, and ledger accept-both still admits that. svc-agents must not send that shape: /trpc/post carries a body
   * digest, so a v1 replay of a different amount is not what left this client.
   */
  it('binds /trpc/post to the body so a captured v1 header with a mutated amount is not what svc-agents sends', async () => {
    await client().post(movement('p-bind', '1'));

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
    ).toEqual({ service: SERVICE, rejected: null, scheme: 'v2' });

    // Same headers, different amount — refused even under accept-both, because the bytes disagree with a digest we can
    // actually check.
    expect(
      verifyServiceHeaders(captured.headers, SECRET, {
        rawBody: retained(mutated),
        mode: 'accept-both',
      }).rejected,
    ).toBe('body-mismatch');

    // A captured v1 header replayed with that mutated amount still verifies under accept-both. That is the hole. It is
    // not what this service sent.
    const v1 = serviceAuthHeaders(SERVICE, SECRET);
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
    await createLedgerClient('http://ledger.test/', SECRET).post(movement('p-3'));
    expect(sent[0]!.url).toBe('http://ledger.test/trpc/post');
  });

  it('returns the ledger transaction with its own id and hash', async () => {
    const tx = await client().post(movement('p-4'));

    expect(tx.id).toBe('tx-1');
    expect(tx.hash).toBe('h1');
    expect(tx.idempotencyKey).toBe(MOVEMENT_KEY('p-4'));
    expect(tx.postedAt).toEqual(new Date('2026-07-27T12:00:00.000Z'));
  });

  it('resolves fetch per call, so a fetch installed after the client was built still sees the call', async () => {
    const built = client();
    const seen: string[] = [];
    const inner = globalThis.fetch;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      seen.push(new URL(String(input)).pathname);
      return inner(input, init);
    }) as typeof fetch;

    await built.post(movement('p-late'));
    expect(seen).toEqual(['/trpc/post']);
  });
});

describe('balances — amounts come back as decimal strings and become bigints', () => {
  it('parses a balance into a scaled bigint', async () => {
    respond = () => ({ status: 200, body: { accountId: 'acc-1', amount: '97.5' } });

    const balance = await client().balance(userAvailable(USER, ASSET));

    expect(typeof balance.amount).toBe('bigint');
    expect(balance.amount).toBe(amt('97.5'));
    expect(formatAmount(balance.amount)).toBe('97.5');
  });

  it('parses a balance at full precision', async () => {
    respond = () => ({ status: 200, body: { accountId: 'acc-2', amount: '0.000000000000000001' } });
    const balance = await client().balance(READ_REF);
    expect(balance.amount).toBe(1n);
  });

  it('sends the account reference the service asked about', async () => {
    respond = () => ({ status: 200, body: { accountId: 'acc-3', amount: '0' } });
    await client().balance(READ_REF);

    expect(sent[0]!.body).toEqual(READ_BODY);
  });

  it('parses every balance in a list', async () => {
    respond = () => ({
      status: 200,
      body: [
        { accountId: 'a', assetId: ASSET, kind: 'available', amount: '10.5' },
        { accountId: 'b', assetId: ASSET, kind: 'hold', amount: '2' },
      ],
    });

    const balances = await client().balances('user', USER);

    expect(balances.map((b) => formatAmount(b.amount))).toEqual(['10.5', '2']);
    for (const b of balances) expect(typeof b.amount).toBe('bigint');
    expect(balances[1]!.account).toMatchObject({ ownerType: 'user', ownerId: USER, kind: 'hold' });
  });

  it('refuses a malformed amount instead of coercing it', async () => {
    // A ledger that answered with a float would be a bug in the ledger; the client's job is to refuse it, not to round
    // it into something plausible.
    respond = () => ({ status: 200, body: { accountId: 'acc-4', amount: '97.5e2' } });
    await expect(client().balance(userAvailable(USER, ASSET))).rejects.toThrow();
  });
});

describe('errors', () => {
  it('preserves the ledger’s own error code rather than collapsing it', async () => {
    respond = () => ({ status: 422, body: 'ledger.insufficient_funds' });

    // 'insufficient funds' is a user who cannot cover it, 'frozen' is an operator having stopped the module. A caller
    // that cannot tell them apart cannot act on either.
    await expect(client().post(movement('p-5'))).rejects.toThrow(/ledger\.insufficient_funds/);
  });

  it('rebuilds InsufficientFundsError from a 400 with its amounts: a user who cannot cover their usage is a typed refusal', async () => {
    respond = () => ({
      status: 400,
      body: {
        message: 'Insufficient IFC: requested 5, available 2',
        code: 'ledger.insufficient_funds',
        accountId: 'a-1',
        assetId: ASSET,
        requested: '5',
        availableBalance: '2',
      },
    });
    const err = await client()
      .post(movement('p-funds'))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InsufficientFundsError);
    expect(sent).toHaveLength(1);
  });

  it('keeps a frozen ledger a LedgerError with its code, and does not retry it', async () => {
    respond = () => ({ status: 412, body: { message: 'frozen', code: 'ledger.frozen' } });
    const err = await client()
      .post(movement('p-frozen'))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LedgerError);
    expect((err as LedgerError).code).toBe('ledger.frozen');
    expect(sent).toHaveLength(1);
  });

  it('names the path and the status when the ledger refuses', async () => {
    respond = () => ({ status: 503, body: 'ledger.frozen' });
    await expect(client().balance(userAvailable(USER, ASSET))).rejects.toThrow(/\/trpc\/balance failed \(503\)/);
  });

  it('gives reads a smaller budget than posts: one retry, not two', async () => {
    // svc-agents only posts today, but any read it gains would run beside open work, so reads are bounded tighter than
    // the post.
    respond = () => ({ status: 503, body: 'busy' });
    await expect(client().balance(userAvailable(USER, ASSET))).rejects.toThrow();
    expect(sent).toHaveLength(2);
    sent.length = 0;
    await expect(client().getTxByKey('fee:agents:s-1:w-1')).rejects.toThrow();
    expect(sent).toHaveLength(2);
  });

  it('never retries a refusal: a 4xx is the ledger’s answer, sent once', async () => {
    respond = () => ({ status: 422, body: 'ledger.insufficient_funds' });
    await expect(client().balance(userAvailable(USER, ASSET))).rejects.toThrow(/insufficient_funds/);
    expect(sent).toHaveLength(1);
  });
});

/**
 * The shared transport's bounded retries, as svc-agents sees them. A post is safe to retry because the ledger answers a
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

    const tx = await client().post(movement('p-retry'));

    expect(tx.id).toBe('tx-r');
    expect(sent).toHaveLength(2);
    expect(sent[1]!.raw).toBe(sent[0]!.raw);
    for (const attempt of sent) {
      expect(verifyServiceHeaders(attempt.headers, SECRET, { rawBody: retained(attempt.raw), mode: 'require' })).toEqual({
        service: SERVICE,
        rejected: null,
        scheme: 'v2',
      });
    }
  });

  it('gives up after two retries (three attempts) and throws the ledger’s refusal', async () => {
    respond = () => ({ status: 502, body: 'bad gateway' });
    await expect(client().post(movement('p-502'))).rejects.toThrow(/\/trpc\/post failed \(502\)/);
    expect(sent).toHaveLength(3);
  });

  it('refuses a malformed acknowledgement as an unknown outcome, never a success', async () => {
    respond = () => ({ status: 200, body: { txId: '', hash: 'h', postedAt: 'invalid' } });
    await expect(client().post(movement('p-bad-ack'))).rejects.toThrow('svc-ledger invalid post acknowledgement; outcome unknown');
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
    await fund(book);
    calls = [];
    globalThis.fetch = fakeLedgerDoor(book, DOOR_SECRET, calls);
  });

  const door = () => createLedgerClient('http://ledger.test', DOOR_SECRET);
  const request = (id = 'p-door') => movement(id, '12.5');

  it(`authenticates as exactly ${SERVICE} on every call (a wrong secret would be a 401)`, async () => {
    const req = request();
    await door().post(req);
    await door().getTxByKey(req.idempotencyKey);
    await door().balance(READ_REF);
    expect(calls.map((c) => [c.path, c.service])).toEqual([
      ['/trpc/post', SERVICE],
      ['/trpc/txByKey', SERVICE],
      ['/trpc/txById', SERVICE],
      ['/trpc/balance', SERVICE],
    ]);
    await expect(
      createLedgerClient('http://ledger.test', 'a-different-secret-of-32-characters!!').balance(userAvailable(USER, ASSET)),
    ).rejects.toThrow(/401|unauthenticated/);
  });

  it('returns the entries the ledger booked on the post receipt, as scaled bigints', async () => {
    const req = request();
    const tx = await door().post(req);

    expect(tx.entries).toHaveLength(req.entries.length);
    expect(tx.entries.every((e) => e.txId === tx.id)).toBe(true);
    expect(tx.entries.map((e) => [e.assetId, e.direction, e.amount]).sort()).toEqual(
      req.entries.map((e) => [ASSET, e.direction, e.amount]).sort(),
    );
    for (const entry of tx.entries) expect(typeof entry.amount).toBe('bigint');
  });

  it('reads a booked transaction back by id and by key, with the same legs', async () => {
    const req = request();
    const posted = await door().post(req);

    const byId = await door().getTx(posted.id);
    const byKey = await door().getTxByKey(req.idempotencyKey);

    for (const read of [byId, byKey]) {
      expect(read).toMatchObject({ id: posted.id, idempotencyKey: req.idempotencyKey, module: 'agents', hash: posted.hash });
      expect(read!.entries.map((e) => [e.accountId, e.direction, e.amount]).sort()).toEqual(
        posted.entries.map((e) => [e.accountId, e.direction, e.amount]).sort(),
      );
    }
  });

  it('answers null for an unbooked key and an unbooked id', async () => {
    await expect(door().getTxByKey('fee:agents:never')).resolves.toBeNull();
    await expect(door().getTx('9d2a8a4e-6f31-4c0e-9a55-0d7f4b1c2e10')).resolves.toBeNull();
  });

  it('a retry of the same key returns the original booking, not a second one', async () => {
    const req = request();
    const first = await door().post(req);
    const again = await door().post(req);
    expect(again.id).toBe(first.id);
    expect((await book.balance(userAvailable(USER, ASSET))).amount).toBe(amt('1000') - amt('12.5'));
  });

  it('rehydrates a ledger refusal with its own error text, and keeps it a LedgerError with its code', async () => {
    // The same key with a different body is the ledger refusing, not an outage.
    await door().post(request());
    const err = await door()
      .post(movement('p-door', '99'))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LedgerError);
    expect((err as LedgerError).code).toBe('ledger.idempotency_conflict');
    expect((err as Error).message).toMatch(/already booked a different movement/);
  });

  it('a refused charge over the wire is an InsufficientFundsError, as the service branches on it', async () => {
    const err = await door()
      .post(movement('p-broke', '5000'))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InsufficientFundsError);
  });

  it('never leaks the raw secret: not in a header, a body, or an error', async () => {
    const seen: string[] = [];
    const spy = fakeLedgerDoor(book, DOOR_SECRET, calls);
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      seen.push(JSON.stringify(init?.headers ?? {}), String(init?.body ?? ''));
      return spy(input, init);
    }) as typeof fetch;

    await door().post(request());
    await expect(createLedgerClient('http://ledger.test', DOOR_SECRET + 'x').balance(userAvailable(USER, ASSET))).rejects.toThrow();
    const failure = await createLedgerClient('http://ledger.test', DOOR_SECRET + 'x')
      .balance(userAvailable(USER, ASSET))
      .catch((e: Error) => e);

    expect(seen.length).toBeGreaterThan(0);
    for (const text of seen) {
      expect(text).not.toContain(DOOR_SECRET);
      expect(text).not.toContain(DOOR_SECRET + 'x');
    }
    expect(String((failure as Error).message)).not.toContain(DOOR_SECRET);
  });
});

/**
 * The lookups the money paths make by key. They used to throw "not exposed over the internal ledger API" (so a caller
 * that wrapped them could only ever see an unknown), while the in-memory ledger in the suites answered them (#4694).
 * They now call svc-ledger's read-only, service-signed `/trpc/txByKey` (#4692) and `/trpc/txById` doors.
 */
describe('getTxByKey — the txByKey door, chained to txById', () => {
  const KEY_TX = '9d2a8a4e-6f31-4c0e-9a55-0d7f4b1c2e11';
  const keyHit = {
    found: true,
    txId: KEY_TX,
    hash: 'h9',
    postedAt: '2026-10-14T01:02:03.000Z',
    module: 'agents',
    reason: 'agents.usage.metered',
  };
  const byId = (idempotencyKey: string, txId = KEY_TX) => ({
    ...keyHit,
    txId,
    idempotencyKey,
    entries: [
      { accountId: 'a-1', assetId: ASSET, direction: 'credit', amount: '10' },
      { accountId: 'a-2', assetId: ASSET, direction: 'debit', amount: '10' },
    ],
  });
  const KEY = 'fee:agents:s-1:w-1';

  it(`asks /trpc/txByKey with the key alone, signed over the exact bytes, as ${SERVICE}`, async () => {
    respond = () => ({ status: 200, body: { found: false } });
    await client().getTxByKey(KEY);

    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe('http://ledger.test/trpc/txByKey');
    expect(sent[0]!.method).toBe('POST');
    expect(sent[0]!.headers['content-type']).toBe('application/json');
    expect(sent[0]!.body).toEqual({ idempotencyKey: KEY });
    expect(verifyServiceHeaders(sent[0]!.headers, SECRET, { rawBody: retained(sent[0]!.raw), mode: 'require' })).toEqual({
      service: SERVICE,
      rejected: null,
      scheme: 'v2',
    });
  });

  it('answers null for a key the ledger has not booked', async () => {
    respond = () => ({ status: 200, body: { found: false } });
    await expect(client().getTxByKey(KEY)).resolves.toBeNull();
  });

  it('answers the booked transaction for a key it has, with its entries from /trpc/txById', async () => {
    respond = (path) => ({ status: 200, body: path === '/trpc/txByKey' ? keyHit : byId(KEY) });
    const tx = await client().getTxByKey(KEY);
    expect(sent.map((c) => new URL(c.url).pathname)).toEqual(['/trpc/txByKey', '/trpc/txById']);
    expect(sent[1]!.body).toEqual({ txId: KEY_TX });
    expect(tx).toMatchObject({ id: KEY_TX, idempotencyKey: KEY, hash: 'h9', module: 'agents', reason: 'agents.usage.metered' });
    expect(tx?.entries).toHaveLength(2);
    expect(tx?.postedAt.toISOString()).toBe('2026-10-14T01:02:03.000Z');
  });

  it('throws when the key is found but its transaction is not, or was booked under another key', async () => {
    respond = (path) => ({ status: 200, body: path === '/trpc/txByKey' ? keyHit : { found: false } });
    await expect(client().getTxByKey(KEY)).rejects.toThrow(/inconsistent/);
    respond = (path) => ({ status: 200, body: path === '/trpc/txByKey' ? keyHit : byId('some-other-key') });
    await expect(client().getTxByKey(KEY)).rejects.toThrow(/another key/);
  });

  it('throws on an answer with no found verdict, rather than reading it as "not booked"', async () => {
    respond = () => ({ status: 200, body: { txId: 'tx-1', hash: 'h1', postedAt: '2026-10-14T00:00:00.000Z' } });
    await expect(client().getTxByKey(KEY)).rejects.toThrow(/malformed/);
    await expect(client().getTx('9d2a8a4e-6f31-4c0e-9a55-0d7f4b1c2e10')).rejects.toThrow(/malformed/);
  });

  it('throws when the ledger cannot answer, rather than reading it as "not booked"', async () => {
    respond = () => ({ status: 503, body: 'down' });
    await expect(client().getTxByKey(KEY)).rejects.toThrow(/\/trpc\/txByKey failed \(503\)/);
  });
});

describe('getTx — the txById door', () => {
  const TX_ID = '9d2a8a4e-6f31-4c0e-9a55-0d7f4b1c2e10';

  it(`asks /trpc/txById with the id alone, signed over the exact bytes, as ${SERVICE}`, async () => {
    respond = () => ({ status: 200, body: { found: false } });
    await client().getTx(TX_ID);

    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe('http://ledger.test/trpc/txById');
    expect(sent[0]!.method).toBe('POST');
    expect(sent[0]!.body).toEqual({ txId: TX_ID });
    expect(verifyServiceHeaders(sent[0]!.headers, SECRET, { rawBody: retained(sent[0]!.raw), mode: 'require' })).toEqual({
      service: SERVICE,
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
        idempotencyKey: 'fee:agents:s-1:w-1',
        hash: 'h1',
        postedAt: '2026-10-14T01:02:03.000Z',
        module: 'agents',
        reason: 'agents.usage.metered',
        entries: [
          { accountId: 'a-1', assetId: ASSET, direction: 'credit', amount: '10.000000000000000001' },
          { accountId: 'a-2', assetId: ASSET, direction: 'debit', amount: '10.000000000000000001' },
        ],
      },
    });
    const tx = await client().getTx(TX_ID);
    expect(tx?.id).toBe(TX_ID);
    expect(tx?.idempotencyKey).toBe('fee:agents:s-1:w-1');
    expect(tx?.entries.map((e) => [e.accountId, e.assetId, e.direction, e.amount])).toEqual([
      ['a-1', ASSET, 'credit', amt('10.000000000000000001')],
      ['a-2', ASSET, 'debit', amt('10.000000000000000001')],
    ]);
    expect(formatAmount(tx!.entries[0]!.amount)).toBe('10.000000000000000001');
  });

  it('throws when the ledger refuses, rather than reading it as "not booked"', async () => {
    respond = () => ({ status: 400, body: { message: 'txId must be a uuid', code: 'BAD_REQUEST' } });
    await expect(client().getTx('nope')).rejects.toThrow();
  });
});
