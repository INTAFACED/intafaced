import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { router, publicProcedure, scopedProcedure, TRPCError } from '@intafaced/contracts';
import { InsufficientFundsError, LedgerError, formatAmount, parseAmount } from '@intafaced/ledger-client';
import { BankError } from './errors.js';
import { accountForSpace, type SpaceRecord } from './spaces/space-service.js';
import type { BankServices } from './bank-service.js';
import { userFacingBankMessage } from './user-copy.js';

/**
 * svc-bank's API.
 *
 * Two things to notice about what is NOT here.
 *
 * First, there is no procedure that writes a balance, because there is no
 * balance to write. `spaces.list` returns figures it just read from the ledger;
 * they are outputs, never inputs.
 *
 * Second, the two jobs — the standing-order runner and the daily accrual — are
 * NOT user-callable. They are operator surface (`admin:treasury`), because a
 * user able to trigger "run every due transfer" is a user able to choose when
 * other people's money moves.
 */

/** Money crosses the wire as a decimal string. Always. Never a number. */
const amountString = z.string().regex(/^\d+(\.\d{1,18})?$/, 'amount must be an unsigned decimal string (max 18dp)');

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A MESSAGE IS A WIRE FORMAT.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * An error string that interpolates a value crosses a trust boundary the moment
 * a mapper passes it through, so `err.message` reaching a client is a
 * SERIALISATION DECISION rather than a debugging convenience. Every branch of
 * `toTrpcError` below now makes that decision explicitly, and the two rules it
 * makes are:
 *
 *   1. A refusal may only DESCRIBE objects the caller was already entitled to
 *      see. Where it cannot, it says so and names nothing.
 *   2. Nothing is passed through by DEFAULT. The `default:` branch used to
 *      return `err.message` verbatim for every code nobody had thought about,
 *      which is how `Space "Holiday fund" is archived` — a sentence written for
 *      an owner — ended up being delivered to a stranger who guessed a uuid.
 *   3. Ramp / card refusals the user reads are catalog keys via `@intafaced/i18n`.
 *      Missing keys render as the dotted code — never invented English.
 *
 * Rule 2 is why the switch is exhaustive over `BankErrorCode` and the default
 * carries a `never` assignment: adding a code without deciding what a caller
 * may be told now fails the typecheck instead of silently becoming a 400 with
 * the domain sentence attached.
 */

/** The generic answer. Detail lives in the log, joined by this reference. */
function opaqueFailure(err: unknown, context: string): TRPCError {
  const correlationId = randomUUID();
  // stderr in one line of JSON, which is what the platform's log shipper reads.
  // The message the CLIENT never sees is the message an operator most needs, so
  // this is the only copy of it and it must not be dropped on the floor.
  console.error(
    JSON.stringify({
      level: 'error',
      service: 'svc-bank',
      event: 'bank.undisclosed_error',
      correlationId,
      context,
      code: (err as { code?: string }).code ?? null,
      detail: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    }),
  );
  return new TRPCError({
    code: 'INTERNAL_SERVER_ERROR',
    // The reference is the whole point: a user reporting "it said ref 8f3c…"
    // gets an operator to the exact line, without the line being published.
    message: `Bank operation failed (ref ${correlationId})`,
    cause: err,
  });
}

/**
 * HTTP /trpc serialises TRPCError.message, not BankError.cause.
 * Earn/cards invent-refusals (pool_underfunded, mark_missing) are not
 * i18n catalog keys; the stable code must ride in the message so a Fastify
 * client can branch. Owner-facing sentences (archived space, asset mismatch)
 * stay un-suffixed — stuffing every BankError code broke that door.
 */
function publicDoorWireMessage(err: BankError): string {
  const facing = userFacingBankMessage(err.code, err.message);
  if (facing.includes(err.code)) return facing;
  if (err.code === 'bank.pool_underfunded' || err.code === 'bank.mark_missing') {
    return facing + ' (' + err.code + ')';
  }
  return facing;
}

function toTrpcError(err: unknown): TRPCError {
  // An answer that has already been decided. Ownership refusals are thrown as
  // TRPCError from inside `guard`, and without this line every one of them was
  // re-wrapped as INTERNAL_SERVER_ERROR — a 500 that tells the caller to retry
  // something that can never succeed, and hides the refusal from any dashboard
  // grouping on status. That applied to the four `assertSelf` calls that were
  // already here, not only to the two added with this change.
  if (err instanceof TRPCError) return err;
  if (err instanceof InsufficientFundsError) {
    return new TRPCError({ code: 'BAD_REQUEST', message: err.message, cause: err });
  }
  if (err instanceof BankError) {
    const message = publicDoorWireMessage(err);
    switch (err.code) {
      case 'bank.space_not_found':
      case 'bank.schedule_not_found':
      case 'bank.pool_not_found':
      case 'bank.position_not_found':
      case 'bank.loan_not_found':
      case 'bank.loan_product_not_found':
      case 'bank.auto_invest_not_found':
      case 'bank.business_not_found':
      case 'bank.business_approval_not_found':
        return new TRPCError({ code: 'NOT_FOUND', message, cause: err });
      case 'bank.not_owner':
        return new TRPCError({ code: 'FORBIDDEN', message, cause: err });
      case 'bank.pool_underfunded':
        // Not the caller's fault and not something a retry fixes — the pool
        // needs funding before this day can accrue.
        return new TRPCError({ code: 'PRECONDITION_FAILED', message, cause: err });

      // ── Loans: refusals that are NOT the caller's fault ───────────────────
      //
      // Each of these is the platform declining to act, and every one of them
      // would be a lie as a 400. A borrower told "bad request" when the lending
      // reserve is empty, or when the price feed is too stale to seize collateral
      // on, will retry the request forever and learn nothing.
      case 'bank.loan_reserve_underfunded':
      case 'bank.mark_unusable':
      case 'bank.mark_missing':
      case 'bank.mark_invalid':
      case 'bank.no_liquidation_counterparty':
      case 'bank.accrual_backlog':
        return new TRPCError({ code: 'PRECONDITION_FAILED', message, cause: err });

      // The loudest one. Collateral was exhausted and the insurance fund could
      // not make the reserve whole — a platform-side loss, not a client error.
      case 'bank.bad_debt_uncovered':
      case 'bank.policy_incoherent':
        return new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message, cause: err });

      // Ordering refusals. Genuinely the caller's request being wrong for the
      // current state of the loan, so 409 rather than 400: nothing about the
      // input is malformed, and the same request may succeed later.
      case 'bank.loan_not_settled':
      case 'bank.loan_not_drawable':
      case 'bank.loan_liquidating':
      case 'bank.margin_call_required':
      case 'bank.loan_closed':
        return new TRPCError({ code: 'CONFLICT', message, cause: err });

      // ── The codes that used to fall through `default:` ────────────────────
      //
      // Every one of them was already reaching the client as a 400 carrying its
      // domain sentence. Nothing about that is wrong FOR AN OWNER — "Space
      // 'Holiday fund' is locked until …" is the most useful thing this service
      // can say to the person who set the lock, and the ADR is explicit that the
      // failure mode to avoid is a service so cautious the owner cannot act. So
      // the messages are kept and the codes are now DECIDED rather than
      // defaulted; who is allowed to hear them is settled one layer up, at the
      // call site that knows whose row it is.
      //
      // The split follows the loans block above. A state the row is in that a
      // later request could clear is 409; a request that is simply wrong for the
      // rules is 400.
      case 'bank.space_archived':
      case 'bank.space_locked':
      case 'bank.schedule_inactive':
      case 'bank.pool_closed':
      case 'bank.position_closed':
      case 'bank.position_locked':
      case 'bank.position_pending':
      case 'bank.loan_product_closed':
      case 'bank.auto_invest_inactive':
      case 'bank.auto_invest_invalid_threshold':
      case 'bank.auto_invest_roundup_exists':
      case 'bank.auto_invest_run_failed':
      case 'bank.auto_invest_below_threshold':
      case 'bank.business_closed':
      case 'bank.business_not_member':
      case 'bank.business_role_forbidden':
      case 'bank.business_invalid_threshold':
      case 'bank.business_invalid_name':
      case 'bank.business_approval_inactive':
      case 'bank.business_self_approve':
      case 'bank.business_rejected':
      case 'bank.business_cancelled':
      // CONFLICT rather than BAD_REQUEST: the request is well-formed, it just
      // collides with a loan that already exists under that id on other terms.
      case 'bank.loan_principal_mismatch':
      case 'bank.loan_collateral_mismatch':
      // The same class for the borrower half and for earn. All three name only
      // the id the caller already holds — never who the existing record belongs
      // to — so FORBIDDEN would be both wrong and more disclosing.
      case 'bank.loan_borrower_mismatch':
      case 'bank.position_conflict':
        return new TRPCError({ code: 'CONFLICT', message, cause: err });

      case 'bank.same_space':
      case 'bank.asset_mismatch':
      case 'bank.below_minimum':
      case 'bank.native_asset_not_earnable':
      case 'bank.ltv_exceeded':
      /** Borrower short of collateral at open — same class as ltv_exceeded. */
      case 'bank.loan_collateral_short':
      case 'bank.card_not_found':
      case 'bank.card_not_active':
      case 'bank.card_limit_exceeded':
      case 'bank.card_authorization_not_found':
      case 'bank.card_authorization_declined':
      case 'bank.card_authorization_closed':
      case 'bank.card_capture_exceeds_authorization':
      /** Disagrees with a claimed settlement row — same class as ramp_conflict. */
      case 'bank.card_settlement_amount_conflict':
      case 'bank.ramp_invalid_amount':
      case 'bank.ramp_invalid_asset':
      case 'bank.ramp_invalid_destination':
      case 'bank.ramp_conflict':
        return new TRPCError({ code: 'BAD_REQUEST', message, cause: err });

      // Named refusals where the platform, not the caller, is missing something.
      // Same shape and the same reason as `bank.no_liquidation_counterparty`.
      case 'bank.no_card_issuer':
      case 'bank.card_sim_not_live':
      case 'bank.cashback_pot_unfunded':
      case 'bank.no_ramp_rail':
      case 'bank.fiat_ramp_no_pay_adapter':
      case 'bank.no_fiat_rail':
      case 'bank.fiat_ramp_socket':
      case 'bank.withdraw_destination_missing':
      case 'bank.dest_user_missing':
      case 'bank.earn_rate_unset':
      case 'bank.auto_invest_rate_unset':
        return new TRPCError({ code: 'PRECONDITION_FAILED', message, cause: err });

      // Kill switches. Same 503 class as the matching HTTP job endpoints —
      // operator flipped the flag off; tRPC must not be a back door past it.
      case 'bank.transfers_disabled':
      case 'bank.interest_accrual_disabled':
      case 'bank.loan_accrual_disabled':
      case 'bank.loan_risk_sweep_disabled':
      case 'bank.auto_invest_disabled':
      case 'bank.loans_disabled':
      case 'bank.cards_disabled':
        return new TRPCError({ code: 'SERVICE_UNAVAILABLE', message, cause: err });

      default: {
        // EXHAUSTIVENESS. If this line stops compiling, a `BankErrorCode` was
        // added without anyone deciding what a caller may be told about it —
        // which is exactly the omission that made the archived-space oracle.
        // Reachable at RUNTIME only for a code outside the declared union, and
        // an undeclared code is precisely the one whose message nobody vetted.
        const undeclared: never = err.code;
        return opaqueFailure(err, `bank.error:${String(undeclared)}`);
      }
    }
  }
  if (err instanceof LedgerError) {
    // NOT `err.message`. `InsufficientFundsError` is handled above because it
    // describes the CALLER's own funds; every other LedgerError is a platform
    // fault whose message names accounts, owner ids and per-asset deltas —
    // internals of the book that no client asked about and none may read.
    return opaqueFailure(err, 'ledger.error');
  }
  return opaqueFailure(err, 'unknown');
}

async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw toTrpcError(err);
  }
}

/**
 * A principal may only ever act on its own money, whatever its scopes say.
 *
 * WHY FORBIDDEN AND NOT NOT_FOUND. The trade-off is real and goes the other
 * way on the first reading: NOT_FOUND leaks strictly less, because it never
 * confirms that the id exists. We take FORBIDDEN anyway.
 *
 *   · It is the truth. Every id this guards is a v4 uuid the client already
 *     holds, so the overwhelmingly common way to reach this line is a user or
 *     an integration passing the wrong one. Telling them "no such schedule"
 *     sends them hunting for a record that is alive and well, and it is a lie
 *     we would have to keep telling in the logs too.
 *
 *   · The oracle it opens is worth almost nothing here. 122 bits of entropy
 *     means the id space is not enumerable, so FORBIDDEN discloses exactly one
 *     fact: a uuid the caller ALREADY OBTAINED belongs to someone else. An
 *     attacker who has the id has, by construction, already been somewhere they
 *     could see it.
 *
 * svc-agents' `ownedSession` makes the opposite call and returns NOT_FOUND for
 * both cases. That is a defensible reading of the same trade-off. What is not
 * defensible is doing both inside one service, so every ownership refusal in
 * svc-bank goes through this function and every one of them is FORBIDDEN.
 */
function assertSelf(principalUserId: string | undefined, ownerId: string): void {
  if (principalUserId !== ownerId) {
    // Note what this message does NOT contain: no name, no asset, no balance,
    // no id. The refusal-shape ADR's rule — a refusal may only describe objects
    // the caller was already entitled to see — is satisfied by this sentence in
    // either reading of the code above it. What the ADR would additionally
    // prefer is the CODE: `NOT_FOUND` rather than `FORBIDDEN`, so that "not
    // yours" cannot confirm an id. That is a change to who may see what, which
    // the ADR reserves to the owner, and this service argued the opposite case
    // in writing first. It stays FORBIDDEN, uniformly, until the owner moves it.
    throw new TRPCError({ code: 'FORBIDDEN', message: 'This account belongs to another user' });
  }
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE DESTINATION GATE — what a caller may be told about somebody else's space.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `transfers.create` and `transfers.schedule` each name TWO spaces and
 * owner-check ONE (see the written reason at those call sites). That is correct
 * for safety and it is the product. It was not correct for disclosure.
 *
 * `space-service.ts` writes its refusals for the person who owns the space:
 * `Space "Holiday fund" is archived`, `Cannot transfer USDT into a EUR space`.
 * Delivered to the owner those sentences are the most useful thing this service
 * says. Delivered to a stranger who guessed a uuid they are an oracle over
 * another user's accounts — existence, the user's own chosen NAME, and the
 * asset — for the price of a transfer that does not even have to succeed.
 *
 * So the message is not the bug and neither is the missing check. The bug is
 * that nothing between them decided whether THIS caller may hear it. This
 * function is that decision, and it has exactly two outcomes:
 *
 *   · the destination is the caller's       → return, and every refusal below
 *                                             reaches them intact, name and all
 *   · it is not, or there is no such space  → `NOT_FOUND`, naming NOTHING, and
 *                                             BYTE-IDENTICAL between the two
 *
 * The second bullet is the whole rule. "Exists but is not yours" and "does not
 * exist" are one answer here — not a lie, because relative to this caller there
 * is no such space in any sense they are entitled to.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: refuse the transfer. Paying a stranger is
 * the product (`bank-service.test.ts` pins that value moves between two
 * different users' spaces), so a destination that is somebody else's, live, and
 * in the right asset proceeds exactly as before. Only the FAILURES stop
 * describing it.
 *
 * The three conditions checked here are the three `space-service.ts` refuses a
 * credit on, and they are re-checked inside `TransferService` where they are
 * ENFORCED. This is not a second enforcement point; it is a disclosure gate
 * that happens to have to know the same three facts.
 */
const NO_SUCH_DESTINATION = 'No such space';

/** One construction site, so the two paths cannot drift apart by a byte. */
function noSuchDestination(): TRPCError {
  return new TRPCError({ code: 'NOT_FOUND', message: NO_SUCH_DESTINATION });
}

async function gateDestination(
  bank: BankServices,
  callerUserId: string | undefined,
  from: SpaceRecord,
  toSpaceId: string,
): Promise<{ mayDescribe: boolean }> {
  // One SELECT, and the same one, whether the row is there or not — `find`
  // rather than `get` for that reason. A lookup that throws for "absent" makes
  // the absent path do measurably different work from the present one, and the
  // ADR's done bar names timing as well as status.
  const to = await bank.spaces.find(toSpaceId);

  if (to !== null && to.userId === callerUserId) return { mayDescribe: true };

  // From here the caller is entitled to nothing about this space, so every
  // branch produces the same object. Ordering is irrelevant — they are equal.
  if (to === null) throw noSuchDestination();
  if (to.archivedAt) throw noSuchDestination();
  if (to.assetId !== from.assetId) throw noSuchDestination();

  // Otherwise: somebody else's live space in the right asset. Cross-user
  // transfer is the product; it proceeds, and a failure after this point comes
  // from the caller's OWN side — their funds, their lock — and is theirs to
  // read.
  return { mayDescribe: false };
}

/**
 * The backstop, for a refusal the gate above did not anticipate.
 *
 * `TransferService` resolves the destination again and could grow a new
 * destination-side precondition without this file noticing. These two codes can
 * only be about the destination once `from` has been fetched and its asset is
 * known, so they are flattened rather than trusted. `bank.space_archived` is
 * NOT in the list on purpose: the gate already covered the destination case,
 * which leaves the caller's OWN archived space as the remaining source, and
 * that message belongs to them.
 */
function hideDestinationDetail(err: unknown): unknown {
  if (err instanceof BankError && (err.code === 'bank.space_not_found' || err.code === 'bank.asset_mismatch')) {
    return noSuchDestination();
  }
  return err;
}

const spaceOutput = z.object({
  id: z.string(),
  assetId: z.string(),
  kind: z.enum(['primary', 'named']),
  name: z.string(),
  goalTarget: z.string().nullable(),
  lockedUntil: z.string().nullable(),
  /** Read from the ledger at request time. Not stored, not cached. */
  balance: amountString,
  /** The ledger account this space is a view of — so a client can verify us. */
  ledgerAccount: z.object({ ownerType: z.string(), ownerId: z.string(), assetId: z.string(), kind: z.string() }),
});

/**
 * Optional kill switches for operator jobs. Production passes live env values
 * from `index.ts`; tests inject without loading `env` (which needs full service env).
 *
 * Every flag that gates an HTTP `/internal/jobs/*` endpoint MUST also gate the
 * matching `ops.*` mutation. A tRPC-only back door past an emergency stop is
 * the residual #1271 closed for transfers and that this options bag closes for
 * earn accrual, loan accrual, and the risk sweep.
 */
export type BankRouterOptions = {
  /** When false, `ops.runDueTransfers` refuses with `bank.transfers_disabled`. Default true. */
  scheduledTransfersEnabled?: boolean;
  /** When false, `ops.accrueInterest` refuses with `bank.interest_accrual_disabled`. Default true. */
  interestAccrualEnabled?: boolean;
  /** When false, `ops.accrueLoanInterest` refuses with `bank.loan_accrual_disabled`. Default true. */
  loanAccrualEnabled?: boolean;
  /** When false, `ops.runRiskSweep` refuses with `bank.loan_risk_sweep_disabled`. Default true. */
  loanRiskSweepEnabled?: boolean;
  /** When false, `ops.runAutoInvest` refuses with `bank.auto_invest_disabled`. Default true. */
  autoInvestEnabled?: boolean;
};

export function createBankRouter(bank: BankServices, options: BankRouterOptions = {}) {
  const scheduledTransfersEnabled = options.scheduledTransfersEnabled ?? true;
  const interestAccrualEnabled = options.interestAccrualEnabled ?? true;
  const loanAccrualEnabled = options.loanAccrualEnabled ?? true;
  const loanRiskSweepEnabled = options.loanRiskSweepEnabled ?? true;
  const autoInvestEnabled = options.autoInvestEnabled ?? true;

  const spaces = router({
    list: scopedProcedure('bank:read', { module: 'bank' })
      .input(z.object({ assetId: z.string().min(1).max(16).optional() }))
      .output(z.array(spaceOutput))
      .query(async ({ ctx, input }) =>
        guard(async () => {
          const userId = ctx.principal.userId;
          const views = await bank.spaces.overview(userId, input.assetId);
          return views.map((v) => ({
            id: v.id,
            assetId: v.assetId,
            kind: v.kind,
            name: v.name,
            goalTarget: v.goalTarget === null ? null : formatAmount(v.goalTarget),
            lockedUntil: v.lockedUntil?.toISOString() ?? null,
            balance: v.balance,
            ledgerAccount: accountForSpace(v),
          }));
        }),
      ),

    /** Assets the user holds with no space yet — sourced from the ledger, not this table. */
    unnamed: scopedProcedure('bank:read', { module: 'bank' })
      .output(z.array(z.object({ assetId: z.string(), balance: amountString })))
      .query(async ({ ctx }) => guard(async () => bank.spaces.unnamedAssets(ctx.principal.userId))),

    create: scopedProcedure('bank:write', { module: 'bank' })
      .input(
        z.object({
          assetId: z.string().min(1).max(16),
          name: z.string().min(1).max(64),
          goalTarget: amountString.optional(),
          lockedUntil: z.string().datetime({ offset: true }).optional(),
        }),
      )
      .output(z.object({ id: z.string(), name: z.string() }))
      .mutation(async ({ ctx, input }) =>
        guard(async () => {
          // The primary space must exist before a named one is useful — it is
          // where value arrives from every other module.
          await bank.spaces.ensurePrimary(ctx.principal.userId, input.assetId);
          const space = await bank.spaces.create({
            userId: ctx.principal.userId,
            assetId: input.assetId,
            name: input.name,
            goalTarget: input.goalTarget ? parseAmount(input.goalTarget) : null,
            lockedUntil: input.lockedUntil ? new Date(input.lockedUntil) : null,
          });
          return { id: space.id, name: space.name };
        }),
      ),

    archive: scopedProcedure('bank:write', { module: 'bank' })
      .input(z.object({ spaceId: z.string().uuid() }))
      .output(z.object({ archived: z.literal(true) }))
      .mutation(async ({ ctx, input }) =>
        guard(async () => {
          const space = await bank.spaces.get(input.spaceId);
          assertSelf(ctx.principal.userId, space.userId);
          await bank.spaces.archive(input.spaceId);
          return { archived: true as const };
        }),
      ),
  });

  const transfers = router({
    /**
     * `transferId` is supplied by the client so a retried request is the same
     * transfer, not a second one (§5: idempotency keys are business keys).
     */
    create: scopedProcedure('bank:write', { module: 'bank' })
      .input(
        z.object({
          transferId: z.string().min(8).max(64),
          fromSpaceId: z.string().uuid(),
          toSpaceId: z.string().uuid(),
          amount: amountString,
        }),
      )
      .output(z.object({ ledgerTxId: z.string(), amount: amountString }))
      .mutation(async ({ ctx, input }) =>
        guard(async () => {
          const from = await bank.spaces.get(input.fromSpaceId);

          /**
           * ONLY THE `from` SIDE IS OWNER-CHECKED, AND THAT IS DELIBERATE.
           *
           * A transfer takes value out of `from` and puts it into `to`. The
           * side that can lose something is the debit, and it is checked here,
           * so this is not a hole: nobody can move money out of an account that
           * is not theirs.
           *
           * The credit side is NOT checked because paying somebody else is the
           * product. `bank-service.test.ts` pins that a transfer "moves value
           * between two different users spaces", and a check here would delete
           * that feature rather than secure it. An operation naming two objects
           * authorises against both OR carries a written reason for the
           * exemption at the call site; this paragraph is that reason, and it
           * exists so the next reader does not have to work out from an absence
           * whether the omission was a decision or an oversight.
           *
           * What the missing check DID cost was disclosure, not safety — see
           * `gateDestination`, which is the half that was actually missing.
           */
          assertSelf(ctx.principal.userId, from.userId);

          const gate = await gateDestination(bank, ctx.principal.userId, from, input.toSpaceId);

          const result = await bank.transfers
            .transfer({
              transferId: input.transferId,
              fromSpaceId: input.fromSpaceId,
              toSpaceId: input.toSpaceId,
              amount: parseAmount(input.amount),
            })
            .catch((err: unknown) => {
              throw gate.mayDescribe ? err : hideDestinationDetail(err);
            });
          return { ledgerTxId: result.ledgerTxId, amount: result.amount };
        }),
      ),

    toUser: scopedProcedure('bank:write', { module: 'bank' })
      .input(
        z.object({
          transferId: z.string().min(8).max(64),
          fromSpaceId: z.string().uuid(),
          toUserId: z.string().min(1).max(64),
          amount: amountString,
        }),
      )
      .output(z.object({ ledgerTxId: z.string(), amount: amountString }))
      .mutation(async ({ ctx, input }) =>
        guard(async () => {
          const from = await bank.spaces.get(input.fromSpaceId);
          assertSelf(ctx.principal.userId, from.userId);
          const result = await bank.transfers.transferToUser({
            transferId: input.transferId,
            fromSpaceId: input.fromSpaceId,
            toUserId: input.toUserId,
            amount: parseAmount(input.amount),
          });
          return { ledgerTxId: result.ledgerTxId, amount: result.amount };
        }),
      ),

    scheduleToUser: scopedProcedure('bank:write', { module: 'bank' })
      .input(
        z.object({
          fromSpaceId: z.string().uuid(),
          toUserId: z.string().min(1).max(64),
          amount: amountString,
          cadence: z.enum(['daily', 'weekly', 'monthly']),
          startsAt: z.string().datetime({ offset: true }),
          endsAt: z.string().datetime({ offset: true }).optional(),
        }),
      )
      .output(z.object({ id: z.string(), nextRunAt: z.string() }))
      .mutation(async ({ ctx, input }) =>
        guard(async () => {
          const from = await bank.spaces.get(input.fromSpaceId);
          assertSelf(ctx.principal.userId, from.userId);
          const schedule = await bank.transfers.scheduleToUser({
            userId: ctx.principal.userId,
            fromSpaceId: input.fromSpaceId,
            toUserId: input.toUserId,
            amount: parseAmount(input.amount),
            cadence: input.cadence,
            startsAt: new Date(input.startsAt),
            endsAt: input.endsAt ? new Date(input.endsAt) : null,
          });
          return { id: schedule.id, nextRunAt: schedule.nextRunAt.toISOString() };
        }),
      ),

    schedule: scopedProcedure('bank:write', { module: 'bank' })
      .input(
        z.object({
          fromSpaceId: z.string().uuid(),
          toSpaceId: z.string().uuid(),
          amount: amountString,
          cadence: z.enum(['daily', 'weekly', 'monthly']),
          startsAt: z.string().datetime({ offset: true }),
          endsAt: z.string().datetime({ offset: true }).optional(),
        }),
      )
      .output(z.object({ id: z.string(), nextRunAt: z.string() }))
      .mutation(async ({ ctx, input }) =>
        guard(async () => {
          const from = await bank.spaces.get(input.fromSpaceId);
          // Same exemption, same reason as `transfers.create` above: the debit
          // side is the side that can lose value, and a standing order to
          // another user is the same product feature on a timer.
          assertSelf(ctx.principal.userId, from.userId);

          // Same gate too, and it matters MORE here. A one-off transfer asks the
          // question once; a standing order that could be created against a
          // stranger's space and then have its asset mismatch reported back
          // turns the oracle into one a caller can leave running.
          const gate = await gateDestination(bank, ctx.principal.userId, from, input.toSpaceId);

          const schedule = await bank.transfers
            .schedule({
              userId: ctx.principal.userId,
              fromSpaceId: input.fromSpaceId,
              toSpaceId: input.toSpaceId,
              amount: parseAmount(input.amount),
              cadence: input.cadence,
              startsAt: new Date(input.startsAt),
              endsAt: input.endsAt ? new Date(input.endsAt) : null,
            })
            .catch((err: unknown) => {
              throw gate.mayDescribe ? err : hideDestinationDetail(err);
            });
          return { id: schedule.id, nextRunAt: schedule.nextRunAt.toISOString() };
        }),
      ),

    listSchedules: scopedProcedure('bank:read', { module: 'bank' })
      .output(
        z.array(
          z.object({
            id: z.string(),
            assetId: z.string(),
            amount: amountString,
            cadence: z.string(),
            nextRunAt: z.string(),
            status: z.string(),
          }),
        ),
      )
      .query(async ({ ctx }) =>
        guard(async () => {
          const schedules = await bank.transfers.listSchedules(ctx.principal.userId);
          return schedules.map((s) => ({
            id: s.id,
            assetId: s.assetId,
            amount: formatAmount(s.amount),
            cadence: s.cadence,
            nextRunAt: s.nextRunAt.toISOString(),
            status: s.status,
          }));
        }),
      ),

    /** What actually ran, and why anything did not. The user's answer to "where is my rent". */
    executions: scopedProcedure('bank:read', { module: 'bank' })
      .input(z.object({ scheduleId: z.string().uuid() }))
      .output(
        z.array(
          z.object({
            occurrence: z.number().int(),
            amount: amountString,
            status: z.string(),
            ledgerTxId: z.string().nullable(),
            rejectionCode: z.string().nullable(),
          }),
        ),
      )
      .query(async ({ ctx, input }) =>
        guard(async () => {
          // `bank:read` answers "may this principal read bank data". It never
          // answered "whose", and without the next two lines this returned
          // another user's transfer history, amounts and rejection codes
          // included, to anyone holding the scope and a schedule id.
          const schedule = await bank.transfers.getSchedule(input.scheduleId);
          assertSelf(ctx.principal.userId, schedule.userId);
          return bank.transfers.executions(input.scheduleId);
        }),
      ),

    cancel: scopedProcedure('bank:write', { module: 'bank' })
      .input(z.object({ scheduleId: z.string().uuid() }))
      .output(z.object({ cancelled: z.literal(true) }))
      .mutation(async ({ ctx, input }) =>
        guard(async () => {
          // The ownership check runs BEFORE the cancel, not as a filter on its
          // result: `cancelSchedule` is an UPDATE, and a check made afterwards
          // would refuse a caller whose write had already landed.
          const schedule = await bank.transfers.getSchedule(input.scheduleId);
          assertSelf(ctx.principal.userId, schedule.userId);
          await bank.transfers.cancelSchedule(input.scheduleId);
          return { cancelled: true as const };
        }),
      ),

    /**
     * Hold a standing order. The reversible half of `cancel`.
     *
     * Same ownership ordering as `cancel`, for the same reason written there.
     */
    pause: scopedProcedure('bank:write', { module: 'bank' })
      .input(z.object({ scheduleId: z.string().uuid() }))
      .output(z.object({ status: z.string(), nextRunAt: z.string() }))
      .mutation(async ({ ctx, input }) =>
        guard(async () => {
          const schedule = await bank.transfers.getSchedule(input.scheduleId);
          assertSelf(ctx.principal.userId, schedule.userId);
          const paused = await bank.transfers.pauseSchedule(input.scheduleId);
          return { status: paused.status, nextRunAt: paused.nextRunAt.toISOString() };
        }),
      ),

    /**
     * Start a paused standing order again.
     *
     * `skipped` is in the OUTPUT, not just the record, because resuming does not
     * settle up. A client that renders `status: 'active'` and nothing else lets a
     * user believe the missed months are still coming; they are not, and the
     * moment to say so is the moment they ask for it. See `resumeSchedule` for
     * why skipping is the safe direction.
     */
    resume: scopedProcedure('bank:write', { module: 'bank' })
      .input(z.object({ scheduleId: z.string().uuid() }))
      .output(
        z.object({
          status: z.string(),
          nextRunAt: z.string(),
          /** Occurrences that came due while paused and will never fire. */
          skipped: z.array(z.number().int()),
        }),
      )
      .mutation(async ({ ctx, input }) =>
        guard(async () => {
          const schedule = await bank.transfers.getSchedule(input.scheduleId);
          assertSelf(ctx.principal.userId, schedule.userId);
          const report = await bank.transfers.resumeSchedule(input.scheduleId);
          return {
            status: report.schedule.status,
            nextRunAt: report.schedule.nextRunAt.toISOString(),
            skipped: [...report.skipped],
          };
        }),
      ),
  });

  const earn = router({
    pools: scopedProcedure('bank:read', { module: 'bank' })
      .input(z.object({ assetId: z.string().min(1).max(16).optional() }))
      .output(
        z.array(
          z.object({
            id: z.string(),
            assetId: z.string(),
            kind: z.enum(['flexible', 'fixed']),
            name: z.string(),
            aprBps: z.number().int(),
            termDays: z.number().int().nullable(),
            minDeposit: amountString,
          }),
        ),
      )
      .query(async ({ input }) =>
        guard(async () => {
          const pools = await bank.earn.listPools(input.assetId);
          return pools.map((p) => ({
            id: p.id,
            assetId: p.assetId,
            kind: p.kind,
            name: p.name,
            aprBps: p.aprBps,
            termDays: p.termDays,
            minDeposit: formatAmount(p.minDeposit),
          }));
        }),
      ),

    deposit: scopedProcedure('bank:write', { module: 'bank' })
      .input(z.object({ poolId: z.string().uuid(), amount: amountString, positionId: z.string().uuid().optional() }))
      .output(z.object({ positionId: z.string(), maturesAt: z.string().nullable() }))
      .mutation(async ({ ctx, input }) =>
        guard(async () => {
          const position = await bank.earn.deposit({
            poolId: input.poolId,
            userId: ctx.principal.userId,
            amount: parseAmount(input.amount),
            ...(input.positionId ? { positionId: input.positionId } : {}),
          });
          return { positionId: position.id, maturesAt: position.maturesAt?.toISOString() ?? null };
        }),
      ),

    withdraw: scopedProcedure('bank:write', { module: 'bank' })
      .input(z.object({ positionId: z.string().uuid() }))
      .output(z.object({ positionId: z.string(), principal: amountString }))
      .mutation(async ({ ctx, input }) =>
        guard(async () => {
          const existing = await bank.earn.position(input.positionId);
          assertSelf(ctx.principal.userId, existing.userId);
          const closed = await bank.earn.withdraw(input.positionId);
          return { positionId: closed.id, principal: formatAmount(closed.principal) };
        }),
      ),

    positions: scopedProcedure('bank:read', { module: 'bank' })
      .output(
        z.array(
          z.object({
            id: z.string(),
            poolId: z.string(),
            assetId: z.string(),
            principal: amountString,
            maturesAt: z.string().nullable(),
          }),
        ),
      )
      .query(async ({ ctx }) =>
        guard(async () => {
          const positions = await bank.earn.positionsOf(ctx.principal.userId);
          return positions.map((p) => ({
            id: p.id,
            poolId: p.poolId,
            assetId: p.assetId,
            principal: formatAmount(p.principal),
            maturesAt: p.maturesAt?.toISOString() ?? null,
          }));
        }),
      ),
  });

  const analytics = router({
    spend: scopedProcedure('bank:read', { module: 'bank' })
      .input(
        z.object({
          assetId: z.string().min(1).max(16),
          from: z.string().datetime({ offset: true }),
          to: z.string().datetime({ offset: true }),
        }),
      )
      .output(
        z.object({
          assetId: z.string(),
          from: z.string(),
          to: z.string(),
          outflowByCategory: z.record(z.string()),
          totalOutflow: z.string(),
          totalInflow: z.string(),
          net: z.string(),
          movements: z.number().int(),
        }),
      )
      .query(async ({ ctx, input }) =>
        guard(async () => {
          const summary = await bank.analytics.spendSummary({
            userId: ctx.principal.userId,
            assetId: input.assetId,
            range: { from: new Date(input.from), to: new Date(input.to) },
          });
          return {
            assetId: summary.assetId,
            from: summary.from,
            to: summary.to,
            outflowByCategory: summary.outflowByCategory,
            totalOutflow: summary.totalOutflow,
            totalInflow: summary.totalInflow,
            net: summary.net,
            movements: summary.movements,
          };
        }),
      ),
  });

  /**
   * LOANS (§8.1).
   *
   * ── WHAT IS DELIBERATELY NOT HERE ──────────────────────────────────────────
   *
   * There is no user-callable `liquidate`, and no user-callable `mark`. Both are
   * operator surface, in `ops`, for the same reason the standing-order runner and
   * the accrual are: a user who can choose WHEN a mark is taken is a user who can
   * choose the price their own — or somebody else's — collateral is valued at.
   * The whole point of the deviation breaker and the staleness window in
   * `prices.ts` is that the mark is not the caller's to pick.
   *
   * There is also no `releaseCollateral` that takes an amount. Release is
   * all-or-nothing on a settled loan (`close`), because a partial release is
   * indistinguishable in its effect from an unsecured top-up of leverage, and it
   * would need its own LTV check to be safe. `addCollateral` covers the direction
   * a borrower actually needs in a hurry.
   */
  const loans = router({
    products: scopedProcedure('bank:read', { module: 'bank' })
      .input(z.object({ assetId: z.string().min(1).max(16).optional() }))
      .output(
        z.array(
          z.object({
            id: z.string(),
            name: z.string(),
            debtAssetId: z.string(),
            collateralAssetId: z.string(),
            quoteAssetId: z.string(),
            aprBps: z.number().int(),
            maxLtvBps: z.number().int(),
            marginCallLtvBps: z.number().int(),
            liquidationLtvBps: z.number().int(),
            minPrincipal: amountString,
          }),
        ),
      )
      .query(async ({ input }) =>
        guard(async () => {
          const products = await bank.loans.listProducts(input.assetId);
          return products.map((p) => ({
            id: p.id,
            name: p.name,
            debtAssetId: p.debtAssetId,
            collateralAssetId: p.collateralAssetId,
            quoteAssetId: p.quoteAssetId,
            aprBps: p.aprBps,
            maxLtvBps: p.maxLtvBps,
            // The two thresholds a borrower must be able to see BEFORE they
            // borrow. Publishing the liquidation level is not a courtesy: a
            // leveraged product whose liquidation price is discoverable only by
            // being liquidated is not a product anyone can manage.
            marginCallLtvBps: p.policy.marginCallLtvBps,
            liquidationLtvBps: p.policy.liquidationLtvBps,
            minPrincipal: formatAmount(p.minPrincipal),
          }));
        }),
      ),

    /**
     * `loanId` is supplied by the client so a retried request is the same loan,
     * not a second one (§5). A timeout on this call must not leave a borrower with
     * two leveraged positions against collateral they meant to pledge once.
     */
    open: scopedProcedure('bank:write', { module: 'bank' })
      .input(
        z.object({
          loanId: z.string().uuid(),
          productId: z.string().uuid(),
          collateralAmount: amountString,
          principal: amountString,
        }),
      )
      .output(z.object({ loanId: z.string(), status: z.string(), ltvBps: z.number().int(), drawLedgerTxId: z.string() }))
      .mutation(async ({ ctx, input }) =>
        guard(async () => {
          const result = await bank.loans.open({
            loanId: input.loanId,
            productId: input.productId,
            userId: ctx.principal.userId,
            collateralAmount: parseAmount(input.collateralAmount),
            principal: parseAmount(input.principal),
          });
          return {
            loanId: result.loan.id,
            status: result.loan.status,
            ltvBps: result.ltvBps,
            drawLedgerTxId: result.drawLedgerTxId,
          };
        }),
      ),

    list: scopedProcedure('bank:read', { module: 'bank' })
      .output(
        z.array(
          z.object({
            id: z.string(),
            productId: z.string(),
            debtAssetId: z.string(),
            collateralAssetId: z.string(),
            principal: amountString,
            outstandingPrincipal: amountString,
            outstandingInterest: amountString,
            collateral: amountString,
            aprBps: z.number().int(),
            status: z.string(),
            marginCalledAt: z.string().nullable(),
          }),
        ),
      )
      .query(async ({ ctx }) =>
        guard(async () => {
          const rows = await bank.loans.loansOf(ctx.principal.userId);
          return Promise.all(
            rows.map(async (loan) => {
              const debt = await bank.loans.outstanding(loan.id);
              return {
                id: loan.id,
                productId: loan.productId,
                debtAssetId: loan.debtAssetId,
                collateralAssetId: loan.collateralAssetId,
                principal: formatAmount(loan.principal),
                // Derived at read time from write-once rows. There is no
                // `outstanding` column, and the schema comments say why.
                outstandingPrincipal: formatAmount(debt.principal),
                outstandingInterest: formatAmount(debt.interest),
                collateral: formatAmount(await bank.loans.collateralOf(loan)),
                aprBps: loan.aprBps,
                status: loan.status,
                marginCalledAt: loan.marginCalledAt?.toISOString() ?? null,
              };
            }),
          );
        }),
      ),

    /**
     * The borrower's own risk view.
     *
     * Read-only and portfolio-wide, so someone can see a margin call coming
     * rather than learning about it from the liquidation. It marks; it never acts.
     */
    health: scopedProcedure('bank:read', { module: 'bank' })
      .output(
        z.object({
          debtValue: amountString,
          collateralValue: amountString,
          portfolioLtvBps: z.number().int(),
          loans: z.array(
            z.object({
              loanId: z.string(),
              debtValue: amountString,
              collateralValue: amountString,
              ltvBps: z.number().int(),
            }),
          ),
        }),
      )
      .query(async ({ ctx }) =>
        guard(async () => {
          const mark = await bank.loans.markUser(ctx.principal.userId);
          return {
            debtValue: formatAmount(mark.debtValue),
            collateralValue: formatAmount(mark.collateralValue),
            portfolioLtvBps: mark.portfolioLtvBps,
            loans: mark.loans.map((l) => ({
              loanId: l.loanId,
              debtValue: formatAmount(l.debtValue),
              collateralValue: formatAmount(l.collateralValue),
              ltvBps: l.ltvBps,
            })),
          };
        }),
      ),

    /** The cheapest way out of a margin call, and the one everyone wants taken. */
    addCollateral: scopedProcedure('bank:write', { module: 'bank' })
      .input(z.object({ loanId: z.string().uuid(), amount: amountString }))
      .output(z.object({ ledgerTxId: z.string(), sequence: z.number().int() }))
      .mutation(async ({ ctx, input }) =>
        guard(async () => {
          const loan = await bank.loans.loan(input.loanId);
          assertSelf(ctx.principal.userId, loan.userId);
          return bank.loans.addCollateral({ loanId: input.loanId, amount: parseAmount(input.amount) });
        }),
      ),

    repay: scopedProcedure('bank:write', { module: 'bank' })
      .input(z.object({ loanId: z.string().uuid(), amount: amountString }))
      .output(
        z.object({
          ledgerTxId: z.string(),
          interestPaid: amountString,
          principalPaid: amountString,
          remainingPrincipal: amountString,
          remainingInterest: amountString,
          closed: z.boolean(),
        }),
      )
      .mutation(async ({ ctx, input }) =>
        guard(async () => {
          const loan = await bank.loans.loan(input.loanId);
          assertSelf(ctx.principal.userId, loan.userId);
          const result = await bank.loans.repay({ loanId: input.loanId, amount: parseAmount(input.amount) });
          return {
            ledgerTxId: result.ledgerTxId,
            interestPaid: formatAmount(result.interestPaid),
            principalPaid: formatAmount(result.principalPaid),
            remainingPrincipal: formatAmount(result.remaining.principal),
            remainingInterest: formatAmount(result.remaining.interest),
            closed: result.closed,
          };
        }),
      ),

    /** Release collateral on a loan that owes nothing. Refuses otherwise. */
    close: scopedProcedure('bank:write', { module: 'bank' })
      .input(z.object({ loanId: z.string().uuid() }))
      .output(z.object({ released: amountString, ledgerTxId: z.string().nullable() }))
      .mutation(async ({ ctx, input }) =>
        guard(async () => {
          const loan = await bank.loans.loan(input.loanId);
          assertSelf(ctx.principal.userId, loan.userId);
          const result = await bank.loans.releaseSettled(input.loanId);
          return { released: formatAmount(result.released), ledgerTxId: result.ledgerTxId };
        }),
      ),
  });

  /**
   * CARDS (§8.1) — the LEDGER half only.
   *
   * ── WHAT IS DELIBERATELY NOT HERE ──────────────────────────────────────────
   *
   * There is no user-callable `authorize`, `capture` or `reverse`. Those three
   * are the ISSUER speaking, not the user, and they are in `ops` behind
   * `admin:treasury` for the same reason the risk sweep is: a user who can
   * decide their own authorisation is a user who can approve a purchase the
   * ledger would have declined, and a user who can trigger a capture can choose
   * when their own money leaves.
   *
   * On a live rail they do not become user procedures either. They become a
   * signed webhook endpoint owned by the issuer integration — which is
   * `socket.live-issuer`, a card-scheme sponsor and an issuing BIN, and is a
   * contract rather than code.
   *
   * ── EVERY SURFACE SAYS WHAT IT IS ──────────────────────────────────────────
   *
   * `simulated` is on the card output and it is not optional. A screen rendering
   * a card from this router cannot accidentally present it as a real one, and a
   * deployment with no issuer at all cannot get this far: it refuses with
   * `bank.no_card_issuer` before a row is written.
   */
  const cardOutput = z.object({
    id: z.string(),
    /** Which balance the card draws on. Every posting against it is in this asset. */
    assetId: z.string(),
    /**
     * What merchants charge this card in (§18).
     *
     * Equal to `assetId` means no conversion happens and no rate is consulted.
     * Different means every authorisation is quoted at the authorisation moment
     * — and refuses by name where no rate can be got, which on a fiat settlement
     * asset is every time, because this platform has no FX source.
     */
    settlementAssetId: z.string(),
    /** The programme id, which is also the ledger rail label. */
    issuer: z.string(),
    /** TRUE MEANS THERE IS NO CARD. Never omitted, never defaulted. */
    simulated: z.boolean(),
    /** Four digits. Not a card number and not part of one. */
    panTail: z.string(),
    status: z.enum(['active', 'frozen', 'closed']),
    cashbackBps: z.number().int(),
    perAuthorizationLimit: amountString,
  });

  const cards = router({
    /** What this deployment's card programme is — including that it is not one. */
    programme: scopedProcedure('bank:read', { module: 'bank' })
      .output(z.object({ id: z.string(), simulated: z.boolean(), displayName: z.string() }))
      .query(async () => guard(async () => bank.cards.programme())),

    list: scopedProcedure('bank:read', { module: 'bank' })
      .output(z.array(cardOutput))
      .query(async ({ ctx }) =>
        guard(async () => {
          const rows = await bank.cards.cardsOf(ctx.principal.userId);
          return rows.map((c) => ({
            id: c.id,
            assetId: c.assetId,
            settlementAssetId: c.settlementAssetId,
            issuer: c.issuer,
            simulated: c.simulated,
            panTail: c.panTail,
            status: c.status,
            cashbackBps: c.cashbackBps,
            perAuthorizationLimit: formatAmount(c.perAuthorizationLimit),
          }));
        }),
      ),

    /**
     * `cardId` is supplied by the client so a retried request is the same card,
     * not a second one drawing on the same balance (§5).
     */
    issue: scopedProcedure('bank:write', { module: 'bank' })
      .input(
        z.object({
          cardId: z.string().uuid(),
          assetId: z.string().min(1).max(16),
          /**
           * What merchants charge this card in. Omitted means the funding asset,
           * which is no conversion — the shape every card had before §18.
           *
           * A card may be issued with a settlement asset nothing can quote; the
           * refusal belongs on the authorisation, where the rate is needed, not
           * on a path that moves no money and could be refused by one transient
           * feed outage.
           */
          settlementAssetId: z.string().min(1).max(16).optional(),
          cashbackBps: z.number().int().min(0).max(10_000).optional(),
          perAuthorizationLimit: amountString,
        }),
      )
      .output(cardOutput)
      .mutation(async ({ ctx, input }) =>
        guard(async () => {
          const card = await bank.cards.issue({
            cardId: input.cardId,
            userId: ctx.principal.userId,
            assetId: input.assetId,
            ...(input.settlementAssetId === undefined ? {} : { settlementAssetId: input.settlementAssetId }),
            ...(input.cashbackBps === undefined ? {} : { cashbackBps: input.cashbackBps }),
            perAuthorizationLimit: parseAmount(input.perAuthorizationLimit),
          });
          return {
            id: card.id,
            assetId: card.assetId,
            settlementAssetId: card.settlementAssetId,
            issuer: card.issuer,
            simulated: card.simulated,
            panTail: card.panTail,
            status: card.status,
            cashbackBps: card.cashbackBps,
            perAuthorizationLimit: formatAmount(card.perAuthorizationLimit),
          };
        }),
      ),

    /**
     * Freeze, unfreeze or close. The gesture a user reaches for first when
     * something is wrong, so it is user surface and not an operator ticket.
     */
    setStatus: scopedProcedure('bank:write', { module: 'bank' })
      .input(z.object({ cardId: z.string().uuid(), status: z.enum(['active', 'frozen', 'closed']) }))
      .output(z.object({ id: z.string(), status: z.string() }))
      .mutation(async ({ ctx, input }) =>
        guard(async () => {
          const card = await bank.cards.card(input.cardId);
          assertSelf(ctx.principal.userId, card.userId);
          const updated = await bank.cards.setStatus(input.cardId, input.status);
          return { id: updated.id, status: updated.status };
        }),
      ),

    /**
     * Every decision taken on this card, approvals and declines alike.
     *
     * The declines are the point. "Why was I declined at the till" is the
     * question a card generates, and a history that only listed successful
     * purchases could not answer it.
     */
    authorizations: scopedProcedure('bank:read', { module: 'bank' })
      .input(z.object({ cardId: z.string().uuid() }))
      .output(
        z.array(
          z.object({
            id: z.string(),
            authorizationRef: z.string(),
            /** WHAT MOVED, in the card's funding asset. */
            amount: amountString,
            merchantCategory: z.string().nullable(),
            decision: z.enum(['approved', 'declined']),
            declineCode: z.string().nullable(),
            status: z.string(),
            decidedAt: z.string(),
            /**
             * WHAT THE MERCHANT CHARGED, and the rate it converted at (§18).
             *
             * NULL where the card is charged in the asset it draws on — nothing
             * was converted, and rendering a rate of 1 would invent a
             * conversion that did not happen. Where it is present, the statement
             * can show the user the price they agreed at the till alongside the
             * units that actually left their balance, which is the pair a
             * converted spend is unreadable without.
             */
            conversion: z
              .object({
                settlementAssetId: z.string(),
                settlementAmount: amountString,
                rate: amountString,
                /** How the rate was derived — `MarkQuality` from the loan book. */
                rateQuality: z.string(),
                rateAsOf: z.string(),
              })
              .nullable(),
          }),
        ),
      )
      .query(async ({ ctx, input }) =>
        guard(async () => {
          // `bank:read` answers "may this principal read bank data". It never
          // answered "whose" — same guard, same reason, as `transfers.executions`.
          const card = await bank.cards.card(input.cardId);
          assertSelf(ctx.principal.userId, card.userId);
          const rows = await bank.cards.authorizationsOf(input.cardId);
          return rows.map((a) => ({
            id: a.id,
            authorizationRef: a.authorizationRef,
            amount: formatAmount(a.amount),
            merchantCategory: a.merchantCategory,
            decision: a.decision,
            declineCode: a.declineCode,
            status: a.status,
            decidedAt: a.decidedAt.toISOString(),
            conversion: a.conversion
              ? {
                  settlementAssetId: a.conversion.settlementAssetId,
                  settlementAmount: formatAmount(a.conversion.settlementAmount),
                  rate: formatAmount(a.conversion.rate),
                  rateQuality: a.conversion.quality,
                  rateAsOf: a.conversion.rateAsOf.toISOString(),
                }
              : null,
          }));
        }),
      ),
  });

  /**
   * Operator surface. The jobs live behind `admin:treasury` — a scope §4.1 marks
   * interactive-only, so it can never be held by a long-lived API key.
   */
  const ops = router({
    runDueTransfers: scopedProcedure('admin:treasury')
      .input(z.object({ limit: z.number().int().min(1).max(10_000).optional() }))
      .output(
        z.object({
          schedulesConsidered: z.number().int(),
          settled: z.number().int(),
          rejected: z.number().int(),
          alreadyFired: z.number().int(),
          /** Schedules looked at only because a claim was left behind. An operator wants zero. */
          strandedSwept: z.number().int(),
          /** Schedules that threw mid-drive; occurrence not consumed; next pass retries. */
          failures: z.array(
            z.object({
              scheduleId: z.string(),
              reason: z.string(),
              code: z.string().optional(),
            }),
          ),
        }),
      )
      .mutation(async ({ input }) =>
        guard(async () => {
          // Parity with POST /internal/jobs/run-due-transfers: the flag is the
          // emergency stop for a mis-computed occurrence index. tRPC must not
          // be a back door past it.
          if (!scheduledTransfersEnabled) {
            throw new BankError('scheduled transfers are disabled', 'bank.transfers_disabled');
          }
          return bank.transfers.runDueTransfers(input.limit === undefined ? {} : { limit: input.limit });
        }),
      ),

    /**
     * Fire due auto-invest rules (threshold sweeps always; DCA when convert is wired).
     * Kill-switch parity with HTTP `POST /internal/jobs/run-auto-invest`.
     */
    runAutoInvest: scopedProcedure('admin:treasury')
      .input(z.object({ limit: z.number().int().min(1).max(10_000).optional() }))
      .output(
        z.object({
          considered: z.number().int(),
          settled: z.number().int(),
          skipped: z.number().int(),
          rejected: z.number().int(),
          failures: z.array(z.object({ ruleId: z.string(), code: z.string() })),
        }),
      )
      .mutation(async ({ input }) =>
        guard(async () => {
          if (!autoInvestEnabled) {
            throw new BankError('auto-invest is disabled', 'bank.auto_invest_disabled');
          }
          return bank.autoInvest.runDue(input.limit === undefined ? {} : { limit: input.limit });
        }),
      ),

    accrueInterest: scopedProcedure('admin:treasury')
      .input(z.object({ poolId: z.string().uuid().optional(), at: z.string().datetime({ offset: true }).optional() }))
      .output(
        z.object({
          results: z.array(
            z.object({
              poolId: z.string(),
              date: z.string(),
              paid: amountString,
              recipients: z.number().int(),
              alreadyAccrued: z.boolean(),
            }),
          ),
          /** Pools that threw (e.g. underfunded); day not consumed for those pools. */
          failures: z.array(
            z.object({
              poolId: z.string(),
              reason: z.string(),
              code: z.string().optional(),
            }),
          ),
        }),
      )
      .mutation(async ({ input }) =>
        guard(async () => {
          // Parity with POST /internal/jobs/accrue-interest.
          if (!interestAccrualEnabled) {
            throw new BankError('interest accrual is disabled', 'bank.interest_accrual_disabled');
          }
          const at = input.at ? new Date(input.at) : new Date();
          // Single-pool path stays loud: operator targeted that pool, so throw.
          if (input.poolId) {
            const r = await bank.earn.accrue({ poolId: input.poolId, at });
            return {
              results: [
                {
                  poolId: r.poolId,
                  date: r.date,
                  paid: formatAmount(r.paid),
                  recipients: r.recipients,
                  alreadyAccrued: r.alreadyAccrued,
                },
              ],
              failures: [],
            };
          }
          const report = await bank.earn.accrueAll(at);
          return {
            results: report.results.map((r) => ({
              poolId: r.poolId,
              date: r.date,
              paid: formatAmount(r.paid),
              recipients: r.recipients,
              alreadyAccrued: r.alreadyAccrued,
            })),
            failures: report.failures,
          };
        }),
      ),

    fundPool: scopedProcedure('admin:treasury')
      .input(z.object({ poolId: z.string().uuid(), fundingId: z.string().min(4).max(64), amount: amountString }))
      .output(z.object({ ledgerTxId: z.string() }))
      .mutation(async ({ input }) =>
        guard(async () => bank.earn.fundPool({ poolId: input.poolId, fundingId: input.fundingId, amount: parseAmount(input.amount) })),
      ),

    // ── Loans (§8.1) ─────────────────────────────────────────────────────────
    //
    // THE RISK SWEEP AND THE LADDER ARE OPERATOR SURFACE, NOT USER SURFACE.
    //
    // A user able to trigger a mark is a user able to choose when their own — or
    // a rival's — collateral is priced, which is precisely what the staleness
    // window and the deviation breaker exist to take out of anyone's hands. Same
    // reasoning as the standing-order runner above: safe to run twice is not a
    // reason to let an untrusted caller choose when.

    fundLoanReserve: scopedProcedure('admin:treasury')
      .input(z.object({ debtAssetId: z.string().min(1).max(16), fundingId: z.string().min(4).max(64), amount: amountString }))
      .output(z.object({ ledgerTxId: z.string() }))
      .mutation(async ({ input }) =>
        guard(async () =>
          bank.loans.fundReserve({ debtAssetId: input.debtAssetId, fundingId: input.fundingId, amount: parseAmount(input.amount) }),
        ),
      ),

    accrueLoanInterest: scopedProcedure('admin:treasury')
      .input(z.object({ loanId: z.string().uuid().optional(), at: z.string().datetime({ offset: true }).optional() }))
      .output(
        z.object({
          results: z.array(z.object({ loanId: z.string(), charged: amountString, days: z.number().int() })),
          failures: z.array(z.object({ loanId: z.string(), reason: z.string(), code: z.string().optional() })),
        }),
      )
      .mutation(async ({ input }) =>
        guard(async () => {
          // Parity with POST /internal/jobs/accrue-loan-interest.
          if (!loanAccrualEnabled) {
            throw new BankError('loan interest accrual is disabled', 'bank.loan_accrual_disabled');
          }
          const at = input.at ? new Date(input.at) : new Date();
          if (input.loanId) {
            const one = await bank.loans.accrue({ loanId: input.loanId, until: at });
            return {
              results: [{ loanId: one.loanId, charged: formatAmount(one.charged), days: one.days.length }],
              failures: [],
            };
          }
          const all = await bank.loans.accrueAll(at);
          return {
            results: all.results.map((r) => ({ loanId: r.loanId, charged: formatAmount(r.charged), days: r.days })),
            failures: all.failures,
          };
        }),
      ),

    runRiskSweep: scopedProcedure('admin:treasury')
      .input(z.object({ limit: z.number().int().min(1).max(10_000).optional() }))
      .output(
        z.object({
          marked: z.number().int(),
          called: z.number().int(),
          liquidated: z.number().int(),
          cleared: z.number().int(),
          // Loans the sweep declined to act on — an unusable mark, no
          // counterparty, a reserve that cannot cover. Surfaced rather than
          // swallowed: a silent refusal is a position nobody is watching.
          refused: z.array(z.object({ loanId: z.string(), reason: z.string() })),
        }),
      )
      .mutation(async ({ input }) =>
        guard(async () => {
          // Parity with POST /internal/jobs/run-risk-sweep. Defaults off in
          // production; a treasury caller must not liquidate past that stop.
          if (!loanRiskSweepEnabled) {
            throw new BankError('loan risk sweep is disabled', 'bank.loan_risk_sweep_disabled');
          }
          return bank.loans.runRiskSweep(input.limit === undefined ? {} : { limit: input.limit });
        }),
      ),

    /** Re-drive loans stuck between the collateral lock and the draw. */
    resumePendingLoans: scopedProcedure('admin:treasury')
      .input(z.object({ limit: z.number().int().min(1).max(1_000).optional() }))
      .output(z.array(z.object({ loanId: z.string(), outcome: z.string(), reason: z.string().optional() })))
      .mutation(async ({ input }) => guard(async () => bank.loans.resumePending(input.limit))),

    /** Give up on a pending loan and give the borrower their collateral back. */
    abandonPendingLoan: scopedProcedure('admin:treasury')
      .input(z.object({ loanId: z.string().uuid() }))
      .output(z.object({ released: amountString, ledgerTxId: z.string().nullable() }))
      .mutation(async ({ input }) =>
        guard(async () => {
          const result = await bank.loans.abandonPending(input.loanId);
          return { released: formatAmount(result.released), ledgerTxId: result.ledgerTxId };
        }),
      ),

    /**
     * Re-drive earn deposits stuck between the ledger post and activate.
     * Same recovery shape as `resumePendingLoans`; key is bank.earn.deposit:<id>.
     */
    resumePendingEarn: scopedProcedure('admin:treasury')
      .input(z.object({ limit: z.number().int().min(1).max(1_000).optional() }))
      .output(z.array(z.object({ positionId: z.string(), outcome: z.string(), reason: z.string().optional() })))
      .mutation(async ({ input }) => guard(async () => bank.earn.resumePending(input.limit))),

    // ── Cards (§8.1, ledger half) ────────────────────────────────────────────
    //
    // THE ISSUER'S SIDE OF THE CONVERSATION, NOT THE USER'S.
    //
    // On a live rail these three are a signed webhook from the issuer, arriving
    // on a deadline the card network sets. There is no live rail — that is
    // `socket.live-issuer`, a sponsor bank and an issuing BIN — so today they are
    // operator surface, and they must NEVER become user surface: a user who can
    // call `cardAuthorize` approves their own purchase, and a user who can call
    // `cardCapture` chooses when their own money leaves the book.
    //
    // The simulator is what makes them exercisable at all, and it says so on
    // every card it issues (`simulated: true`).

    cardAuthorize: scopedProcedure('admin:treasury')
      .input(
        z.object({
          cardId: z.string().uuid(),
          authorizationRef: z.string().min(4).max(128),
          /**
           * THE MERCHANT'S NUMBER, in the card's SETTLEMENT asset.
           *
           * The same asset the card draws on unless the card was issued with a
           * settlement asset of its own — in which case this is converted at a
           * rate quoted now and frozen, and refuses `bank.mark_missing` if no
           * rate can be got rather than guessing one.
           */
          amount: amountString,
          merchantCategory: z.string().min(1).max(64).optional(),
        }),
      )
      .output(
        z.object({
          authorizationId: z.string(),
          decision: z.enum(['approved', 'declined']),
          declineCode: z.string().nullable(),
          /** WHAT WAS HELD, in the funding asset. The converted figure on a converted card. */
          amount: amountString,
          /** The frozen quote, or null because this card converts nothing. */
          conversion: z
            .object({
              settlementAssetId: z.string(),
              settlementAmount: amountString,
              rate: amountString,
              rateQuality: z.string(),
              rateAsOf: z.string(),
            })
            .nullable(),
        }),
      )
      .mutation(async ({ input }) =>
        guard(async () => {
          const authorization = await bank.cards.authorize({
            cardId: input.cardId,
            authorizationRef: input.authorizationRef,
            amount: parseAmount(input.amount),
            ...(input.merchantCategory === undefined ? {} : { merchantCategory: input.merchantCategory }),
          });
          return {
            authorizationId: authorization.id,
            decision: authorization.decision,
            declineCode: authorization.declineCode,
            amount: formatAmount(authorization.amount),
            conversion: authorization.conversion
              ? {
                  settlementAssetId: authorization.conversion.settlementAssetId,
                  settlementAmount: formatAmount(authorization.conversion.settlementAmount),
                  rate: formatAmount(authorization.conversion.rate),
                  rateQuality: authorization.conversion.quality,
                  rateAsOf: authorization.conversion.rateAsOf.toISOString(),
                }
              : null,
          };
        }),
      ),

    cardCapture: scopedProcedure('admin:treasury')
      .input(z.object({ cardId: z.string().uuid(), authorizationRef: z.string().min(4).max(128), amount: amountString }))
      .output(
        z.object({
          /** WHAT LEFT THE BOOK, in the funding asset. */
          captured: amountString,
          returned: amountString,
          captureLedgerTxId: z.string(),
          reversalLedgerTxId: z.string().nullable(),
          /**
           * What the merchant cleared and the FROZEN rate it converted at — the
           * rate the authorisation was decided on, re-read and never re-quoted.
           * Null on a card that converts nothing.
           */
          settlement: z.object({ assetId: z.string(), amount: amountString, rate: amountString }).nullable(),
          // Surfaced rather than swallowed. A reward the rewards pot could not
          // pay is a fact an operator needs on the day it happens — the same
          // reasoning as `runRiskSweep.refused`.
          cashback: z.object({
            status: z.enum(['none', 'paid', 'refused']),
            amount: amountString,
            reason: z.string().optional(),
          }),
          /**
           * Spare-change sweep. Capture still stands when this is skipped or
           * refused — same reporting rule as cashback.
           */
          roundUp: z.object({
            status: z.enum(['none', 'skipped', 'settled', 'refused']),
            amount: amountString,
            reason: z.string().optional(),
            positionId: z.string().optional(),
          }),
        }),
      )
      .mutation(async ({ input }) =>
        guard(async () => {
          const result = await bank.cards.capture({
            cardId: input.cardId,
            authorizationRef: input.authorizationRef,
            amount: parseAmount(input.amount),
          });
          return {
            captured: formatAmount(result.captured),
            returned: formatAmount(result.returned),
            captureLedgerTxId: result.captureLedgerTxId,
            reversalLedgerTxId: result.reversalLedgerTxId,
            settlement: result.settlement
              ? {
                  assetId: result.settlement.assetId,
                  amount: formatAmount(result.settlement.amount),
                  rate: formatAmount(result.settlement.rate),
                }
              : null,
            cashback: {
              status: result.cashback.status,
              amount: formatAmount(result.cashback.amount),
              ...(result.cashback.status === 'refused' ? { reason: result.cashback.reason } : {}),
            },
            roundUp: {
              status: result.roundUp.status,
              amount: formatAmount(result.roundUp.amount),
              ...(result.roundUp.status === 'skipped' || result.roundUp.status === 'refused' ? { reason: result.roundUp.reason } : {}),
              ...(result.roundUp.status === 'settled' ? { positionId: result.roundUp.positionId } : {}),
            },
          };
        }),
      ),

    /** The authorisation expired or was voided. The whole hold goes back. */
    cardReverse: scopedProcedure('admin:treasury')
      .input(z.object({ cardId: z.string().uuid(), authorizationRef: z.string().min(4).max(128) }))
      .output(z.object({ returned: amountString, ledgerTxId: z.string() }))
      .mutation(async ({ input }) =>
        guard(async () => {
          const result = await bank.cards.reverse({ cardId: input.cardId, authorizationRef: input.authorizationRef });
          return { returned: formatAmount(result.returned), ledgerTxId: result.ledgerTxId };
        }),
      ),

    /**
     * Re-drive card settlements that were claimed and never reached the ledger,
     * and report what is still held against the authorisation.
     *
     * The card equivalent of `resumePendingLoans`, and it exists for the same
     * reason: one failed post must not leave a user's hold unreachable. Takes no
     * amount — each row is re-driven for the amount it was claimed with, because
     * a recovery that can restate what moved is not a recovery.
     */
    cardResumeSettlement: scopedProcedure('admin:treasury')
      .input(z.object({ cardId: z.string().uuid(), authorizationRef: z.string().min(4).max(128) }))
      .output(
        z.object({
          authorizationId: z.string(),
          resumed: z.array(
            z.object({
              sequence: z.number().int(),
              kind: z.enum(['capture', 'reversal']),
              amount: amountString,
              outcome: z.enum(['settled', 'failed']),
              ledgerTxId: z.string().optional(),
              reason: z.string().optional(),
            }),
          ),
          // Read from the ledger, not added up from our own rows. Zero is the
          // invariant an operator is actually checking for after a recovery.
          held: amountString,
        }),
      )
      .mutation(async ({ input }) =>
        guard(async () => {
          const result = await bank.cards.resumeSettlements({
            cardId: input.cardId,
            authorizationRef: input.authorizationRef,
          });
          return {
            authorizationId: result.authorizationId,
            resumed: result.resumed.map((row) => ({
              sequence: row.sequence,
              kind: row.kind,
              amount: formatAmount(row.amount),
              outcome: row.outcome,
              ...(row.ledgerTxId === undefined ? {} : { ledgerTxId: row.ledgerTxId }),
              ...(row.reason === undefined ? {} : { reason: row.reason }),
            })),
            held: formatAmount(result.held),
          };
        }),
      ),

    /**
     * Move bank revenue into the pot cashback is paid from.
     *
     * The named source, in one call. Cashback is a share of fees the platform
     * really charged; a pot funded from anywhere else would make the advertised
     * rate a promise against revenue that has not happened.
     */
    fundCashbackPot: scopedProcedure('admin:treasury')
      .input(z.object({ windowId: z.string().min(4).max(64), assetId: z.string().min(1).max(16), amount: amountString }))
      .output(z.object({ ledgerTxId: z.string(), capacity: amountString }))
      .mutation(async ({ input }) =>
        guard(async () => {
          const posted = await bank.cards.fundCashbackPot({
            windowId: input.windowId,
            assetId: input.assetId,
            amount: parseAmount(input.amount),
          });
          return { ledgerTxId: posted.ledgerTxId, capacity: formatAmount(await bank.cards.cashbackCapacity(input.assetId)) };
        }),
      ),

    /**
     * The reserve identity, as a query rather than an investigation:
     * `balance(loanReserve) + Σ outstanding principal` against what was funded.
     */
    reconcileLoanReserve: scopedProcedure('admin:treasury')
      .input(z.object({ debtAssetId: z.string().min(1).max(16) }))
      .output(
        z.object({
          reserveBalance: amountString,
          outstandingPrincipal: amountString,
          badDebt: amountString,
          funded: amountString,
          drift: amountString,
          /** False until funded is journal-independent; do not treat drift 0 as green. */
          independent: z.boolean(),
          insuranceCapacity: amountString,
        }),
      )
      .query(async ({ input }) =>
        guard(async () => {
          const r = await bank.loans.reconcileReserve(input.debtAssetId);
          return {
            reserveBalance: formatAmount(r.reserveBalance),
            outstandingPrincipal: formatAmount(r.outstandingPrincipal),
            badDebt: formatAmount(r.badDebt),
            funded: formatAmount(r.funded),
            drift: formatAmount(r.drift),
            independent: r.independent,
            insuranceCapacity: formatAmount(await bank.loans.insuranceCapacity(input.debtAssetId)),
          };
        }),
      ),

    /**
     * Operator on-ramp credit for the CRYPTO ledger half.
     *
     * Not user-callable: a user who credits their own balance does not need a
     * ramp. Fiat refuses `bank.fiat_ramp_no_pay_adapter` when no pay adapter can settle.
     */
    creditOnramp: scopedProcedure('admin:treasury')
      .input(
        z.object({
          userId: z.string().min(1),
          assetId: z.string().min(1).max(16),
          amount: amountString,
          kind: z.enum(['crypto', 'fiat']).default('crypto'),
          railRef: z.string().min(1).max(256),
        }),
      )
      .output(
        z.object({
          id: z.string(),
          userId: z.string(),
          assetId: z.string(),
          amount: amountString,
          kind: z.enum(['crypto', 'fiat']),
          rail: z.string(),
          railRef: z.string(),
          simulated: z.boolean(),
          status: z.string(),
          ledgerTxId: z.string().nullable(),
        }),
      )
      .mutation(async ({ ctx, input }) =>
        guard(async () => {
          const row = await bank.ramps.creditOnramp({
            userId: input.userId,
            assetId: input.assetId,
            amount: parseAmount(input.amount),
            kind: input.kind,
            railRef: input.railRef,
            creditedBy: ctx.principal.userId,
          });
          return {
            id: row.id,
            userId: row.userId,
            assetId: row.assetId,
            amount: formatAmount(row.amount),
            kind: row.kind,
            rail: row.rail,
            railRef: row.railRef,
            simulated: row.simulated,
            status: row.status,
            ledgerTxId: row.ledgerTxId,
          };
        }),
      ),
  });

  /**
   * RAMPS — crypto ledger half. Fiat is socket.psp-partners commercially; the
   * code path is svc-pay RailAdapter (`fiatVia`) — refuse or ledger-client wire.
   *
   * `simulated` is never omitted: this surface does not broadcast to a chain and
   * never claims a live PSP. Live confirmation stays in svc-pay; Class X is a
   * human decision to point working code at real money.
   */
  const rampProgrammeOutput = z.object({
    id: z.string(),
    simulated: z.boolean(),
    displayName: z.string(),
    cryptoRail: z.string().nullable(),
    fiatLeg: z.literal('socket.psp-partners'),
    fiatVia: z.literal('svc-pay.RailAdapter'),
  });

  const onrampOutput = z.object({
    id: z.string(),
    assetId: z.string(),
    amount: amountString,
    kind: z.enum(['crypto', 'fiat']),
    rail: z.string(),
    railRef: z.string(),
    simulated: z.boolean(),
    status: z.string(),
    ledgerTxId: z.string().nullable(),
    createdAt: z.string(),
  });

  const offrampOutput = z.object({
    id: z.string(),
    assetId: z.string(),
    amount: amountString,
    kind: z.enum(['crypto', 'fiat']),
    rail: z.string(),
    destinationRef: z.string(),
    clientRef: z.string(),
    simulated: z.boolean(),
    status: z.string(),
    holdLedgerTxId: z.string().nullable(),
    settleLedgerTxId: z.string().nullable(),
    createdAt: z.string(),
  });

  const autoInvestRuleOutput = z.object({
    id: z.string(),
    kind: z.enum(['threshold_sweep', 'dca', 'card_roundup']),
    assetId: z.string(),
    threshold: amountString.nullable(),
    targetPoolId: z.string().nullable(),
    buyAssetId: z.string().nullable(),
    amount: amountString.nullable(),
    cadence: z.enum(['daily', 'weekly', 'monthly']).nullable(),
    nextRunAt: z.string().nullable(),
    status: z.enum(['active', 'paused', 'cancelled']),
    createdAt: z.string(),
  });

  function mapRule(r: Awaited<ReturnType<typeof bank.autoInvest.listRules>>[number]) {
    return {
      id: r.id,
      kind: r.kind,
      assetId: r.assetId,
      threshold: r.threshold === null ? null : formatAmount(r.threshold),
      targetPoolId: r.targetPoolId,
      buyAssetId: r.buyAssetId,
      amount: r.amount === null ? null : formatAmount(r.amount),
      cadence: r.cadence,
      nextRunAt: r.nextRunAt?.toISOString() ?? null,
      status: r.status,
      createdAt: r.createdAt.toISOString(),
    };
  }

  const autoInvest = router({
    /**
     * List this user's auto-invest rules. Rules hold no balance — they are
     * instructions; the ledger answers "how much".
     */
    list: scopedProcedure('bank:read', { module: 'bank' })
      .output(z.array(autoInvestRuleOutput))
      .query(async ({ ctx }) =>
        guard(async () => {
          const rows = await bank.autoInvest.listRules(ctx.principal.userId);
          return rows.map(mapRule);
        }),
      ),

    /**
     * Same-asset threshold sweep: keep `threshold` in primary available; move
     * excess into an earn pool of the same asset. No rate is consulted.
     */
    createThresholdSweep: scopedProcedure('bank:write', { module: 'bank' })
      .input(
        z.object({
          assetId: z.string().min(1).max(16),
          threshold: amountString,
          targetPoolId: z.string().uuid(),
        }),
      )
      .output(autoInvestRuleOutput)
      .mutation(async ({ ctx, input }) =>
        guard(async () => {
          const rule = await bank.autoInvest.createThresholdSweep({
            userId: ctx.principal.userId,
            assetId: input.assetId,
            threshold: parseAmount(input.threshold),
            targetPoolId: input.targetPoolId,
          });
          return mapRule(rule);
        }),
      ),

    /**
     * Card round-up. Same-asset spare change → earn pool on capture.
     * `buyAssetId` that differs from `assetId` refuses `bank.auto_invest_rate_unset`
     * — the surface exists so the dishonest half is named, not silent.
     */
    createRoundUp: scopedProcedure('bank:write', { module: 'bank' })
      .input(
        z.object({
          assetId: z.string().min(1).max(16),
          granularity: amountString,
          targetPoolId: z.string().uuid(),
          buyAssetId: z.string().min(1).max(16).optional(),
        }),
      )
      .output(autoInvestRuleOutput)
      .mutation(async ({ ctx, input }) =>
        guard(async () => {
          const rule = await bank.autoInvest.createCardRoundUp({
            userId: ctx.principal.userId,
            assetId: input.assetId,
            granularity: parseAmount(input.granularity),
            targetPoolId: input.targetPoolId,
            ...(input.buyAssetId ? { buyAssetId: input.buyAssetId } : {}),
          });
          return mapRule(rule);
        }),
      ),

    /**
     * DCA schedule. Refuses `bank.auto_invest_rate_unset` when this deployment
     * has no convert counterparty — §8 rates are never invented here.
     */
    createDca: scopedProcedure('bank:write', { module: 'bank' })
      .input(
        z.object({
          spendAssetId: z.string().min(1).max(16),
          buyAssetId: z.string().min(1).max(16),
          amount: amountString,
          cadence: z.enum(['daily', 'weekly', 'monthly']),
          startsAt: z.string().datetime({ offset: true }),
        }),
      )
      .output(autoInvestRuleOutput)
      .mutation(async ({ ctx, input }) =>
        guard(async () => {
          const rule = await bank.autoInvest.createDca({
            userId: ctx.principal.userId,
            spendAssetId: input.spendAssetId,
            buyAssetId: input.buyAssetId,
            amount: parseAmount(input.amount),
            cadence: input.cadence,
            startsAt: new Date(input.startsAt),
          });
          return mapRule(rule);
        }),
      ),

    cancel: scopedProcedure('bank:write', { module: 'bank' })
      .input(z.object({ ruleId: z.string().uuid() }))
      .output(z.object({ ok: z.literal(true) }))
      .mutation(async ({ ctx, input }) =>
        guard(async () => {
          const rule = await bank.autoInvest.getRule(input.ruleId);
          if (rule.userId !== ctx.principal.userId) {
            throw new BankError('Not your auto-invest rule', 'bank.not_owner');
          }
          await bank.autoInvest.cancelRule(input.ruleId);
          return { ok: true as const };
        }),
      ),

    /**
     * Hold a rule without cancelling. Runner only considers `active` rules.
     */
    pause: scopedProcedure('bank:write', { module: 'bank' })
      .input(z.object({ ruleId: z.string().uuid() }))
      .output(autoInvestRuleOutput)
      .mutation(async ({ ctx, input }) =>
        guard(async () => {
          const rule = await bank.autoInvest.getRule(input.ruleId);
          if (rule.userId !== ctx.principal.userId) {
            throw new BankError('Not your auto-invest rule', 'bank.not_owner');
          }
          return mapRule(await bank.autoInvest.pauseRule(input.ruleId));
        }),
      ),

    /**
     * Resume a paused rule. Next runDue pass applies normal due rules — no
     * multi-fire invent of missed windows.
     */
    resume: scopedProcedure('bank:write', { module: 'bank' })
      .input(z.object({ ruleId: z.string().uuid() }))
      .output(autoInvestRuleOutput)
      .mutation(async ({ ctx, input }) =>
        guard(async () => {
          const rule = await bank.autoInvest.getRule(input.ruleId);
          if (rule.userId !== ctx.principal.userId) {
            throw new BankError('Not your auto-invest rule', 'bank.not_owner');
          }
          return mapRule(await bank.autoInvest.resumeRule(input.ruleId));
        }),
      ),
  });

  const ramps = router({
    /** What this deployment's ramp programme is — including that it is not one. */
    programme: scopedProcedure('bank:read', { module: 'bank' })
      .output(rampProgrammeOutput)
      .query(async () => guard(async () => bank.ramps.programmeInfo())),

    /**
     * Fiat settle probe. Refuses with a typed code when no svc-pay adapter can
     * settle fiat (empty / sandbox / absent). Does not invent FX. Live partner
     * rails remain Class X — this door never claims simulated: false.
     */
    fiatSettle: scopedProcedure('bank:read', { module: 'bank' })
      .output(
        z.object({
          canSettle: z.literal(true),
          onrampRailId: z.string(),
          offrampRailId: z.string(),
        }),
      )
      .query(async () => guard(async () => bank.ramps.fiatSettle())),

    onramps: scopedProcedure('bank:read', { module: 'bank' })
      .output(z.array(onrampOutput))
      .query(async ({ ctx }) =>
        guard(async () => {
          const rows = await bank.ramps.onrampsOf(ctx.principal.userId);
          return rows.map((r) => ({
            id: r.id,
            assetId: r.assetId,
            amount: formatAmount(r.amount),
            kind: r.kind,
            rail: r.rail,
            railRef: r.railRef,
            simulated: r.simulated,
            status: r.status,
            ledgerTxId: r.ledgerTxId,
            createdAt: r.createdAt.toISOString(),
          }));
        }),
      ),

    offramps: scopedProcedure('bank:read', { module: 'bank' })
      .output(z.array(offrampOutput))
      .query(async ({ ctx }) =>
        guard(async () => {
          const rows = await bank.ramps.offrampsOf(ctx.principal.userId);
          return rows.map((r) => ({
            id: r.id,
            assetId: r.assetId,
            amount: formatAmount(r.amount),
            kind: r.kind,
            rail: r.rail,
            destinationRef: r.destinationRef,
            clientRef: r.clientRef,
            simulated: r.simulated,
            status: r.status,
            holdLedgerTxId: r.holdLedgerTxId,
            settleLedgerTxId: r.settleLedgerTxId,
            createdAt: r.createdAt.toISOString(),
          }));
        }),
      ),

    /**
     * Persist a user withdraw dest (IBAN/IFSC/EVM) so a later offramp has a
     * real ref before withdrawHold. Does not move value and does not invent a PSP.
     */
    setWithdrawDestination: scopedProcedure('bank:write', { module: 'bank' })
      .input(z.object({ kind: z.enum(['crypto', 'bank']), ref: z.string().min(1).max(256) }))
      .output(z.object({ kind: z.string(), ref: z.string() }))
      .mutation(async ({ ctx, input }) =>
        guard(async () => bank.ramps.setWithdrawDestination({ userId: ctx.principal.userId, kind: input.kind, ref: input.ref })),
      ),

    /**
     * User off-ramp. `offrampId` + `clientRef` are client-supplied so a retry
     * is the same withdrawal (§5). Fiat refuses before any hold is posted.
     * Destination is persisted (or loaded) before withdrawHold.
     */
    offramp: scopedProcedure('bank:write', { module: 'bank' })
      .input(
        z.object({
          offrampId: z.string().uuid(),
          assetId: z.string().min(1).max(16),
          amount: amountString,
          kind: z.enum(['crypto', 'fiat']).default('crypto'),
          destinationRef: z.string().min(1).max(256).optional(),
          clientRef: z.string().min(1).max(128),
        }),
      )
      .output(offrampOutput)
      .mutation(async ({ ctx, input }) =>
        guard(async () => {
          const row = await bank.ramps.offramp({
            offrampId: input.offrampId,
            userId: ctx.principal.userId,
            assetId: input.assetId,
            amount: parseAmount(input.amount),
            kind: input.kind,
            destinationRef: input.destinationRef,
            clientRef: input.clientRef,
          });
          return {
            id: row.id,
            assetId: row.assetId,
            amount: formatAmount(row.amount),
            kind: row.kind,
            rail: row.rail,
            destinationRef: row.destinationRef,
            clientRef: row.clientRef,
            simulated: row.simulated,
            status: row.status,
            holdLedgerTxId: row.holdLedgerTxId,
            settleLedgerTxId: row.settleLedgerTxId,
            createdAt: row.createdAt.toISOString(),
          };
        }),
      ),
  });

  const businessAccountOutput = z.object({
    id: z.string(),
    name: z.string(),
    assetId: z.string(),
    spendThreshold: amountString,
    status: z.enum(['active', 'closed']),
    createdAt: z.string(),
  });

  const businessApprovalOutput = z.object({
    id: z.string(),
    accountId: z.string(),
    makerUserId: z.string(),
    checkerUserId: z.string().nullable(),
    fromSpaceId: z.string(),
    toSpaceId: z.string(),
    assetId: z.string(),
    amount: amountString,
    status: z.enum(['pending', 'approved', 'rejected', 'cancelled']),
    transferId: z.string().nullable(),
    holdLedgerTxId: z.string().nullable(),
    ledgerTxId: z.string().nullable(),
    createdAt: z.string(),
  });

  const business = router({
    list: scopedProcedure('bank:read', { module: 'bank' })
      .output(z.array(businessAccountOutput))
      .query(async ({ ctx }) =>
        guard(async () => {
          const rows = await bank.business.accountsOf(ctx.principal.userId);
          return rows.map((a) => ({
            id: a.id,
            name: a.name,
            assetId: a.assetId,
            spendThreshold: formatAmount(a.spendThreshold),
            status: a.status,
            createdAt: a.createdAt.toISOString(),
          }));
        }),
      ),

    create: scopedProcedure('bank:write', { module: 'bank' })
      .input(
        z.object({
          name: z.string().min(1).max(128),
          assetId: z.string().min(1).max(16),
          spendThreshold: amountString,
        }),
      )
      .output(businessAccountOutput)
      .mutation(async ({ ctx, input }) =>
        guard(async () => {
          const a = await bank.business.createAccount({
            name: input.name,
            assetId: input.assetId,
            spendThreshold: parseAmount(input.spendThreshold),
            creatorUserId: ctx.principal.userId,
          });
          return {
            id: a.id,
            name: a.name,
            assetId: a.assetId,
            spendThreshold: formatAmount(a.spendThreshold),
            status: a.status,
            createdAt: a.createdAt.toISOString(),
          };
        }),
      ),

    addMember: scopedProcedure('bank:write', { module: 'bank' })
      .input(
        z.object({
          accountId: z.string().uuid(),
          userId: z.string().min(1),
          role: z.enum(['admin', 'maker', 'checker']),
        }),
      )
      .output(z.object({ accountId: z.string(), userId: z.string(), role: z.enum(['admin', 'maker', 'checker']) }))
      .mutation(async ({ ctx, input }) =>
        guard(async () => {
          const m = await bank.business.addMember({
            accountId: input.accountId,
            actorUserId: ctx.principal.userId,
            userId: input.userId,
            role: input.role,
          });
          return { accountId: m.accountId, userId: m.userId, role: m.role };
        }),
      ),

    proposeTransfer: scopedProcedure('bank:write', { module: 'bank' })
      .input(
        z.object({
          accountId: z.string().uuid(),
          fromSpaceId: z.string().uuid(),
          toSpaceId: z.string().uuid(),
          amount: amountString,
        }),
      )
      .output(
        z.discriminatedUnion('kind', [
          z.object({
            kind: z.literal('posted'),
            transferId: z.string(),
            ledgerTxId: z.string(),
          }),
          z.object({
            kind: z.literal('pending'),
            approval: businessApprovalOutput,
          }),
        ]),
      )
      .mutation(async ({ ctx, input }) =>
        guard(async () => {
          const result = await bank.business.proposeTransfer({
            accountId: input.accountId,
            makerUserId: ctx.principal.userId,
            fromSpaceId: input.fromSpaceId,
            toSpaceId: input.toSpaceId,
            amount: parseAmount(input.amount),
          });
          if (result.kind === 'posted') return result;
          const a = result.approval;
          return {
            kind: 'pending' as const,
            approval: {
              id: a.id,
              accountId: a.accountId,
              makerUserId: a.makerUserId,
              checkerUserId: a.checkerUserId,
              fromSpaceId: a.fromSpaceId,
              toSpaceId: a.toSpaceId,
              assetId: a.assetId,
              amount: formatAmount(a.amount),
              status: a.status,
              transferId: a.transferId,
              holdLedgerTxId: a.holdLedgerTxId,
              ledgerTxId: a.ledgerTxId,
              createdAt: a.createdAt.toISOString(),
            },
          };
        }),
      ),

    approve: scopedProcedure('bank:write', { module: 'bank' })
      .input(z.object({ approvalId: z.string().uuid() }))
      .output(z.object({ transferId: z.string(), ledgerTxId: z.string() }))
      .mutation(async ({ ctx, input }) =>
        guard(async () => bank.business.approve({ approvalId: input.approvalId, checkerUserId: ctx.principal.userId })),
      ),

    reject: scopedProcedure('bank:write', { module: 'bank' })
      .input(z.object({ approvalId: z.string().uuid() }))
      .output(z.object({ ok: z.literal(true) }))
      .mutation(async ({ ctx, input }) =>
        guard(async () => {
          await bank.business.reject({ approvalId: input.approvalId, checkerUserId: ctx.principal.userId });
          return { ok: true as const };
        }),
      ),

    cancel: scopedProcedure('bank:write', { module: 'bank' })
      .input(z.object({ approvalId: z.string().uuid() }))
      .output(z.object({ ok: z.literal(true) }))
      .mutation(async ({ ctx, input }) =>
        guard(async () => {
          await bank.business.cancel({ approvalId: input.approvalId, actorUserId: ctx.principal.userId });
          return { ok: true as const };
        }),
      ),

    pending: scopedProcedure('bank:read', { module: 'bank' })
      .input(z.object({ accountId: z.string().uuid() }))
      .output(z.array(businessApprovalOutput))
      .query(async ({ ctx, input }) =>
        guard(async () => {
          const rows = await bank.business.listPending(input.accountId, ctx.principal.userId);
          return rows.map((a) => ({
            id: a.id,
            accountId: a.accountId,
            makerUserId: a.makerUserId,
            checkerUserId: a.checkerUserId,
            fromSpaceId: a.fromSpaceId,
            toSpaceId: a.toSpaceId,
            assetId: a.assetId,
            amount: formatAmount(a.amount),
            status: a.status,
            transferId: a.transferId,
            holdLedgerTxId: a.holdLedgerTxId,
            ledgerTxId: a.ledgerTxId,
            createdAt: a.createdAt.toISOString(),
          }));
        }),
      ),
  });

  return router({
    health: publicProcedure
      .output(z.object({ ok: z.boolean(), service: z.literal('svc-bank') }))
      .query(() => ({ ok: true, service: 'svc-bank' as const })),
    spaces,
    transfers,
    earn,
    loans,
    cards,
    ramps,
    autoInvest,
    business,
    analytics,
    ops,
  });
}

export type BankRouter = ReturnType<typeof createBankRouter>;
