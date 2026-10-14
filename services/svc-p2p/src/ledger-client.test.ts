import { afterEach, describe, expect, it, vi } from 'vitest';
import { InsufficientFundsError, MemoryLedger, recipes, parseAmount, tradeEscrowAccount, userAvailable } from '@intafaced/ledger-client';
import { rehydrateLedgerHttpError } from '@intafaced/ledger-client';
import { verifyServiceHeaders } from '@intafaced/contracts';
import { createLedgerClient } from './ledger-client.js';
import { fakeLedgerDoor, type DoorCall } from './ledger-door-fake.js';

describe('rehydrateLedgerHttpError (P2P-01)', () => {
  it('rebuilds InsufficientFundsError from structured s2s body', () => {
    const err = rehydrateLedgerHttpError(
      '/trpc/post',
      400,
      JSON.stringify({
        message: 'Insufficient USDT: requested 10, available 0',
        code: 'ledger.insufficient_funds',
        accountId: 'acct-1',
        assetId: 'USDT',
        requested: '10',
        availableBalance: '0',
      }),
    );
    expect(err).toBeInstanceOf(InsufficientFundsError);
    const funds = err as InsufficientFundsError;
    expect(funds.assetId).toBe('USDT');
    expect(funds.requested).toBe('10');
    expect(funds.availableBalance).toBe('0');
    expect(funds.accountId).toBe('acct-1');
  });

  it('rebuilds from message text when code is embedded only in the string', () => {
    const err = rehydrateLedgerHttpError('/trpc/post', 400, JSON.stringify({ message: 'Insufficient BTC: requested 1, available 0.1' }));
    expect(err).toBeInstanceOf(InsufficientFundsError);
    const funds = err as InsufficientFundsError;
    expect(funds.assetId).toBe('BTC');
    expect(funds.requested).toBe('1');
    expect(funds.availableBalance).toBe('0.1');
  });

  it('leaves non-funds failures as plain Error', () => {
    const err = rehydrateLedgerHttpError('/trpc/post', 500, '{"message":"boom"}');
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(InsufficientFundsError);
    expect(err.message).toMatch(/svc-ledger/);
  });
});

describe('P2P ledger transport budget', () => {
  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 0.5, 2_147_483_648, null as unknown as number, '15' as unknown as number])(
    'refuses invalid timeoutMs %s instead of disabling its deadline',
    (timeoutMs) => {
      expect(() => createLedgerClient('http://fixture.invalid', 'synthetic-p2p-fixture-internal-secret', { timeoutMs })).toThrow(
        RangeError,
      );
    },
  );
});

it('accepts the actual published ACK fields without inventing transaction-ID or hash formats', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify({ txId: 'opaque-server-id', hash: 'opaque-server-hash', postedAt: '2026-10-11T00:00:00.000Z' })),
    ),
  );
  try {
    const ledger = createLedgerClient('http://fixture.invalid', 'synthetic-p2p-fixture-internal-secret');
    const request = recipes.escrowLock({
      tradeId: '00000000-0000-4000-8000-0000000000a6',
      sellerId: '11111111-1111-4111-8111-111111111111',
      buyerId: '22222222-2222-4222-8222-222222222222',
      assetId: 'USDT',
      amount: parseAmount('100'),
    });
    await expect(ledger.post(request)).resolves.toMatchObject({
      id: 'opaque-server-id',
      hash: 'opaque-server-hash',
      postedAt: new Date('2026-10-11T00:00:00.000Z'),
    });
  } finally {
    vi.unstubAllGlobals();
  }
});

afterEach(() => vi.unstubAllGlobals());

const SELLER = '11111111-1111-4111-8111-111111111111';
const BUYER = '22222222-2222-4222-8222-222222222222';
const TRADE = '00000000-0000-4000-8000-0000000000a6';
const SCRIPT_SECRET = 'scripted-p2p-fixture-internal-secret';
const DOOR_SECRET = 'door-internal-service-secret-32-chars!!';

const lock = (amount = '100') =>
  recipes.escrowLock({ tradeId: TRADE, sellerId: SELLER, buyerId: BUYER, assetId: 'USDT', amount: parseAmount(amount) });

function retained(body: string) {
  return { retained: true as const, bytes: Buffer.from(body, 'utf8') };
}

/** One recorded request, as the ledger saw it. */
interface Seen {
  path: string;
  headers: Record<string, string>;
  raw: string;
}

/** A scripted door: `answer(path, nth)` is the response for the nth call to that path. */
function scripted(answer: (path: string, nth: number) => { status: number; body: unknown } | 'hang') {
  const seen: Seen[] = [];
  const counts = new Map<string, number>();
  const fetchStub = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    seen.push({ path, headers: (init?.headers ?? {}) as Record<string, string>, raw: String(init?.body ?? '') });
    const nth = (counts.get(path) ?? 0) + 1;
    counts.set(path, nth);
    const verdict = answer(path, nth);
    if (verdict === 'hang') {
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
      });
    }
    return new Response(JSON.stringify(verdict.body), { status: verdict.status, headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetchStub);
  return seen;
}

describe('svc-p2p over the shared client: credentials and wire shape', () => {
  it('signs every call as exactly svc-p2p, bound to the bytes sent', async () => {
    const book = new MemoryLedger();
    const calls: DoorCall[] = [];
    vi.stubGlobal('fetch', fakeLedgerDoor(book, DOOR_SECRET, calls));
    await book.post(recipes.deposit({ userId: SELLER, assetId: 'USDT', amount: parseAmount('500'), rail: 'test', railRef: 'p2p-door' }));
    const ledger = createLedgerClient('http://ledger.test', DOOR_SECRET);

    const request = lock();
    await ledger.post(request);
    await ledger.balance(userAvailable(SELLER, 'USDT'));
    await ledger.getTxByKey(request.idempotencyKey);

    expect(calls.map((c) => [c.path, c.service])).toEqual([
      ['/trpc/post', 'svc-p2p'],
      ['/trpc/balance', 'svc-p2p'],
      ['/trpc/txByKey', 'svc-p2p'],
      ['/trpc/txById', 'svc-p2p'],
    ]);
    await expect(
      createLedgerClient('http://ledger.test', 'a-different-secret-of-32-characters!!').balance(userAvailable(SELLER, 'USDT')),
    ).rejects.toThrow(/401|unauthenticated/);
  });

  it('sends amounts as decimal strings with a v2 body-bound signature the ledger verifies', async () => {
    const seen = scripted(() => ({ status: 200, body: { txId: 'tx-1', hash: 'h1', postedAt: '2026-10-11T00:00:00.000Z' } }));
    await createLedgerClient('http://ledger.test/', 'synthetic-p2p-fixture-internal-secret').post(lock('0.000000000000000001'));

    expect(seen).toHaveLength(1);
    const wire = JSON.parse(seen[0]!.raw) as { entries: Array<{ amount: unknown }>; idempotencyKey: string };
    expect(wire.idempotencyKey).toBe(`p2p.escrow.lock:${TRADE}`);
    for (const entry of wire.entries) expect(entry.amount).toBe('0.000000000000000001');
    expect(
      verifyServiceHeaders(seen[0]!.headers, 'synthetic-p2p-fixture-internal-secret', { rawBody: retained(seen[0]!.raw), mode: 'require' }),
    ).toEqual({ service: 'svc-p2p', rejected: null, scheme: 'v2' });
  });

  it('returns the entries the ledger booked on the post receipt, and reads a booking back by key and id', async () => {
    const book = new MemoryLedger();
    vi.stubGlobal('fetch', fakeLedgerDoor(book, DOOR_SECRET));
    await book.post(recipes.deposit({ userId: SELLER, assetId: 'USDT', amount: parseAmount('500'), rail: 'test', railRef: 'p2p-door' }));
    const ledger = createLedgerClient('http://ledger.test', DOOR_SECRET);

    const request = lock();
    const posted = await ledger.post(request);
    expect(posted.entries).toHaveLength(request.entries.length);

    // svc-p2p's old client threw on both; the shared client answers them (nothing in svc-p2p calls them today).
    const byKey = await ledger.getTxByKey(request.idempotencyKey);
    expect(byKey).toMatchObject({ id: posted.id, hash: posted.hash, module: 'p2p' });
    expect(byKey!.entries.map((e) => [e.accountId, e.direction, e.amount]).sort()).toEqual(
      posted.entries.map((e) => [e.accountId, e.direction, e.amount]).sort(),
    );
    await expect(ledger.getTxByKey('p2p.escrow.lock:never')).resolves.toBeNull();
  });
});

describe('svc-p2p budgets: a post is never retried, a read may be', () => {
  const ack = { txId: 'tx-ok', hash: 'h-ok', postedAt: '2026-10-11T00:00:00.000Z' };

  it('sends a post once even when the ledger answers 503: p2p claims every remote invocation, so a hidden retry would be unclaimed', async () => {
    const seen = scripted(() => ({ status: 503, body: 'busy' }));
    await expect(createLedgerClient('http://ledger.test', SCRIPT_SECRET).post(lock())).rejects.toThrow(/\/trpc\/post failed \(503\)/);
    expect(seen).toHaveLength(1);
  });

  it('sends a post once when it times out, and surfaces the timeout (what the sweep and the uncertainty bookkeeping read)', async () => {
    const seen = scripted(() => 'hang');
    const failed = await createLedgerClient('http://ledger.test', SCRIPT_SECRET, { timeoutMs: 50 })
      .post(lock())
      .catch((error: unknown) => error as Error);
    expect(['TimeoutError', 'AbortError']).toContain((failed as Error).name);
    expect(seen).toHaveLength(1);
  });

  it('retries a read once on 503', async () => {
    const seen = scripted((path, nth) =>
      nth === 1 ? { status: 503, body: 'busy' } : { status: 200, body: { accountId: 'a-1', amount: '5' } },
    );
    const balance = await createLedgerClient('http://ledger.test', SCRIPT_SECRET).balance(userAvailable(SELLER, 'USDT'));
    expect(balance.amount).toBe(parseAmount('5'));
    expect(seen).toHaveLength(2);
  });

  it('gives up a read after one retry', async () => {
    const seen = scripted(() => ({ status: 503, body: 'busy' }));
    await expect(createLedgerClient('http://ledger.test', SCRIPT_SECRET).balances('user', SELLER)).rejects.toThrow(
      /\/trpc\/balances failed \(503\)/,
    );
    expect(seen).toHaveLength(2);
  });

  it('refuses a malformed acknowledgement as an unknown outcome', async () => {
    scripted(() => ({ status: 200, body: { ...ack, postedAt: 'not-a-date' } }));
    await expect(createLedgerClient('http://ledger.test', SCRIPT_SECRET).post(lock())).rejects.toThrow(
      'svc-ledger invalid post acknowledgement; outcome unknown',
    );
  });
});

/**
 * THE FUNDS REFUSAL. p2p-service voids a trade only on a typed, DEFINITIVE `InsufficientFundsError`. The client makes it
 * definitive only when the wire body is complete and consistent AND the ledger's own balance read names the same credited
 * account; every weaker answer is an unknown outcome (a plain Error), which leaves the trade re-drivable.
 */
describe('funds refusal is definitive only when the ledger body and the balance read agree', () => {
  const funds = (overrides: Record<string, unknown> = {}) => ({
    message: 'Insufficient funds',
    code: 'ledger.insufficient_funds',
    accountId: 'acct-seller',
    assetId: 'USDT',
    requested: '100',
    availableBalance: '3',
    ...overrides,
  });
  const UNKNOWN = 'svc-ledger incomplete or inconsistent funds refusal; outcome unknown';

  /** post -> 400 funds body; balance -> identity (default agrees with `accountId: 'acct-seller'`). */
  const door = (
    body: unknown,
    balance: { status: number; body: unknown } = { status: 200, body: { accountId: 'acct-seller', amount: '3' } },
  ) => scripted((path) => (path === '/trpc/post' ? { status: 400, body } : balance));

  const run = () =>
    createLedgerClient('http://ledger.test', SCRIPT_SECRET)
      .post(lock('100'))
      .catch((error: unknown) => error as Error);

  it('refuses with a typed InsufficientFundsError carrying the ledger fields, after reading the CREDITED account', async () => {
    const seen = door(funds());
    const error = await run();

    expect(error).toBeInstanceOf(InsufficientFundsError);
    expect(error).toMatchObject({
      code: 'ledger.insufficient_funds',
      accountId: 'acct-seller',
      assetId: 'USDT',
      requested: '100',
      availableBalance: '3',
    });
    expect(seen.map((c) => c.path)).toEqual(['/trpc/post', '/trpc/balance']);
    // The account read is the escrow lock's credit leg, rebuilt from the wire body the shared transport sent.
    const credit = lock('100').entries.find((e) => e.direction === 'credit')!;
    expect(JSON.parse(seen[1]!.raw)).toEqual(credit.account);
  });

  it('refuses with the typed error against the fake door too (real structured body, MemoryLedger funds check)', async () => {
    const book = new MemoryLedger();
    const calls: DoorCall[] = [];
    vi.stubGlobal('fetch', fakeLedgerDoor(book, DOOR_SECRET, calls));
    await book.post(recipes.deposit({ userId: SELLER, assetId: 'USDT', amount: parseAmount('3'), rail: 'test', railRef: 'p2p-short' }));

    const error = (await createLedgerClient('http://ledger.test', DOOR_SECRET)
      .post(lock('100'))
      .catch((e: unknown) => e)) as InsufficientFundsError;

    expect(error).toBeInstanceOf(InsufficientFundsError);
    expect(error.assetId).toBe('USDT');
    expect(error.requested).toBe('100');
    expect(error.availableBalance).toBe('3');
    expect(calls.map((c) => c.path)).toEqual(['/trpc/post', '/trpc/balance']);
    expect((await book.balance(tradeEscrowAccount(SELLER, 'USDT', TRADE))).amount).toBe(0n);
  });

  it.each([
    ['a blank message', funds({ message: ' ' })],
    ['a padded accountId', funds({ accountId: ' acct-seller' })],
    ['no assetId', funds({ assetId: '' })],
    ['a padded requested', funds({ requested: ' 100' })],
    ['an unparseable requested', funds({ requested: '1e2' })],
    ['availability not below the request', funds({ availableBalance: '100' })],
    ['a negative availability', funds({ availableBalance: '-1' })],
    ['a message that contradicts the fields', funds({ message: 'Insufficient BTC: requested 100, available 3' })],
    ['a request no credit leg matches', funds({ requested: '99' })],
    ['an asset no credit leg carries', funds({ assetId: 'BTC', requested: '100' })],
  ])('is an unknown outcome, not a refusal, for %s', async (_what, body) => {
    door(body);
    const error = await run();
    expect(error).not.toBeInstanceOf(InsufficientFundsError);
    expect((error as Error).message).toBe(UNKNOWN);
  });

  it.each([
    ['a body that is not an object', 'ledger.insufficient_funds'],
    ['a JSON array', [funds()]],
    ['another code', funds({ code: 'ledger.frozen' })],
  ])('never types %s as a funds refusal, and reads nothing more', async (_what, body) => {
    const seen = door(body);
    expect(await run()).not.toBeInstanceOf(InsufficientFundsError);
    expect(seen.map((c) => c.path)).toEqual(['/trpc/post']);
  });

  it.each([
    ['an account that is not the refused one', { status: 200, body: { accountId: 'someone-else', amount: '3' } }],
    ['a balance read that fails', { status: 500, body: { message: 'boom' } }],
    ['a balance read with no amount', { status: 200, body: { accountId: 'acct-seller' } }],
    ['a balance read with an unparseable amount', { status: 200, body: { accountId: 'acct-seller', amount: '3e1' } }],
    ['a balance read that is not an object', { status: 200, body: [] }],
  ])('is an unknown outcome, not a refusal, for %s', async (_what, balance) => {
    door(funds(), balance);
    const error = await run();
    expect(error).not.toBeInstanceOf(InsufficientFundsError);
    expect((error as Error).message).toBe(UNKNOWN);
  });

  it('accepts the published absent-account identity (empty accountId) only when the read agrees', async () => {
    door(funds({ accountId: '' }), { status: 200, body: { accountId: '', amount: '0' } });
    expect(await run()).toBeInstanceOf(InsufficientFundsError);
    door(funds({ accountId: '' }), { status: 200, body: { accountId: 'acct-seller', amount: '0' } });
    expect(((await run()) as Error).message).toBe(UNKNOWN);
  });

  it('leaves other refusals as the ledger said them, with no balance read: frozen, conflict, 5xx', async () => {
    const seen = scripted(() => ({ status: 412, body: { message: 'frozen', code: 'ledger.frozen' } }));
    const error = (await run()) as Error & { code?: string };
    expect(error).not.toBeInstanceOf(InsufficientFundsError);
    expect(error.code).toBe('ledger.frozen');
    expect(seen.map((c) => c.path)).toEqual(['/trpc/post']);
  });

  it('does not type a funds failure on a READ as definitive evidence about a post (reads carry no request to check)', async () => {
    const seen = scripted(() => ({ status: 400, body: funds() }));
    const error = await createLedgerClient('http://ledger.test', SCRIPT_SECRET)
      .balance(userAvailable(SELLER, 'USDT'))
      .catch((e: unknown) => e);
    // As before the move: a read refused with a funds-shaped body is rehydrated typed, with no second call.
    expect(error).toBeInstanceOf(InsufficientFundsError);
    expect(seen).toHaveLength(1);
  });
});
