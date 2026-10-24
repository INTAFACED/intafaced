import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  InsufficientFundsError,
  LedgerError,
  formatAmount,
  parseAmount as amt,
  recipes,
  userAvailable,
  orderHoldAccount,
  type PostRequest,
} from '@intafaced/ledger-client';
import Fastify, { type FastifyInstance } from 'fastify';
import { serviceAuthHeaders, serviceAuthHeadersForBody } from '@intafaced/contracts';
import {
  handleS2sBalance,
  handleS2sBalances,
  handleS2sCustody,
  handleS2sHistory,
  handleS2sPortfolio,
  handleS2sPost,
  handleS2sReportExport,
  handleS2sStatementPnl,
  httpError,
  registerS2sHttp,
} from './s2s-http.js';
import { HISTORY_MAX_ENTRIES, HistoryTooLargeError, type HistoryEntry } from './ledger/history.js';
import { RECIPE_REQUIRED_CODE } from './recipe-gate.js';
import type { LedgerService } from './service.js';

const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function stubService(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    post: async () => ({ id: 'tx-s2s', hash: 'deadbeef', postedAt: new Date('2026-07-27T00:00:00Z') }),
    balance: async () => ({
      account: userAvailable(USER, 'USDT'),
      accountId: 'acct-1',
      amount: amt('42'),
    }),
    balances: async () => [],
    history: async () => [] as HistoryEntry[],
    ...overrides,
  } as unknown as LedgerService;
}

/** The window svc-bank's spend view actually sends — `Date.toISOString()`. */
const validHistory = {
  account: userAvailable(USER, 'USDT'),
  from: '2026-07-09T00:00:00.000Z',
  to: '2026-08-08T00:00:00.000Z',
};

const historyEntry: HistoryEntry = {
  txId: 'tx-hist-1',
  module: 'trade',
  reason: 'trade.fill',
  direction: 'credit',
  // 18 decimal places — the full precision the book carries.
  amount: amt('12.345678901234567891'),
  postedAt: new Date('2026-07-27T12:00:00.000Z'),
};

function toWire(req: PostRequest) {
  return {
    idempotencyKey: req.idempotencyKey,
    module: req.module,
    reason: req.reason,
    ...(req.meta ? { meta: req.meta } : {}),
    entries: req.entries.map((e) => ({
      account: e.account,
      direction: e.direction,
      amount: formatAmount(e.amount),
    })),
  };
}

const validPost = toWire(recipes.orderHold({ orderId: 'order-test', userId: USER, assetId: 'USDT', amount: amt('10') }));

const assembledSecondBook = {
  idempotencyKey: 'second-book-not-a-recipe',
  module: 'evil',
  reason: 'second.book',
  entries: [
    { account: userAvailable(USER, 'USDT'), direction: 'credit' as const, amount: '10' },
    {
      account: userAvailable('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'USDT'),
      direction: 'debit' as const,
      amount: '10',
    },
  ],
};

describe('s2s-http (graph W1-C money surface)', () => {
  it('posts and returns txId/hash/postedAt for service clients', async () => {
    const out = await handleS2sPost(stubService(), validPost);
    expect(out.txId).toBe('tx-s2s');
    expect(out.hash).toBe('deadbeef');
    expect(out.postedAt).toMatch(/^2026-07-27/);
  });

  it('returns the entries the ledger booked, as decimal strings, so callers can check the receipt', async () => {
    const booked = {
      id: 'tx-s2s',
      hash: 'deadbeef',
      postedAt: new Date('2026-07-27T00:00:00Z'),
      entries: [
        { id: '1', txId: 'tx-s2s', accountId: 'acct-1', assetId: 'USDT', direction: 'debit', amount: amt('5'), balanceAfter: amt('5') },
        { id: '2', txId: 'tx-s2s', accountId: 'acct-2', assetId: 'USDT', direction: 'credit', amount: amt('5'), balanceAfter: -amt('5') },
      ],
    };
    const out = await handleS2sPost(stubService({ post: async () => booked }), validPost);
    expect(out.entries).toEqual([
      { id: '1', txId: 'tx-s2s', accountId: 'acct-1', assetId: 'USDT', direction: 'debit', amount: '5', balanceAfter: '5' },
      { id: '2', txId: 'tx-s2s', accountId: 'acct-2', assetId: 'USDT', direction: 'credit', amount: '5', balanceAfter: '-5' },
    ]);
  });

  it('refuses assembled entries that are not a known recipe, and never posts', async () => {
    let posted = false;
    await expect(
      handleS2sPost(
        stubService({
          post: async () => {
            posted = true;
            return { id: 'tx-s2s', hash: 'deadbeef', postedAt: new Date('2026-07-27T00:00:00Z') };
          },
        }),
        assembledSecondBook,
      ),
    ).rejects.toMatchObject({ code: RECIPE_REQUIRED_CODE });
    expect(posted).toBe(false);
  });

  it('refuses a JSON number amount and never asks the ledger to post', async () => {
    let posted = false;
    await expect(
      handleS2sPost(
        stubService({
          post: async () => {
            posted = true;
            return { id: 'tx-number', hash: 'h', postedAt: new Date() };
          },
        }),
        {
          ...validPost,
          entries: validPost.entries.map((e) => ({ ...e, amount: 10 })),
        },
      ),
    ).rejects.toBeInstanceOf(z.ZodError);
    expect(posted).toBe(false);
  });

  it('maps insufficient funds to 400', () => {
    const mapped = httpError(new InsufficientFundsError(userAvailable(USER, 'USDT'), amt('1'), amt('0')));
    expect(mapped.status).toBe(400);
  });

  it('maps frozen ledger to 412', () => {
    const mapped = httpError(new LedgerError('frozen for test', 'ledger.frozen'));
    expect(mapped.status).toBe(412);
  });

  it('returns balance amounts as decimal strings', async () => {
    const out = await handleS2sBalance(stubService(), userAvailable(USER, 'USDT'));
    expect(out.amount).toBe(formatAmount(amt('42')));
    expect(out.accountId).toBe('acct-1');
    // available is unpurposed — empty string, not omitted, so callers can key
    // by purpose without special-casing "field missing".
    expect(out.purpose).toBe('');
  });

  it('answers a missing account as typed zero, never as an error', async () => {
    const out = await handleS2sBalance(
      stubService({
        balance: async () => ({ account: userAvailable(USER, 'USDT'), accountId: '', amount: 0n }),
      }),
      userAvailable(USER, 'USDT'),
    );
    expect(out.accountId).toBe('');
    expect(out.amount).toBe('0');
    expect(typeof out.amount).toBe('string');
  });

  it('propagates an infra failure on balance rather than reporting 0', async () => {
    await expect(
      handleS2sBalance(
        stubService({
          balance: async () => {
            throw new Error('connect ECONNREFUSED');
          },
        }),
        userAvailable(USER, 'USDT'),
      ),
    ).rejects.toThrow(/ECONNREFUSED/);
  });

  it('surfaces purpose on balances so two holds do not re-commingle on the wire', async () => {
    // purpose is account IDENTITY (P0-3). Without it, two order holds collapse
    // to the same (assetId, kind) and any caller that keys that way re-merges
    // pots the book keeps apart.
    const out = await handleS2sBalances(
      stubService({
        balances: async () => [
          {
            account: orderHoldAccount(USER, 'USDT', 'order-a'),
            accountId: 'hold-a',
            amount: amt('10'),
          },
          {
            account: orderHoldAccount(USER, 'USDT', 'order-b'),
            accountId: 'hold-b',
            amount: amt('20'),
          },
          {
            account: userAvailable(USER, 'USDT'),
            accountId: 'avail-1',
            amount: amt('5'),
          },
        ],
      }),
      { ownerType: 'user', ownerId: USER },
    );

    expect(out).toHaveLength(3);
    const byId = Object.fromEntries(out.map((row) => [row.accountId, row]));
    expect(byId['hold-a']).toMatchObject({
      assetId: 'USDT',
      kind: 'hold',
      purpose: 'order:order-a',
      amount: '10',
    });
    expect(byId['hold-b']).toMatchObject({
      assetId: 'USDT',
      kind: 'hold',
      purpose: 'order:order-b',
      amount: '20',
    });
    expect(byId['avail-1']).toMatchObject({ kind: 'available', purpose: '', amount: '5' });
    // Same asset+kind, different purpose — the whole point of this field.
    expect(byId['hold-a']!.purpose).not.toBe(byId['hold-b']!.purpose);
  });

  it('returns empty custodial holdings and a named-absent indexer, never a zero chain balance', async () => {
    const out = await handleS2sPortfolio(stubService({ balances: async () => [] }), {
      ownerType: 'user',
      ownerId: USER,
    });

    expect(out.custodial).toEqual([]);
    expect(out.indexer).toEqual({ status: 'absent', reason: 'indexer.portfolio_positions_unwired' });
    expect(out.indexer).not.toHaveProperty('amount');
  });

  it('composes present indexer positions over S2S when URL + 0x account work', async () => {
    const chainAccount = '0x1111111111111111111111111111111111111111';
    const out = await handleS2sPortfolio(
      stubService({ balances: async () => [] }),
      { ownerType: 'user', ownerId: USER, chainAccount },
      {
        url: 'http://indexer.test',
        fetch: async () =>
          new Response(JSON.stringify({ result: { data: [{ market: 'IFC-USD', size: '2', entryPrice: '11' }] } }), {
            headers: { 'content-type': 'application/json' },
          }),
      },
    );
    expect(out.indexer).toEqual({
      status: 'present',
      positions: [{ market: 'IFC-USD', size: '2', entryPrice: '11' }],
    });
    if (out.indexer.status !== 'present') throw new Error('expected present');
    expect(typeof out.indexer.positions[0]!.size).toBe('string');
  });

  it('names unwired on indexer fetch failure, never a zero chain amount', async () => {
    const out = await handleS2sPortfolio(
      stubService({ balances: async () => [] }),
      { ownerType: 'user', ownerId: USER, chainAccount: '0x1111111111111111111111111111111111111111' },
      {
        url: 'http://indexer.test',
        fetch: async () => {
          throw new Error('ECONNREFUSED');
        },
      },
    );
    expect(out.indexer).toEqual({ status: 'absent', reason: 'indexer.portfolio_positions_unwired' });
    expect(JSON.stringify(out.indexer)).not.toMatch(/"0"/);
  });

  it('statement PnL is a typed refuse, never a 0 PnL/NAV', async () => {
    const out = await handleS2sStatementPnl(stubService(), {
      ownerType: 'user',
      ownerId: USER,
      reportingAssetId: 'USDT',
    });
    expect(out.status).toBe('refused');
    expect(out.realized).toBeNull();
    expect(out.unrealized).toBeNull();
    expect(out.nav).toBeNull();
    expect(out.codes).toContain('ledger.statement.lots_missing');
    expect(out.codes).toContain('ledger.statement.nav_inputs_missing');
    expect(JSON.stringify(out)).not.toMatch(/"0"/);
  });

  it('propagates an infra failure on statement rather than a 0 PnL', async () => {
    await expect(
      handleS2sStatementPnl(
        stubService({
          balances: async () => {
            throw new Error('connect ECONNREFUSED');
          },
        }),
        { ownerType: 'user', ownerId: USER, reportingAssetId: 'USDT' },
      ),
    ).rejects.toThrow(/ECONNREFUSED/);
  });

  it('report export refuses completeness when IDs are missing, never invents a number', async () => {
    const out = await handleS2sReportExport(stubService(), {
      kind: 'regulator',
      complete: true,
      ownerId: USER,
      reportingPeriod: '2026-Q3',
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe('completeness_ids_missing');
    expect(out.missing).toEqual(['legalEntityId', 'regulatorId']);
    expect(out.complete).toBe(false);
    expect(JSON.stringify(out)).not.toMatch(/"0"/);
  });

  it('custody refuses off-exchange without OWNER and never treats an adapter as the book', async () => {
    const off = await handleS2sCustody(stubService(), { kind: 'off_exchange' });
    expect(off.ok).toBe(false);
    if (off.ok) return;
    expect(off.reason).toBe('ledger.custody.off_exchange_owner_unset');
    const asBook = await handleS2sCustody(stubService(), {
      kind: 'chain',
      treatAsBook: true,
      adapterAmount: '1',
    });
    expect(asBook.ok).toBe(false);
    if (asBook.ok) return;
    expect(asBook.reason).toBe('ledger.custody.adapter_is_not_book');
    expect(asBook.role).toBe('adapter');
  });
});

/**
 * THE 404 THIS CHANGE CLOSES.
 *
 * `/bank/analytics` returned 500 because svc-bank's spend view called
 * `POST /trpc/history`, this file registered three routes, and Fastify answered
 * `{"message":"Route POST:/trpc/history not found","statusCode":404}`. Its client
 * refused to substitute an empty result — deliberately, since "you spent
 * nothing" and "we could not ask" must not look the same to a user — so the
 * refusal travelled all the way to the browser.
 *
 * These tests are written against what `createLedgerHistory` in
 * `services/svc-bank/src/ledger-client.ts` sends and parses. They fail if this
 * side drifts from it in either direction.
 */
describe('s2s history — the shape svc-bank already parses', () => {
  it('answers a bare ARRAY, because the caller does `result.map(...)`', async () => {
    const out = await handleS2sHistory(stubService({ history: async () => [historyEntry] }), validHistory);
    expect(Array.isArray(out)).toBe(true);
  });

  it('names exactly the six fields the caller reads, and no others', async () => {
    const out = await handleS2sHistory(stubService({ history: async () => [historyEntry] }), validHistory);

    // Rename one of these and svc-bank's `parseAmount(undefined)` throws
    // MoneyError instead of a 404 — a different failure, not a fixed one.
    expect(Object.keys(out[0]!).sort()).toEqual(['amount', 'direction', 'module', 'postedAt', 'reason', 'txId']);
  });

  it('sends `amount` as a DECIMAL STRING at full precision, never a number', async () => {
    const out = await handleS2sHistory(stubService({ history: async () => [historyEntry] }), validHistory);

    expect(typeof out[0]!.amount).toBe('string');
    expect(out[0]!.amount).toBe('12.345678901234567891');
    // JSON cannot carry this value as a number; asserting it survives the actual
    // serialisation is the only version of this check that means anything.
    expect(JSON.parse(JSON.stringify(out))[0].amount).toBe('12.345678901234567891');
  });

  it('sends `postedAt` as an ISO string the caller can hand to `new Date(...)`', async () => {
    const out = await handleS2sHistory(stubService({ history: async () => [historyEntry] }), validHistory);
    expect(out[0]!.postedAt).toBe('2026-07-27T12:00:00.000Z');
    expect(new Date(out[0]!.postedAt).getTime()).toBe(historyEntry.postedAt.getTime());
  });

  it('passes `direction` through as the book recorded it', async () => {
    const out = await handleS2sHistory(stubService({ history: async () => [historyEntry] }), validHistory);
    expect(out[0]!.direction).toBe('credit');
  });

  it('answers an account with no movements with an honest empty array, not an error', async () => {
    const out = await handleS2sHistory(stubService({ history: async () => [] }), validHistory);
    expect(out).toEqual([]);
  });

  it('answers a missing account the same way — typed empty, not a 0 spend', async () => {
    const out = await handleS2sHistory(stubService({ history: async () => [] }), validHistory);
    expect(Array.isArray(out)).toBe(true);
    expect(out).toEqual([]);
    expect(JSON.stringify(out)).not.toMatch(/"0"/);
  });

  it('does not invent `after` — a cursor on the body is a socket refuse, not a page', async () => {
    await expect(handleS2sHistory(stubService(), { ...validHistory, after: 'entry-1' })).rejects.toMatchObject({
      code: 'ledger.history_page_socket',
    });
  });

  it('propagates an infra failure rather than answering empty (empty would look like a quiet month)', async () => {
    await expect(
      handleS2sHistory(
        stubService({
          history: async () => {
            throw new Error('connect ECONNREFUSED');
          },
        }),
        validHistory,
      ),
    ).rejects.toThrow(/ECONNREFUSED/);
  });

  it('hands the handler’s parsed window to the ledger as real Dates', async () => {
    const seen: Array<{ from: Date; to: Date }> = [];
    await handleS2sHistory(
      stubService({
        history: async (_ref: unknown, range: { from: Date; to: Date }) => {
          seen.push(range);
          return [];
        },
      }),
      validHistory,
    );

    expect(seen[0]!.from.toISOString()).toBe('2026-07-09T00:00:00.000Z');
    expect(seen[0]!.to.toISOString()).toBe('2026-08-08T00:00:00.000Z');
  });

  it('refuses an inverted window rather than answering it empty', async () => {
    await expect(handleS2sHistory(stubService(), { ...validHistory, from: validHistory.to, to: validHistory.from })).rejects.toMatchObject({
      code: 'ledger.history_range_invalid',
    });
  });

  it('refuses a malformed timestamp instead of coercing it to Invalid Date', async () => {
    await expect(handleS2sHistory(stubService(), { ...validHistory, from: 'yesterday' })).rejects.toThrow();
  });

  it('maps both history refusals to 400 with a code the caller can rehydrate', () => {
    const tooLarge = httpError(
      new HistoryTooLargeError(
        'acct-1',
        { from: new Date('2026-07-09T00:00:00Z'), to: new Date('2026-08-08T00:00:00Z') },
        HISTORY_MAX_ENTRIES,
      ),
    );

    // 400, not 500: nothing is broken here, and retrying the same window never
    // helps. `rehydrateLedgerHttpError` rebuilds a typed LedgerError only when
    // the body names a code — without one svc-bank records `bank.post_failed`.
    expect(tooLarge.status).toBe(400);
    expect(tooLarge.body.code).toBe('ledger.history_range_too_large');
    expect(String(tooLarge.body.message)).toContain(String(HISTORY_MAX_ENTRIES));

    const inverted = httpError(new LedgerError('backwards', 'ledger.history_range_invalid'));
    expect(inverted.status).toBe(400);
    expect(inverted.body.code).toBe('ledger.history_range_invalid');
  });
});

// ── Authentication on the surface that is actually served ────────────────────
//
// These tests exist because a previous revision of this change secured
// `createLedgerRouter`'s `post` procedure and stopped there. That router is
// built in `index.ts` and exported for its TYPE — nothing registers
// `fastifyTRPCPlugin`, so no guard on it is reachable from the port. The routes
// below are what a caller actually hits.
//
// The lesson, written down: a guard is worth exactly as much as the route that
// runs it. Test the mounted path, not the one you edited.

//
// They now run against a REAL Fastify instance rather than a hand-rolled stand-in.
// That is not tidiness: `registerS2sHttp` installs a content-type parser to keep
// the raw request bytes, and body binding is only meaningful if the bytes being
// digested are the ones Fastify actually received. A fake `app` that records
// route handlers would verify a digest against a body the test handed it
// directly, which is the one thing that cannot go wrong in production.

describe('s2s HTTP — service credentials', () => {
  const SECRET = 'ledger-internal-service-secret-32ch!';

  async function mount(
    service?: LedgerService,
    options?: Pick<NonNullable<Parameters<typeof registerS2sHttp>[3]>, 'bodyBind' | 'doorCallers'>,
  ) {
    const app = Fastify({ logger: false });
    registerS2sHttp(app, service ?? stubService(), SECRET, options ?? {});
    await app.ready();
    return app;
  }

  /** Post exactly `payload` — the same bytes the caller signed. */
  const send = (app: FastifyInstance, path: string, headers: Record<string, string>, payload: string) =>
    app.inject({ method: 'POST', url: path, headers: { 'content-type': 'application/json', ...headers }, payload });

  const wire = (body: unknown) => JSON.stringify(body);

  /**
   * THE ATTACK. A stranger reaching the port posts a balanced transaction
   * crediting a treasury boundary and debiting their own available balance —
   * the `deposit` recipe. Every ledger invariant is satisfied; it is simply not
   * authorised. This asserts the ledger was never asked, not merely that the
   * response was an error.
   */
  it('refuses an authenticated non-recipe post, and never reaches the ledger', async () => {
    let posted = false;
    const app = await mount(
      stubService({
        post: async () => {
          posted = true;
          return { id: 'tx-1', hash: 'h', postedAt: new Date() };
        },
      }),
    );
    const payload = wire(assembledSecondBook);

    const res = await send(app, '/trpc/post', serviceAuthHeadersForBody('svc-trade', SECRET, payload), payload);

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe(RECIPE_REQUIRED_CODE);
    expect(posted).toBe(false);
    await app.close();
  });

  it('refuses an unauthenticated post, and never reaches the ledger', async () => {
    let posted = false;
    const app = await mount(
      stubService({
        post: async () => {
          posted = true;
          return { id: 'tx-1', hash: 'h', postedAt: new Date() };
        },
      }),
    );

    const res = await send(app, '/trpc/post', {}, wire(validPost));

    expect(res.statusCode).toBe(401);
    expect(posted).toBe(false);
    await app.close();
  });

  it('refuses a forged signature', async () => {
    const app = await mount();

    const res = await send(
      app,
      '/trpc/post',
      {
        'x-intafaced-service': 'svc-trade',
        'x-intafaced-service-ts': String(Math.floor(Date.now() / 1000)),
        'x-intafaced-service-sig': 'f'.repeat(64),
      },
      wire(validPost),
    );

    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('accepts a properly signed service call that binds its body', async () => {
    const app = await mount();
    const payload = wire(validPost);

    const res = await send(app, '/trpc/post', serviceAuthHeadersForBody('svc-trade', SECRET, payload), payload);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ txId: 'tx-s2s', hash: 'deadbeef' });
    await app.close();
  });

  // ── L2-6: the replay this closes ───────────────────────────────────────────

  /**
   * THE TEST THE CHANGE EXISTS FOR, on the mounted path.
   *
   * Credentials captured from a legitimate 10-unit transfer, replayed byte for
   * byte against a 99999-unit one. Under the old scheme the signature covered
   * only `service` and a timestamp, so this succeeded for 300 seconds — and
   * `/trpc/post` reaches `ledger.post()` directly, which is what made a
   * replayable signature a replayable money instruction.
   */
  it('refuses captured credentials replayed over a mutated body, and never reaches the ledger', async () => {
    let posted = false;
    const app = await mount(
      stubService({
        post: async () => {
          posted = true;
          return { id: 'tx-forged', hash: 'h', postedAt: new Date() };
        },
      }),
    );

    const honest = wire(validPost);
    const headers = serviceAuthHeadersForBody('svc-trade', SECRET, honest);

    const tampered = honest.replace(/"amount":"10"/g, '"amount":"99999"');
    expect(tampered).not.toBe(honest);

    const res = await send(app, '/trpc/post', headers, tampered);

    expect(res.statusCode).toBe(401);
    expect(res.json().message).toMatch(/body-mismatch/);
    // The assertion that matters: the ledger was never asked to post it.
    expect(posted).toBe(false);
    await app.close();
  });

  it('refuses a body altered by a single byte', async () => {
    const app = await mount();
    const honest = wire(validPost);
    const headers = serviceAuthHeadersForBody('svc-trade', SECRET, honest);

    // A trailing space. Semantically the same JSON, different bytes, and the
    // digest commits to bytes.
    const res = await send(app, '/trpc/post', headers, `${honest} `);

    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('binds each route separately — a signature for one body does not travel to another', async () => {
    const app = await mount();
    const balanceBody = wire(userAvailable(USER, 'USDT'));
    const headers = serviceAuthHeadersForBody('svc-trade', SECRET, balanceBody);

    // Credentials minted for a harmless balance read, pointed at the write.
    const res = await send(app, '/trpc/post', headers, wire(validPost));

    expect(res.statusCode).toBe(401);
    await app.close();
  });

  // ── The migration, both directions ─────────────────────────────────────────

  it('accept-both admits a legacy v1 caller that has not been redeployed', async () => {
    const app = await mount(undefined, { bodyBind: 'accept-both' });
    const payload = wire(validPost);

    // No body digest — the old client, still in the fleet.
    const res = await send(app, '/trpc/post', serviceAuthHeaders('svc-trade', SECRET), payload);

    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('require refuses that same legacy caller, naming why', async () => {
    const app = await mount(undefined, { bodyBind: 'require' });

    const res = await send(app, '/trpc/post', serviceAuthHeaders('svc-trade', SECRET), wire(validPost));

    expect(res.statusCode).toBe(401);
    expect(res.json().message).toMatch(/missing-body-digest/);
    await app.close();
  });

  it('require still admits a redeployed v2 caller — the destination state works', async () => {
    const app = await mount(undefined, { bodyBind: 'require' });
    const payload = wire(validPost);

    const res = await send(app, '/trpc/post', serviceAuthHeadersForBody('svc-trade', SECRET, payload), payload);

    expect(res.statusCode).toBe(200);
    await app.close();
  });

  // Reads leak too. `balances` for a `treasury` or `house` owner is the
  // platform's own position; the tRPC twin restricts a user to their own
  // accounts and this route had no equivalent.
  it('refuses unauthenticated reads on every route, not just the write', async () => {
    const app = await mount();

    for (const path of [
      '/trpc/balance',
      '/trpc/balances',
      '/trpc/history',
      '/trpc/portfolio',
      '/trpc/statementPnl',
      '/trpc/reportExport',
      '/trpc/custody',
    ]) {
      const res = await send(app, path, {}, wire({ ownerType: 'treasury', ownerId: 'rail:crypto-native' }));
      expect(res.statusCode).toBe(401);
    }
    await app.close();
  });

  // ── /trpc/history, on the port ─────────────────────────────────────────────
  //
  // The handler tests above prove the shape. These prove the route exists and is
  // behind the same door — which is the half that was actually missing: every
  // guard in this file was already written, and Fastify still answered 404.

  it('ANSWERS a signed statementPnl call with a typed refuse, never 0', async () => {
    const app = await mount(undefined, { doorCallers: { statementPnl: ['svc-bank'], reportExport: ['svc-bank'], custody: ['svc-bank'] } });
    const payload = wire({ ownerType: 'user', ownerId: USER, reportingAssetId: 'USDT' });

    const res = await send(app, '/trpc/statementPnl', serviceAuthHeadersForBody('svc-bank', SECRET, payload), payload);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      status: 'refused',
      realized: null,
      unrealized: null,
      nav: null,
    });
    expect(JSON.stringify(res.json())).not.toMatch(/"0"/);
    await app.close();
  });

  it('ANSWERS a signed reportExport call with a completeness refuse, never a 0 NAV', async () => {
    const app = await mount(undefined, { doorCallers: { statementPnl: ['svc-bank'], reportExport: ['svc-bank'], custody: ['svc-bank'] } });
    const payload = wire({ kind: 'nav', complete: true, reportingPeriod: '2026-Q3' });

    const res = await send(app, '/trpc/reportExport', serviceAuthHeadersForBody('svc-bank', SECRET, payload), payload);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      ok: false,
      reason: 'completeness_ids_missing',
      kind: 'nav',
      complete: false,
    });
    expect(JSON.stringify(res.json())).not.toMatch(/"0"/);
    await app.close();
  });

  it('ANSWERS a signed custody call with an off-exchange OWNER refuse', async () => {
    const app = await mount(undefined, { doorCallers: { statementPnl: ['svc-bank'], reportExport: ['svc-bank'], custody: ['svc-bank'] } });
    const payload = wire({ kind: 'off_exchange' });

    const res = await send(app, '/trpc/custody', serviceAuthHeadersForBody('svc-bank', SECRET, payload), payload);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      ok: false,
      reason: 'ledger.custody.off_exchange_owner_unset',
      kind: 'off_exchange',
      role: 'adapter',
    });
    await app.close();
  });

  it('ANSWERS a signed history call — the 404 that 500-ed /bank/analytics is gone', async () => {
    const app = await mount(stubService({ history: async () => [historyEntry] }));
    const payload = wire(validHistory);

    const res = await send(app, '/trpc/history', serviceAuthHeadersForBody('svc-bank', SECRET, payload), payload);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([
      {
        txId: 'tx-hist-1',
        module: 'trade',
        reason: 'trade.fill',
        direction: 'credit',
        amount: '12.345678901234567891',
        postedAt: '2026-07-27T12:00:00.000Z',
      },
    ]);
    await app.close();
  });

  it('never reaches the ledger for an unauthenticated history read', async () => {
    let asked = false;
    const app = await mount(
      stubService({
        history: async () => {
          asked = true;
          return [];
        },
      }),
    );

    const res = await send(app, '/trpc/history', {}, wire(validHistory));

    // An entry history is a record of what someone did with their money — at
    // least as sensitive as the balance it sums to.
    expect(res.statusCode).toBe(401);
    expect(asked).toBe(false);
    await app.close();
  });

  it('binds the history body too — credentials for one window do not travel to another', async () => {
    const app = await mount();
    const honest = wire(validHistory);
    const headers = serviceAuthHeadersForBody('svc-bank', SECRET, honest);

    const other = wire({ ...validHistory, account: { ownerType: 'treasury', ownerId: 'mint', assetId: 'IFC', kind: 'available' } });
    expect(other).not.toBe(honest);

    const res = await send(app, '/trpc/history', headers, other);

    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('surfaces the cap refusal as 400 on the wire, carrying its code', async () => {
    const app = await mount(
      stubService({
        history: async () => {
          throw new HistoryTooLargeError(
            'acct-1',
            { from: new Date('2026-07-09T00:00:00Z'), to: new Date('2026-08-08T00:00:00Z') },
            HISTORY_MAX_ENTRIES,
          );
        },
      }),
    );
    const payload = wire(validHistory);

    const res = await send(app, '/trpc/history', serviceAuthHeadersForBody('svc-bank', SECRET, payload), payload);

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('ledger.history_range_too_large');
    await app.close();
  });

  it('ANSWERS a quiet history as a 200 empty array, never a 0 amount', async () => {
    const app = await mount(stubService({ history: async () => [] }));
    const payload = wire(validHistory);
    const res = await send(app, '/trpc/history', serviceAuthHeadersForBody('svc-bank', SECRET, payload), payload);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
    expect(JSON.stringify(res.json())).not.toMatch(/"0"/);
    await app.close();
  });

  it('does not invent a paged-history cursor — `after` is 400, not a silent first page', async () => {
    const app = await mount(stubService({ history: async () => [historyEntry] }));
    const payload = wire({ ...validHistory, after: 'entry-1' });
    const res = await send(app, '/trpc/history', serviceAuthHeadersForBody('svc-bank', SECRET, payload), payload);
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('ledger.history_page_socket');
    expect(Array.isArray(res.json())).toBe(false);
    await app.close();
  });

  it('serves /trpc/historyPage behind the same guard: 401 without credentials, never asked', async () => {
    let asked = false;
    const app = await mount(
      stubService({
        historyPage: async () => {
          asked = true;
          return { entries: [], nextCursor: null };
        },
      }),
    );
    const res = await send(app, '/trpc/historyPage', {}, wire({ ownerType: 'user', ownerId: USER, kind: 'available' }));
    expect(res.statusCode).toBe(401);
    expect(asked).toBe(false);
    await app.close();
  });

  it('serves /trpc/historyPage to a signed service: decimal-string amounts, ISO times, cursor passthrough', async () => {
    const seen: unknown[] = [];
    const app = await mount(
      stubService({
        historyPage: async (input: unknown) => {
          seen.push(input);
          return {
            entries: [
              { ...historyEntry, assetId: 'USDT', entryId: '42', rail: 'crypto-native', orderId: null, fee: 123_000_000_000_000_000n },
            ],
            nextCursor: 'abc',
          };
        },
      }),
    );
    const payload = wire({ ownerType: 'user', ownerId: USER, kind: 'available', assetId: 'USDT' });
    const res = await send(app, '/trpc/historyPage', serviceAuthHeadersForBody('svc-bank', SECRET, payload), payload);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      entries: [
        {
          txId: 'tx-hist-1',
          module: 'trade',
          reason: 'trade.fill',
          direction: 'credit',
          amount: '12.345678901234567891',
          postedAt: '2026-07-27T12:00:00.000Z',
          assetId: 'USDT',
          entryId: '42',
          rail: 'crypto-native',
          orderId: null,
          fee: '0.123',
        },
      ],
      nextCursor: 'abc',
    });
    expect(seen[0]).toMatchObject({ limit: 50, assetId: 'USDT' });
    await app.close();
  });

  it('/trpc/historyPage: bad limit is 400, forged cursor is 400 with its code, old /trpc/history still refuses cursor', async () => {
    const app = await mount();
    const body = { ownerType: 'user', ownerId: USER, kind: 'available' };

    const tooBig = wire({ ...body, limit: 201 });
    expect((await send(app, '/trpc/historyPage', serviceAuthHeadersForBody('svc-bank', SECRET, tooBig), tooBig)).statusCode).toBe(400);

    expect(httpError(new LedgerError('bad', 'ledger.history_cursor_invalid')).status).toBe(400);

    const old = wire({ ...validHistory, cursor: 'x' });
    const res = await send(app, '/trpc/history', serviceAuthHeadersForBody('svc-bank', SECRET, old), old);
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('ledger.history_page_socket');
    await app.close();
  });

  it('history infra fail is 500, never a 200 empty or a 0 spend', async () => {
    const app = await mount(
      stubService({
        history: async () => {
          throw new Error('connect ECONNREFUSED');
        },
      }),
    );
    const payload = wire(validHistory);
    const res = await send(app, '/trpc/history', serviceAuthHeadersForBody('svc-bank', SECRET, payload), payload);
    expect(res.statusCode).toBe(500);
    expect(Array.isArray(res.json())).toBe(false);
    expect(JSON.stringify(res.json())).not.toMatch(/"amount":"0"/);
    await app.close();
  });

  it('balance missing account is typed zero; infra fail is 500 not 0', async () => {
    const missing = await mount(
      stubService({
        balance: async () => ({ account: userAvailable(USER, 'USDT'), accountId: '', amount: 0n }),
      }),
    );
    const body = wire(userAvailable(USER, 'USDT'));
    const ok = await send(missing, '/trpc/balance', serviceAuthHeadersForBody('svc-bank', SECRET, body), body);
    expect(ok.statusCode).toBe(200);
    expect(ok.json().amount).toBe('0');
    expect(typeof ok.json().amount).toBe('string');
    await missing.close();

    const failing = await mount(
      stubService({
        balance: async () => {
          throw new Error('connect ECONNREFUSED');
        },
      }),
    );
    const fail = await send(failing, '/trpc/balance', serviceAuthHeadersForBody('svc-bank', SECRET, body), body);
    expect(fail.statusCode).toBe(500);
    expect(fail.json()).not.toHaveProperty('amount');
    expect(JSON.stringify(fail.json())).not.toMatch(/"0"/);
    await failing.close();
  });

  it('statement infra fail is 500, never a 0 PnL/NAV', async () => {
    const app = await mount(
      stubService({
        balances: async () => {
          throw new Error('connect ECONNREFUSED');
        },
      }),
      { doorCallers: { statementPnl: ['svc-bank'], reportExport: ['svc-bank'], custody: ['svc-bank'] } },
    );
    const payload = wire({ ownerType: 'user', ownerId: USER, reportingAssetId: 'USDT' });
    const res = await send(app, '/trpc/statementPnl', serviceAuthHeadersForBody('svc-bank', SECRET, payload), payload);
    expect(res.statusCode).toBe(500);
    expect(JSON.stringify(res.json())).not.toMatch(/"realized":"0"/);
    expect(JSON.stringify(res.json())).not.toMatch(/"nav":"0"/);
    await app.close();
  });

  it('maps the page-socket refusal to 400 with a rehydratable code', () => {
    const mapped = httpError(new LedgerError('socket', 'ledger.history_page_socket'));
    expect(mapped.status).toBe(400);
    expect(mapped.body.code).toBe('ledger.history_page_socket');
  });

  it('refuses an owner id from the wrong identifier space on this route as well', async () => {
    const app = await mount();
    // A vendored bigint member id where a user UUID belongs — the dual-book door.
    const payload = wire({ ...validHistory, account: { ...validHistory.account, ownerId: '1042' } });

    const res = await send(app, '/trpc/history', serviceAuthHeadersForBody('svc-bank', SECRET, payload), payload);

    expect(res.statusCode).toBe(400);
    await app.close();
  });

  // ── The parser this change swapped in must not have changed anything else ──

  it('still answers 400 for malformed JSON, with Fastify’s own code', async () => {
    const app = await mount();
    const payload = '{not json';

    const res = await send(app, '/trpc/post', serviceAuthHeadersForBody('svc-trade', SECRET, payload), payload);

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('FST_ERR_CTP_INVALID_JSON_BODY');
    await app.close();
  });

  it('still answers 400 for an empty JSON body', async () => {
    const app = await mount();

    const res = await send(app, '/trpc/post', serviceAuthHeadersForBody('svc-trade', SECRET, ''), '');

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('FST_ERR_CTP_EMPTY_JSON_BODY');
    await app.close();
  });

  it('maps a reused idempotency key with a different body to 409, so a caller cannot record success', () => {
    expect(httpError(new LedgerError('key taken by another movement', 'ledger.idempotency_conflict'))).toEqual({
      status: 409,
      body: { message: 'key taken by another movement', code: 'ledger.idempotency_conflict' },
    });
  });

  it('maps an unauthenticated caller to 401, distinct from 412 frozen and 400 funds', () => {
    expect(httpError(new LedgerError('no creds', 'ledger.unauthenticated')).status).toBe(401);
    expect(httpError(new LedgerError('frozen', 'ledger.frozen')).status).toBe(412);
    expect(httpError(new InsufficientFundsError('a', 'USDT', '1', '0')).status).toBe(400);
    expect(httpError(new LedgerError('not a recipe', RECIPE_REQUIRED_CODE))).toEqual({
      status: 400,
      body: { message: 'not a recipe', code: RECIPE_REQUIRED_CODE },
    });
  });
});
