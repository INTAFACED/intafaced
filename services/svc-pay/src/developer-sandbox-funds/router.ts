import { TRPCError, router, scopedProcedure } from '@intafaced/contracts';
import { sandboxFundInputSchema, sandboxFundOutputSchema, type SandboxFundRefusal } from '@intafaced/contracts/developer-sandboxes';

/**
 * Sandbox test funds (DV-sandbox-02, J-developer-02 #4), pay's part of a developer sandbox.
 *
 * Where a sandbox's TEST balances live is the owner's decision (the sandbox store). Until it is made, every fund
 * refuses `pay.sandbox_funds_unset` and nothing is written: no ledger call, no table. The sandbox itself belongs to
 * svc-identity, whose tables pay never reads; because the answer is the same refusal for every sandbox id, it says
 * nothing about whose sandbox an id is. When the store exists, this door asks identity for ownership first.
 */
export class SandboxFundError extends Error {
  constructor(
    message: string,
    readonly code: SandboxFundRefusal,
  ) {
    super(message);
    this.name = 'SandboxFundError';
  }
}

export function createSandboxFundsRouter() {
  return router({
    sandboxFunds: router({
      fund: scopedProcedure('trade:write', { person: true })
        .input(sandboxFundInputSchema)
        .output(sandboxFundOutputSchema)
        .mutation((): never => {
          const cause = new SandboxFundError(
            "Sandbox test funds wait for the owner's decision on where sandbox balances are kept",
            'pay.sandbox_funds_unset',
          );
          throw new TRPCError({ code: 'PRECONDITION_FAILED', message: `[${cause.code}] ${cause.message}`, cause });
        }),
    }),
  });
}
