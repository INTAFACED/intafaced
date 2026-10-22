/**
 * Card programme funding model (BK-cops-04). Read and change of how card spend is funded.
 *
 * Only `jit` runs: the card is an access device and spend is held and captured from the customer's own ledger balance
 * (withdrawHold, then withdrawSettle or withdrawReverse; see cards/card-service.ts). There is no programme pool, so
 * `prefunded_pooled` and `credit` refuse `bank.funding_model_not_wired` until BK-cops-05 and LG-card-programme-01
 * land. Asking for the current model (`jit`) refuses `bank.funding_model_unchanged`: nothing would change, so nothing
 * is recorded. Both refusals come before the approval is consumed, so a refused set never spends a second operator's
 * approval. Today every set refuses; the approval path is there for the day a second model is wired.
 *
 * `changedAt` and `changedBy` are null because the model has never changed: `jit` is the only model there has been.
 * They are not a missing record; the first real change (with a stored row) comes with BK-cops-05.
 */
import {
  bankProgrammeFundingModelSetInputSchema,
  bankProgrammeFundingModelViewSchema,
  scopedProcedure,
  type BankProgrammeFundingModel,
  type BankProgrammeFundingModelSetInput,
  type BankProgrammeFundingModelView,
} from '@intafaced/contracts';
import { z } from 'zod';
import { BankError } from '../errors.js';

type Guard = <T>(fn: () => Promise<T>) => Promise<T>;
type ConsumeOpsApproval = (
  input: { approvalId?: string | null; operationId?: string | null },
  actionType: string,
  fields: Record<string, string>,
) => Promise<string>;

/** The model in force. Never changed so far; see the header. */
export const CURRENT_FUNDING_MODEL: BankProgrammeFundingModel = 'jit';

/** The models this deployment can run. Only `jit` until the pooled programme ledger lands. */
export const WIRED_FUNDING_MODELS: readonly BankProgrammeFundingModel[] = ['jit'];

export const FUNDING_MODEL_SET_ACTION = 'bank.ops.programmeFundingModelSet' as const;

const JIT_EXPLANATION =
  'Just in time: the card is an access device. Each card spend is held from the customer’s own balance and then ' +
  'captured or released; no programme pool holds money and no card balance exists.';

export function programmeFundingModelView(): BankProgrammeFundingModelView {
  return bankProgrammeFundingModelViewSchema.parse({
    current: CURRENT_FUNDING_MODEL,
    explanation: JIT_EXPLANATION,
    wired: [...WIRED_FUNDING_MODELS],
    changedAt: null,
    changedBy: null,
  });
}

/** Refuses an unwired model, then the current model (no change), then consumes the approval bound to model and reason. */
export async function setProgrammeFundingModel(
  input: BankProgrammeFundingModelSetInput,
  consume: ConsumeOpsApproval,
): Promise<BankProgrammeFundingModelView> {
  const parsed = bankProgrammeFundingModelSetInputSchema.parse(input);
  if (!WIRED_FUNDING_MODELS.includes(parsed.model)) {
    throw new BankError(
      `Funding model ${parsed.model} is not wired; only jit runs until BK-cops-05 and LG-card-programme-01 land (bank.funding_model_not_wired)`,
      'bank.funding_model_not_wired',
    );
  }
  if (parsed.model === CURRENT_FUNDING_MODEL) {
    throw new BankError(
      `Funding model is already ${parsed.model}; nothing would change, so no approval is used (bank.funding_model_unchanged)`,
      'bank.funding_model_unchanged',
    );
  }
  await consume(parsed, FUNDING_MODEL_SET_ACTION, { model: parsed.model, reason: parsed.reason });
  return programmeFundingModelView();
}

export function programmeFundingModelGetProcedure(guard: Guard) {
  return scopedProcedure('admin:read')
    .input(z.object({}).strict().optional())
    .output(bankProgrammeFundingModelViewSchema)
    .query(() => guard(async () => programmeFundingModelView()));
}

export function programmeFundingModelSetProcedure(consume: ConsumeOpsApproval, guard: Guard) {
  return scopedProcedure('admin:treasury')
    .input(bankProgrammeFundingModelSetInputSchema)
    .output(bankProgrammeFundingModelViewSchema)
    .mutation(({ input }) => guard(() => setProgrammeFundingModel(input, consume)));
}
