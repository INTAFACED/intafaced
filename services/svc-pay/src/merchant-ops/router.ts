import type { Sql } from 'postgres';
import { z } from 'zod';
import { router, scopedProcedure } from '@intafaced/contracts';
import { defaultDisputeCaseStore, type DisputeCaseStore } from '../fraud/dispute-case.js';
import type { FounderAuthority } from '../founder-authority.js';
import { founderProcedure } from '../namespaces/founder-procedure.js';
import { CustomerDirectory } from './customers.js';
import { DisputeOpsService, EVIDENCE_KINDS } from './disputes.js';
import { MerchantOpsError, wrapOps } from './errors.js';
import { EXPORT_KINDS, ExportService, type ExportDeps } from './exports.js';
import { MerchantKybView } from './kyb.js';
import { NOTIFICATION_KINDS, NotificationService } from './notifications.js';
import { OperatorNotes } from './notes.js';
import { cursorInput, limitInput } from './pagination.js';
import { resolveMerchantCaller, TEAM_ROLES } from './roles.js';
import { TeamService } from './team.js';

/**
 * `merchantOps.*`   - the merchant's own operations pages (W15). Scoped to the
 *                     caller's merchant, which is resolved from the signed
 *                     principal and never accepted from the request body.
 * `founderAdmin.ops.*` - operator-only notes. Built from `founderProcedure`
 *                     (never `admin:read`); see namespaces/founder-procedure.ts.
 *
 * Every procedure refuses another merchant's ids with the same answer as an id
 * that does not exist (M1), lists only the caller's rows (M2), and checks the
 * caller's team role on top of the session scope.
 */
export interface MerchantOpsDeps {
  /** The pay database. Absent = every merchantOps procedure refuses `pay.merchant_ops_unavailable`. */
  readonly sql?: Sql;
  readonly founderAuthority: FounderAuthority;
  /** Defaults to the process-wide dispute case store the fraud code already uses. */
  readonly disputes?: DisputeCaseStore;
  readonly exports?: ExportDeps;
  /**
   * How a freshly queued export gets generated. Default: run it in this process
   * on the next tick. Tests pass a no-op and drive `processQueued` themselves.
   */
  readonly exportKick?: (jobId: string, run: () => Promise<boolean>) => void;
}

const id = z.string().uuid();
const iso = z.string().datetime({ offset: true });
const assetIdIn = z.string().trim().min(1).max(32);
const note = z.string().trim().min(1).max(2000);

function makeParts(deps: MerchantOpsDeps) {
  const sql = deps.sql;
  const parts = sql
    ? {
        sql,
        team: new TeamService(sql),
        disputes: new DisputeOpsService(sql, deps.disputes ?? defaultDisputeCaseStore),
        customers: new CustomerDirectory(sql),
        kyb: new MerchantKybView(sql),
        exports: new ExportService(sql, deps.exports),
        notifications: new NotificationService(sql),
        notes: new OperatorNotes(sql),
      }
    : null;
  /** Without a database every procedure refuses closed; none answers empty. */
  const need = () => {
    if (!parts) throw new MerchantOpsError('pay.merchant_ops_unavailable', 'unavailable');
    return parts;
  };
  return { need };
}

export function createMerchantOpsRouter(deps: MerchantOpsDeps) {
  const read = scopedProcedure('pay:read', { module: 'pay' });
  const write = scopedProcedure('pay:write', { module: 'pay' });
  const { need } = makeParts(deps);
  const kick =
    deps.exportKick ??
    ((_jobId: string, run: () => Promise<boolean>) => {
      setImmediate(() => void run().catch(() => undefined));
    });

  /** Resolve once per call: the merchant and role of whoever is calling. */
  const callerOf = (ctx: { principal: { userId: string; kid?: string | undefined } }) => resolveMerchantCaller(need().sql, ctx.principal);
  return router({
    merchantOps: router({
      disputes: router({
        list: read
          .input(
            z.object({
              limit: limitInput,
              cursor: cursorInput,
              status: z.enum(['open', 'contested', 'accepted', 'won', 'lost']).optional(),
              paymentId: id.optional(),
            }),
          )
          .query(({ ctx, input }) => wrapOps(async () => need().disputes.list(await callerOf(ctx), input))),
        summary: read.input(z.object({}).strict()).query(({ ctx }) => wrapOps(async () => need().disputes.summary(await callerOf(ctx)))),
        get: read
          .input(z.object({ disputeId: z.string().trim().min(1).max(200) }))
          .query(({ ctx, input }) => wrapOps(async () => need().disputes.get(await callerOf(ctx), input.disputeId))),
        addEvidence: write
          .input(
            z.object({
              disputeId: z.string().trim().min(1).max(200),
              kind: z.enum(EVIDENCE_KINDS),
              fileName: z.string().trim().min(1).max(255),
              contentType: z.string().trim().min(1).max(127),
              sizeBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
              sha256: z.string().regex(/^[0-9a-fA-F]{64}$/),
              note: note.optional(),
            }),
          )
          .mutation(({ ctx, input }) => wrapOps(async () => need().disputes.addEvidence(await callerOf(ctx), input))),
        respond: write
          .input(
            z.object({
              requestId: id,
              disputeId: z.string().trim().min(1).max(200),
              action: z.enum(['contest', 'accept_liability']),
              note: note.optional(),
            }),
          )
          .mutation(({ ctx, input }) => wrapOps(async () => need().disputes.respond(await callerOf(ctx), input))),
      }),

      customers: router({
        list: read
          .input(
            z.object({
              limit: limitInput,
              cursor: cursorInput,
              search: z.string().trim().min(1).max(200).optional(),
              seenAfter: iso.optional(),
              seenBefore: iso.optional(),
            }),
          )
          .query(({ ctx, input }) => wrapOps(async () => need().customers.list(await callerOf(ctx), input))),
        summary: read
          .input(z.object({ activeSince: iso }))
          .query(({ ctx, input }) => wrapOps(async () => need().customers.summary(await callerOf(ctx), input))),
        get: read
          .input(z.object({ customerRef: z.string().trim().min(1).max(200), recentPaymentsLimit: limitInput }))
          .query(({ ctx, input }) => wrapOps(async () => need().customers.get(await callerOf(ctx), input))),
      }),

      team: router({
        list: read
          .input(z.object({ limit: limitInput, cursor: cursorInput, status: z.enum(['active', 'invited', 'removed']).optional() }))
          .query(({ ctx, input }) => wrapOps(async () => need().team.list(await callerOf(ctx), input))),
        history: read
          .input(z.object({ limit: limitInput, cursor: cursorInput }))
          .query(({ ctx, input }) => wrapOps(async () => need().team.history(await callerOf(ctx), input))),
        /** Which role the caller holds, so the portal can hide what they cannot do. */
        me: read
          .input(z.object({}).strict())
          .query(({ ctx }) => wrapOps(async () => {
            const c = await callerOf(ctx);
            return { merchantId: c.merchantId, userId: c.userId, role: c.role };
          })),
        invite: write
          .input(z.object({ userId: z.string().trim().min(1).max(128), role: z.enum(TEAM_ROLES), label: z.string().trim().min(1).max(120).optional() }))
          .mutation(({ ctx, input }) => wrapOps(async () => need().team.invite(await callerOf(ctx), input))),
        changeRole: write
          .input(z.object({ memberId: id, role: z.enum(TEAM_ROLES) }))
          .mutation(({ ctx, input }) => wrapOps(async () => need().team.changeRole(await callerOf(ctx), input))),
        remove: write
          .input(z.object({ memberId: id }))
          .mutation(({ ctx, input }) => wrapOps(async () => need().team.remove(await callerOf(ctx), input))),
        leave: write
          .input(z.object({}).strict())
          .mutation(({ ctx }) => wrapOps(async () => need().team.leave(await callerOf(ctx)))),
        myInvitations: read
          .input(z.object({}).strict())
          .query(({ ctx }) => wrapOps(async () => need().team.myInvitations(ctx.principal.userId))),
        acceptInvite: write
          .input(z.object({ memberId: id }))
          .mutation(({ ctx, input }) => wrapOps(async () => {
            if (ctx.principal.kid !== undefined) throw new MerchantOpsError('pay.team_interactive_only', 'forbidden');
            return need().team.acceptInvite(ctx.principal.userId, input.memberId);
          })),
        declineInvite: write
          .input(z.object({ memberId: id }))
          .mutation(({ ctx, input }) => wrapOps(async () => {
            if (ctx.principal.kid !== undefined) throw new MerchantOpsError('pay.team_interactive_only', 'forbidden');
            return need().team.declineInvite(ctx.principal.userId, input.memberId);
          })),
      }),

      kyb: router({
        current: read.input(z.object({}).strict()).query(({ ctx }) => wrapOps(async () => need().kyb.current(await callerOf(ctx)))),
        history: read
          .input(z.object({ limit: limitInput, cursor: cursorInput }))
          .query(({ ctx, input }) => wrapOps(async () => need().kyb.history(await callerOf(ctx), input))),
      }),

      exports: router({
        create: write
          .input(
            z.object({
              requestId: id,
              kind: z.enum(EXPORT_KINDS),
              filters: z
                .object({ from: iso.optional(), to: iso.optional(), status: z.string().max(32).optional(), assetId: assetIdIn.optional() })
                .strict()
                .default({}),
            }),
          )
          .mutation(({ ctx, input }) =>
            wrapOps(async () => {
              const p = need();
              const result = await p.exports.create(await callerOf(ctx), input);
              if (result.created) kick(result.job.jobId, () => p.exports.process(result.job.jobId));
              return result.job;
            }),
          ),
        list: read
          .input(
            z.object({
              limit: limitInput,
              cursor: cursorInput,
              kind: z.enum(EXPORT_KINDS).optional(),
              status: z.enum(['queued', 'running', 'ready', 'failed']).optional(),
            }),
          )
          .query(({ ctx, input }) => wrapOps(async () => need().exports.list(await callerOf(ctx), input))),
        get: read
          .input(z.object({ jobId: id }))
          .query(({ ctx, input }) => wrapOps(async () => need().exports.get(await callerOf(ctx), input.jobId))),
        download: read
          .input(z.object({ jobId: id }))
          .query(({ ctx, input }) => wrapOps(async () => need().exports.download(await callerOf(ctx), input.jobId))),
      }),

      notifications: router({
        list: read
          .input(z.object({ limit: limitInput, cursor: cursorInput, unreadOnly: z.boolean().optional(), kind: z.enum(NOTIFICATION_KINDS).optional() }))
          .query(({ ctx, input }) => wrapOps(async () => need().notifications.list(await callerOf(ctx), input))),
        unreadCount: read
          .input(z.object({}).strict())
          .query(({ ctx }) => wrapOps(async () => need().notifications.unreadCount(await callerOf(ctx)))),
        markRead: write
          .input(z.object({ notificationIds: z.array(id).min(1).max(200) }))
          .mutation(({ ctx, input }) => wrapOps(async () => need().notifications.markRead(await callerOf(ctx), input.notificationIds))),
        markAllRead: write
          .input(z.object({}).strict())
          .mutation(({ ctx }) => wrapOps(async () => need().notifications.markAllRead(await callerOf(ctx)))),
        preferences: router({
          list: read
            .input(z.object({}).strict())
            .query(({ ctx }) => wrapOps(async () => need().notifications.preferences(await callerOf(ctx)))),
          set: write
            .input(
              z.object({
                kind: z.enum(NOTIFICATION_KINDS),
                inApp: z.boolean(),
                threshold: z.string().regex(/^[0-9]+(\.[0-9]{1,18})?$/).nullish(),
              }),
            )
            .mutation(({ ctx, input }) => wrapOps(async () => need().notifications.setPreference(await callerOf(ctx), input))),
        }),
      }),
    }),
  });
}
export type MerchantOpsRouter = ReturnType<typeof createMerchantOpsRouter>;

/**
 * The subtree mounted at `founderAdmin.ops` (see namespaces/founder-admin.ts).
 * tRPC cannot merge two routers that both define `founderAdmin`, so the notes
 * are handed to the founder-admin router to mount, not merged beside it.
 */
export function createFounderOpsRouter(deps: MerchantOpsDeps) {
  const founder = founderProcedure(deps.founderAuthority);
  const { need } = makeParts(deps);
  const founderIdOf = (ctx: unknown): string => {
    const value = (ctx as { founderUserId?: unknown }).founderUserId;
    if (typeof value !== 'string' || value.length === 0) throw new MerchantOpsError('pay.founder_authority_missing', 'forbidden');
    return value;
  };

  return router({
    notes: router({
      add: founder
        .input(
          z.object({
            merchantId: id,
            body: z.string().trim().min(1).max(4000),
            tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
            flagged: z.boolean().default(false),
          }),
        )
        .mutation(({ ctx, input }) => wrapOps(async () => need().notes.add(founderIdOf(ctx), input))),
      list: founder
        .input(
          z.object({
            merchantId: id,
            limit: limitInput,
            cursor: cursorInput,
            flaggedOnly: z.boolean().optional(),
            includeRetracted: z.boolean().optional(),
          }),
        )
        .query(({ input }) => wrapOps(async () => need().notes.list(input))),
      retract: founder
        .input(z.object({ noteId: id, reason: z.string().trim().min(3).max(500) }))
        .mutation(({ ctx, input }) => wrapOps(async () => need().notes.retract(founderIdOf(ctx), input))),
    }),
  });
}
export type FounderOpsRouter = ReturnType<typeof createFounderOpsRouter>;

