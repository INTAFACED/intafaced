import {
  QUANT_GRANT_INVALID,
  QUANT_PAPER_MANUAL_ORDER_UNSUPPORTED,
  QUANT_PERMISSION_DENIED,
  QUANT_RUN_IMMUTABLE,
  QUANT_RUN_NOT_FOUND,
  QUANT_TEAM_MEMBER_INVALID,
  QUANT_VERSION_NOT_FOUND,
  QuantError,
} from '../errors.js';
import {
  QUANT_PAPER_LIST_MAX,
  QUANT_SUPPORT_GRANT_MAX_SECONDS,
  QUANT_SUPPORT_GRANT_MIN_SECONDS,
  publicJurisdictionProcedure,
  quantEditLockSchema,
  quantPaperListSchema,
  quantPaperRunSchema,
  quantSharedListSchema,
  quantSharedOpenSchema,
  quantSupportGrantInputSchema,
  quantTeamRemoveInputSchema,
  quantTeamSaveInputSchema,
  quantTeamSchema,
  quantTeamSetInputSchema,
  router,
} from '@intafaced/contracts';
import { idempotencyConflict } from '../studio/keys.js';
import { z } from 'zod';
import { toTrpc, accountField, type QuantCore } from './core.js';

export function teamRoutes(core: QuantCore) {
  const {
    strategies,
    runs,
    now,
    presentPaper,
    releaseNoteOf,
    accountOf,
    team,
    ownStrategy,
    lockView,
    teamOf,
    sharedStrategy,
    sharedView,
    editableBy,
    takeEditLock,
  } = core;
  return router({
    get: publicJurisdictionProcedure('quant', 'fiat')
      .input(z.object({ strategyId: z.string().min(1).max(128), ...accountField }))
      .output(quantTeamSchema)
      .query(async ({ input, ctx }) => {
        try {
          const accountId = accountOf(ctx, input.accountId);
          const found = await ownStrategy(accountId, input.strategyId);
          return await teamOf(accountId, found.id);
        } catch (err) {
          toTrpc(err);
        }
      }),

    /** Adds a teammate or changes their permission. A new one counts against the plan's collaborators per strategy. */
    set: publicJurisdictionProcedure('quant', 'fiat')
      .input(quantTeamSetInputSchema.extend(accountField))
      .output(quantTeamSchema)
      .mutation(async ({ input, ctx }) => {
        try {
          const accountId = accountOf(ctx, input.accountId);
          const found = await ownStrategy(accountId, input.strategyId);
          const memberId = input.memberId.trim().toLowerCase();
          if (!z.string().guid().safeParse(memberId).success) {
            throw new QuantError(QUANT_TEAM_MEMBER_INVALID, 'memberId — not an account id');
          }
          if (memberId === accountId.toLowerCase()) {
            throw new QuantError(QUANT_TEAM_MEMBER_INVALID, 'memberId — the owner already has every permission');
          }
          await team.upsert({
            strategyId: found.id,
            ownerId: accountId,
            memberId,
            role: input.role,
            liveControl: input.liveControl,
            at: new Date(now()),
          });
          return await teamOf(accountId, found.id);
        } catch (err) {
          toTrpc(err);
        }
      }),

    /** Removes a teammate: their next request is not found. A run already going is left as it is. */
    remove: publicJurisdictionProcedure('quant', 'fiat')
      .input(quantTeamRemoveInputSchema.extend(accountField))
      .output(quantTeamSchema)
      .mutation(async ({ input, ctx }) => {
        try {
          const accountId = accountOf(ctx, input.accountId);
          const found = await ownStrategy(accountId, input.strategyId);
          await team.remove({ strategyId: found.id, memberId: input.memberId.toLowerCase() });
          return await teamOf(accountId, found.id);
        } catch (err) {
          toTrpc(err);
        }
      }),

    /** A time-boxed grant for support to read the source, under `quant.grant:<strategy>:<seq>` (seq: grants the screen read). */
    grant: publicJurisdictionProcedure('quant', 'fiat')
      .input(quantSupportGrantInputSchema.extend(accountField))
      .output(quantTeamSchema)
      .mutation(async ({ input, ctx }) => {
        try {
          const accountId = accountOf(ctx, input.accountId);
          const found = await ownStrategy(accountId, input.strategyId);
          if (input.seconds < QUANT_SUPPORT_GRANT_MIN_SECONDS || input.seconds > QUANT_SUPPORT_GRANT_MAX_SECONDS) {
            throw new QuantError(
              QUANT_GRANT_INVALID,
              `seconds — a support grant lasts from ${QUANT_SUPPORT_GRANT_MIN_SECONDS} to ${QUANT_SUPPORT_GRANT_MAX_SECONDS} seconds`,
            );
          }
          await team.createGrant({
            strategyId: found.id,
            ownerId: accountId,
            key: `quant.grant:${found.id}:${input.seq}`,
            at: new Date(now()),
            seconds: input.seconds,
          });
          return await teamOf(accountId, found.id);
        } catch (err) {
          toTrpc(err);
        }
      }),

    /** The strategies shared with the caller, and the caller's own account id, which an owner adds them by. */
    shared: publicJurisdictionProcedure('quant', 'fiat')
      .input(z.object({ ...accountField }).optional())
      .output(quantSharedListSchema)
      .query(async ({ input, ctx }) => {
        try {
          const accountId = accountOf(ctx, input?.accountId);
          const rows = await team.sharedWith(accountId);
          const out = [];
          for (const row of rows) {
            const found = await strategies.get({ accountId: row.ownerId, id: row.strategyId });
            if (!found || found.deletedAt) continue;
            out.push({
              strategyId: found.id,
              ownerId: row.ownerId,
              name: found.name,
              version: found.version,
              role: row.role,
              liveControl: row.liveControl,
            });
          }
          return { accountId, strategies: out };
        } catch (err) {
          toTrpc(err);
        }
      }),

    /** A shared strategy as the teammate reads it. Not shared with the caller (or removed) is not found. */
    open: publicJurisdictionProcedure('quant', 'fiat')
      .input(z.object({ strategyId: z.string().min(1).max(128), ...accountField }))
      .output(quantSharedOpenSchema)
      .query(async ({ input, ctx }) => {
        try {
          const accountId = accountOf(ctx, input.accountId);
          const { member, found } = await sharedStrategy(accountId, input.strategyId);
          return await sharedView(accountId, member, found);
        } catch (err) {
          toTrpc(err);
        }
      }),

    /**
     * A teammate's save: a new version of the owner's strategy with the name and note given, under
     * `quant.team.save:<strategy>:<member>:v<base>`. View only refuses `quant.permission_denied`; another person's live
     * lock refuses `quant.edit_locked`; saving takes or renews the caller's lock.
     */
    save: publicJurisdictionProcedure('quant', 'fiat')
      .input(quantTeamSaveInputSchema.extend(accountField))
      .output(quantSharedOpenSchema)
      .mutation(async ({ input, ctx }) => {
        try {
          const accountId = accountOf(ctx, input.accountId);
          const { member, found } = await sharedStrategy(accountId, input.strategyId);
          if (member.role !== 'edit') {
            throw new QuantError(QUANT_PERMISSION_DENIED, 'this strategy is shared with you to view only, so you cannot save it');
          }
          const key = `quant.team.save:${found.id}:${accountId}:v${input.baseVersion}`;
          const prior = await strategies.replay(found.accountId, key);
          if (prior?.operation === 'revise') return await sharedView(accountId, member, prior.response);
          if (prior) idempotencyConflict(prior.operation);
          await takeEditLock(found.id, accountId);
          const base = found.versions.find((row) => row.version === input.baseVersion);
          if (!base) throw new QuantError(QUANT_VERSION_NOT_FOUND, `version ${input.baseVersion} not found`);
          const { version: _v, createdAt: _c, ...draft } = base;
          const saved = await strategies.revise({
            accountId: found.accountId,
            id: found.id,
            idempotencyKey: key,
            draft: { ...draft, name: input.name.trim(), releaseNote: releaseNoteOf(input.releaseNote) },
          });
          return await sharedView(accountId, member, saved);
        } catch (err) {
          toTrpc(err);
        }
      }),

    /** Takes or renews the edit lock: the owner or an edit teammate. Another person's live lock refuses `quant.edit_locked`. */
    lock: publicJurisdictionProcedure('quant', 'fiat')
      .input(z.object({ strategyId: z.string().min(1).max(128), ...accountField }))
      .output(quantEditLockSchema)
      .mutation(async ({ input, ctx }) => {
        try {
          const accountId = accountOf(ctx, input.accountId);
          const strategyId = await editableBy(accountId, input.strategyId);
          return lockView(await takeEditLock(strategyId, accountId), accountId);
        } catch (err) {
          toTrpc(err);
        }
      }),

    /** Lets the caller's own edit lock go. Not holding it changes nothing. */
    unlock: publicJurisdictionProcedure('quant', 'fiat')
      .input(z.object({ strategyId: z.string().min(1).max(128), ...accountField }))
      .output(quantEditLockSchema)
      .mutation(async ({ input, ctx }) => {
        try {
          const accountId = accountOf(ctx, input.accountId);
          const strategyId = await editableBy(accountId, input.strategyId);
          await team.releaseLock({ strategyId, holderId: accountId });
          return lockView(await team.lock(strategyId), accountId);
        } catch (err) {
          toTrpc(err);
        }
      }),

    /** The owner's paper runs of a shared strategy, newest first, as the teammate sees them. */
    paperRuns: publicJurisdictionProcedure('quant', 'fiat')
      .input(z.object({ strategyId: z.string().min(1).max(128), ...accountField }))
      .output(quantPaperListSchema)
      .query(async ({ input, ctx }) => {
        try {
          const accountId = accountOf(ctx, input.accountId);
          const { found } = await sharedStrategy(accountId, input.strategyId);
          const rows = await runs.paperRuns({ userId: found.accountId, strategyId: found.id, limit: QUANT_PAPER_LIST_MAX });
          return {
            runs: rows.map((row) => ({
              runId: row.run.id,
              strategyId: row.run.strategyId ?? '',
              strategyVersion: row.run.strategyVersion ?? 1,
              state: row.run.finished ? ('stopped' as const) : ('running' as const),
              startedAt: row.run.started,
              stoppedAt: row.run.finished,
              cash: row.settings.cash,
              feed: row.settings.feed,
            })),
            counts: [],
          };
        } catch (err) {
          toTrpc(err);
        }
      }),

    /**
     * A teammate's manual order to the owner's paper run of a shared strategy: without live control it refuses
     * `quant.permission_denied`, and nothing is sent. With live control it refuses `quant.paper_manual_order_unsupported`:
     * a paper run trades only by its own rules, so no manual order is ever placed on one. Not shared is not found.
     */
    order: publicJurisdictionProcedure('quant', 'fiat')
      .input(
        z.object({
          strategyId: z.string().min(1).max(128),
          runId: z.string().min(1).max(128),
          side: z.enum(['buy', 'sell']),
          size: z.string().regex(/^(?:0|[1-9]\d{0,17})(?:\.\d{1,18})?$/, 'size — a decimal string'),
          ...accountField,
        }),
      )
      .output(z.never())
      .mutation(async ({ input, ctx }) => {
        try {
          const accountId = accountOf(ctx, input.accountId);
          const { member, found } = await sharedStrategy(accountId, input.strategyId);
          if (!member.liveControl) {
            throw new QuantError(
              QUANT_PERMISSION_DENIED,
              'you were given no live control of this strategy, so you cannot send its runs a manual order; nothing was sent',
            );
          }
          const paper = await runs.paperRun({ userId: found.accountId, id: input.runId });
          if (!paper || paper.run.strategyId !== found.id) throw new QuantError(QUANT_RUN_NOT_FOUND, 'run not found');
          throw new QuantError(
            QUANT_PAPER_MANUAL_ORDER_UNSUPPORTED,
            'a paper run trades only by its own rules and takes no manual order; nothing was sent',
          );
        } catch (err) {
          toTrpc(err);
        }
      }),

    /** Stops the owner's paper run of a shared strategy: only with live control, else `quant.permission_denied`. */
    stop: publicJurisdictionProcedure('quant', 'fiat')
      .input(z.object({ strategyId: z.string().min(1).max(128), runId: z.string().min(1).max(128), ...accountField }))
      .output(quantPaperRunSchema)
      .mutation(async ({ input, ctx }) => {
        try {
          const accountId = accountOf(ctx, input.accountId);
          const { member, found } = await sharedStrategy(accountId, input.strategyId);
          if (!member.liveControl) {
            throw new QuantError(
              QUANT_PERMISSION_DENIED,
              'you were given no live control of this strategy, so you cannot stop its runs; nothing was stopped',
            );
          }
          const paper = await runs.paperRun({ userId: found.accountId, id: input.runId });
          if (!paper || paper.run.strategyId !== found.id) throw new QuantError(QUANT_RUN_NOT_FOUND, 'run not found');
          if (!paper.run.finished) {
            try {
              await runs.finish({
                id: paper.run.id,
                userId: found.accountId,
                outcome: 'stopped',
                stored: { detail: null, response: { stopped: true } },
              });
            } catch (err) {
              if (!(err instanceof QuantError) || err.code !== QUANT_RUN_IMMUTABLE) throw err;
            }
          }
          const stopped = await runs.paperRun({ userId: found.accountId, id: input.runId });
          if (!stopped) throw new QuantError(QUANT_RUN_NOT_FOUND, 'run not found');
          return await presentPaper(found.accountId, stopped);
        } catch (err) {
          toTrpc(err);
        }
      }),
  });
}
