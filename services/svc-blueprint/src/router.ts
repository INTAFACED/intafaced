import { z } from 'zod';
import { router, publicProcedure, scopedProcedure, TRPCError } from '@intafaced/contracts';
import {
  blueprintExportSchema,
  blueprintSchema,
  cardInput,
  cardOfInput,
  cardOpenerSchema,
  cardRenderSchema,
  cardShareSchema,
  createShareInput,
  eraseReceiptSchema,
  mentorMatchSchema,
  onboardInput,
  onboardOutput,
  setVisibilityInput,
  shareIdInput,
} from '@intafaced/contracts';
import { AttestationSurfaceError } from './attestations/zero-pii.js';
import { BlueprintError, type BlueprintService } from './blueprint-service.js';

/**
 * svc-blueprint's API (§7.1, §7.2).
 *
 * The contract shape lives in `packages/contracts` — this implements it.
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

export function createBlueprintRouter(blueprint: BlueprintService) {
  return router({
    health: publicProcedure
      .output(z.object({ ok: z.boolean(), service: z.literal('svc-blueprint') }))
      .query(() => ({ ok: true, service: 'svc-blueprint' as const })),

    /**
     * Run the Blueprint session (§7.1).
     *
     * The input carries the session's answers and, optionally, birth data. Both
     * are forwarded to the Neural Engine and then dropped — nothing on this
     * path persists them (§10).
     */
    onboard: scopedProcedure('blueprint:write', { module: 'blueprint' })
      .input(onboardInput.omit({ userId: true }))
      .output(onboardOutput)
      .mutation(async ({ ctx, input }) => {
        try {
          return await blueprint.onboard({ ...input, userId: ctx.principal.userId });
        } catch (err) {
          throw toTrpcError(err);
        }
      }),

    /** The caller's own Blueprint. */
    me: scopedProcedure('blueprint:read', { module: 'blueprint' })
      .output(blueprintSchema.nullable())
      .query(({ ctx }) => blueprint.get({ userId: ctx.principal.userId })),

    /**
     * The caller's own share card (§7.1, §7.2). Always allowed for the owner,
     * including when visibility is `private`. `cardOf` is the other-user path.
     *
     * Still not a public unauthenticated URL — walking that back later would
     * break embedded unfurls. Authenticated + visibility is the reversible
     * direction; OG/share tokens stay ops.social-promotion / Class X.
     */
    card: scopedProcedure('blueprint:read', { module: 'blueprint' })
      .input(cardInput)
      .output(cardRenderSchema)
      .query(async ({ ctx, input }) => {
        try {
          return await blueprint.card({ userId: ctx.principal.userId, size: input.size });
        } catch (err) {
          throw toTrpcError(err);
        }
      }),

    /**
     * Someone else's share card, gated by `blueprints.visibility`.
     *
     * `userId` is the subject. The viewer is the signed principal — a forged
     * header still cannot pick the viewer. Denied and missing are the same
     * `NOT_FOUND`, so private Blueprints are not enumerable by id.
     */
    cardOf: scopedProcedure('blueprint:read', { module: 'blueprint' })
      .input(cardOfInput)
      .output(cardRenderSchema)
      .query(async ({ ctx, input }) => {
        try {
          return await blueprint.cardFor({
            viewerId: ctx.principal.userId,
            ...(input.userId ? { subjectUserId: input.userId } : {}),
            ...(input.shareId ? { shareId: input.shareId } : {}),
            size: input.size,
          });
        } catch (err) {
          throw toTrpcError(err);
        }
      }),

    /**
     * Shares of the caller's own cards (MC-blueprint-01). The account is the
     * signed principal. A share id from the body is only the row to revoke or
     * to list; it never chooses whose shares are created.
     */
    shares: router({
      create: scopedProcedure('blueprint:write', { module: 'blueprint' })
        .input(createShareInput)
        .output(cardShareSchema)
        .mutation(async ({ ctx, input }) => {
          try {
            return await blueprint.createShare({ userId: ctx.principal.userId, size: input.size });
          } catch (err) {
            throw toTrpcError(err);
          }
        }),

      list: scopedProcedure('blueprint:read', { module: 'blueprint' })
        .output(z.array(cardShareSchema))
        .query(async ({ ctx }) => {
          try {
            return await blueprint.listShares({ userId: ctx.principal.userId });
          } catch (err) {
            throw toTrpcError(err);
          }
        }),

      revoke: scopedProcedure('blueprint:write', { module: 'blueprint' })
        .input(shareIdInput)
        .output(cardShareSchema)
        .mutation(async ({ ctx, input }) => {
          try {
            return await blueprint.revokeShare({ userId: ctx.principal.userId, shareId: input.shareId });
          } catch (err) {
            throw toTrpcError(err);
          }
        }),

      openers: scopedProcedure('blueprint:read', { module: 'blueprint' })
        .input(shareIdInput)
        .output(z.array(cardOpenerSchema))
        .query(async ({ ctx, input }) => {
          try {
            return await blueprint.shareOpeners({ userId: ctx.principal.userId, shareId: input.shareId });
          } catch (err) {
            throw toTrpcError(err);
          }
        }),
    }),

    setVisibility: scopedProcedure('blueprint:write', { module: 'blueprint' })
      .input(setVisibilityInput.omit({ userId: true }))
      .output(blueprintSchema)
      .mutation(async ({ ctx, input }) => {
        try {
          return await blueprint.setVisibility({ userId: ctx.principal.userId, visibility: input.visibility });
        } catch (err) {
          throw toTrpcError(err);
        }
      }),

    /**
     * The caller's mentor shortlist.
     *
     * Reads the shortlist directly. It used to pluck `mentorMatches` off
     * `export()`, which was merely wasteful until the card joined the export —
     * at which point a shortlist request would compose an SVG and call an
     * external rasterizer, and could stall behind that renderer's timeout.
     */
    mentors: scopedProcedure('blueprint:read', { module: 'blueprint' })
      .output(z.array(mentorMatchSchema))
      .query(({ ctx }) => blueprint.mentors({ userId: ctx.principal.userId })),

    /**
     * §7.2 ownership — portable. Everything this service holds about the
     * caller, as JSON, in one response.
     */
    export: scopedProcedure('blueprint:read', { module: 'blueprint' })
      .output(blueprintExportSchema)
      .query(({ ctx }) => blueprint.export({ userId: ctx.principal.userId })),

    /**
     * §7.2 ownership — deletable. A hard delete that cascades; see the method's
     * comment for what "cascades" is doing.
     *
     * `blueprint:write` and nothing more. It is tempting to gate erasure behind
     * 2FA, but that would mean an account whose second factor is lost can never
     * be erased — turning a user's right to delete into a support ticket.
     */
    erase: scopedProcedure('blueprint:write', { module: 'blueprint' })
      .output(eraseReceiptSchema)
      .mutation(async ({ ctx }) => {
        try {
          return await blueprint.erase({ userId: ctx.principal.userId });
        } catch (err) {
          throw toTrpcError(err);
        }
      }),
  });
}

export type BlueprintRouter = ReturnType<typeof createBlueprintRouter>;
