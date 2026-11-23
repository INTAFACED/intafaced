import { z } from 'zod';
import { asset, campaignDecimal, id } from './campaigns-base.js';

// ── Earning rules (CM-rewards-hub-05) ───────────────────────────────────────────────────────────────────────────────

/**
 * The triggers an earning rule may name: events declared in `packages/events`, each with the names its incentive
 * formula may read. `trade.fill.settled`: `amount` is the fill's quote amount, `fee` its fee, `qty` its quantity.
 * `pay.deposit_credit.posted`: `amount` is the amount credited. `bank.card_cashback.earned`: `amount` is what a card
 * capture the card partner holds spent, `cashback` the cashback svc-bank worked out on it at the person's rank card tier
 * (J-bank-13 #7). Anything else refuses `campaigns.trigger_unknown`.
 */
export const EARNING_TRIGGERS = {
  'trade.fill.settled': { label: 'A spot fill settles', names: ['amount', 'fee', 'qty'] },
  'pay.deposit_credit.posted': { label: 'A crypto deposit is credited', names: ['amount'] },
  'bank.card_cashback.earned': { label: 'Card spend earns cashback', names: ['amount', 'cashback'] },
} as const;
export type EarningTrigger = keyof typeof EARNING_TRIGGERS;

/**
 * An earning rule: when its trigger's event arrives for a participant, and its condition holds, it gives the incentive
 * its formula works out, in the campaign's reward asset. A formula is parsed from a closed grammar (decimal numbers, the
 * trigger's names, `+ - * /`, brackets, `min(a, b)` and `max(a, b)`); anything else refuses `campaigns.formula_invalid`.
 * A fixed incentive is a formula that is one number. A rule is part of the campaign revision (ENGINE LC-5).
 */
export const earningRuleSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    trigger: z.string().max(64),
    /** The condition on the event: its amount is at least this; null: any amount. */
    minAmount: campaignDecimal.nullable().default(null),
    formula: z.string().trim().min(1).max(200),
    /**
     * What the rule gives. Absent: an incentive, the formula's answer in the campaign's reward asset. `points`: that many
     * points of the points programme. A points effect saves, but it waits for the owner's answer to whether INTAFACED runs
     * a points programme whose points have value or convert to cash: evaluating it refuses `owner.decision` for that rule
     * only, and a live event gives nothing for it, while the campaign's other rules evaluate and pay as before.
     */
    effect: z.enum(['incentive', 'points']).optional(),
  })
  .strict();
export type EarningRule = z.infer<typeof earningRuleSchema>;
export type EarningEffect = NonNullable<EarningRule['effect']>;

/**
 * Evaluate a campaign's earning rules on one TEST event the operator types (CM-rewards-hub-05 preview and test): what each
 * rule would give for it, writing nothing. `values` are the trigger's names (`amount`, `fee`, `qty`), each a decimal
 * string in the campaign's reward asset; a name the trigger does not have refuses `campaigns.formula_invalid`.
 */
export const earningEvaluateInputSchema = z
  .object({
    id,
    trigger: z.string().max(64),
    values: z.record(z.string().max(16), campaignDecimal),
  })
  .strict();
export type EarningEvaluateInput = z.infer<typeof earningEvaluateInputSchema>;

/** One rule's answer to the TEST event: what it would give, why it gives nothing, or the refusal for its effect alone. */
export const earningEvaluationResultSchema = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('gives'),
    rule: z.string(),
    effect: z.literal('incentive'),
    amount: campaignDecimal,
    asset: asset.nullable(),
  }),
  z.object({
    outcome: z.literal('nothing'),
    rule: z.string(),
    effect: z.enum(['incentive', 'points']),
    /** `other_trigger`: the rule answers another event; `below_condition`: the amount is under its minimum; `zero`: it works out to nothing. */
    reason: z.enum(['other_trigger', 'below_condition', 'zero']),
  }),
  z.object({
    outcome: z.literal('refused'),
    rule: z.string(),
    effect: z.literal('points'),
    code: z.literal('owner.decision'),
    question: z.string(),
  }),
]);
export type EarningEvaluationResult = z.infer<typeof earningEvaluationResultSchema>;

export const earningEvaluationSchema = z.object({
  campaignId: id,
  trigger: z.string(),
  results: z.array(earningEvaluationResultSchema),
});
export type EarningEvaluation = z.infer<typeof earningEvaluationSchema>;
