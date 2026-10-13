import { z } from 'zod';
import { signedDecimalSchema } from '../../shared/money';

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
