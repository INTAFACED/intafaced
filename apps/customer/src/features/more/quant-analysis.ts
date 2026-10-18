import { z } from 'zod';
import { signedDecimalSchema } from '../../shared/money';
import type { StudioDraft } from './quant-draft';

const iso = z
  .string()
  .datetime({ offset: true })
  .refine((value) => Number.isFinite(Date.parse(value)));
const activity = z.object({ fillCount: z.number().int().nonnegative().safe(), notional: signedDecimalSchema });
export const historicalResultSchema = z.object({
  ok: z.literal(true),
  environment: z.literal('backtest'),
  kind: z.literal('simulated'),
  live: z.literal(false),
  simulated: z.literal(true),
  claimLabel: z.literal('Historical simulation — not a forecast'),
  runId: z.string().min(1),
  strategyId: z.string().min(1),
  walkForward: z.object({ inSampleFrom: iso, inSampleTo: iso, outOfSampleFrom: iso, outOfSampleTo: iso }),
  inSample: activity,
  outOfSample: activity,
  outOfSampleLabel: z.enum(['Out-of-sample: passed', 'Out-of-sample: failed', 'Out-of-sample: inconclusive']),
});
export type HistoricalResult = z.infer<typeof historicalResultSchema>;
export type HistoricalRequest = {
  strategyId: string;
  symbol: string;
  walkForward: HistoricalResult['walkForward'];
  outOfSampleStatus: 'passed' | 'failed' | 'inconclusive';
  strategyVariantCount: number;
  costModel: {
    fees: { kind: string; source: string };
    slippage: { kind: string; source: string };
    latency: { kind: string; source: string };
  };
  environment: 'backtest';
  presentedAs: 'simulated';
  idempotencyKey: string;
};
/** This is a RAM projection of one reply and its declared request. It has no
 * original settlement capability; bt_strategy labels repeat across runs. */
export type HistoricalSnapshot = { data: HistoricalResult; request: HistoricalRequest; view: object };
export function matchesHistoricalRequest(data: HistoricalResult, request: HistoricalRequest) {
  return (
    data.strategyId === request.strategyId &&
    data.runId === `bt_${request.strategyId}` &&
    Object.entries(request.walkForward).every(([field, value]) => data.walkForward[field as keyof typeof request.walkForward] === value) &&
    data.outOfSampleLabel === `Out-of-sample: ${request.outOfSampleStatus}`
  );
}
/** Explicit UTC controls avoid silently changing an interval with device zone
 * or a DST normalization. Calendar normalization is rejected by round-trip. */
export function utcInput(value: string): string | undefined {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return undefined;
  const date = new Date(value + ':00Z');
  if (!Number.isFinite(date.getTime())) return undefined;
  const canonical = date.toISOString();
  return canonical.slice(0, 16) === value ? canonical : undefined;
}

/** The cost models the service accepts for each cost, in the order the form lists them. */
export const COST_MODELS = {
  fees: ['venue-schedule', 'tiered-venue-schedule'],
  slippage: ['order-book-replay', 'measured-impact'],
  latency: ['measured-distribution', 'event-replay'],
} as const;
export type CostKey = keyof typeof COST_MODELS;
/** Plain-English copy key for each model the service accepts, so the raw model names never reach the page. */
export const MODEL_COPY = {
  'venue-schedule': 'feesVenue',
  'tiered-venue-schedule': 'feesTiered',
  'order-book-replay': 'slippageBook',
  'measured-impact': 'slippageImpact',
  'measured-distribution': 'latencyDistribution',
  'event-replay': 'latencyEvents',
} as const;
export const HYPOTHESIS_COPY = { inconclusive: 'hypothesisNone', passed: 'hypothesisPassed', failed: 'hypothesisFailed' } as const;
/** What the customer expects before the run. The service takes it as an input and does not compute a verdict yet. */
export const HYPOTHESES = ['inconclusive', 'passed', 'failed'] as const;
export type Hypothesis = (typeof HYPOTHESES)[number];
/**
 * Strategies that can be analysed: the named Studio draft kept on this device. The shared library is closed, so a
 * strategy the customer never made can never be picked. An unnamed draft is not offered because it has no label.
 */
export function draftStrategyNames(draft: StudioDraft | null): string[] {
  const name = draft?.name.trim();
  return name ? [name] : [];
}
