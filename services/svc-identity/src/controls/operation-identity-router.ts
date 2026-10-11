import {
  identityOperationDecisionInputSchema,
  identityOperationDecisionSchema,
  router,
  serviceProcedure,
  TRPCError,
} from '@intafaced/contracts';
import type { OperationIdentityDecisions } from './operation-identity-decisions.js';

export function createOperationIdentityRouter(decisions: Pick<OperationIdentityDecisions, 'decide'>) {
  return router({
    operationAdmission: router({
      decide: serviceProcedure
        .input(identityOperationDecisionInputSchema)
        .output(identityOperationDecisionSchema)
        .mutation(({ ctx, input }) => {
          if (ctx.service !== input.intent.operation.service)
            throw new TRPCError({ code: 'FORBIDDEN', message: 'identity.operation_owner_denied' });
          return decisions.decide(input, ctx.service);
        }),
    }),
  });
}
