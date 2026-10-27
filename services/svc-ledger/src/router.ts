import { z } from 'zod';
import { AuthError, type Principal } from '@intafaced/auth';
import {
  anyScopeProcedure,
  router,
  protectedProcedure,
  publicProcedure,
  scopedProcedure,
  serviceProcedureFor,
  TRPCError,
} from '@intafaced/contracts';
import {
  LEDGER_RECONCILE_ASOF_INVALID,
  LEDGER_RECONCILE_CONTROL_NOT_FOUND,
  OPS_CONTROL_ACTOR_UNSET,
  OPS_CONTROL_REASON_REQUIRED,
  defineReconciliationControlInputSchema,
  reconciliationControlListSchema,
  reconciliationControlRunSchema,
  reconciliationControlViewSchema,
  runReconciliationControlInputSchema,
  updateReconciliationControlInputSchema,
} from '@intafaced/contracts/ledger-reconciliation';
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
  type OwnerType,
} from '@intafaced/ledger-client';
import { postAcknowledgement } from './s2s-http.js';
import { composePortfolioView, portfolioViewSchema } from '@intafaced/portfolio-view';
import { DualControlError } from './ledger/dual-control.js';
import {
  ActionApprovalConsumeError,
  consumeLedgerApproval,
  unwiredApprovalConsumer,
  type ActionApprovalConsumer,
} from './ledger/action-approval-consume.js';
import { HISTORY_RAILS, parseHistoryDoorInput, parseHistoryPageInput, parseHistoryRange, serializeHistoryPage } from './ledger/history.js';
import { LEDGER_DOOR_CALLERS } from './door-callers.js';
import { applyCallerBinding, type CallerBindingOptions, type PostCaller } from './caller-binding.js';
import { RECIPE_REQUIRED_CODE, assertKnownRecipePost } from './recipe-gate.js';
import { MAKER_REBATE_UNBOUND_CODE, assertMakerRebateBound } from './maker-rebate-binding.js';
import { CAMPAIGN_LOCK_UNBOUND_CODE, assertCampaignLockBound } from './campaign-lock-binding.js';
import { WITHDRAW_RETURN_UNBOUND_CODE, assertWithdrawReturnBound } from './withdraw-return-binding.js';
import { statementPnlFromThisBook, statementPnlInputSchema, statementPnlResultSchema } from './ledger/statement-pnl.js';
import {
  operatorOwnerBalances,
  operatorOwnerBalancesInputSchema,
  operatorOwnerBalancesOutputSchema,
} from './ledger/operator-owner-balances.js';
import { isWriteBlockCode } from './ledger/write-block.js';
import { operatorTraceInputSchema, operatorTraceOutputSchema, traceBusinessKey, TraceInconsistentError } from './ledger/operator-trace.js';
import { LookupUnrecordedError, requireLookupAuthority } from './ledger/operator-lookup.js';
import {
  BookingRecordMissingError,
  LEDGER_TX_NOT_FOUND,
  operatorTxGet,
  operatorTxGetInputSchema,
  operatorTxGetOutputSchema,
} from './ledger/operator-tx-get.js';
import { ReconciliationControlError } from './ledger/reconciliation-control-error.js';
import {
  defineReconciliationControl,
  listReconciliationControls,
  runReconciliationControl,
  updateReconciliationControl,
} from './ledger/reconciliation-controls.js';
import type { LedgerService } from './service.js';
import type { Sql } from 'postgres';
import { userCopy } from './user-copy.js';

/**
 * svc-ledger's internal API.
 *
 * Note what is NOT here: there is no user-facing write. `post` is called by
 * other SERVICES with service credentials, never by a user token — which is why
 * `packages/auth` has no `ledger:write` scope at all. A user moves value by
 * asking a module to do something (place an order, release an escrow); the
 * module decides whether that is legal and posts the recipe.
 */

function toTrpcError(err: unknown): TRPCError {
  if (err instanceof InsufficientFundsError) {
    return new TRPCError({ code: 'BAD_REQUEST', message: userCopy(err.code), cause: err });
  }
  if (err instanceof UnbalancedTransactionError || err instanceof InvalidEntryError) {
    // A malformed transaction is a bug in the calling service, not user error.
    return new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: userCopy(err.code), cause: err });
  }
  if (err instanceof LedgerError && err.code === 'ledger.idempotency_conflict') {
    return new TRPCError({ code: 'CONFLICT', message: err.message, cause: err });
  }
  if (err instanceof LedgerError && isWriteBlockCode(err.code)) {
    return new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: err.code, cause: err });
  }
  if (err instanceof LedgerError && err.code === 'ledger.frozen') {
    return new TRPCError({ code: 'PRECONDITION_FAILED', message: userCopy(err.code), cause: err });
  }
  // Already frozen under another actor/reason — conflict, not internal error.
  // Mirrors operator HTTP 409 so both doors name the same refusal.
  if (err instanceof DualControlError || err instanceof ActionApprovalConsumeError) {
    return new TRPCError({ code: 'PRECONDITION_FAILED', message: err.message, cause: err });
  }
  if (err instanceof LedgerError && err.code === 'ledger.freeze_attributed') {
    return new TRPCError({ code: 'CONFLICT', message: userCopy(err.code), cause: err });
  }
  // Operator reconcile: another run holds the single-flight lock, or the proof could not
  // finish. Operator-only procedure, so the message is the operator's to read as written.
  if (err instanceof LedgerError && err.code === 'ledger.reconcile_in_progress') {
    return new TRPCError({ code: 'CONFLICT', message: err.message, cause: err });
  }
  if (err instanceof LedgerError && err.code === 'ledger.reconcile_incomplete') {
    return new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: err.message, cause: err });
  }
  if (err instanceof ReconciliationControlError) {
    if (err.code === 'ledger.idempotency_conflict') {
      return new TRPCError({ code: 'CONFLICT', message: err.code, cause: err });
    }
    if (err.code === LEDGER_RECONCILE_CONTROL_NOT_FOUND) {
      return new TRPCError({ code: 'NOT_FOUND', message: err.code, cause: err });
    }
    if (err.code === LEDGER_RECONCILE_ASOF_INVALID || err.code === OPS_CONTROL_ACTOR_UNSET || err.code === OPS_CONTROL_REASON_REQUIRED) {
      return new TRPCError({ code: 'BAD_REQUEST', message: err.code, cause: err });
    }
    return new TRPCError({ code: 'PRECONDITION_FAILED', message: err.code, cause: err });
  }
  // Caller-actionable, and retrying the same body never will succeed. Same
  // status as `s2s-http.httpError`: a history window that cannot be answered,
  // and an assembled body that is not a recipe. Copy stays on the error.
  if (err instanceof LedgerError && err.code === 'ledger.caller_unbound') {
    return new TRPCError({ code: 'UNAUTHORIZED', message: err.message, cause: err });
  }
  if (err instanceof LedgerError && err.code === 'ledger.caller_forbidden') {
    return new TRPCError({ code: 'FORBIDDEN', message: err.message, cause: err });
  }
  if (
    err instanceof LedgerError &&
    (err.code === 'ledger.history_range_invalid' ||
      err.code === 'ledger.history_range_too_large' ||
      err.code === 'ledger.history_page_socket' ||
      err.code === 'ledger.history_cursor_invalid' ||
      err.code === RECIPE_REQUIRED_CODE ||
      err.code === MAKER_REBATE_UNBOUND_CODE ||
      err.code === CAMPAIGN_LOCK_UNBOUND_CODE ||
      err.code === WITHDRAW_RETURN_UNBOUND_CODE)
  ) {
    return new TRPCError({ code: 'BAD_REQUEST', message: err.message, cause: err });
  }
  if (err instanceof LedgerError) {
    return new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: userCopy(err.code), cause: err });
  }
  return new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: userCopy('error.generic'), cause: err });
}

/**
 * A ledger:read principal reads an owner it holds: its user id, or the
 * sub-account id when the token carries that sub-account. Module, house, and
 * treasury owners are platform pots and stay on the service door.
 */
function assertPrincipalHoldsOwner(principal: Principal, ownerType: OwnerType, ownerId: string): void {
  const held = (ownerType === 'user' && principal.userId === ownerId) || (ownerType === 'subaccount' && principal.sub_account === ownerId);
  if (held) return;
  throw new TRPCError({ code: 'FORBIDDEN', message: userCopy('error.forbidden') });
}

const balanceOutput = z.object({
  accountId: z.string(),
  assetId: z.string(),
  kind: z.string(),
  // Purpose is account IDENTITY (P0-3), not optional decoration. Two holds with
  // different claims must not collapse to the same (assetId, kind) on the wire —
  // callers that key by those alone would re-commingle what the book keeps apart.
  purpose: z.string(),
  amount: z.string(),
});

export interface LedgerIndexerCompose {
  readonly url?: string;
  readonly fetch?: typeof globalThis.fetch;
}

/**
 * The object lookups' door, the same rule as the operator port's (`requireLookupAuthority`): a founder's `admin:read`
 * with a second factor, or `admin:treasury`. A missing second factor is UNAUTHORIZED, anything else FORBIDDEN, as
 * `scopedProcedure` reports them.
 */
const lookupProcedure = protectedProcedure.use(async ({ ctx, next }) => {
  try {
    requireLookupAuthority(ctx.principal);
  } catch (err) {
    if (err instanceof AuthError && err.code === 'mfa.required') {
      throw new TRPCError({ code: 'UNAUTHORIZED', message: err.message, cause: err });
    }
    throw new TRPCError({ code: 'FORBIDDEN', message: (err as Error).message, cause: err });
  }
  return next({ ctx });
});

export function createLedgerRouter(
  ledger: LedgerService,
  indexer?: LedgerIndexerCompose,
  approvals: ActionApprovalConsumer = unwiredApprovalConsumer(),
  binding?: CallerBindingOptions,
) {
  return router({
    // Reads the freeze row rather than a cached field: a replica that reports
    // itself healthy while the shared book is frozen is worse than no health
    // check at all.
    health: publicProcedure
      .output(z.object({ ok: z.boolean(), service: z.literal('svc-ledger'), postingEnabled: z.boolean() }))
      .query(async () => ({ ok: true, service: 'svc-ledger' as const, postingEnabled: (await ledger.status()).postingEnabled })),

    /**
     * Service-to-service only — and now enforced, not merely documented.
     *
     * This was `publicProcedure`, justified by the note above: there is no
     * `ledger:write` scope, so no user token can post. That reasoning is
     * inverted. `publicProcedure` checks no scope at all, so the absence of
     * `ledger:write` removed the last thing that could have been checked.
     *
     * Mounted, that meant anyone reaching the port could post a balanced
     * transaction crediting `railBoundary` — a `treasury` account, the one
     * owner type allowed to run negative — and debiting their own `available`.
     * That is the `deposit` recipe. Sum-to-zero passes, non-negative passes,
     * paired locks pass: the transaction is well-formed, just unauthorised.
     *
     * `serviceProcedure` requires the caller to prove it is a service holding
     * the internal secret (§2).
     */
    post: serviceProcedureFor(LEDGER_DOOR_CALLERS.post)
      .input(postRequestSchema)
      .output(
        z.object({
          txId: z.string(),
          hash: z.string(),
          postedAt: z.string(),
          entries: z.array(
            z.object({
              id: z.string(),
              txId: z.string(),
              accountId: z.string(),
              assetId: z.string(),
              direction: z.enum(['debit', 'credit']),
              amount: z.string(),
              balanceAfter: z.string(),
            }),
          ),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        try {
          // Same allowlist as the mounted HTTP door. That door is what proves
          // the key. Here the name is verified only when the context says a
          // service key matched. A name from the shared secret, or a name with
          // no proof, is a claim and is only counted.
          const caller: PostCaller =
            ctx.service && ctx.serviceAuth === 'keypair'
              ? { kind: 'bound', service: ctx.service }
              : { kind: 'legacy', claimed: ctx.service };
          applyCallerBinding(caller, input, binding);
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
        } catch (err) {
          throw toTrpcError(err);
        }
      }),

    balance: scopedProcedure('ledger:read')
      .input(accountRefSchema)
      .output(balanceOutput)
      .query(async ({ ctx, input }) => {
        assertPrincipalHoldsOwner(ctx.principal, input.ownerType, input.ownerId);
        const balance = await ledger.balance(input);
        return {
          accountId: balance.accountId,
          assetId: input.assetId,
          kind: input.kind,
          purpose: accountPurpose(input),
          amount: formatAmount(balance.amount),
        };
      }),

    balances: scopedProcedure('ledger:read')
      .input(z.object({ ownerType: z.enum(['user', 'subaccount', 'module', 'house', 'treasury']), ownerId: z.string() }))
      .output(z.array(balanceOutput))
      .query(async ({ ctx, input }) => {
        assertPrincipalHoldsOwner(ctx.principal, input.ownerType, input.ownerId);

        const balances = await ledger.balances(input.ownerType, input.ownerId);
        return balances.map((b) => ({
          accountId: b.accountId,
          assetId: b.account.assetId,
          kind: b.account.kind,
          purpose: b.account.purpose ?? '',
          amount: formatAmount(b.amount),
        }));
      }),

    /**
     * Portfolio VIEW (§25:723). Reads `ledger.balances`. Does not post.
     * Chain half is HTTP/tRPC to svc-indexer `positions` when INDEXER_URL and a
     * 0x `chainAccount` are both usable. Otherwise named
     * `indexer.portfolio_positions_unwired` — never a zero chain balance.
     * Owner UUID is not an EVM address; this door does not invent one.
     */
    portfolio: scopedProcedure('ledger:read')
      .input(
        z.object({
          ownerType: z.enum(['user', 'subaccount', 'module', 'house', 'treasury']),
          ownerId: z.string(),
          chainAccount: z
            .string()
            .regex(/^0x[0-9a-fA-F]{40}$/)
            .optional(),
        }),
      )
      .output(portfolioViewSchema)
      .query(async ({ ctx, input }) => {
        assertPrincipalHoldsOwner(ctx.principal, input.ownerType, input.ownerId);

        const balances = await ledger.balances(input.ownerType, input.ownerId);
        return composePortfolioView({
          ownerType: input.ownerType,
          ownerId: input.ownerId,
          balances,
          url: indexer?.url ?? process.env.INDEXER_URL,
          chainAccount: input.chainAccount,
          fetch: indexer?.fetch,
        });
      }),

    /**
     * Customer statement PnL/NAV (PTX-M14-R01/R02).
     *
     * Realized/unrealized/NAV come only from lot basis, marks, and NAV inputs.
     * This book does not store those — missing is a typed refuse, never 0 PnL.
     * Does not post. Does not invent FIFO lots from history amounts.
     */
    statementPnl: scopedProcedure('ledger:read')
      .input(statementPnlInputSchema)
      .output(statementPnlResultSchema)
      .query(async ({ ctx, input }) => {
        assertPrincipalHoldsOwner(ctx.principal, input.ownerType, input.ownerId);
        return statementPnlFromThisBook(input);
      }),

    /**
     * Entry history for one account in one window (§8.1 projection source).
     *
     * `serviceProcedure`, not `scopedProcedure('ledger:read')`, and the choice
     * is not a coin flip:
     *
     *   · The caller is a SERVICE. svc-bank folds this into a spend summary
     *     after deciding, with the user's token, which spaces that user may see.
     *     It holds service credentials on this path and forwards no user token,
     *     so a scoped procedure would reject the only caller there is.
     *
     *   · The input is a bare `AccountRef`, which can name `house` and
     *     `treasury` accounts — `rail:*`, `fees:*`, `mint`. `balances` can
     *     restrict a principal to its own rows because its input carries the
     *     owner and `ctx.principal` can be compared against it; here the same
     *     check would have to trust the caller to say who it is asking for.
     *     Under `ledger:read` that turns every holder of a read scope into
     *     someone who can enumerate the platform's own movements, transaction by
     *     transaction. Service credentials are the stronger statement, and the
     *     true one about who calls this.
     *
     *   · AUTHORISATION IS THE MODULE'S JOB (README: this service "does not
     *     decide whether a movement is allowed"). The same split applies to
     *     reads — svc-ledger answers what the book says to a caller that proved
     *     it is one of ours; WHICH HUMAN may see it is svc-bank's question, and
     *     svc-bank already asks it.
     *
     * Served on no port, like every procedure in this file: `index.ts` exports
     * this router for its TYPE and registers no tRPC plugin. The reachable
     * surface is `registerS2sHttp`, where `/trpc/history` is mounted behind the
     * same service-credential guard. This entry exists so the two describe one
     * API — it is not what makes the route safe.
     */
    history: serviceProcedureFor(LEDGER_DOOR_CALLERS.history)
      .input(z.unknown())
      .output(
        z.array(
          z.object({
            txId: z.string(),
            module: z.string(),
            reason: z.string(),
            direction: z.enum(['debit', 'credit']),
            /** Decimal string. Money never crosses as a `number`. */
            amount: z.string(),
            postedAt: z.string(),
          }),
        ),
      )
      .query(async ({ input }) => {
        try {
          const parsed = parseHistoryDoorInput(input);
          const range = parseHistoryRange(parsed.from, parsed.to);
          const entries = await ledger.history(parsed.account, range);
          return entries.map((e) => ({
            txId: e.txId,
            module: e.module,
            reason: e.reason,
            direction: e.direction,
            amount: formatAmount(e.amount),
            postedAt: e.postedAt.toISOString(),
          }));
        } catch (err) {
          throw toTrpcError(err);
        }
      }),

    /**
     * One page of entry history, newest first (U5a). Sibling of `history`, which
     * is unchanged. Same `serviceProcedure` guard and the same reasoning: the
     * account scope comes from this input, which only a service can send, and
     * the cursor is a position inside that scope, never an account. Served,
     * like `history`, through `registerS2sHttp` (`/trpc/historyPage`).
     */
    historyPage: serviceProcedureFor(LEDGER_DOOR_CALLERS.historyPage)
      .input(z.unknown())
      .output(
        z.object({
          entries: z.array(
            z.object({
              txId: z.string(),
              module: z.string(),
              reason: z.string(),
              direction: z.enum(['debit', 'credit']),
              /** Decimal string. Money never crosses as a `number`. */
              amount: z.string(),
              postedAt: z.string(),
              assetId: z.string(),
              /** `ledger_entries.id` (bigserial) as a decimal string. */
              entryId: z.string(),
              /** `meta.rail` when allow-listed (see `HISTORY_RAILS`), else null. */
              rail: z.enum(HISTORY_RAILS).nullable(),
              /** The page owner's own trade order this line belongs to (hold, amend, release, fill), else null. */
              orderId: z.string().min(1).max(128).nullable(),
              /** Decimal string: the fee taken from the owner's receiving line of a fill (`0` when none), else null. */
              fee: z.string().nullable(),
            }),
          ),
          nextCursor: z.string().nullable(),
        }),
      )
      .query(async ({ input }) => {
        try {
          return serializeHistoryPage(await ledger.historyPage(parseHistoryPageInput(input)));
        } catch (err) {
          throw toTrpcError(err);
        }
      }),

    // ── Operator surface (§14 admin controls) ────────────────────────────────

    reconcile: scopedProcedure('admin:treasury')
      .input(
        z.object({
          confirmOperatorId: z.string().max(128).nullish(),
          approvalId: z.string().min(1).max(128),
          operationId: z.string().min(1).max(128),
        }),
      )
      .output(
        z.object({
          ok: z.boolean(),
          accountsChecked: z.number(),
          chainLength: z.number(),
          unbalancedAssets: z.array(z.string()),
          confirmOperatorId: z.string(),
          /** Present only when the hash chain failed — where verification stopped. */
          chainBrokenAt: z.string().optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        try {
          void ctx.principal.userId;
          const prior = await ledger.freezeState();
          const consumed = await consumeLedgerApproval(
            approvals,
            input,
            'ledger.reconcile',
            'posting_reconcile',
            prior.changedAtPrecise,
            {},
          );
          const confirmOperatorId = consumed.approverId ?? consumed.requesterId;
          const report = await ledger.reconcile();
          // chainLength is the number of transactions that verified, even on a
          // break — never collapse a broken chain to 0 (that looks like an empty
          // healthy book). Same shape as POST /operator/reconcile.
          return {
            ok: report.ok,
            accountsChecked: report.balances.accountsChecked,
            chainLength: report.chain.length,
            unbalancedAssets: report.unbalancedAssets,
            confirmOperatorId,
            ...(!report.chain.ok && 'brokenAt' in report.chain ? { chainBrokenAt: report.chain.brokenAt } : {}),
          };
        } catch (err) {
          throw toTrpcError(err);
        }
      }),

    /**
     * Operator account browser (OPS-ledger-desk-01): every balance an owner holds. Writes an access row first and refuses
     * the read if it cannot.
     */
    ownerBalances: scopedProcedure('admin:treasury')
      .input(operatorOwnerBalancesInputSchema)
      .output(operatorOwnerBalancesOutputSchema)
      .query(async ({ ctx, input }) => {
        try {
          return await operatorOwnerBalances(ledger, { actorId: ctx.principal.userId, requestId: ctx.requestId ?? null }, input);
        } catch (err) {
          throw toTrpcError(err);
        }
      }),

    /**
     * Operator trace (OPS-ledger-desk-01): a business key to the transaction it booked, each posting with its balance
     * after, or an honest `found: false`. Recorded in the access log first. A read, never a post; works while the posting
     * freeze is on.
     */
    trace: lookupProcedure
      .input(operatorTraceInputSchema)
      .output(operatorTraceOutputSchema)
      .query(async ({ ctx, input }) => {
        try {
          return await traceBusinessKey(ledger, { actorId: ctx.principal.userId, requestId: ctx.requestId ?? null }, input);
        } catch (err) {
          if (err instanceof TraceInconsistentError || err instanceof BookingRecordMissingError || err instanceof LookupUnrecordedError) {
            throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: err.code, cause: err });
          }
          throw toTrpcError(err);
        }
      }),

    /**
     * Operator transaction detail (OPS-ledger-desk-01): one booked transaction by id with its postings. Recorded in the
     * access log first. A read; works while the posting freeze is on.
     */
    transactionGet: lookupProcedure
      .input(operatorTxGetInputSchema)
      .output(operatorTxGetOutputSchema)
      .query(async ({ ctx, input }) => {
        try {
          return await operatorTxGet(ledger, { actorId: ctx.principal.userId, requestId: ctx.requestId ?? null }, input);
        } catch (err) {
          if (err instanceof LedgerError && err.code === LEDGER_TX_NOT_FOUND) {
            throw new TRPCError({ code: 'NOT_FOUND', message: err.code, cause: err });
          }
          if (err instanceof LookupUnrecordedError || err instanceof BookingRecordMissingError) {
            throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: err.code, cause: err });
          }
          throw toTrpcError(err);
        }
      }),

    /**
     * The freeze is durable, so this returns what the DATABASE now holds rather
     * than the constant it used to. `frozenBy` is echoed back because the
     * operator halting the platform should see their own name land on the
     * record — and because on a book already frozen by reconciliation, the
     * reply naming a different actor is the fastest way to find that out.
     */
    freeze: scopedProcedure('admin:treasury')
      // Same floor as POST /operator/freeze: a twelve-character minimum forces a
      // sentence the next operator can act on. `min(1)` accepted "x" and left
      // the durable row unactionable — the database only refuses empty reason,
      // not a useless one. Cap matches the HTTP schema (500).
      .input(
        z.object({
          // Same floor as POST /operator/freeze — trim so spaces cannot pad min(12).
          reason: z
            .string()
            .transform((s) => s.trim())
            .pipe(z.string().min(12).max(500)),
          confirmOperatorId: z.string().max(128).nullish(),
          approvalId: z.string().min(1).max(128),
          operationId: z.string().min(1).max(128),
        }),
      )
      .output(
        z.object({
          postingEnabled: z.boolean(),
          frozenReason: z.string().nullable(),
          frozenBy: z.string().nullable(),
          confirmOperatorId: z.string(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        try {
          const prior = await ledger.freezeState();
          const consumed = await consumeLedgerApproval(approvals, input, 'ledger.freeze', 'posting_freeze', prior.changedAtPrecise, {
            reason: input.reason,
          });
          const confirmOperatorId = consumed.approverId ?? consumed.requesterId;
          const state = await ledger.freeze(input.reason, ctx.principal.userId);
          return { postingEnabled: !state.frozen, frozenReason: state.reason, frozenBy: state.actor, confirmOperatorId };
        } catch (err) {
          throw toTrpcError(err);
        }
      }),

    unfreeze: scopedProcedure('admin:treasury')
      .input(
        z.object({
          confirmOperatorId: z.string().max(128).nullish(),
          approvalId: z.string().min(1).max(128),
          operationId: z.string().min(1).max(128),
        }),
      )
      .output(
        z.object({
          postingEnabled: z.boolean(),
          frozenReason: z.string().nullable(),
          frozenBy: z.string().nullable(),
          confirmOperatorId: z.string(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        try {
          const prior = await ledger.freezeState();
          const consumed = await consumeLedgerApproval(approvals, input, 'ledger.unfreeze', 'posting_unfreeze', prior.changedAtPrecise, {});
          const confirmOperatorId = consumed.approverId ?? consumed.requesterId;
          const state = await ledger.unfreeze(ctx.principal.userId, confirmOperatorId);
          return { postingEnabled: !state.frozen, frozenReason: state.reason, frozenBy: state.actor, confirmOperatorId };
        } catch (err) {
          throw toTrpcError(err);
        }
      }),

    /**
     * Operator reconciliation controls (OPS-reconciliation-01). Read-only: a run
     * does not post and does not freeze. `admin:compliance` may list; treasury defines and runs.
     */
    reconciliation: router({
      controls: router({
        list: anyScopeProcedure(['admin:treasury', 'admin:compliance'])
          .output(reconciliationControlListSchema)
          .query(async () => {
            try {
              return { controls: await listReconciliationControls(ledgerSql(ledger)) };
            } catch (err) {
              throw toTrpcError(err);
            }
          }),
        define: scopedProcedure('admin:treasury')
          .input(defineReconciliationControlInputSchema)
          .output(reconciliationControlViewSchema)
          .mutation(async ({ ctx, input }) => {
            try {
              return await defineReconciliationControl(
                ledgerSql(ledger),
                { actorId: ctx.principal.userId, requestId: ctx.requestId ?? null },
                input,
              );
            } catch (err) {
              throw toTrpcError(err);
            }
          }),
        update: scopedProcedure('admin:treasury')
          .input(updateReconciliationControlInputSchema)
          .output(reconciliationControlViewSchema)
          .mutation(async ({ ctx, input }) => {
            try {
              return await updateReconciliationControl(
                ledgerSql(ledger),
                { actorId: ctx.principal.userId, requestId: ctx.requestId ?? null },
                input,
              );
            } catch (err) {
              throw toTrpcError(err);
            }
          }),
        run: scopedProcedure('admin:treasury')
          .input(runReconciliationControlInputSchema)
          .output(reconciliationControlRunSchema)
          .mutation(async ({ ctx, input }) => {
            try {
              return await runReconciliationControl(
                ledgerSql(ledger),
                approvals,
                { actorId: ctx.principal.userId, requestId: ctx.requestId ?? null },
                input,
              );
            } catch (err) {
              throw toTrpcError(err);
            }
          }),
      }),
    }),
  });
}

/** The service's postgres handle. `sql` stays private because another branch owns `service.ts`'s shape; the field is stable. */
function ledgerSql(ledger: LedgerService): Sql {
  const sql = (ledger as unknown as { sql?: Sql }).sql;
  if (!sql) {
    throw new ReconciliationControlError('ledger.reconcile_source_unavailable');
  }
  return sql;
}

export type LedgerRouter = ReturnType<typeof createLedgerRouter>;
