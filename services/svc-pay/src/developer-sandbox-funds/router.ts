import { TRPCError, router, scopedProcedure } from '@intafaced/contracts';
import { type SandboxFundRefusal } from '@intafaced/contracts/developer-sandboxes';
import type { Sql } from 'postgres';
import type { SandboxFundSettings } from './settings.js';
import { SandboxFundError, SandboxStore } from './store.js';
import {
  PAY_SANDBOX_FUNDS_BALANCE,
  PAY_SANDBOX_FUNDS_FUND,
  PAY_SANDBOX_FUNDS_RESET,
} from '@intafaced/contracts/pay-sandbox-funds-procedures';
import { mountRecord } from '@intafaced/contracts/procedure-mount';
import { payRefusal } from '../record-refusal.js';

/**
 * `sandboxFunds.*` (DV-sandbox-02, J-developer-02 #4, #5, #8): a person's developer sandbox TEST balance, Fund and
 * Reset, from the sandbox store (store.ts), which never touches the ledger. A signed-in person only, never an acting
 * service. Rows are keyed by the caller and the sandbox id, so a sandbox id that is not the caller's reads as an empty
 * TEST balance of the caller's own and never anyone else's.
 */
const STATUS: Record<SandboxFundRefusal, TRPCError['code']> = {
  'pay.sandbox_funds_unset': 'PRECONDITION_FAILED',
  'pay.sandbox_reset_cap_unset': 'PRECONDITION_FAILED',
  'pay.sandbox_reset_cap_reached': 'TOO_MANY_REQUESTS',
  'pay.sandbox_request_conflict': 'CONFLICT',
};

async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof SandboxFundError) {
      throw new TRPCError({ code: STATUS[error.code], message: `[${error.code}] ${error.message}`, cause: error });
    }
    throw error;
  }
}

export function createSandboxFundsRouter(deps: { readonly sql: Sql; readonly settings: SandboxFundSettings }) {
  const store = new SandboxStore(deps.sql, deps.settings);
  const read = scopedProcedure('trade:read', { person: true });
  const write = scopedProcedure('trade:write', { person: true });
  return router({
    sandboxFunds: router({
      balance: mountRecord(
        PAY_SANDBOX_FUNDS_BALANCE,
        ({ ctx, input }) => guarded(() => store.balance({ userId: ctx.principal.userId, sandboxId: input.sandboxId })),
        payRefusal,
      ),
      fund: mountRecord(
        PAY_SANDBOX_FUNDS_FUND,
        ({ ctx, input }) => guarded(() => store.fund({ userId: ctx.principal.userId, sandboxId: input.sandboxId }, input.requestId)),
        payRefusal,
      ),
      reset: mountRecord(
        PAY_SANDBOX_FUNDS_RESET,
        ({ ctx, input }) => guarded(() => store.reset({ userId: ctx.principal.userId, sandboxId: input.sandboxId }, input.requestId)),
        payRefusal,
      ),
    }),
  });
}
