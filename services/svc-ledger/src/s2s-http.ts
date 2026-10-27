import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { isWriteBlockCode } from './ledger/write-block.js';
import {
  LEDGER_FEE_REVENUE_WINDOW_INVALID,
  LEDGER_HOLDINGS_HISTORY_TOO_LARGE,
  LEDGER_HOLDINGS_HISTORY_WINDOW_INVALID,
  DEFAULT_SERVICE_BODY_BIND_MODE,
  retainRawBody,
  verifyServiceRequest,
  type ServiceAuthMode,
  type ServiceBodyBindMode,
  type ServiceVerifier,
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
  type LedgerTx,
} from '@intafaced/ledger-client';
import { z } from 'zod';
import { composePortfolioView } from '@intafaced/portfolio-view';
import { handleCustody } from './ledger/custody-adapters.js';
import { handleFinanceClose } from './ledger/finance-close.js';
import { parseFeeRevenueInput, serializeFeeRevenue } from './ledger/fee-revenue.js';
import { parseHoldingsHistoryInput, serializeHoldingsHistory } from './ledger/holdings-history.js';
import { parseHistoryDoorInput, parseHistoryPageInput, parseHistoryRange, serializeHistoryPage } from './ledger/history.js';
import { handleReportExport } from './ledger/report-export.js';
import { handleResilience } from './ledger/resilience-gate.js';
import { handleStatementPnlHappyOrRefuse } from './ledger/statement-pnl-reproduce.js';
import {
  CALLER_FORBIDDEN,
  CALLER_UNBOUND,
  applyCallerBinding,
  callerBindingCount,
  callerBindingWarnAllowed,
  type CallerBindingOptions,
  type PostCaller,
} from './caller-binding.js';
import { LEDGER_DOOR_CALLERS, type LedgerDoor } from './door-callers.js';
import { RECIPE_REQUIRED_CODE, assertKnownRecipePost } from './recipe-gate.js';
import { MAKER_REBATE_UNBOUND_CODE, assertMakerRebateBound } from './maker-rebate-binding.js';
import { CAMPAIGN_LOCK_UNBOUND_CODE, assertCampaignLockBound } from './campaign-lock-binding.js';
import { WITHDRAW_RETURN_UNBOUND_CODE, assertWithdrawReturnBound } from './withdraw-return-binding.js';
import type { LedgerService } from './service.js';
import { userCopy } from './user-copy.js';
import { REGISTRY_REFUSALS } from './ledger/supported-assets.js';

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
  // 401: the signature did not prove which service this is (shared secret, or
  // no key). 403: the service is proven and is not allowed to post this body.
  if (err instanceof LedgerError && err.code === CALLER_UNBOUND) {
    return { status: 401, body: { message: err.message, code: err.code } };
  }
  if (err instanceof LedgerError && err.code === CALLER_FORBIDDEN) {
    return { status: 403, body: { message: err.message, code: err.code } };
  }
  // 409: the key is taken by a different movement. Retrying unchanged is guaranteed
  // useless and the caller must NOT record success; a new key is a new movement.
  if (err instanceof LedgerError && err.code === 'ledger.idempotency_conflict') {
    return { status: 409, body: { message: err.message, code: err.code } };
  }
  // 503: the store cannot take a write right now. Nothing was booked; retry with the SAME key.
  if (err instanceof LedgerError && isWriteBlockCode(err.code)) {
    return { status: 503, body: { message: err.code, code: err.code } };
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
      err.code === LEDGER_FEE_REVENUE_WINDOW_INVALID ||
      err.code === LEDGER_HOLDINGS_HISTORY_WINDOW_INVALID ||
      err.code === LEDGER_HOLDINGS_HISTORY_TOO_LARGE ||
      err.code === 'ledger.history_cursor_invalid' ||
      err.code === RECIPE_REQUIRED_CODE ||
      err.code === MAKER_REBATE_UNBOUND_CODE ||
      err.code === CAMPAIGN_LOCK_UNBOUND_CODE ||
      err.code === WITHDRAW_RETURN_UNBOUND_CODE)
  ) {
    return { status: 400, body: { message: err.message, code: err.code } };
  }
  // The registry's refusals (W-balances-05): the asset as asked is unknown, unpublished or the request malformed.
  // The caller's to fix or to show; never a fault in this service.
  if (err instanceof LedgerError && REGISTRY_REFUSALS.has(err.code)) {
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

export async function handleS2sPost(ledger: LedgerService, body: unknown, caller?: PostCaller, binding?: CallerBindingOptions) {
  const input = postRequestSchema.parse(body);
  // Direct unit calls omit the caller and stay on the recipe gate. Both doors
  // that accept a network post pass the verified caller in.
  if (caller) applyCallerBinding(caller, input, binding);
  assertKnownRecipePost(input);
  await assertMakerRebateBound(ledger, input);
  await assertCampaignLockBound(ledger, input);
  await assertWithdrawReturnBound(ledger, input);
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
  return postAcknowledgement(tx);
}

/**
 * What a post returns: the transaction identity AND the entries the ledger actually booked, so a caller's receipt check
 * compares real accounts and amounts instead of an empty list. Amounts are decimal strings.
 */
export function postAcknowledgement(tx: LedgerTx) {
  return {
    txId: tx.id,
    hash: tx.hash,
    postedAt: tx.postedAt.toISOString(),
    entries: (tx.entries ?? []).map((e) => ({
      id: e.id,
      txId: e.txId,
      accountId: e.accountId,
      assetId: e.assetId,
      direction: e.direction,
      amount: formatAmount(e.amount),
      balanceAfter: formatAmount(e.balanceAfter),
    })),
  };
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

/**
 * What one customer or Space holds now and how it moved since `from`, per asset, reason and bucket (J-portfolio-05).
 * A read for svc-bank's value-over-time and change-in-value views. The owner comes from the body, which only an
 * authenticated service can send.
 */
export async function handleS2sHoldingsHistory(ledger: LedgerService, body: unknown) {
  const input = parseHoldingsHistoryInput(body);
  return serializeHoldingsHistory(input, await ledger.holdingsHistory(input));
}

/**
 * Fee revenue per asset over one window, for svc-ops' venue report. A read: the
 * answer is sums over the `fees:*` house accounts and nothing else. Its only
 * caller is svc-ops (`door-callers.ts`), which gets no other door through this one.
 */
export async function handleS2sFeeRevenue(ledger: LedgerService, body: unknown) {
  const range = parseFeeRevenueInput(body);
  return serializeFeeRevenue(range, await ledger.feeRevenue(range));
}

/** The ledger's `restore.watermark.read`: chain tip position and hash, for svc-ops alone. A read. */
export async function handleS2sRestoreWatermark(ledger: LedgerService) {
  return ledger.restoreWatermark();
}

const txByKeyInput = z.object({ idempotencyKey: z.string().min(1).max(512) });

/**
 * Was this idempotency key already booked? A read, never a post.
 *
 * svc-trade's Convert settle asks this before each step (is the customer hold
 * already released? is the fill already booked?), and its HTTP client had no
 * door to ask, so every `convert.accept` came back as a 500. Answers the
 * identifying fields only: the entries (who moved what) stay in the ledger.
 */
export async function handleS2sTxByKey(ledger: LedgerService, body: unknown) {
  const input = txByKeyInput.parse(body);
  const tx = await ledger.getTxByKey(input.idempotencyKey);
  if (!tx) return { found: false as const };
  return {
    found: true as const,
    txId: tx.id,
    hash: tx.hash,
    postedAt: tx.postedAt.toISOString(),
    module: tx.module,
    reason: tx.reason,
  };
}

const txByIdInput = z.object({ txId: z.string().guid() });

/**
 * Fetch one booked transaction by its id. A read, never a post. The twin of
 * `txByKey`, for the callers that hold a ledger tx id (a payout receipt, a
 * business transfer) and need to check what it booked.
 *
 * Returns no more than the in-process `getTx`: the identifying fields plus the
 * entries (a caller verifying a receipt must see who was debited and credited,
 * which `txByKey` deliberately does not give). Free-form `meta` and the
 * sharding hashes stay in the ledger. The id must be a UUID, which is what
 * every ledger tx id is; anything else is refused up front rather than reaching
 * the database as a malformed-uuid error.
 */
export async function handleS2sTxById(ledger: LedgerService, body: unknown) {
  const input = txByIdInput.parse(body);
  const tx = await ledger.getTx(input.txId);
  if (!tx) return { found: false as const };
  return {
    found: true as const,
    txId: tx.id,
    idempotencyKey: tx.idempotencyKey,
    hash: tx.hash,
    postedAt: tx.postedAt.toISOString(),
    module: tx.module,
    reason: tx.reason,
    entries: tx.entries.map((e) => ({
      accountId: e.accountId,
      assetId: e.assetId,
      direction: e.direction,
      // Decimal string on the wire, always (see `handleS2sHistory`).
      amount: formatAmount(e.amount),
    })),
  };
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
  /**
   * Per-service keys (S2S v3). Unset leaves every door on the shared secret
   * alone. `dual` accepts a key-signed call or the shared secret; `keypair`
   * refuses the shared secret.
   */
  s2s?: { verifier: ServiceVerifier; mode: ServiceAuthMode };
  /** Test seam: replaces the caller list of the named doors. Production passes nothing. */
  doorCallers?: Partial<Record<LedgerDoor, readonly string[]>>;
  onCallerViolation?: CallerBindingOptions['onViolation'];
}

export function registerS2sHttp(app: FastifyInstance, ledger: LedgerService, internalSecret: string, options: S2sHttpOptions = {}): void {
  const mode = options.bodyBind ?? DEFAULT_SERVICE_BODY_BIND_MODE;
  const bindingOptions: CallerBindingOptions = {
    onViolation: (violation) => {
      options.onCallerViolation?.(violation);
      if (violation.reason === 'unbound' && !callerBindingWarnAllowed(violation.service)) return;
      const count = callerBindingCount(violation.reason, violation.service);
      app.log.warn(
        {
          event: 'ledger.caller_binding',
          code: violation.code,
          reason: violation.reason,
          service: violation.service,
          module: violation.module,
          recipe: violation.recipe,
          mode: options.s2s?.mode ?? 'dual',
          count,
        },
        `ledger caller binding violation count=${count}`,
      );
    },
  };

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
   *
   * The caller is the owner of the key that verified, or, while the service is
   * not in `keypair` mode, the name claimed under the shared secret. The door's
   * caller list is enforced on a verified key; a door with an empty list
   * refuses every key.
   */
  const authenticate = (req: FastifyRequest, door: LedgerDoor): PostCaller => {
    const { service, rejected, scheme } = verifyServiceRequest(req, {
      verifier: options.s2s?.verifier,
      mode: options.s2s?.mode,
      legacySecret: internalSecret,
      bodyBindMode: mode,
    });

    if (!service) {
      // The reason travels to the caller. None of them disclose secret material,
      // and `body-mismatch` versus `stale` is the difference between diagnosing
      // an incident and guessing at one.
      throw new LedgerError(
        `Service credentials are required on the internal ledger API (§2): ${rejected ?? 'missing'}`,
        'ledger.unauthenticated',
      );
    }
    // A name claimed under the shared secret is not proof, so it cannot be refused
    // on its own say-so: the local test scripts and callers not yet on keys sign
    // that way. `keypair` mode refuses the shared secret outright.
    if (scheme === 'keypair' && !(options.doorCallers?.[door] ?? (LEDGER_DOOR_CALLERS[door] as readonly string[])).includes(service)) {
      throw new LedgerError(`Caller ${service} may not call ${door}.`, CALLER_FORBIDDEN);
    }
    return scheme === 'keypair' ? { kind: 'bound', service } : { kind: 'legacy', claimed: service };
  };

  const guarded =
    <T>(door: LedgerDoor, handle: (ledger: LedgerService, body: unknown) => Promise<T>) =>
    async (req: FastifyRequest, reply: FastifyReply) => {
      try {
        authenticate(req, door);
        return await handle(ledger, req.body);
      } catch (err) {
        const { status, body } = httpError(err);
        return reply.code(status).send(body);
      }
    };

  // Post keeps the proven caller, because the recipe allowlist judges it.
  app.post('/trpc/post', async (req, reply) => {
    try {
      const caller = authenticate(req, 'post');
      return await handleS2sPost(ledger, req.body, caller, bindingOptions);
    } catch (err) {
      const { status, body } = httpError(err);
      return reply.code(status).send(body);
    }
  });
  app.post('/trpc/balance', guarded('balance', handleS2sBalance));
  app.post('/trpc/balances', guarded('balances', handleS2sBalances));
  // Read-only existence check by idempotency key; same `guarded` door.
  app.post('/trpc/txByKey', guarded('txByKey', handleS2sTxByKey));
  // Read-only fetch by tx id; same `guarded` door.
  app.post('/trpc/txById', guarded('txById', handleS2sTxById));
  // Guarded by the same `authenticate` as the other three, and that is the point
  // of registering it here rather than anywhere else: an entry history is a
  // record of what a person or the house did with their money, at least as
  // sensitive as the balance it sums to. A read route mounted outside `guarded`
  // would have been unauthenticated exactly as the money plane once was. There
  // is one door, and every route goes through it.
  app.post('/trpc/history', guarded('history', handleS2sHistory));
  // Paged sibling, same `guarded` door (U5a).
  app.post('/trpc/historyPage', guarded('historyPage', handleS2sHistoryPage));
  // What one owner holds now and how it moved since a point in time (J-portfolio-05). Same `guarded` door.
  app.post('/trpc/holdingsHistory', guarded('holdingsHistory', handleS2sHoldingsHistory));
  // The asset and network registry (W-balances-05). Reads, same `guarded` door.
  app.post(
    '/trpc/assetsList',
    guarded('assetsList', (svc, body) => svc.listAssets(body ?? {}).then((assets) => ({ assets }))),
  );
  app.post(
    '/trpc/assetsGet',
    guarded('assetsGet', (svc, body) => svc.getAsset(body)),
  );
  // Fee revenue per asset. Same `guarded` door; the caller list names svc-ops alone.
  app.post('/trpc/feeRevenue', guarded('feeRevenue', handleS2sFeeRevenue));
  app.post(
    '/trpc/restoreWatermark',
    guarded('restoreWatermark', (_svc, _body) => handleS2sRestoreWatermark(ledger)),
  );
  app.post(
    '/trpc/portfolio',
    guarded('portfolio', (svc, body) => handleS2sPortfolio(svc, body, { url: options.indexerUrl, fetch: options.indexerFetch })),
  );
  app.post('/trpc/statementPnl', guarded('statementPnl', handleS2sStatementPnl));
  app.post('/trpc/reportExport', guarded('reportExport', handleS2sReportExport));
  app.post('/trpc/custody', guarded('custody', handleS2sCustody));
  app.post('/trpc/financeClose', guarded('financeClose', handleS2sFinanceClose));
  app.post('/trpc/resilience', guarded('resilience', handleS2sResilience));
}
