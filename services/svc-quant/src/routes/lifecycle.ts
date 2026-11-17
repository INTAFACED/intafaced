import { GATE_CRITERION_NAMES } from '../lifecycle/gate.js';
import { QUANT_GATE_CRITERIA_UNSET, QUANT_STAGE_TRANSITION_INVALID, QuantError } from '../errors.js';
import {
  type QuantStage,
  publicJurisdictionProcedure,
  quantLifecycleSchema,
  quantPromoteInputSchema,
  quantPromoteOutputSchema,
  router,
} from '@intafaced/contracts';
import { withQuantSpan } from '../tracing.js';
import { z } from 'zod';
import { toTrpc, accountField, type QuantCore } from './core.js';

export function lifecycleRoutes(core: QuantCore) {
  const { now, lifecycle, lifecycleOf, accountOf } = core;
  return router({
    /** One version's stage, its stored stage rows and gate decisions, and every gate check as it reads now. Writes nothing. */
    get: publicJurisdictionProcedure('quant', 'fiat')
      .input(z.object({ strategyId: z.string().min(1).max(128), strategyVersion: z.number().int().positive(), ...accountField }))
      .output(quantLifecycleSchema)
      .query(async ({ input, ctx }) => {
        try {
          return await lifecycleOf(accountOf(ctx, input.accountId), input.strategyId, input.strategyVersion);
        } catch (err) {
          toTrpc(err);
        }
      }),

    /**
     * Promote: asks the gate to move one version from `paper` to `candidate` (ENGINE LC-2, LC-3). A blank criterion
     * refuses `quant.gate_criteria_unset` naming it and writes nothing. Otherwise the decision is one audit row and, when
     * approved, one stage row, in one transaction under `quant.stage:<id>:v<n>:paper:candidate:<seq>`: the same press
     * again reads its first answer back, and a version already past `paper` refuses `quant.stage_transition_invalid`.
     */
    promote: publicJurisdictionProcedure('quant', 'fiat')
      .input(quantPromoteInputSchema.extend(accountField))
      .output(quantPromoteOutputSchema)
      .mutation(async ({ input, ctx }) =>
        withQuantSpan('quant.lifecycle.promote', { language: 'none' }, async () => {
          try {
            const accountId = accountOf(ctx, input.accountId);
            const key = `quant.stage:${input.strategyId}:v${input.strategyVersion}:paper:candidate:${input.seq}`;
            const prior = await lifecycle.replay(accountId, key);
            if (prior) return { ...prior, lifecycle: await lifecycleOf(accountId, input.strategyId, input.strategyVersion) };
            const before = await lifecycleOf(accountId, input.strategyId, input.strategyVersion);
            if (before.gate.unset.length) {
              throw new QuantError(
                QUANT_GATE_CRITERIA_UNSET,
                `${before.gate.unset.join(', ')} — not set by the owner: ${before.gate.unset.map((name) => GATE_CRITERION_NAMES[name]).join('; ')}`,
              );
            }
            const moved = (stage: QuantStage) => !['draft', 'backtested', 'validated', 'paper'].includes(stage);
            if (moved(before.stage)) {
              throw new QuantError(QUANT_STAGE_TRANSITION_INVALID, `${before.stage} to candidate — this version already left paper`);
            }
            const at = new Date(now()).toISOString();
            const approved = before.gate.approved && before.stage === 'paper';
            const runIds = before.gate.checks.flatMap((check) => (check.runId ? [check.runId] : []));
            const decision = {
              decision: approved ? ('approved' as const) : ('rejected' as const),
              at,
              runIds: [...new Set(runIds)],
              criteria: before.gate.checks.flatMap((check) => (check.criterion ? [check.criterion] : [])),
            };
            const stage = approved ? { from: 'paper' as const, to: 'candidate' as const, at, runIds: decision.runIds } : null;
            const response = { decision, stage };
            const kept = await lifecycle.record({
              key,
              accountId,
              strategyId: before.strategyId,
              strategyVersion: input.strategyVersion,
              actor: ctx.principal?.userId ?? accountId,
              decision,
              stage,
              response,
            });
            if (!kept) throw new QuantError(QUANT_STAGE_TRANSITION_INVALID, 'paper to candidate — this version already reached candidate');
            return { ...kept, lifecycle: await lifecycleOf(accountId, input.strategyId, input.strategyVersion) };
          } catch (err) {
            toTrpc(err);
          }
        }),
      ),
  });
}
