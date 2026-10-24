import { z } from 'zod';
import { router, scopedProcedure, TRPCError } from '@intafaced/contracts';
import type { AuthService } from './auth/auth-service.js';
import { SecurityStepUpError, toSecurityStepUpTrpc, type SecurityStepUp } from './auth/security-step-up.js';
import { TrustedDeviceError } from './auth/trusted-devices.js';

/** The wire shape of a trusted-device refusal. Also used by the public `auth.device*` doors in router.ts. */
export function trustedDeviceTrpcError(err: TrustedDeviceError): TRPCError {
  const code =
    err.code === 'auth.too_many_attempts'
      ? 'TOO_MANY_REQUESTS'
      : err.code === 'auth.code_invalid' || err.code === 'auth.code_expired' || err.code === 'auth.device_authorisation_invalid'
        ? 'UNAUTHORIZED'
        : err.code === 'auth.device_authorisation_used' || err.code === 'auth.device_authorisation_pending'
          ? 'CONFLICT'
          : err.code === 'identity.device_not_found'
            ? 'NOT_FOUND'
            : err.code === 'auth.device_authorisation_required' ||
                err.code === 'auth.device_not_trusted' ||
                err.code === 'auth.account_frozen'
              ? 'FORBIDDEN'
              : 'PRECONDITION_FAILED';
  return new TRPCError({ code, message: err.message, cause: err });
}

function mapError(err: unknown): never {
  if (err instanceof TrustedDeviceError) throw trustedDeviceTrpcError(err);
  return toSecurityStepUpTrpc(err);
}

/** An API key or a sub-account is not the person at the keyboard: it may not trust or remove a device. */
function refuseDelegated(principal: { kid?: string | null | undefined; sub_account?: string | null | undefined }): void {
  if (principal.kid || principal.sub_account) throw new SecurityStepUpError('identity.delegated_refused');
}

const iso = z.string().datetime({ offset: true });

/**
 * Top-level `trustedDevices` (I-signin-sessions-07). `list` answers this account's trusted devices, whether the owner
 * turned the new-device check on, and the sign-ins waiting for approval. `approve` lets a session on a trusted device
 * approve one waiting sign-in of the same account; `remove` stops trusting a device and ends the sessions signed in on
 * it. Both spend a step-up approval first.
 */
export function createTrustedDevicesRouter(auth: AuthService, stepUp: SecurityStepUp) {
  return router({
    trustedDevices: router({
      list: scopedProcedure('identity:read')
        .output(
          z
            .object({
              check: z.enum(['on', 'off']),
              devices: z.array(
                z
                  .object({
                    id: z.string().guid(),
                    label: z.string(),
                    firstSeenAt: iso,
                    lastSeenAt: iso,
                    trustedUntil: iso.nullable(),
                    current: z.boolean(),
                  })
                  .strict(),
              ),
              waiting: z.array(z.object({ flowId: z.string().guid(), label: z.string(), createdAt: iso, expiresAt: iso }).strict()),
            })
            .strict(),
        )
        .query(async ({ ctx }) => {
          try {
            const [devices, waiting] = await Promise.all([
              auth.trustedDevices(ctx.principal.userId, ctx.principal.sid ?? null),
              auth.pendingDeviceAuthorisations(ctx.principal.userId),
            ]);
            return {
              check: auth.newDeviceCheckOn() ? ('on' as const) : ('off' as const),
              devices: devices.map((d) => ({
                id: d.id,
                label: d.label,
                firstSeenAt: d.firstSeenAt.toISOString(),
                lastSeenAt: d.lastSeenAt.toISOString(),
                trustedUntil: d.trustedUntil ? d.trustedUntil.toISOString() : null,
                current: d.current,
              })),
              waiting: waiting.map((w) => ({
                flowId: w.flowId,
                label: w.label,
                createdAt: w.createdAt.toISOString(),
                expiresAt: w.expiresAt.toISOString(),
              })),
            };
          } catch (err) {
            return mapError(err);
          }
        }),
      approve: scopedProcedure('identity:write')
        .input(z.object({ flowId: z.string().guid(), stepUpApprovalId: z.string().min(1).max(128).nullish() }).strict())
        .output(z.object({ approved: z.literal(true) }).strict())
        .mutation(async ({ ctx, input }) => {
          try {
            refuseDelegated(ctx.principal);
            if (!ctx.principal.sid)
              throw new TrustedDeviceError('Approve new devices from a device that is already trusted.', 'auth.device_not_trusted');
            await stepUp.require(
              ctx.principal,
              'identity.step_up.trusted_device_approve',
              { flowId: input.flowId },
              input.stepUpApprovalId,
            );
            await auth.deviceApproveFromSession({ flowId: input.flowId, userId: ctx.principal.userId, sessionId: ctx.principal.sid });
            return { approved: true as const };
          } catch (err) {
            return mapError(err);
          }
        }),
      remove: scopedProcedure('identity:write')
        .input(
          z
            .object({
              deviceId: z.string().guid(),
              clientRequestId: z.string().min(1).max(128),
              stepUpApprovalId: z.string().min(1).max(128).nullish(),
            })
            .strict(),
        )
        .output(z.object({ removed: z.boolean(), sessionsEnded: z.number().int().nonnegative() }).strict())
        .mutation(async ({ ctx, input }) => {
          try {
            refuseDelegated(ctx.principal);
            await stepUp.require(
              ctx.principal,
              'identity.step_up.trusted_device_remove',
              { deviceId: input.deviceId, clientRequestId: input.clientRequestId },
              input.stepUpApprovalId,
            );
            return await auth.removeTrustedDevice(ctx.principal.userId, input.deviceId);
          } catch (err) {
            return mapError(err);
          }
        }),
    }),
  });
}
