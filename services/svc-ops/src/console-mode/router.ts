import { TRPCError } from '@trpc/server';
import { router } from '@intafaced/contracts/trpc';
import { OpsError } from '../codes.js';
import type { ConsoleModeDesk } from './desk.js';
import { OPS_CONSOLE_MODE_GET, OPS_CONSOLE_MODE_SET } from '@intafaced/contracts/ops-console-mode-procedures';
import { mountRecord } from '@intafaced/contracts/procedure-mount';
import { opsRefusal } from '../record-refusal.js';

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
    get: mountRecord(
      OPS_CONSOLE_MODE_GET,
      async () => {
        try {
          return await desk.get();
        } catch (err) {
          return deskError(err);
        }
      },
      opsRefusal,
    ),
    set: mountRecord(
      OPS_CONSOLE_MODE_SET,
      async ({ ctx, input }) => {
        try {
          return await desk.set(ctx.principal.userId, input);
        } catch (err) {
          return deskError(err);
        }
      },
      opsRefusal,
    ),
  });
}
