import { TRPCError } from '@intafaced/contracts';
import { BankError, type BankErrorCode } from './errors.js';

/**
 * BankError to a tRPC status for procedures that live outside `router.ts`'s
 * `guard`. The status matches the switch in `router.ts`.
 */

const STATUS: Partial<Record<BankErrorCode, TRPCError['code']>> = {
  'bank.transfer_message_conflict': 'CONFLICT',
  'bank.activity_not_found': 'NOT_FOUND',
  'bank.activity_lookup_bounded': 'PRECONDITION_FAILED',
  'portfolio.entries_do_not_sum': 'PRECONDITION_FAILED',
  'bank.activity_range': 'BAD_REQUEST',
  'bank.activity_note_conflict': 'CONFLICT',
  'bank.activity_note_empty': 'BAD_REQUEST',
  'bank.activity_dispute_conflict': 'CONFLICT',
  'bank.activity_dispute_exists': 'CONFLICT',
  'bank.statement_range': 'BAD_REQUEST',
  'bank.statement_pdf_one_month': 'PRECONDITION_FAILED',
  'bank.statement_too_large': 'PRECONDITION_FAILED',
  'bank.statement_unavailable': 'SERVICE_UNAVAILABLE',
  'bank.statement_balances_unavailable': 'PRECONDITION_FAILED',
  'bank.activity_filter_name_invalid': 'BAD_REQUEST',
  'bank.activity_filter_empty': 'BAD_REQUEST',
  'bank.activity_filter_conflict': 'CONFLICT',
  'bank.activity_filter_limit_unset': 'BAD_REQUEST',
};

export function throwBankProcedure(err: unknown): never {
  if (err instanceof TRPCError) throw err;
  if (err instanceof BankError) {
    const code = STATUS[err.code] ?? 'BAD_REQUEST';
    throw new TRPCError({ code, message: `${err.message} (${err.code})`, cause: err });
  }
  throw err;
}
