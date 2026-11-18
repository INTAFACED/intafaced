import { z } from 'zod';

// J-algo-dev-16: Monte Carlo on a finished backtest (RC-algo-dev-04), the market data lake (RC-algo-dev-02) and the
// account's live approval policy (RC-algo-dev-01). Every figure is simulated or is the exchange's own public market data;
// nothing here moves money. Amounts are decimal strings.

const decimalText = z.string().regex(/^-?\d+(\.\d{1,18})?$/);
const percentiles = z.object({ p5: decimalText, p25: decimalText, p50: decimalText, p75: decimalText, p95: decimalText });

export const quantMonteCarloInputSchema = z.object({
  runId: z.string().min(1).max(128),
  /** The seed the resampling draws from: the same run, count and seed always give the same distribution. */
  seed: z.number().int().min(0).max(2_147_483_647),
});

export const quantMonteCarloSchema = z.object({
  runId: z.string(),
  runs: z.number().int().positive(),
  seed: z.number().int().nonnegative(),
  roundTrips: z.number().int().positive(),
  startCash: decimalText,
  maxDrawdownPercent: percentiles,
  finalEquity: percentiles,
  /** Percent of resampled paths that reached the ruin level; null when the ruin level is not set. */
  ruinProbabilityPercent: decimalText.nullable(),
  /** The strategy's equity-stop floor (its risk screen) the paths are judged against; null when it is blank. */
  ruinLevel: decimalText.nullable(),
  simulated: z.literal(true),
  live: z.literal(false),
  claimLabel: z.literal('Simulated resampling of a historical simulation — not a forecast'),
});
export type QuantMonteCarlo = z.infer<typeof quantMonteCarloSchema>;

export const QUANT_LAKE_KINDS = ['tick', 'book', 'fill'] as const;
const range = z.object({ from: z.string(), to: z.string() });

export const quantLakeCatalogueInputSchema = z
  .object({ symbol: z.string().min(1).max(32).optional(), kind: z.enum(QUANT_LAKE_KINDS).optional() })
  .optional();

export const quantLakeDatasetSchema = z.object({
  kind: z.enum(QUANT_LAKE_KINDS),
  rows: z.number().int().nonnegative(),
  first: z.string().nullable(),
  last: z.string().nullable(),
  /** Times captured without a break longer than twice the capture interval. */
  coverage: z.array(range),
  /** Times nothing was captured between two captures, or a capture failed: shown as gaps, never filled. */
  gaps: z.array(range),
  /** The newest rows as stored, normalised. */
  latest: z.array(z.object({ observedAt: z.string(), payload: z.record(z.string(), z.unknown()) })),
});

export const quantLakeCatalogueSchema = z.object({
  captureSeconds: z.number().int().positive(),
  retentionDays: z.number().int().positive(),
  /** The oldest instant a row can still be held, by the retention. */
  keptFrom: z.string(),
  asOf: z.string(),
  symbols: z.array(
    z.object({
      symbol: z.string(),
      capturing: z.boolean(),
      datasets: z.array(quantLakeDatasetSchema),
    }),
  ),
  source: z.literal('INTAFACED exchange public market data'),
});
export type QuantLakeCatalogue = z.infer<typeof quantLakeCatalogueSchema>;

export const quantLakeCaptureInputSchema = z.object({
  symbol: z.string().min(1).max(32),
  capturing: z.boolean(),
  reason: z.string().trim().min(1).max(500),
  idempotencyKey: z.string().min(1).max(200),
});

export const QUANT_APPROVAL_DECISIONS = ['pending', 'approved', 'rejected'] as const;

export const quantApprovalPolicySchema = z.object({
  /** Null: the account has not set a policy. */
  required: z.boolean().nullable(),
  setAt: z.string().nullable(),
});

export const quantApprovalPolicySetInputSchema = z.object({
  required: z.boolean(),
  idempotencyKey: z.string().min(1).max(200),
});

export const quantApprovalRowSchema = z.object({
  approvalId: z.string(),
  strategyVersion: z.number().int().positive(),
  contentHash: z.string(),
  requester: z.string(),
  reviewer: z.string().nullable(),
  decision: z.enum(QUANT_APPROVAL_DECISIONS),
  reason: z.string(),
  requestedAt: z.string(),
  decidedAt: z.string().nullable(),
  /** False once the version's rules or the strategy's risk settings changed after the request: it no longer counts. */
  current: z.boolean(),
});

export const quantApprovalStateSchema = z.object({
  strategyId: z.string(),
  ownerId: z.string(),
  policy: quantApprovalPolicySchema,
  /** The newest version and the hash an approval of it binds to now. */
  version: z.number().int().positive(),
  contentHash: z.string(),
  /** Whether the newest version may go live under the policy now, and the refusal code when not. */
  live: z.object({ allowed: z.boolean(), code: z.string().nullable() }),
  approvals: z.array(quantApprovalRowSchema),
  /** The caller may decide: a teammate on the strategy who did not request it. */
  canDecide: z.boolean(),
});
export type QuantApprovalState = z.infer<typeof quantApprovalStateSchema>;

export const quantApprovalRequestInputSchema = z.object({
  strategyId: z.string().min(1).max(128),
  strategyVersion: z.number().int().positive(),
});

export const quantApprovalDecideInputSchema = z.object({
  strategyId: z.string().min(1).max(128),
  approvalId: z.string().min(1).max(64),
  decision: z.enum(['approved', 'rejected']),
  reason: z.string().trim().max(500),
});
