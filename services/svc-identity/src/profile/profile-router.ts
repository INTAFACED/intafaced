/**
 * `profile.get` and `profile.update`, and `profile.antiPhishing.get`/`set`. Customer sessions only.
 * An API key or a sub-account is refused. A body `userId` is ignored.
 */
import { z } from 'zod';
import { antiPhishingCodeSchema, antiPhishingSetResultSchema, protectedProcedure, router, TRPCError } from '@intafaced/contracts';
import { userCopy } from '../user-copy.js';
import { AntiPhishingError, type AntiPhishingService } from './anti-phishing.js';
import { ProfileError, ProfileService, type ProfileRow } from './profile-service.js';

const profileOutput = z.object({
  displayName: z.string().nullable(),
  locale: z.string(),
  region: z.string().nullable(),
  version: z.number().int(),
});

const updateInput = z
  .object({
    displayName: z.string().max(200).optional(),
    locale: z.string().max(35).optional(),
    region: z.string().max(16).optional(),
    ifVersion: z.number().int().min(0).max(1_000_000_000),
    /** Accepted and ignored. The session user is the only account this door writes. */
    userId: z.string().max(80).optional(),
  })
  .strict();

function delegated(principal: { kid?: string | null; sub_account?: string | null }): boolean {
  return Boolean(principal.kid || principal.sub_account);
}

function antiPhishingToTrpc(err: AntiPhishingError): TRPCError {
  const code =
    err.code === 'identity.anti_phishing_delegated'
      ? 'FORBIDDEN'
      : err.code === 'identity.session_not_live'
        ? 'UNAUTHORIZED'
        : err.code === 'auth.not_found'
          ? 'NOT_FOUND'
          : err.code === 'identity.anti_phishing_invalid' ||
              err.code === 'identity.anti_phishing_guessable' ||
              err.code === 'identity.client_request_id_invalid'
            ? 'BAD_REQUEST'
            : 'PRECONDITION_FAILED';
  return new TRPCError({ code, message: `${userCopy(err.code)} [${err.code}]`, cause: err });
}

function toTrpc(err: unknown): never {
  if (err instanceof TRPCError) throw err;
  if (err instanceof AntiPhishingError) throw antiPhishingToTrpc(err);
  if (err instanceof ProfileError) {
    const code =
      err.code === 'identity.profile_version_conflict'
        ? 'CONFLICT'
        : err.code === 'identity.region_change_requires_review' || err.code === 'identity.delegated_refused'
          ? 'FORBIDDEN'
          : err.code === 'identity.profile_missing' || err.code === 'identity.profile_unwired'
            ? 'PRECONDITION_FAILED'
            : 'BAD_REQUEST';
    throw new TRPCError({ code, message: userCopy(err.code), cause: err });
  }
  throw err;
}

type Principal = { userId: string; sid: string; kid?: string | null; sub_account?: string | null };

export function createProfileRouter(profile: ProfileService | undefined, antiPhishing?: AntiPhishingService) {
  const svc = (): ProfileService => {
    if (!profile) throw new ProfileError('identity.profile_unwired');
    return profile;
  };
  const codes = (): AntiPhishingService => {
    if (!antiPhishing) throw new AntiPhishingError('identity.anti_phishing_unavailable');
    return antiPhishing;
  };
  const actor = (principal: Principal) => ({
    userId: principal.userId,
    sessionId: principal.sid,
    apiKey: Boolean(principal.kid),
    subAccount: Boolean(principal.sub_account),
  });

  return router({
    /** The signed-in user's own profile. Region is visible and not editable. */
    get: protectedProcedure.output(profileOutput).query(async ({ ctx }) => {
      try {
        if (delegated(ctx.principal)) throw new ProfileError('identity.delegated_refused');
        return await svc().get(ctx.principal.userId);
      } catch (err) {
        toTrpc(err);
      }
    }),

    /**
     * Change display name and locale. `ifVersion` must be the version from
     * `profile.get`. A stale version returns the current row and writes nothing.
     */
    update: protectedProcedure
      .input(updateInput)
      .output(profileOutput)
      .mutation(async ({ ctx, input }): Promise<ProfileRow> => {
        try {
          if (delegated(ctx.principal)) throw new ProfileError('identity.delegated_refused');
          return await svc().update({
            userId: ctx.principal.userId,
            sessionId: ctx.principal.sid,
            ifVersion: input.ifVersion,
            ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
            ...(input.locale !== undefined ? { locale: input.locale } : {}),
            ...(input.region !== undefined ? { region: input.region } : {}),
          });
        } catch (err) {
          toTrpc(err);
        }
      }),

    antiPhishing: router({
      /** The caller's own code, or null. A live session only; this answer carries nothing else. */
      get: protectedProcedure.output(antiPhishingCodeSchema).query(async ({ ctx }) => {
        try {
          return await codes().read(actor(ctx.principal as Principal));
        } catch (err) {
          toTrpc(err);
        }
      }),

      /** Set the code, or clear it with ''. Needs the step-up `identity.step_up.anti_phishing_set` over this code and request id. */
      set: protectedProcedure
        .input(
          z
            .object({
              // Wide wire bounds only; the service checks the real shape and answers identity.anti_phishing_invalid.
              code: z.string().max(256),
              stepUpApprovalId: z.string().uuid(),
              clientRequestId: z.string().max(256),
            })
            .strict(),
        )
        .output(antiPhishingSetResultSchema)
        .mutation(async ({ ctx, input }) => {
          try {
            return await codes().set({ ...actor(ctx.principal as Principal), ...input });
          } catch (err) {
            toTrpc(err);
          }
        }),
    }),
  });
}
