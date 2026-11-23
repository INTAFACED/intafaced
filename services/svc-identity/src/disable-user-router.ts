import { accountControlResultSchema } from '@intafaced/contracts/account-controls';
import { router, protectedProcedure } from '@intafaced/contracts/trpc';
import { callFounderControl, identityFreezeInputSchema, type FounderControlsPort } from './controls/founder-controls-router.js';

/** Legacy name, same founder transaction; old reasonless bodies refuse. */
export function createDisableUserRouter(controls: Pick<FounderControlsPort, 'change'>) {
  return router({
    disableUser: protectedProcedure
      .input(identityFreezeInputSchema)
      .output(accountControlResultSchema)
      .mutation(({ ctx, input }) => callFounderControl(controls, ctx, input)),
  });
}
