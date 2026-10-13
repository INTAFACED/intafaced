import { router, protectedProcedure, accountControlResultSchema } from '@intafaced/contracts';
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
