import { TRPCError } from '@trpc/server';
import { router } from '@intafaced/contracts/trpc';
import {
  OPS_LEDGER_REVERSALS_EXECUTE,
  OPS_LEDGER_REVERSALS_GET,
  OPS_LEDGER_REVERSALS_LIST,
  OPS_LEDGER_REVERSALS_REQUEST,
} from '@intafaced/contracts/ops-ledger-reversals-procedures';
import { mountRecord } from '@intafaced/contracts/procedure-mount';
import {
  OPS_REVERSAL_ALREADY_REVERSED,
  OPS_REVERSAL_NOT_FOUND,
  OPS_REVERSAL_REQUESTER_ONLY,
  OPS_REVERSAL_SAME_PERSON,
  OPS_REVERSAL_STATE_ILLEGAL,
  OpsError,
} from '../codes.js';
import { opsRefusal } from '../refusal.js';
import type { LedgerReversalDesk } from './desk.js';

const STATUS: Partial<Record<string, TRPCError['code']>> = {
  [OPS_REVERSAL_NOT_FOUND]: 'NOT_FOUND',
  [OPS_REVERSAL_ALREADY_REVERSED]: 'CONFLICT',
  [OPS_REVERSAL_STATE_ILLEGAL]: 'CONFLICT',
  [OPS_REVERSAL_REQUESTER_ONLY]: 'FORBIDDEN',
  [OPS_REVERSAL_SAME_PERSON]: 'FORBIDDEN',
};

function deskError(err: unknown): never {
  if (err instanceof OpsError) {
    throw new TRPCError({ code: STATUS[err.code] ?? 'PRECONDITION_FAILED', message: `${err.code} — ${err.message}`, cause: err });
  }
  throw err;
}

const run = async <T>(work: () => Promise<T>): Promise<T> => {
  try {
    return await work();
  } catch (err) {
    return deskError(err);
  }
};

/**
 * Operator reversals of posted ledger transactions (OPS-ledger-desk-02). `request` and `execute` move value in the ledger, so
 * they need `admin:treasury`; svc-ops records the caller as the one who asked or ran. `list` and `get` need `admin:read`.
 */
export function createLedgerReversalsRouter(desk: LedgerReversalDesk) {
  return router({
    request: mountRecord(
      OPS_LEDGER_REVERSALS_REQUEST,
      ({ ctx, input }) => run(() => desk.request(ctx.principal.userId, input)),
      opsRefusal,
    ),
    execute: mountRecord(
      OPS_LEDGER_REVERSALS_EXECUTE,
      ({ ctx, input }) => run(() => desk.execute(ctx.principal.userId, input)),
      opsRefusal,
    ),
    get: mountRecord(OPS_LEDGER_REVERSALS_GET, ({ input }) => run(() => desk.get(input.requestNo)), opsRefusal),
    list: mountRecord(OPS_LEDGER_REVERSALS_LIST, ({ input }) => run(() => desk.list(input.originalTxId, input.limit)), opsRefusal),
  });
}
