import { randomUUID } from 'node:crypto';
import { TRPCError } from '@intafaced/contracts';
import { InsufficientFundsError, LedgerError } from '@intafaced/ledger-client';
import { DualControlError } from '../dual-control.js';
import { ActionApprovalConsumeError } from '../action-approval-consume.js';
import { BANK_ERROR_STATUS, BankError, LedgerFrozenRefusal } from '../errors.js';
import { userFacingBankMessage } from '../user-copy.js';

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
 * Rule 2 is why `BANK_ERROR_STATUS` (errors.ts) is the codes themselves: a code is
 * declared with what a caller may be told, in its folder's `bank-errors.ts`, so it
 * cannot exist undecided and silently become a 400 with the domain sentence attached.
 */

/** The generic answer. Detail lives in the log, joined by this reference. */
export function opaqueFailure(err: unknown, context: string): TRPCError {
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
export function publicDoorWireMessage(err: BankError): string {
  const facing = userFacingBankMessage(err.code, err.message);
  if (facing.includes(err.code)) return facing;
  if (
    err.code === 'bank.pool_underfunded' ||
    err.code === 'bank.mark_missing' ||
    err.code === 'bank.prices_unavailable' ||
    err.code === 'bank.value_range_invalid' ||
    err.code === 'bank.value_range_too_long' ||
    err.code === 'bank.value_history_too_large' ||
    err.code === 'bank.value_history_unavailable' ||
    err.code === 'bank.earn_principal_mismatch' ||
    err.code === 'bank.loan_seizure_cross_asset' ||
    err.code === 'bank.loan_health_price_unset' ||
    err.code === 'bank.recipient_cannot_receive' ||
    err.code === 'bank.recipient_check_unavailable' ||
    err.code === 'bank.recipient_check_unset' ||
    err.code === 'bank.step_up_required' ||
    err.code === 'bank.step_up_mismatch' ||
    err.code === 'bank.step_up_used' ||
    err.code === 'bank.step_up_unavailable'
  ) {
    return facing + ' (' + err.code + ')';
  }
  return facing;
}

export function toTrpcError(err: unknown): TRPCError {
  // An answer that has already been decided. Ownership refusals are thrown as
  // TRPCError from inside `guard`, and without this line every one of them was
  // re-wrapped as INTERNAL_SERVER_ERROR — a 500 that tells the caller to retry
  // something that can never succeed, and hides the refusal from any dashboard
  // grouping on status. That applied to the four `assertSelf` calls that were
  // already here, not only to the two added with this change.
  if (err instanceof TRPCError) return err;
  if (err instanceof DualControlError || err instanceof ActionApprovalConsumeError) {
    return new TRPCError({ code: 'PRECONDITION_FAILED', message: err.message, cause: err });
  }
  if (err instanceof InsufficientFundsError) {
    return new TRPCError({ code: 'BAD_REQUEST', message: err.message, cause: err });
  }
  if (err instanceof BankError) {
    // EXHAUSTIVENESS is the table's type. At runtime a code outside the declared union is
    // precisely the one whose message nobody vetted, so it gets the generic answer.
    if (!Object.hasOwn(BANK_ERROR_STATUS, err.code)) return opaqueFailure(err, `bank.error:${String(err.code)}`);
    return new TRPCError({ code: BANK_ERROR_STATUS[err.code], message: publicDoorWireMessage(err), cause: err });
  }
  if (err instanceof LedgerFrozenRefusal) {
    // The posting freeze, proved not posted: the ledger's own code and nothing else, never the book's internals.
    return new TRPCError({ code: 'PRECONDITION_FAILED', message: 'ledger.frozen', cause: err });
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

export async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw toTrpcError(err);
  }
}
