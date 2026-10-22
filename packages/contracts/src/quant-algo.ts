/**
 * Algo dev contract (J-algo-dev-01): the shapes the customer Algo dev rooms read from svc-quant.
 *
 * Browser safe: nothing here imports Node. Every figure a strategy or run carries is simulated; nothing here is a
 * balance or a ledger amount.
 */
import { z } from 'zod';

/** The quick start on the Algo dev home. Each step is true only when the account's own stored rows show it. */
export const quantQuickStartOutputSchema = z.object({
  strategy: z.boolean(),
  backtest: z.boolean(),
  paperRun: z.boolean(),
});
export type QuantQuickStart = z.infer<typeof quantQuickStartOutputSchema>;

/** One saved strategy as a list shows it: the head of its versions. The service sends more fields; these are read. */
export const quantStrategySummarySchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  version: z.number().int().positive(),
  createdAt: z.string(),
});
export type QuantStrategySummary = z.infer<typeof quantStrategySummarySchema>;

/** `studio.list`: the caller's undeleted strategies, one page. */
export const quantStrategyListOutputSchema = z.object({
  strategies: z.array(quantStrategySummarySchema),
  nextCursor: z.string().nullable(),
});
