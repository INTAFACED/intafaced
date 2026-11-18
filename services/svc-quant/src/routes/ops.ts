import { CONTROL_RUN, ESCAPE_CORPUS } from '../sandbox/escape-corpus.js';
import { OWNER_CRITERION_FORMAT } from '../lifecycle/gate.js';
import { QUANT_CRITERIA_REASON_UNSET, QUANT_LAKE_STORE_UNSET, QUANT_LAKE_SYMBOL_UNKNOWN, QuantError } from '../errors.js';
import {
  QUANT_OWNER_CRITERIA,
  QUANT_PROMOTION_AUDIT_PAGE,
  QUANT_QUOTA_RESOURCES,
  QUANT_SANDBOX_LIMITS,
  quantCriteriaSchema,
  quantCriteriaSetInputSchema,
  quantDisclosureCountsOutputSchema,
  quantDisclosurePublishInputSchema,
  quantDisclosurePublishOutputSchema,
  quantDisputeOpenInputSchema,
  quantDisputeResolveInputSchema,
  quantEscapeCorpusInputSchema,
  quantEscapeCorpusSchema,
  quantLakeCaptureInputSchema,
  quantModerationEntrySchema,
  quantModerationInputSchema,
  quantModerationQueueInputSchema,
  quantModerationQueueSchema,
  quantPromotionAuditSchema,
  quantQuotaAssignInputSchema,
  quantQuotaAssignOutputSchema,
  quantQuotaProfileSchema,
  quantQuotaSetInputSchema,
  quantQuotaSetOutputSchema,
  quantSandboxLimitSetInputSchema,
  quantSandboxLimitSetOutputSchema,
  quantSupportSourceSchema,
  quantTemplateListingInputSchema,
  quantTemplateListingSchema,
  quantTemplatePublishInputSchema,
  quantTemplateVersionSchema,
  quantTierSetInputSchema,
  quantTierSetOutputSchema,
  router,
  scopedProcedure,
} from '@intafaced/contracts';
import { assertOpsRunsLimit, optionalWindowBound, requireWindowBound } from '../runs/limit.js';
import { blankTemplateRules } from '../templates/rules.js';
import { parseLimit, parseWhole } from '../quota/quota.js';
import { requireIdempotencyKey } from '../studio/keys.js';
import { requireRunLimits } from '../sandbox/limits.js';
import { runSandbox } from '../sandbox/run.js';
import { withQuantSpan } from '../tracing.js';
import { z } from 'zod';
import { toTrpc, missingStrategy, type QuantCore } from './core.js';

export function opsRoutes(core: QuantCore) {
  const { deps, strategies, runs, now, judgement, disclosure, templates, quota, lifecycle, runDeps, quotaReason, team, library } = core;
  return router({
    /**
     * Pauses or resumes the lake's capture of one symbol (J-algo-dev-16 #2): one insert-only row with the actor and the
     * reason, under the caller's key. While paused nothing is captured, so that time reads as a gap.
     */
    lake: router({
      capture: scopedProcedure('admin:write', { module: 'quant', plane: 'fiat' })
        .input(quantLakeCaptureInputSchema)
        .output(z.object({ symbol: z.string(), capturing: z.boolean(), reason: z.string(), actor: z.string(), at: z.string() }))
        .mutation(async ({ input, ctx }) => {
          try {
            const lake = deps.dataLake;
            if (!lake || lake.settings.symbols.length === 0 || lake.settings.captureSeconds === null) {
              throw new QuantError(
                QUANT_LAKE_STORE_UNSET,
                'QUANT_LAKE_SYMBOLS and QUANT_LAKE_CAPTURE_SECONDS — the lake captures nothing on this deployment',
              );
            }
            if (!lake.settings.symbols.includes(input.symbol)) {
              throw new QuantError(QUANT_LAKE_SYMBOL_UNKNOWN, `the lake does not capture ${input.symbol}`);
            }
            const row = await lake.store.change({
              symbol: input.symbol,
              capturing: input.capturing,
              reason: input.reason,
              actor: ctx.principal.userId,
              key: `quant.lake_capture:${input.symbol}:${input.idempotencyKey}`,
              at: new Date(now()).toISOString(),
            });
            return { symbol: row.symbol, capturing: row.capturing, reason: row.reason, actor: row.actor, at: row.at };
          } catch (err) {
            toTrpc(err);
          }
        }),
    }),
    strategy: router({
      /**
       * Support's read of one strategy (J-algo-dev-08): the source only while the owner's time-boxed grant is active,
       * else metadata only. Every read, granted or not, writes one audit row the owner sees in `team.get`.
       */
      source: scopedProcedure('admin:read', { module: 'quant', plane: 'fiat' })
        .input(z.object({ strategyId: z.string().min(1).max(128), ownerId: z.string().guid() }))
        .output(quantSupportSourceSchema)
        .query(async ({ input, ctx }) => {
          try {
            const found = await strategies.get({ accountId: input.ownerId, id: input.strategyId });
            if (!found || found.deletedAt) missingStrategy();
            const grant = await team.recordRead({ strategyId: found.id, reader: ctx.principal.userId, at: new Date(now()) });
            return {
              strategyId: found.id,
              ownerId: found.accountId,
              name: found.name,
              version: found.version,
              versions: found.versions.length,
              granted: grant !== null,
              grantExpiresAt: grant?.expiresAt ?? null,
              source: grant ? found.source : null,
            };
          } catch (err) {
            toTrpc(err);
          }
        }),
    }),

    runs: scopedProcedure('admin:read', { module: 'quant', plane: 'fiat' })
      .input(
        z
          .object({
            from: z.string().optional().nullable(),
            to: z.string().optional().nullable(),
            kind: z.enum(['backtest', 'sandbox', 'paper']).optional().nullable(),
            userId: z.string().guid().optional().nullable(),
            limit: z.number().int().optional(),
            cursor: z.string().optional().nullable(),
          })
          .optional(),
      )
      .output(
        z.object({
          runs: z.array(
            z.object({
              id: z.string(),
              kind: z.enum(['backtest', 'sandbox', 'paper']),
              userId: z.string().guid().nullable(),
              started: z.string(),
              duration: z.number().int().nullable(),
              outcome: z.string().nullable(),
            }),
          ),
          nextCursor: z.string().nullable(),
        }),
      )
      .query(async ({ input }) => {
        try {
          const limit = assertOpsRunsLimit(input?.limit);
          const cursor = input?.cursor?.trim() ? input.cursor.trim() : null;
          const page = await runs.list({
            from: optionalWindowBound(input?.from, 'from'),
            to: optionalWindowBound(input?.to, 'to'),
            kind: input?.kind ?? null,
            userId: input?.userId ?? null,
            limit,
            cursor,
          });
          return {
            runs: page.runs.map((row) => ({
              id: row.id,
              kind: row.kind,
              userId: row.userId,
              started: row.started,
              duration: row.duration,
              outcome: row.outcome,
            })),
            nextCursor: page.nextCursor,
          };
        } catch (err) {
          toTrpc(err);
        }
      }),

    runCounts: scopedProcedure('admin:read', { module: 'quant', plane: 'fiat' })
      .input(
        z
          .object({
            from: z.string().optional().nullable(),
            to: z.string().optional().nullable(),
          })
          .optional(),
      )
      .output(
        z.object({
          byKind: z.object({ backtest: z.number().int(), sandbox: z.number().int(), paper: z.number().int() }),
          byOutcome: z.array(z.object({ outcome: z.string(), count: z.number().int() })),
          asOf: z.string(),
        }),
      )
      .query(async ({ input }) => {
        try {
          const counts = await runs.counts({
            from: requireWindowBound(input?.from, 'from'),
            to: requireWindowBound(input?.to, 'to'),
          });
          return {
            byKind: { backtest: counts.byKind.backtest, sandbox: counts.byKind.sandbox, paper: counts.byKind.paper },
            byOutcome: counts.byOutcome.map((row) => ({ outcome: row.outcome, count: row.count })),
            asOf: counts.asOf,
          };
        } catch (err) {
          toTrpc(err);
        }
      }),

    /**
     * Library moderation (J-algo-dev-10, AL-library-03). The review queue reads with `admin:read`; hide, unhide, remove
     * and the disputes write with `admin:write`, each one audit row naming the founder from their own token and the
     * reason. Operators never see a listing's source. No money moves.
     */
    library: router({
      queue: scopedProcedure('admin:read', { module: 'quant', plane: 'fiat' })
        .input(quantModerationQueueInputSchema)
        .output(quantModerationQueueSchema)
        .query(async ({ input }) => {
          try {
            return await library.queue({ cursor: input?.cursor ?? null });
          } catch (err) {
            toTrpc(err);
          }
        }),
      hide: scopedProcedure('admin:write', { module: 'quant', plane: 'fiat' })
        .input(quantModerationInputSchema)
        .output(quantModerationEntrySchema)
        .mutation(async ({ input, ctx }) => {
          try {
            return await library.moderate(ctx.principal.userId, input, 'hide');
          } catch (err) {
            toTrpc(err);
          }
        }),
      unhide: scopedProcedure('admin:write', { module: 'quant', plane: 'fiat' })
        .input(quantModerationInputSchema)
        .output(quantModerationEntrySchema)
        .mutation(async ({ input, ctx }) => {
          try {
            return await library.moderate(ctx.principal.userId, input, 'unhide');
          } catch (err) {
            toTrpc(err);
          }
        }),
      remove: scopedProcedure('admin:write', { module: 'quant', plane: 'fiat' })
        .input(quantModerationInputSchema)
        .output(quantModerationEntrySchema)
        .mutation(async ({ input, ctx }) => {
          try {
            return await library.moderate(ctx.principal.userId, input, 'remove');
          } catch (err) {
            toTrpc(err);
          }
        }),
      dispute: router({
        open: scopedProcedure('admin:write', { module: 'quant', plane: 'fiat' })
          .input(quantDisputeOpenInputSchema)
          .output(quantModerationEntrySchema)
          .mutation(async ({ input, ctx }) => {
            try {
              return await library.openDispute(ctx.principal.userId, input);
            } catch (err) {
              toTrpc(err);
            }
          }),
        resolve: scopedProcedure('admin:write', { module: 'quant', plane: 'fiat' })
          .input(quantDisputeResolveInputSchema)
          .output(quantModerationEntrySchema)
          .mutation(async ({ input, ctx }) => {
            try {
              return await library.resolveDispute(ctx.principal.userId, input);
            } catch (err) {
              toTrpc(err);
            }
          }),
      }),
    }),

    lifecycle: router({
      /**
       * The promotion audit (AL-lifecycle-01, J-algo-dev-13 #3): every stored gate decision across accounts, newest
       * first, with the one stage row an approval wrote, who pressed and the criteria the gate judged by.
       */
      audit: scopedProcedure('admin:read', { module: 'quant', plane: 'fiat' })
        .output(quantPromotionAuditSchema)
        .query(async () => {
          try {
            const found = await lifecycle.audit(QUANT_PROMOTION_AUDIT_PAGE);
            return { rows: found.rows.map((row) => ({ ...row })), total: found.total, asOf: new Date().toISOString() };
          } catch (err) {
            toTrpc(err);
          }
        }),
    }),

    criteria: router({
      /** Every owner criterion an operator can set at runtime, with where its value comes from now. */
      get: scopedProcedure('admin:read', { module: 'quant', plane: 'fiat' })
        .output(quantCriteriaSchema)
        .query(async () => {
          try {
            const rows = await lifecycle.criteria();
            const boot: Record<string, string | null> = {
              'oos.minTrades': judgement.criteria.minTrades,
              'oos.minReturnPercent': judgement.criteria.minReturnPercent,
              'oos.maxDrawdownPercent': judgement.criteria.maxDrawdownPercent,
              'oos.maxShortfallPercent': judgement.criteria.maxShortfallPercent,
            };
            return {
              criteria: QUANT_OWNER_CRITERIA.map((name) => {
                const row = rows.find((r) => r.name === name);
                return row
                  ? { name, value: row.value, source: 'operator' as const }
                  : { name, value: boot[name] ?? null, source: 'boot' as const };
              }),
            };
          } catch (err) {
            toTrpc(err);
          }
        }),

      /**
       * Sets one owner criterion, blank for "not set", or with `toBoot` puts it back to its boot value. A reason is required
       * and kept with the actor in an audit row.
       */
      set: scopedProcedure('admin:write', { module: 'quant', plane: 'fiat' })
        .input(quantCriteriaSetInputSchema)
        .output(
          z.object({
            name: z.enum(QUANT_OWNER_CRITERIA),
            value: z.string().nullable(),
            setAt: z.string(),
            toBoot: z.boolean().optional(),
          }),
        )
        .mutation(async ({ input, ctx }) => {
          try {
            const reason = input.reason.trim();
            if (!reason) throw new QuantError(QUANT_CRITERIA_REASON_UNSET, 'reason — an owner criterion change needs a reason');
            const toBoot = input.toBoot === true;
            const value = toBoot ? null : input.value?.trim() ? input.value.trim() : null;
            if (value !== null && !OWNER_CRITERION_FORMAT[input.name].test(value)) {
              throw new QuantError('quant.params_invalid', `${input.name} — ${value} is not a value this criterion takes`);
            }
            return await lifecycle.setCriterion({
              name: input.name,
              value,
              toBoot,
              reason,
              actor: ctx.principal.userId,
              idempotencyKey: input.idempotencyKey,
            });
          } catch (err) {
            toTrpc(err);
          }
        }),
    }),

    quota: router({
      /** Sets one limit of one profile; blank is "not set". A reason is required and kept with the actor. */
      set: scopedProcedure('admin:write', { module: 'quant', plane: 'fiat' })
        .input(quantQuotaSetInputSchema)
        .output(quantQuotaSetOutputSchema)
        .mutation(async ({ input, ctx }) => {
          try {
            const reason = quotaReason(input.reason);
            const saved = await quota.set({
              profile: input.profile,
              resource: input.resource,
              limit: parseLimit(input.limit),
              reason,
              actor: ctx.principal.userId,
              idempotencyKey: input.idempotencyKey,
            });
            return { ...saved, limit: saved.limit === null ? null : saved.limit.toString() };
          } catch (err) {
            toTrpc(err);
          }
        }),

      /** Attaches an account to a profile. A reason is required and kept with the actor. */
      assign: scopedProcedure('admin:write', { module: 'quant', plane: 'fiat' })
        .input(quantQuotaAssignInputSchema)
        .output(quantQuotaAssignOutputSchema)
        .mutation(async ({ input, ctx }) => {
          try {
            const reason = quotaReason(input.reason);
            return await quota.assign({
              accountId: input.accountId,
              profile: input.profile,
              reason,
              actor: ctx.principal.userId,
              idempotencyKey: input.idempotencyKey,
            });
          } catch (err) {
            toTrpc(err);
          }
        }),

      /** Publishes or withdraws the compute tier on one profile (RC-algo-dev-05). A reason is required and kept with the actor. */
      tier: scopedProcedure('admin:write', { module: 'quant', plane: 'fiat' })
        .input(quantTierSetInputSchema)
        .output(quantTierSetOutputSchema)
        .mutation(async ({ input, ctx }) => {
          try {
            const reason = quotaReason(input.reason);
            const saved = await quota.setTier({
              profile: input.profile,
              dataFreshnessSeconds: parseWhole('dataFreshnessSeconds', input.dataFreshnessSeconds),
              priorityClass: parseWhole('priorityClass', input.priorityClass),
              published: input.published,
              reason,
              actor: ctx.principal.userId,
              idempotencyKey: input.idempotencyKey,
            });
            return {
              ...saved,
              dataFreshnessSeconds: saved.dataFreshnessSeconds?.toString() ?? null,
              priorityClass: saved.priorityClass?.toString() ?? null,
            };
          } catch (err) {
            toTrpc(err);
          }
        }),

      /** Sets one sandbox limit of one profile (J-algo-dev-12); blank is "not set". A reason is required and kept with the actor. */
      sandbox: scopedProcedure('admin:write', { module: 'quant', plane: 'fiat' })
        .input(quantSandboxLimitSetInputSchema)
        .output(quantSandboxLimitSetOutputSchema)
        .mutation(async ({ input, ctx }) => {
          try {
            const reason = quotaReason(input.reason);
            const saved = await quota.setSandboxLimit({
              profile: input.profile,
              limit: input.limit,
              value: parseWhole(input.limit, input.value),
              reason,
              actor: ctx.principal.userId,
              idempotencyKey: input.idempotencyKey,
            });
            return { ...saved, value: saved.value === null ? null : saved.value.toString() };
          } catch (err) {
            toTrpc(err);
          }
        }),

      /** One profile's limits and sandbox limits as stored. */
      profile: scopedProcedure('admin:read', { module: 'quant', plane: 'fiat' })
        .input(z.object({ profile: z.string().trim().min(1).max(80) }))
        .output(quantQuotaProfileSchema)
        .query(async ({ input }) => {
          try {
            const [rows, sandboxRows] = await Promise.all([quota.limits(input.profile), quota.sandboxLimits(input.profile)]);
            return {
              profile: input.profile,
              limits: QUANT_QUOTA_RESOURCES.map((resource) => {
                const row = rows.find((r) => r.resource === resource);
                return { resource, limit: row?.limit == null ? null : row.limit.toString(), setAt: row?.setAt ?? null };
              }),
              sandbox: QUANT_SANDBOX_LIMITS.map((limit) => {
                const row = sandboxRows.find((r) => r.limit === limit);
                return { limit, value: row?.value == null ? null : row.value.toString(), setAt: row?.setAt ?? null };
              }),
            };
          } catch (err) {
            toTrpc(err);
          }
        }),
    }),

    sandbox: router({
      /**
       * Runs the escape corpus against the sandbox under one profile's limits (J-algo-dev-12 #5, ENGINE T-14). Each case
       * goes through the same door as a developer's run; each must end in a typed refusal, and the control run after
       * them must still run. Nothing is stored and no order reaches anything: the paper book of each case is its own.
       */
      corpus: scopedProcedure('admin:write', { module: 'quant', plane: 'fiat' })
        .input(quantEscapeCorpusInputSchema)
        .output(quantEscapeCorpusSchema)
        .mutation(async ({ input }) =>
          withQuantSpan('quant.ops.sandbox.corpus', { language: 'none' }, async () => {
            try {
              const run = requireRunLimits({ name: input.profile, source: 'assigned' }, await quota.sandboxLimits(input.profile));
              const sandboxDeps = runDeps(run);
              const attempt = (language: (typeof ESCAPE_CORPUS)[number]['language'], source: string) => {
                try {
                  const ran = runSandbox({ language, source, cash: '1000', environment: 'paper', presentedAs: 'paper' }, sandboxDeps);
                  return { ok: true as const, code: null, message: 'ran', logs: ran.logs };
                } catch (err) {
                  if (err instanceof QuantError) return { ok: false as const, code: err.code as string, message: err.message, logs: [] };
                  // Anything untyped is a hole in the sandbox, reported as one rather than thrown past the corpus.
                  return { ok: false as const, code: null, message: err instanceof Error ? err.message : 'untyped failure', logs: [] };
                }
              };
              const cases = ESCAPE_CORPUS.map((c) => {
                const out = attempt(c.language, c.source);
                return { id: c.id, attack: c.attack, language: c.language, code: out.code, message: out.message };
              });
              const control = attempt(CONTROL_RUN.language, CONTROL_RUN.source);
              return {
                profile: input.profile,
                cases,
                control: { ok: control.ok, code: control.code, logs: control.logs },
                asOf: new Date().toISOString(),
              };
            } catch (err) {
              toTrpc(err);
            }
          }),
        ),
    }),

    template: router({
      /** The next version of a starter template. Every number stays blank; the row records who, why and when. */
      publish: scopedProcedure('admin:write', { module: 'quant', plane: 'fiat' })
        .input(quantTemplatePublishInputSchema)
        .output(quantTemplateVersionSchema)
        .mutation(async ({ input, ctx }) =>
          withQuantSpan('quant.ops.template.publish', { language: 'none' }, async () => {
            try {
              const published = await templates.publish({
                id: input.id,
                name: input.name,
                description: input.description,
                rules: blankTemplateRules(input.rules),
                releaseNote: input.releaseNote,
                reason: input.reason,
                publishedBy: ctx.principal.userId,
                idempotencyKey: input.idempotencyKey,
              });
              return { ...published };
            } catch (err) {
              toTrpc(err);
            }
          }),
        ),

      /** Withdraws a starter template from the list or restores it. Its versions stay; the row records who, why and when. */
      listing: scopedProcedure('admin:write', { module: 'quant', plane: 'fiat' })
        .input(quantTemplateListingInputSchema)
        .output(quantTemplateListingSchema)
        .mutation(async ({ input, ctx }) =>
          withQuantSpan('quant.ops.template.listing', { language: 'none' }, async () => {
            try {
              return await templates.setListed({
                id: input.id,
                listed: input.listed,
                reason: input.reason,
                setBy: ctx.principal.userId,
                idempotencyKey: input.idempotencyKey,
              });
            } catch (err) {
              toTrpc(err);
            }
          }),
        ),
    }),

    disclosure: router({
      publish: scopedProcedure('admin:write', { module: 'quant', plane: 'fiat' })
        .input(quantDisclosurePublishInputSchema)
        .output(quantDisclosurePublishOutputSchema)
        .mutation(async ({ input, ctx }) =>
          withQuantSpan('quant.ops.disclosure.publish', { language: 'none' }, async () => {
            try {
              const published = await disclosure.publish({
                text: input.text,
                reason: input.reason,
                publishedBy: ctx.principal.userId,
                idempotencyKey: requireIdempotencyKey(input.idempotencyKey),
              });
              return { version: published.version, publishedAt: published.publishedAt };
            } catch (err) {
              toTrpc(err);
            }
          }),
        ),

      counts: scopedProcedure('admin:read', { module: 'quant', plane: 'fiat' })
        .output(quantDisclosureCountsOutputSchema)
        .query(async () => {
          try {
            const counts = await disclosure.counts();
            return { versions: counts.versions.map((row) => ({ ...row })), asOf: new Date().toISOString() };
          } catch (err) {
            toTrpc(err);
          }
        }),
    }),
  });
}
