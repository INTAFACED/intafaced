import { TRPCError } from '@trpc/server';
import type { Context } from '@intafaced/contracts';
import { mountRecords, type RefusalOf } from '@intafaced/contracts/procedure-mount';
import { BLUEPRINT_PROCEDURES } from '@intafaced/contracts/blueprint-procedures';
import { AttestationSurfaceError } from './attestations/zero-pii.js';
import { BlueprintError, type BlueprintService } from './blueprint-service.js';

/**
 * svc-blueprint's API (§7.1, §7.2).
 *
 * Mounted from its records (`@intafaced/contracts/blueprint-procedures`): this file holds only the handlers.
 *
 * ── Authorisation, stated once ──────────────────────────────────────────────
 * Every owner procedure operates on `ctx.principal.userId` and never on a
 * userId from the input. There is deliberately no "onboard this other person"
 * or "erase that account" path: a Blueprint is the most personal object in the
 * OS and an export endpoint that takes an arbitrary id is a data-exfiltration
 * endpoint with extra steps. Operator access, when it is specced, goes through
 * apps/admin with `admin:compliance` and an audit trail — not through here.
 *
 * The one exception is `cardOf`: the input names whose *share card* to read,
 * and the viewer is still the signed principal. `blueprints.visibility` decides
 * whether that read succeeds. Profile / export / erase stay self-only.
 *
 * `blueprint` is non-custodial and `minTier: 'none'` in the jurisdiction matrix
 * (packages/config), so the guard's job is scope and region, not verification.
 */

function toTrpcError(err: unknown): TRPCError {
  if (err instanceof AttestationSurfaceError) {
    return new TRPCError({ code: 'BAD_REQUEST', message: err.message, cause: err });
  }
  if (!(err instanceof BlueprintError)) {
    return new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Request failed', cause: err });
  }

  switch (err.code) {
    case 'blueprint.engine_unavailable':
      // 503, not 500: the Neural Engine is a dependency that can be down, and
      // the client should retry rather than treat it as a bug in the request.
      return new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'The Neural Engine is unavailable', cause: err });
    case 'blueprint.engine_protocol':
    case 'blueprint.invalid_profile':
      return new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'The Neural Engine returned an unusable profile', cause: err });
    case 'blueprint.crew_full':
      return new TRPCError({ code: 'CONFLICT', message: 'That crew is full', cause: err });
    case 'blueprint.crew_not_found':
    case 'blueprint.not_found':
      return new TRPCError({ code: 'NOT_FOUND', message: err.message, cause: err });
    case 'blueprint.crew_capacity_unset':
    case 'blueprint.mentor_shortlist_unset':
    case 'blueprint.season_unset':
    case 'blueprint.share_limit_unset':
    case 'blueprint.opens_list_limit_unset':
      return new TRPCError({ code: 'PRECONDITION_FAILED', message: err.message, cause: err });
    case 'blueprint.share_limit_reached':
      return new TRPCError({ code: 'CONFLICT', message: err.message, cause: err });
    case 'blueprint.open_log_unavailable':
      return new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: err.message, cause: err });
  }
}

/** svc-blueprint's one refusal reader, in its wire form (`toTrpcError`). A TRPCError a handler already shaped passes as it is. */
const blueprintRefusal: RefusalOf = (err) =>
  err instanceof TRPCError
    ? undefined
    : {
        code: err instanceof BlueprintError || err instanceof AttestationSurfaceError ? err.code : 'blueprint.request_failed',
        error: toTrpcError(err),
      };

/**
 * `me`, `mentors` and `export` never mapped their errors: whatever they throw is sent as INTERNAL_SERVER_ERROR with its
 * own message, as tRPC sends an unknown error. Kept as it is, bug included, so the wire does not move with the mount.
 */
const unmapped =
  <T>(read: () => Promise<T>) =>
  async (): Promise<T> => {
    try {
      return await read();
    } catch (err) {
      if (err instanceof TRPCError) throw err;
      throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', cause: err });
    }
  };

/** The signed caller. Every record here is scope-guarded, so the guard has already refused a call without one. */
function userOf({ principal }: Context): string {
  if (!principal) throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Not signed in' });
  return principal.userId;
}

export function createBlueprintRouter(blueprint: BlueprintService) {
  return mountRecords(
    BLUEPRINT_PROCEDURES,
    {
      'blueprint.health': () => ({ ok: true, service: 'svc-blueprint' as const }),
      'blueprint.onboard': ({ ctx, input }) => blueprint.onboard({ ...input, userId: userOf(ctx) }),
      'blueprint.me': ({ ctx }) => unmapped(() => blueprint.get({ userId: userOf(ctx) }))(),
      'blueprint.card': ({ ctx, input }) => blueprint.card({ userId: userOf(ctx), size: input.size }),
      /** The viewer is the signed principal; the input names only whose card, so a forged header cannot pick the viewer. */
      'blueprint.cardOf': ({ ctx, input }) =>
        blueprint.cardFor({
          viewerId: userOf(ctx),
          ...(input.userId ? { subjectUserId: input.userId } : {}),
          ...(input.shareId ? { shareId: input.shareId } : {}),
          size: input.size,
        }),
      'blueprint.shares.create': ({ ctx, input }) => blueprint.createShare({ userId: userOf(ctx), size: input.size }),
      'blueprint.shares.list': ({ ctx }) => blueprint.listShares({ userId: userOf(ctx) }),
      'blueprint.shares.revoke': ({ ctx, input }) => blueprint.revokeShare({ userId: userOf(ctx), shareId: input.shareId }),
      'blueprint.shares.openers': ({ ctx, input }) => blueprint.shareOpeners({ userId: userOf(ctx), shareId: input.shareId }),
      'blueprint.setVisibility': ({ ctx, input }) => blueprint.setVisibility({ userId: userOf(ctx), visibility: input.visibility }),
      'blueprint.mentors': ({ ctx }) => unmapped(() => blueprint.mentors({ userId: userOf(ctx) }))(),
      'blueprint.export': ({ ctx }) => unmapped(() => blueprint.export({ userId: userOf(ctx) }))(),
      'blueprint.erase': ({ ctx }) => blueprint.erase({ userId: userOf(ctx) }),
    },
    blueprintRefusal,
  );
}

export type BlueprintRouter = ReturnType<typeof createBlueprintRouter>;
