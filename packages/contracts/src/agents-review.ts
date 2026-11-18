/**
 * WHAT MY AGENTS DID (AG-analytics-01, AG-audit-01, AG-usage-02; J-agents-13): what svc-agents `analytics.summary`,
 * `run.trace`, `log.count`, `log.export` and `usage.summary` answer. Browser-safe: zod only. Read only; amounts and
 * costs are unsigned decimal strings, never a `number`; spend is the sum of sealed usage windows as stored.
 */

import { z } from 'zod';
import { assetIdSchema } from './asset-id.js';

/** An unsigned exact decimal string such as `0.0001234`. */
const decimal = z.string().regex(/^\d+(\.\d+)?$/);
const count = z.number().int().nonnegative();

export const ACTION_KINDS = ['session_open', 'session_close', 'completion', 'embedding', 'tool_call', 'usage_settlement'] as const;
export const ACTION_OUTCOMES = ['executed', 'refused', 'failed'] as const;
export const actionOutcomeSchema = z.enum(ACTION_OUTCOMES);
export type ActionOutcome = z.infer<typeof actionOutcomeSchema>;

export const reviewAmountSchema = z.object({ assetId: assetIdSchema.min(1), amount: decimal });

export const reviewDayFiguresSchema = z.object({
  day: z.string(),
  sessions: count,
  actions: count,
  executed: count,
  refused: count,
  failed: count,
  /** Test and dry runs of the day; null when the filter leaves them out. */
  testRuns: count.nullable(),
  spend: z.array(reviewAmountSchema),
});

/** `analytics.summary`: the person's dashboard over a range of UTC days, both ends included. */
export const analyticsSummarySchema = z.object({
  from: z.string(),
  to: z.string(),
  includesTest: z.boolean(),
  totals: reviewDayFiguresSchema.omit({ day: true }),
  days: z.array(reviewDayFiguresSchema),
});
export type AnalyticsSummary = z.infer<typeof analyticsSummarySchema>;

export const RUN_PLAN_STATES = ['admitted', 'running', 'waiting_approval', 'completed', 'refused', 'failed'] as const;

/** `run.trace`: one run of one of the person's sessions as timed plan steps and engine or tool calls. */
export const runTraceSchema = z.object({
  runId: z.string(),
  requestId: z.string(),
  sessionId: z.string(),
  agentId: z.string(),
  task: z.string().nullable(),
  state: z.string(),
  cost: decimal.nullable(),
  assetId: assetIdSchema.nullable(),
  startedAt: z.string(),
  plan: z.array(
    z.object({
      sequence: z.number().int(),
      state: z.enum(RUN_PLAN_STATES),
      code: z.string().nullable(),
      startedAt: z.string(),
      tookMs: z.number().int().nullable(),
    }),
  ),
  calls: z.array(
    z.object({
      actionId: z.string(),
      sequence: z.number().int(),
      kind: z.enum(ACTION_KINDS),
      status: actionOutcomeSchema,
      tool: z.string().nullable(),
      task: z.string().nullable(),
      startedAt: z.string(),
      finishedAt: z.string(),
      tookMs: count,
      inputTokens: z.string().regex(/^\d+$/),
      outputTokens: z.string().regex(/^\d+$/),
      cost: decimal,
      refusalCode: z.string().nullable(),
    }),
  ),
});
export type RunTrace = z.infer<typeof runTraceSchema>;

/** One row of the person's activity log, as `log.mine` and `log.export` answer it. */
export const actionLogRowSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  agentId: z.string(),
  sequence: count,
  kind: z.enum(ACTION_KINDS),
  status: actionOutcomeSchema,
  tool: z.string().nullable(),
  task: z.string().nullable(),
  model: z.string().nullable(),
  inputTokens: z.string().regex(/^\d+$/),
  outputTokens: z.string().regex(/^\d+$/),
  cost: decimal,
  refusalCode: z.string().nullable(),
  messageKey: z.string(),
  messageParams: z.record(z.string(), z.union([z.string(), z.number()])),
  occurredAt: z.string(),
});
export type ActionLogRow = z.infer<typeof actionLogRowSchema>;

/** `log.count`: how many rows the log holds for one outcome or all: what an export of that filter will hold. */
export const actionLogCountSchema = z.object({ total: count });

/** The most rows one `log.export` page returns. */
export const ACTION_LOG_EXPORT_PAGE = 500;

/** `log.export`: one page of the whole filtered log, newest first; `nextCursor` is null on the last page. */
export const actionLogExportPageSchema = z.object({
  rows: z.array(actionLogRowSchema).max(ACTION_LOG_EXPORT_PAGE),
  nextCursor: z.string().nullable(),
});

export const usageGroupSchema = z.object({
  key: z.string(),
  name: z.string().nullable(),
  windows: count,
  assetId: assetIdSchema.min(1),
  amount: decimal,
});

/** `usage.summary`: sealed usage windows, and their totals by agent, user and task, each adding up to the same total. */
export const usageSummarySchema = z.object({
  windowCount: count,
  windows: z.array(
    z.object({
      sessionId: z.string(),
      agentId: z.string(),
      agentName: z.string().nullable(),
      windowId: z.string(),
      day: z.string(),
      task: z.string(),
      state: z.enum(['unpaid', 'settled']),
      amount: decimal,
      assetId: assetIdSchema.min(1),
    }),
  ),
  total: z.array(reviewAmountSchema),
  byAgent: z.array(usageGroupSchema),
  byUser: z.array(usageGroupSchema),
  byTask: z.array(usageGroupSchema),
});
export type UsageSummary = z.infer<typeof usageSummarySchema>;
