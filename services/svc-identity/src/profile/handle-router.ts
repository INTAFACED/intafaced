/**
 * `handle.get`, `handle.change` and `handle.setDiscoverable` (PP-send-request-03). The signed-in owner's own handle
 * only: the user is the session's, a body never names one. An API key or a sub-account is refused.
 */
import { router, TRPCError } from '@intafaced/contracts/trpc';
import { SecurityLockError } from '../auth/security-lock.js';
import { HandleSettingsError, type HandleActor, type HandleSettingsService } from './handle-settings.js';
import {
  IDENTITY_HANDLE_GET,
  IDENTITY_HANDLE_CHANGE,
  IDENTITY_HANDLE_SET_DISCOVERABLE,
} from '@intafaced/contracts/identity-handle-procedures';
import { mountRecord } from '@intafaced/contracts/procedure-mount';
import { codedRefusal } from '../record-refusal.js';

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
      get: mountRecord(
        IDENTITY_HANDLE_GET,
        async ({ ctx }) => {
          try {
            return await service.get(actor(ctx.principal as Principal));
          } catch (err) {
            toTrpc(err);
          }
        },
        codedRefusal,
      ),

      /** Change the handle from `fromHandle` to `handle`. Rule, cap and taken refusals each carry their own code. */
      change: mountRecord(
        IDENTITY_HANDLE_CHANGE,
        async ({ ctx, input }) => {
          try {
            return await service.change(actor(ctx.principal as Principal), input);
          } catch (err) {
            toTrpc(err);
          }
        },
        codedRefusal,
      ),

      /** Let people find me by my handle, or not. Off, others' handle lookups answer not found. */
      setDiscoverable: mountRecord(
        IDENTITY_HANDLE_SET_DISCOVERABLE,
        async ({ ctx, input }) => {
          try {
            return await service.setDiscoverable(actor(ctx.principal as Principal), input.discoverable);
          } catch (err) {
            toTrpc(err);
          }
        },
        codedRefusal,
      ),
    }),
  });
}
