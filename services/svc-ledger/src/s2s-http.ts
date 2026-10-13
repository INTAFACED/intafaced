import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  DEFAULT_SERVICE_BODY_BIND_MODE,
  rawBodyOf,
  retainRawBody,
  verifyServiceHeaders,
  type ServiceBodyBindMode,
} from '@intafaced/contracts';
import {
  formatAmount,
  parseAmount,
  accountPurpose,
  accountRefSchema,
  postRequestSchema,
  InsufficientFundsError,
  LedgerError,
  UnbalancedTransactionError,
  InvalidEntryError,
  type EntryInput,
} from '@intafaced/ledger-client';
import { z } from 'zod';
import { composePortfolioView } from '@intafaced/portfolio-view';
import { handleCustody } from './ledger/custody-adapters.js';
import { handleFinanceClose } from './ledger/finance-close.js';
import { parseHistoryDoorInput, parseHistoryPageInput, parseHistoryRange, serializeHistoryPage } from './ledger/history.js';
import { handleReportExport } from './ledger/report-export.js';
import { handleResilience } from './ledger/resilience-gate.js';
import { handleStatementPnlHappyOrRefuse } from './ledger/statement-pnl-reproduce.js';
import { RECIPE_REQUIRED_CODE, assertKnownRecipePost } from './recipe-gate.js';
import type { LedgerService } from './service.js';
import { userCopy } from './user-copy.js';

/**
 * Plain S2S HTTP surface used by service ledger-clients.
 *
 * Bodies are raw JSON (not the tRPC envelope). Kept out of `index.ts` so the
 * DoD gate can require a real import from a test without booting Postgres.
 */

export function httpError(err: unknown): { status: number; body: Record<string, unknown> } {
  // Insufficient funds must rehydrate as InsufficientFundsError on callers
  // (P2P void-on-failed-lock). Message alone is lossy under string-wrapped throws.
  if (err instanceof InsufficientFundsError) {
    return {
      status: 400,
      body: {
        message: userCopy(err.code),
        code: err.code,
        accountId: err.accountId,
        assetId: err.assetId,
        requested: err.requested,
        availableBalance: err.availableBalance,
      },
    };
  }
  if (err instanceof UnbalancedTransactionError || err instanceof InvalidEntryError) {
    return { status: 500, body: { message: userCopy(err.code), code: err.code } };
  }
  // 400, not 500: the caller handed us an identifier from the wrong space. That
  // is a bad request with an actionable fix ("you passed the vendored member id
  // where a user UUID belongs"), and an adapter must be able to tell it apart
  // from our own bug — it is the one error where retrying is guaranteed useless.
  if (err instanceof LedgerError && err.code === 'ledger.owner_identity_space') {
    return { status: 400, body: { message: err.message, code: err.code } };
  }
  // 401, not 403: the caller has not said who it is. "Known and not allowed" is
  // a different answer and must stay distinguishable to a calling service.
  if (err instanceof LedgerError && err.code === 'ledger.unauthenticated') {
    return { status: 401, body: { message: err.message, code: err.code } };
  }
  // 409: the key is taken by a different movement. Retrying unchanged is guaranteed
  // useless and the caller must NOT record success; a new key is a new movement.
  if (err instanceof LedgerError && err.code === 'ledger.idempotency_conflict') {
    return { status: 409, body: { message: err.message, code: err.code } };
  }
  if (err instanceof LedgerError && err.code === 'ledger.frozen') {
    return { status: 412, body: { message: userCopy(err.code), code: err.code } };
  }
  // 400 for both history refusals, same reasoning as `owner_identity_space`
  // above: the request as asked cannot be answered, retrying it unchanged is
  // guaranteed useless, and the fix is in the caller's hands — invert the
  // window, or narrow it. A 500 would tell an operator to look at this service
  // for a fault that is not here, and would read as "the ledger is broken" on a
  // caller that is about to decide whether to show a user a number.
  if (
    err instanceof LedgerError &&
    (err.code === 'ledger.history_range_invalid' ||
      err.code === 'ledger.history_range_too_large' ||
      err.code === 'ledger.history_page_socket' ||
      err.code === 'ledger.history_cursor_invalid' ||
      err.code === RECIPE_REQUIRED_CODE)
  ) {
    return { status: 400, body: { message: err.message, code: err.code } };
  }
  if (err instanceof LedgerError) return { status: 500, body: { message: userCopy(err.code), code: err.code } };
  if (err instanceof z.ZodError) return { status: 400, body: { message: err.message } };
  return { status: 500, body: { message: 'Ledger request failed' } };
}

const balancesInput = z.object({
  ownerType: z.enum(['user', 'subaccount', 'module', 'house', 'treasury']),
  ownerId: z.string(),
});

const portfolioS2sInput = balancesInput.extend({
  chainAccount: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/)
    .optional(),
});

export interface PortfolioIndexerCompose {
  readonly url?: string;
  readonly fetch?: typeof globalThis.fetch;
}

export async function handleS2sPost(ledger: LedgerService, body: unknown) {
  const input = postRequestSchema.parse(body);
  assertKnownRecipePost(input);
  const entries: EntryInput[] = input.entries.map((e) => ({
    account: e.account,
    direction: e.direction,
    amount: parseAmount(e.amount),
  }));
  const tx = await ledger.post({
    idempotencyKey: input.idempotencyKey,
    module: input.module,
    reason: input.reason,
    entries,
    ...(input.meta ? { meta: input.meta } : {}),
    ...(input.correlationId ? { correlationId: input.correlationId } : {}),
  });
  return { txId: tx.id, hash: tx.hash, postedAt: tx.postedAt.toISOString() };
}

export async function handleS2sBalance(ledger: LedgerService, body: unknown) {
  const input = accountRefSchema.parse(body);
  const balance = await ledger.balance(input);
  return {
    accountId: balance.accountId,
    assetId: input.assetId,
    kind: input.kind,
    // Purpose is account IDENTITY (P0-3). Canonical trim — echoing the request
    // string would let padded "order:x " and "order:x" look like two pots.
    purpose: accountPurpose(input),
    amount: formatAmount(balance.amount),
  };
}

/**
 * The read svc-bank's spend view has been calling since before it existed.
 *
 * It was calling `/trpc/history`, this file registered three routes, and Fastify
 * answered `404 Route POST:/trpc/history not found` — which svc-bank's client
 * correctly refused to paper over, so `/bank/analytics` returned 500 rather than
 * a zero. The socket its adapter declared is this handler.
 *
 * Output is a BARE ARRAY of decimal-string amounts, because that is the contract
 * the caller already parses (`result.map(...)`). Wrapping it in
 * `{ entries, truncated }` would be a nicer envelope and would break the caller
 * this change exists to unbreak — so the cap is made visible by refusing instead
 * (see `ledger/history.ts`), which needs no envelope and cannot be ignored.
 */
export async function handleS2sHistory(ledger: LedgerService, body: unknown) {
  const input = parseHistoryDoorInput(body);
  const range = parseHistoryRange(input.from, input.to);
  const entries = await ledger.history(input.account, range);

  return entries.map((e) => ({
    txId: e.txId,
    module: e.module,
    reason: e.reason,
    direction: e.direction,
    // Decimal string on the wire, always. `formatAmount` is the only encoder;
    // a `number` here would round 18-decimal amounts on the way out.
    amount: formatAmount(e.amount),
    postedAt: e.postedAt.toISOString(),
  }));
}

/**
 * Paged history (U5a). `/trpc/history` is unchanged and still refuses a cursor;
 * this is the sibling that serves one. Scope (owner, kind, purpose, optional
 * asset) comes from the body, which only an authenticated service can send; the
 * cursor is a position inside that scope and is never read for an account.
 */
export async function handleS2sHistoryPage(ledger: LedgerService, body: unknown) {
  return serializeHistoryPage(await ledger.historyPage(parseHistoryPageInput(body)));
}

export async function handleS2sBalances(ledger: LedgerService, body: unknown) {
  const input = balancesInput.parse(body);
  const balances = await ledger.balances(input.ownerType, input.ownerId);
  return balances.map((b) => ({
    accountId: b.accountId,
    assetId: b.account.assetId,
    kind: b.account.kind,
    // Purpose is account IDENTITY (P0-3), not optional decoration. Two holds
    // with different claims must not collapse to the same (assetId, kind) on
    // the wire — callers that key by those alone would re-commingle what the
    // book keeps apart.
    purpose: b.account.purpose ?? '',
    amount: formatAmount(b.amount),
  }));
}

/**
 * Portfolio view. Same owner input as `balances`, plus optional 0x
 * `chainAccount`. Does not post. Chain half is HTTP/tRPC to indexer `positions`
 * when URL + address are usable; otherwise named unwired — never a zero.
 */
export async function handleS2sPortfolio(ledger: LedgerService, body: unknown, indexer?: PortfolioIndexerCompose) {
  const input = portfolioS2sInput.parse(body);
  const balances = await ledger.balances(input.ownerType, input.ownerId);
  return composePortfolioView({
    ownerType: input.ownerType,
    ownerId: input.ownerId,
    balances,
    url: indexer?.url ?? process.env.INDEXER_URL,
    chainAccount: input.chainAccount,
    fetch: indexer?.fetch,
  });
}

/**
 * G-statements-happy + B5. When lots exist, the statement reproduces.
 * Missing lots/marks/NAV still refuse. Never a fabricated 0. Does not post.
 */
export async function handleS2sStatementPnl(ledger: LedgerService, body: unknown) {
  return handleStatementPnlHappyOrRefuse(ledger, body);
}

/**
 * G-reporting. NAV / SFTP / regulator export completeness.
 * Missing IDs refuse completeness. Never invent cost basis. Does not post.
 */
export async function handleS2sReportExport(_ledger: LedgerService, body: unknown) {
  return handleReportExport(body);
}

/**
 * G-custody. Chain/fiat adapters stay adapters. Breaks age, never auto-clear.
 * Off-exchange without OWNER authorization refuses. Does not post.
 */
export async function handleS2sCustody(_ledger: LedgerService, body: unknown) {
  return handleCustody(body);
}

/**
 * G-finance. Client vs corporate stay distinct. Close refuses incomplete recipes.
 * No misleading PoR. No invented reserve. Does not post.
 */
export async function handleS2sFinanceClose(_ledger: LedgerService, body: unknown) {
  return handleFinanceClose(body);
}

/**
 * G-resilience. Degraded dependency refuses new risk. Split-brain money is
 * impossible. SLO numbers are OWNER — raw metrics still emit. Does not post.
 */
export async function handleS2sResilience(_ledger: LedgerService, body: unknown) {
  return handleResilience(body);
}

/**
 * THIS is the surface that is actually served.
 *
 * `createLedgerRouter` is constructed in `index.ts` and exported for its TYPE.
 * Nothing registers `fastifyTRPCPlugin` here, so the tRPC procedures — and every
 * guard on them — are unreachable from the port. Scoping `post` to
 * `serviceProcedure` in the router (as an earlier revision of this PR did)
 * changed a type signature and nothing a caller could reach.
 *
 * These raw handlers are the real money plane, and they had no
 * authentication of any kind. `/trpc/post` reaches `ledger.post()` directly, so
 * anyone able to reach the port could credit `railBoundary` — a `treasury`
 * account, the one owner type allowed to run negative — and debit their own
 * `available`. That is the `deposit` recipe: well-formed, every invariant
 * satisfied, and unauthorised.
 *
 * A guard written on one door does not secure the other one.
 */
export interface S2sHttpOptions {
  /**
   * How strictly to enforce body binding (L2-6). Defaults to `accept-both`, the
   * setting that cannot 401 a caller that has not been redeployed yet.
   */
  bodyBind?: ServiceBodyBindMode;
  /** Optional indexer compose. Unset URL → named `indexer.portfolio_positions_unwired`. */
  indexerUrl?: string;
  indexerFetch?: typeof globalThis.fetch;
}

export function registerS2sHttp(app: FastifyInstance, ledger: LedgerService, internalSecret: string, options: S2sHttpOptions = {}): void {
  const mode = options.bodyBind ?? DEFAULT_SERVICE_BODY_BIND_MODE;

  /**
   * Keep the exact request bytes, so the signed digest can be checked against
   * them. This is the plumbing L2-6 was deferred for; see `raw-body.ts` for what
   * was measured about Fastify's parser lifecycle.
   *
   * If this were omitted, `require` would refuse every caller with
   * `body-unavailable` rather than quietly accepting bodies it cannot verify.
   */
  retainRawBody(app);

  /**
   * Refuse before the handler runs, so an unauthenticated request never reaches
   * `ledger.post` at all — not even to be rejected by it later.
   */
  const authenticate = (req: FastifyRequest): string => {
    const { service, rejected, scheme } = verifyServiceHeaders(req.headers, internalSecret, { rawBody: rawBodyOf(req), mode });

    if (!service) {
      // The reason travels to the caller. None of them disclose secret material,
      // and `body-mismatch` versus `stale` is the difference between diagnosing
      // an incident and guessing at one.
      throw new LedgerError(`Service credentials are required on the internal ledger API (§2): ${rejected}`, 'ledger.unauthenticated');
    }

    // THE MIGRATION SIGNAL (L2-6).
    //
    // A v1 accept is an authenticated caller that has NOT bound its body, so its
    // signature is still replayable against any body on any of these three
    // routes for 300 seconds. It is tolerated only so the fleet can roll one
    // service at a time. This warning naming the caller is what makes
    // `INTERNAL_SERVICE_BODY_BIND=require` a decision an operator can justify:
    // when it has gone quiet for every caller, flipping is safe.
    if (scheme === 'v1') {
      app.log.warn(
        { callingService: service, scheme, bodyBind: mode },
        's2s caller did not bind its request body (L2-6) — its signature is replayable; redeploy it before setting INTERNAL_SERVICE_BODY_BIND=require',
      );
    }

    return service;
  };

  const guarded =
    <T>(handle: (ledger: LedgerService, body: unknown) => Promise<T>) =>
    async (req: FastifyRequest, reply: FastifyReply) => {
      try {
        authenticate(req);
        return await handle(ledger, req.body);
      } catch (err) {
        const { status, body } = httpError(err);
        return reply.code(status).send(body);
      }
    };

  app.post('/trpc/post', guarded(handleS2sPost));
  app.post('/trpc/balance', guarded(handleS2sBalance));
  app.post('/trpc/balances', guarded(handleS2sBalances));
  // Guarded by the same `authenticate` as the other three, and that is the point
  // of registering it here rather than anywhere else: an entry history is a
  // record of what a person or the house did with their money, at least as
  // sensitive as the balance it sums to. A read route mounted outside `guarded`
  // would have been unauthenticated exactly as the money plane once was. There
  // is one door, and every route goes through it.
  app.post('/trpc/history', guarded(handleS2sHistory));
  // Paged sibling, same `guarded` door (U5a).
  app.post('/trpc/historyPage', guarded(handleS2sHistoryPage));
  app.post(
    '/trpc/portfolio',
    guarded((svc, body) => handleS2sPortfolio(svc, body, { url: options.indexerUrl, fetch: options.indexerFetch })),
  );
  app.post('/trpc/statementPnl', guarded(handleS2sStatementPnl));
  app.post('/trpc/reportExport', guarded(handleS2sReportExport));
  app.post('/trpc/custody', guarded(handleS2sCustody));
  app.post('/trpc/financeClose', guarded(handleS2sFinanceClose));
  app.post('/trpc/resilience', guarded(handleS2sResilience));
}
