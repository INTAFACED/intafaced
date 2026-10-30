/**
 * `handle.get`, `handle.change` and `handle.setDiscoverable` (PP-send-request-03). The signed-in owner's own handle
 * only: the user is the session's, a body never names one. An API key or a sub-account is refused.
 */
import { z } from 'zod';
import { protectedProcedure, router, TRPCError } from '@intafaced/contracts';
import { SecurityLockError } from '../auth/security-lock.js';
import { HandleSettingsError, type HandleActor, type HandleSettingsService } from './handle-settings.js';

const settingsOutput = z.object({
  handle: z.string(),
  discoverable: z.boolean(),
  changesUsed: z.number().int().min(0),
  changeCap: z.number().int().min(1).nullable(),
  changesLeft: z.number().int().min(0).nullable(),
});

type Principal = { userId: string; sid: string; kid?: string | null; sub_account?: string | null };

function actor(principal: Principal): HandleActor {
  return { userId: principal.userId, sessionId: principal.sid, apiKey: Boolean(principal.kid), subAccount: Boolean(principal.sub_account) };
}

function toTrpc(err: unknown): never {
  if (err instanceof TRPCError) throw err;
  if (err instanceof SecurityLockError) {
    throw new TRPCError({ code: 'FORBIDDEN', message: `Your account is security locked [${err.code}]`, cause: err });
  }
  if (err instanceof HandleSettingsError) {
    const code =
      err.code === 'identity.handle_taken' || err.code === 'identity.handle_changed_elsewhere'
        ? 'CONFLICT'
        : err.code === 'identity.delegated_refused' || err.code === 'auth.account_frozen'
          ? 'FORBIDDEN'
          : err.code === 'identity.session_not_live'
            ? 'UNAUTHORIZED'
            : err.code === 'auth.not_found'
              ? 'NOT_FOUND'
              : err.code === 'identity.handle_change_cap_unset' || err.code === 'identity.handle_change_cap_reached'
                ? 'PRECONDITION_FAILED'
                : 'BAD_REQUEST';
    throw new TRPCError({ code, message: err.message, cause: err });
  }
  throw err;
}

export function createHandleRouter(service: HandleSettingsService) {
  return router({
    handle: router({
      /** The caller's own handle, whether people can find them by it, and the changes used and left. */
      get: protectedProcedure.output(settingsOutput).query(async ({ ctx }) => {
        try {
          return await service.get(actor(ctx.principal as Principal));
        } catch (err) {
          toTrpc(err);
        }
      }),

      /** Change the handle from `fromHandle` to `handle`. Rule, cap and taken refusals each carry their own code. */
      change: protectedProcedure
        .input(z.object({ handle: z.string().max(64), fromHandle: z.string().max(64) }).strict())
        .output(settingsOutput)
        .mutation(async ({ ctx, input }) => {
          try {
            return await service.change(actor(ctx.principal as Principal), input);
          } catch (err) {
            toTrpc(err);
          }
        }),

      /** Let people find me by my handle, or not. Off, others' handle lookups answer not found. */
      setDiscoverable: protectedProcedure
        .input(z.object({ discoverable: z.boolean() }).strict())
        .output(settingsOutput)
        .mutation(async ({ ctx, input }) => {
          try {
            return await service.setDiscoverable(actor(ctx.principal as Principal), input.discoverable);
          } catch (err) {
            toTrpc(err);
          }
        }),
    }),
  });
}
