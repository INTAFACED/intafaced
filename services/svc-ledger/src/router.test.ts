import { describe, expect, it, beforeEach } from 'vitest';
import { issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import type { Context } from '@intafaced/contracts';
import {
  InsufficientFundsError,
  InvalidEntryError,
  LedgerError,
  UnbalancedTransactionError,
  formatAmount,
  houseFees,
  moduleAccount,
  parseAmount as amt,
  railBoundary,
  recipes,
  subAccountAvailable,
  userAvailable,
  type PostRequest,
} from '@intafaced/ledger-client';
import { createLedgerRouter } from './router.js';
import { stubApprovalConsumer } from './ledger/action-approval-consume.js';
import { RECIPE_REQUIRED_CODE } from './recipe-gate.js';
import { WITHDRAW_RETURN_UNBOUND_CODE } from './withdraw-return-binding.js';
import type { LedgerService } from './service.js';
import { userCopy } from './user-copy.js';

/**
 * The tRPC surface.
 *
 * This file exists because the DoD gate said it should: `router.ts` reaches the
 * ledger and had no test, which the old "any test nearby counts" check hid.
 *
 * What it protects is error MAPPING and authorisation, not ledger maths — the
 * engine has its own conformance suite. A caller has to be able to tell
 * "you cannot afford this" from "the ledger is frozen" from "your service sent
 * a malformed transaction", because those three demand completely different
 * responses and two of them are not the user's fault.
 */

const authConfig = {
  secret: 'a-ledger-router-test-secret-long-enough',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
};

const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SUB = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const APPROVED = { approvalId: 'appr-1', operationId: 'op-1' };

function withApproval(service: LedgerService) {
  return createLedgerRouter(service, undefined, stubApprovalConsumer(OTHER));
}

/**
 * `mfa` defaults false. Treasury scopes are in `INTERACTIVE_ONLY_SCOPES`, so
 * `requireScope` refuses them without a second factor — which is why the
 * operator tests below pass `mfa: true`. Discovered by writing this file: the
 * first draft omitted it and the freeze tests failed, correctly.
 */
async function ctx(scopes: string[], mfa = false, service: string | null = 'svc-trade', subAccountId?: string): Promise<Context> {
  if (scopes.length === 0) return { principal: null, service, region: 'DE', requestId: 'req-1' };
  const { token } = await issueAccessToken(
    {
      userId: USER,
      sessionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      scopes,
      tier: 'basic',
      mfa,
      ...(subAccountId ? { subAccountId } : {}),
    },
    authConfig,
  );
  return { principal: await verifyAccessToken(token, authConfig), service, region: 'DE', requestId: 'req-1' };
}

/**
 * A caller off the network with no credentials of any kind — no principal, no
 * service. This is what `post` used to accept.
 */
const anonymousCtx = (): Context => ({ principal: null, service: null, region: 'DE', requestId: 'req-anon' });

/** Minimal stand-in — the router only ever calls these five. */
function stubService(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    post: async () => ({ id: 'tx-1', hash: 'abc', postedAt: new Date('2026-07-27T00:00:00Z') }),
    balance: async () => ({ account: userAvailable(USER, 'USDT'), accountId: 'acct-1', amount: amt('100') }),
    balances: async () => [{ account: userAvailable(USER, 'USDT'), accountId: 'acct-1', amount: amt('100') }],
    reconcile: async () => ({ ok: true, balances: { ok: true, accountsChecked: 3 }, chain: { ok: true, length: 7 }, unbalancedAssets: [] }),
    freezeState: async () => ({
      frozen: false,
      reason: null,
      actor: null,
      changedAt: new Date('2026-07-27T00:00:00Z'),
      changedAtPrecise: '2026-07-27 00:00:00.000000+00',
    }),
    freeze: async (reason: string, actor: string) => ({ frozen: true, reason, actor, changedAt: new Date('2026-07-27T00:00:00Z') }),
    unfreeze: async (actor: string) => ({ frozen: false, reason: null, actor, changedAt: new Date('2026-07-27T00:00:00Z') }),
    status: async () => ({ postingEnabled: true, frozenReason: null, frozenBy: null }),
    ...overrides,
  } as unknown as LedgerService;
}

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

/** A registry recipe. The old two-leg `trade.fill` fixture is not one. */
const validPost = toWire(recipes.orderHold({ orderId: 'order-test', userId: USER, assetId: 'USDT', amount: amt('10') }));

const assembledSecondBook = {
  idempotencyKey: 'second-book-not-a-recipe',
  module: 'evil',
  reason: 'second.book',
  entries: [
    { account: userAvailable(USER, 'USDT'), direction: 'credit' as const, amount: '10' },
    {
      account: userAvailable(OTHER, 'USDT'),
      direction: 'debit' as const,
      amount: '10',
    },
  ],
};

describe('post — who may call it at all', () => {
  /**
   * THE ONE THAT MATTERS.
   *
   * `post` was a `publicProcedure`. Mounted, that let anyone reaching the port
   * post a balanced transaction crediting `railBoundary` — a `treasury`
   * account, the only owner type allowed to run negative — and debiting their
   * own `available`. That is the `deposit` recipe: sum-to-zero passes,
   * non-negative passes, paired locks pass. Well-formed, and unauthorised.
   *
   * Note the shape of this test: it does not check an error message, it checks
   * that the ledger was never asked to move anything.
   */
  it('refuses a caller with no service credentials, and moves nothing', async () => {
    let posted = false;
    const service = stubService({
      post: async () => {
        posted = true;
        return { id: 'tx-1', hash: 'abc', postedAt: new Date() };
      },
    });

    await expect(createLedgerRouter(service).createCaller(anonymousCtx()).post(validPost)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    expect(posted).toBe(false);
  });

  it('is not satisfied by a USER token, however privileged', async () => {
    // A user principal is not a service. There is no `ledger:write` scope by
    // design, and `admin:treasury` with MFA still must not reach `post`.
    await expect(
      createLedgerRouter(stubService())
        .createCaller(await ctx(['admin:treasury'], true, null))
        .post(validPost),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('accepts an authenticated service caller', async () => {
    const caller = createLedgerRouter(stubService()).createCaller(await ctx([], false, 'svc-trade'));
    await expect(caller.post(validPost)).resolves.toMatchObject({ txId: 'tx-1', hash: 'abc' });
  });

  it('refuses assembled entries that are not a known recipe, and never posts', async () => {
    let posted = false;
    const service = stubService({
      post: async () => {
        posted = true;
        return { id: 'tx-1', hash: 'abc', postedAt: new Date() };
      },
    });

    await expect(
      createLedgerRouter(service)
        .createCaller(await ctx([]))
        .post(assembledSecondBook),
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: "POST /trpc/post only accepts ledger-client recipes; 'evil/second.book' is not a known recipe",
      cause: expect.objectContaining({ code: RECIPE_REQUIRED_CODE }),
    });
    expect(posted).toBe(false);
  });
});

describe('post — a returned withdrawal is bound to its settle on this door too', () => {
  const returned = toWire(
    recipes.withdrawReturned({ userId: USER, assetId: 'USDT', amount: amt('40'), rail: 'crypto-native', withdrawalId: 'wd-1:1' }),
  );

  function counting() {
    const seen = { posted: false };
    const service = stubService({
      getTxByKey: async () => null,
      post: async () => {
        seen.posted = true;
        return { id: 'tx-1', hash: 'abc', postedAt: new Date() };
      },
    });
    return { seen, caller: async () => createLedgerRouter(service).createCaller(await ctx([])) };
  }

  it('refuses a return with no posted settle as BAD_REQUEST, and never posts', async () => {
    const { seen, caller } = counting();
    await expect((await caller()).post(returned)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      cause: expect.objectContaining({ code: WITHDRAW_RETURN_UNBOUND_CODE }),
    });
    expect(seen.posted).toBe(false);
  });

  it('refuses a caller-chosen reason that borrows withdraw.returned from another module', async () => {
    const { seen, caller } = counting();
    const borrowed = toWire(
      recipes.rewardPay({ userId: USER, assetId: 'USDT', amount: amt('40'), reason: 'withdraw.returned', rewardId: 'r-1' }),
    );
    await expect((await caller()).post(borrowed)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringContaining('not the ledger module'),
      cause: expect.objectContaining({ code: WITHDRAW_RETURN_UNBOUND_CODE }),
    });
    expect(seen.posted).toBe(false);
  });
});

describe('post — error mapping', () => {
  it('accepts a valid post and returns the transaction', async () => {
    const caller = createLedgerRouter(stubService()).createCaller(await ctx([]));
    await expect(caller.post(validPost)).resolves.toMatchObject({ txId: 'tx-1', hash: 'abc' });
  });

  it('maps insufficient funds to BAD_REQUEST — the caller can act on this', async () => {
    const service = stubService({
      post: async () => {
        throw new InsufficientFundsError('acct-1', 'USDT', '100', '10');
      },
    });
    await expect(
      createLedgerRouter(service)
        .createCaller(await ctx([]))
        .post(validPost),
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: userCopy('ledger.insufficient_funds'),
    });
  });

  it('maps a frozen ledger to PRECONDITION_FAILED, not BAD_REQUEST', async () => {
    // Distinct on purpose: "you cannot afford this" is the user's problem and
    // permanent until they fund; "the ledger is frozen" is ours and temporary.
    // Collapsing them would have every caller retrying the wrong one.
    const service = stubService({
      post: async () => {
        throw new LedgerError('Ledger posting is frozen: reconciliation mismatch', 'ledger.frozen');
      },
    });
    await expect(
      createLedgerRouter(service)
        .createCaller(await ctx([]))
        .post(validPost),
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: userCopy('ledger.frozen'),
    });
  });

  it('maps an unbalanced transaction to INTERNAL_SERVER_ERROR — that is a calling-service bug', async () => {
    const service = stubService({
      post: async () => {
        throw new UnbalancedTransactionError({ USDT: '1' });
      },
    });
    await expect(
      createLedgerRouter(service)
        .createCaller(await ctx([]))
        .post(validPost),
    ).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: userCopy('ledger.unbalanced'),
    });
  });

  it('maps an invalid entry to INTERNAL_SERVER_ERROR for the same reason', async () => {
    const service = stubService({
      post: async () => {
        throw new InvalidEntryError('zero-amount entry');
      },
    });
    await expect(
      createLedgerRouter(service)
        .createCaller(await ctx([]))
        .post(validPost),
    ).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: userCopy('ledger.invalid_entry'),
    });
  });

  it('rejects a malformed request before it reaches the ledger', async () => {
    const caller = createLedgerRouter(stubService()).createCaller(await ctx([]));

    // Single entry — value moving from nowhere.
    await expect(caller.post({ ...validPost, entries: [validPost.entries[0]!] })).rejects.toThrow();
    // Short idempotency key — a retry could not find the original.
    await expect(caller.post({ ...validPost, idempotencyKey: 'short' })).rejects.toThrow();
    // Float amount on the wire.
    await expect(
      caller.post({ ...validPost, entries: [{ ...validPost.entries[0]!, amount: '1.5e3' }, validPost.entries[1]!] }),
    ).rejects.toThrow();
  });
});

describe('balances — authorisation', () => {
  it('requires ledger:read', async () => {
    const caller = createLedgerRouter(stubService()).createCaller(await ctx(['trade:read']));
    await expect(caller.balance(userAvailable(USER, 'USDT'))).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('serves a scoped principal its own balance', async () => {
    const caller = createLedgerRouter(stubService()).createCaller(await ctx(['ledger:read']));
    await expect(caller.balance(userAvailable(USER, 'USDT'))).resolves.toMatchObject({ amount: '100' });
  });

  it('refuses to list another user’s balances, scope notwithstanding', async () => {
    // The scope says "may read balances", not "may read anyone's balances".
    const caller = createLedgerRouter(stubService()).createCaller(await ctx(['ledger:read']));
    await expect(caller.balances({ ownerType: 'user', ownerId: OTHER })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(caller.balances({ ownerType: 'user', ownerId: USER })).resolves.toHaveLength(1);
  });

  it('refuses a ledger:read principal reading an owner it does not hold', async () => {
    let asked = false;
    const service = stubService({
      balance: async () => {
        asked = true;
        return { account: userAvailable(USER, 'USDT'), accountId: 'acct-1', amount: amt('100') };
      },
      balances: async () => {
        asked = true;
        return [{ account: userAvailable(USER, 'USDT'), accountId: 'acct-1', amount: amt('100') }];
      },
    });
    const caller = createLedgerRouter(service).createCaller(await ctx(['ledger:read']));
    const unheld = [
      userAvailable(OTHER, 'USDT'),
      subAccountAvailable(SUB, 'USDT'),
      moduleAccount('pay', 'clearing', 'USDT'),
      houseFees('trade', 'USDT'),
      railBoundary('crypto-native', 'USDT'),
    ];

    for (const account of unheld) {
      const owner = { ownerType: account.ownerType, ownerId: account.ownerId };
      await expect(caller.balance(account)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(caller.balances(owner)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(caller.portfolio(owner)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(caller.statementPnl({ ...owner, reportingAssetId: 'USDT' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
    expect(asked).toBe(false);
  });

  it('serves the sub-account a principal holds, and still refuses the ones it does not', async () => {
    const caller = createLedgerRouter(stubService()).createCaller(await ctx(['ledger:read'], false, 'svc-trade', SUB));

    await expect(caller.balance(subAccountAvailable(SUB, 'USDT'))).resolves.toMatchObject({ amount: '100' });
    await expect(caller.balances({ ownerType: 'subaccount', ownerId: SUB })).resolves.toEqual([
      expect.objectContaining({ amount: '100', assetId: 'USDT' }),
    ]);
    await expect(caller.portfolio({ ownerType: 'subaccount', ownerId: SUB })).resolves.toMatchObject({
      ownerType: 'subaccount',
      ownerId: SUB,
      custodial: [{ amount: '100', assetId: 'USDT' }],
    });
    await expect(caller.statementPnl({ ownerType: 'subaccount', ownerId: SUB, reportingAssetId: 'USDT' })).resolves.toMatchObject({
      status: 'refused',
      realized: null,
      unrealized: null,
      nav: null,
    });

    await expect(caller.balance(userAvailable(USER, 'USDT'))).resolves.toMatchObject({ amount: '100' });
    await expect(caller.balance(userAvailable(OTHER, 'USDT'))).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(caller.balance(subAccountAvailable(OTHER, 'USDT'))).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(caller.balances({ ownerType: 'module', ownerId: 'pay:clearing' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(caller.balances({ ownerType: 'house', ownerId: 'fees:trade' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(caller.portfolio({ ownerType: 'treasury', ownerId: 'mint' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(caller.statementPnl({ ownerType: 'house', ownerId: 'fees:trade', reportingAssetId: 'USDT' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('serves a portfolio view of own balances with indexer named absent when chain account is missing', async () => {
    const fetch = async () => {
      throw new Error('indexer must not be called without a 0x account');
    };
    const caller = createLedgerRouter(stubService(), { url: 'http://indexer.test', fetch }).createCaller(await ctx(['ledger:read']));
    await expect(caller.portfolio({ ownerType: 'user', ownerId: USER })).resolves.toMatchObject({
      ownerId: USER,
      custodial: [{ amount: '100', assetId: 'USDT' }],
      indexer: { status: 'absent', reason: 'indexer.portfolio_positions_unwired' },
    });
  });

  it('refuses another user’s portfolio, and does not invent chain zeros on an empty book', async () => {
    const caller = createLedgerRouter(
      stubService({
        balances: async () => [],
      }),
    ).createCaller(await ctx(['ledger:read']));

    await expect(caller.portfolio({ ownerType: 'user', ownerId: OTHER })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(caller.portfolio({ ownerType: 'user', ownerId: USER })).resolves.toMatchObject({
      custodial: [],
      indexer: { status: 'absent', reason: 'indexer.portfolio_positions_unwired' },
    });
  });

  it('composes present indexer positions as decimal strings when URL + 0x account work', async () => {
    const chainAccount = '0x1111111111111111111111111111111111111111';
    const fetch = async () =>
      new Response(
        JSON.stringify({
          result: { data: [{ market: 'IFC-USD', size: '1.5', entryPrice: '30.25' }] },
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    const caller = createLedgerRouter(stubService(), { url: 'http://indexer.test', fetch }).createCaller(await ctx(['ledger:read']));
    const view = await caller.portfolio({ ownerType: 'user', ownerId: USER, chainAccount });
    expect(view.indexer).toEqual({
      status: 'present',
      positions: [{ market: 'IFC-USD', size: '1.5', entryPrice: '30.25' }],
    });
    if (view.indexer.status !== 'present') throw new Error('expected present');
    expect(typeof view.indexer.positions[0]!.size).toBe('string');
    expect(typeof view.indexer.positions[0]!.entryPrice).toBe('string');
  });

  it('names unwired when the indexer fetch fails, and never returns a zero chain amount', async () => {
    const chainAccount = '0x1111111111111111111111111111111111111111';
    const fetch = async () => {
      throw new Error('ECONNREFUSED');
    };
    const caller = createLedgerRouter(stubService(), { url: 'http://indexer.test', fetch }).createCaller(await ctx(['ledger:read']));
    const view = await caller.portfolio({ ownerType: 'user', ownerId: USER, chainAccount });
    expect(view.indexer).toEqual({ status: 'absent', reason: 'indexer.portfolio_positions_unwired' });
    expect(view.indexer).not.toHaveProperty('amount');
    expect(JSON.stringify(view.indexer)).not.toMatch(/"0"/);
  });

  it('rejects an anonymous caller', async () => {
    const caller = createLedgerRouter(stubService()).createCaller(await ctx([]));
    await expect(caller.balance(userAvailable(USER, 'USDT'))).rejects.toThrow(/Authentication required/);
  });

  it('statement PnL refuses when lots/marks/NAV are missing, and never returns 0', async () => {
    const caller = createLedgerRouter(stubService()).createCaller(await ctx(['ledger:read']));
    const out = await caller.statementPnl({ ownerType: 'user', ownerId: USER, reportingAssetId: 'USDT' });
    expect(out.status).toBe('refused');
    expect(out.realized).toBeNull();
    expect(out.unrealized).toBeNull();
    expect(out.nav).toBeNull();
    expect(out.codes).toEqual(['ledger.statement.lots_missing', 'ledger.statement.mark_missing', 'ledger.statement.nav_inputs_missing']);
    expect(JSON.stringify(out)).not.toMatch(/"0"/);
  });

  it('refuses another user’s statement PnL', async () => {
    const caller = createLedgerRouter(stubService()).createCaller(await ctx(['ledger:read']));
    await expect(caller.statementPnl({ ownerType: 'user', ownerId: OTHER, reportingAssetId: 'USDT' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });
});

describe('operator controls', () => {
  let frozenWith: { reason: string; actor: string } | null;
  let service: LedgerService;

  beforeEach(() => {
    frozenWith = null;
    service = stubService({
      freeze: async (reason: string, actor: string) => {
        frozenWith = { reason, actor };
        return { frozen: true, reason, actor, changedAt: new Date('2026-07-27T00:00:00Z') };
      },
    });
  });

  it('requires admin:treasury to freeze', async () => {
    const caller = withApproval(service).createCaller(await ctx(['ledger:read', 'admin:read']));
    await expect(caller.freeze({ reason: 'testing', ...APPROVED })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(frozenWith).toBeNull();
  });

  it('refuses to freeze without a second factor, even with the scope', async () => {
    // §9: treasury actions are INTERACTIVE_ONLY. A stolen access token carrying
    // admin:treasury must not be able to halt the platform on its own.
    const caller = withApproval(service).createCaller(await ctx(['admin:treasury'], false));
    await expect(caller.freeze({ reason: 'testing', ...APPROVED })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(frozenWith).toBeNull();
  });

  it('freezes with the operator’s reason AND their identity recorded', async () => {
    // Who froze it is not decoration. An operator finding the platform halted
    // needs to know whether a human did it or reconciliation did.
    const caller = withApproval(service).createCaller(await ctx(['admin:treasury'], true));
    await expect(caller.freeze({ reason: 'suspected drift in USDT', ...APPROVED })).resolves.toEqual({
      postingEnabled: false,
      frozenReason: 'suspected drift in USDT',
      frozenBy: USER,
      confirmOperatorId: OTHER,
    });
    expect(frozenWith).toEqual({ reason: 'suspected drift in USDT', actor: USER });
  });

  it('demands a non-empty reason — an unexplained freeze is unactionable', async () => {
    const caller = withApproval(service).createCaller(await ctx(['admin:treasury'], true));
    await expect(caller.freeze({ reason: '', ...APPROVED })).rejects.toThrow();
  });

  it('demands a usable reason (≥12 chars), same floor as the operator HTTP door', async () => {
    // "testing" is 7 characters. The old min(1) accepted it; the next operator
    // reading posting_freeze.reason would learn nothing. Align with operator-http.
    const caller = withApproval(service).createCaller(await ctx(['admin:treasury'], true));
    await expect(caller.freeze({ reason: 'too short', ...APPROVED })).rejects.toThrow();
    expect(frozenWith).toBeNull();

    await expect(caller.freeze({ reason: 'suspected drift in USDT', ...APPROVED })).resolves.toMatchObject({
      postingEnabled: false,
      frozenReason: 'suspected drift in USDT',
      confirmOperatorId: OTHER,
    });
    expect(frozenWith).toEqual({ reason: 'suspected drift in USDT', actor: USER });
  });

  it('maps freeze_attributed to CONFLICT — not a silent soft success', async () => {
    const conflicted = stubService({
      freeze: async () => {
        throw new LedgerError('Ledger already frozen by recon: reconciliation mismatch — refusing overwrite', 'ledger.freeze_attributed');
      },
    });
    const caller = withApproval(conflicted).createCaller(await ctx(['admin:treasury'], true));
    await expect(caller.freeze({ reason: 'operator: suspected USDT drift', ...APPROVED })).rejects.toMatchObject({
      code: 'CONFLICT',
      message: userCopy('ledger.freeze_attributed'),
    });
  });

  it('freeze/unfreeze without approval ids refuse — a typed-in second name is not enough', async () => {
    const caller = withApproval(service).createCaller(await ctx(['admin:treasury'], true));
    await expect(caller.freeze({ reason: 'suspected drift in USDT', confirmOperatorId: OTHER } as never)).rejects.toThrow();
    await expect(caller.freeze({ reason: 'suspected drift in USDT', confirmOperatorId: USER } as never)).rejects.toThrow();
    expect(frozenWith).toBeNull();

    await expect(caller.unfreeze({} as never)).rejects.toThrow();
    await expect(caller.unfreeze({ confirmOperatorId: USER } as never)).rejects.toThrow();

    await expect(caller.unfreeze({ ...APPROVED })).resolves.toMatchObject({
      postingEnabled: true,
      confirmOperatorId: OTHER,
    });
  });

  it('gates reconcile behind admin:treasury and reports the run', async () => {
    const open = withApproval(stubService()).createCaller(await ctx(['admin:treasury'], true));
    await expect(open.reconcile({ ...APPROVED })).resolves.toMatchObject({
      ok: true,
      accountsChecked: 3,
      chainLength: 7,
      confirmOperatorId: OTHER,
    });

    const denied = createLedgerRouter(stubService()).createCaller(await ctx(['ledger:read']));
    await expect(denied.reconcile({ ...APPROVED })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('reconcile without a distinct confirm refuses and does not run', async () => {
    let ran = false;
    const caller = withApproval(
      stubService({
        reconcile: async () => {
          ran = true;
          throw new Error('must not run');
        },
      }),
    ).createCaller(await ctx(['admin:treasury'], true));
    await expect(caller.reconcile({} as never)).rejects.toThrow();
    await expect(caller.reconcile({ confirmOperatorId: USER } as never)).rejects.toThrow();
    expect(ran).toBe(false);
  });

  it('on a broken chain reports length-so-far, never invents green zero', async () => {
    // The previous shape collapsed a failed chain to chainLength: 0. An empty
    // book and a book that broke at tx 5 are not the same fact.
    const open = withApproval(
      stubService({
        reconcile: async () => ({
          ok: false,
          ranAt: new Date('2026-08-09T00:00:00Z'),
          balances: { ok: true, accountsChecked: 2 },
          chain: { ok: false, brokenAt: 'tx-broken', length: 5 },
          totals: { USDT: '0' },
          unbalancedAssets: [],
        }),
      }),
    ).createCaller(await ctx(['admin:treasury'], true));

    await expect(open.reconcile({ ...APPROVED })).resolves.toMatchObject({
      ok: false,
      accountsChecked: 2,
      chainLength: 5,
      chainBrokenAt: 'tx-broken',
      unbalancedAssets: [],
      confirmOperatorId: OTHER,
    });
  });
});

describe('health', () => {
  it('is open, and reports whether posting is enabled', async () => {
    const caller = createLedgerRouter(stubService()).createCaller(await ctx([]));
    await expect(caller.health()).resolves.toEqual({ ok: true, service: 'svc-ledger', postingEnabled: true });
  });

  it('reflects a frozen ledger', async () => {
    const service = stubService({ status: async () => ({ postingEnabled: false, frozenReason: 'drift', frozenBy: 'reconciliation' }) });
    const caller = createLedgerRouter(service).createCaller(await ctx([]));
    await expect(caller.health()).resolves.toMatchObject({ postingEnabled: false });
  });
});

describe('amounts cross the boundary as decimal strings', () => {
  it('never returns a number', async () => {
    const service = stubService({
      balance: async () => ({
        account: userAvailable(USER, 'USDT'),
        accountId: 'acct-1',
        amount: amt('1234.123456789012345678'),
      }),
    });
    const caller = createLedgerRouter(service).createCaller(await ctx(['ledger:read']));
    const result = await caller.balance(userAvailable(USER, 'USDT'));

    expect(typeof result.amount).toBe('string');
    // Full 18-decimal precision survives — a float would have lost it here.
    expect(result.amount).toBe('1234.123456789012345678');
    expect(formatAmount(amt(result.amount))).toBe('1234.123456789012345678');
  });
});
