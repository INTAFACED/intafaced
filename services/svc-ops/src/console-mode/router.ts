import { TRPCError } from '@trpc/server';
import { consoleModeSchema, consoleModeSetInputSchema, consoleModeSetOutputSchema, router, scopedProcedure } from '@intafaced/contracts';
import { OpsError } from '../codes.js';
import type { ConsoleModeDesk } from './desk.js';

const guards = { module: 'core-ops' as const, plane: 'fiat' as const };

function deskError(err: unknown): never {
  if (err instanceof OpsError) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: `${err.code} — ${err.message}`, cause: err });
  throw err;
}

/**
 * `consoleMode.get` (`admin:read`): the founder console's maintenance mode in force. `consoleMode.set` (`admin:write`): turn
 * it on with a reason, or off, under a second founder's approval. No storage refuses `ops.console_mode_storage_unconfigured`.
 */
export function createConsoleModeRouter(desk: ConsoleModeDesk) {
  return router({
    get: scopedProcedure('admin:read', guards)
      .output(consoleModeSchema)
      .query(async () => {
        try {
          return await desk.get();
        } catch (err) {
          return deskError(err);
        }
      }),
    set: scopedProcedure('admin:write', guards)
      .input(consoleModeSetInputSchema)
      .output(consoleModeSetOutputSchema)
      .mutation(async ({ ctx, input }) => {
        try {
          return await desk.set(ctx.principal.userId, input);
        } catch (err) {
          return deskError(err);
        }
      }),
  });
}
