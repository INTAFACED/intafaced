import { z } from 'zod';
import { VOUCHER_STATES, REWARD_STATES, CAMPAIGN_STATES, CAMPAIGN_TYPES, voucherCode } from './campaigns-catalogue.js';

/**
 * The operator's watch desk for running campaigns (J-campaigns-17, CM-campaign-admin-01, -02, CM-campaign-types-03).
 * Shared by svc-campaigns and the founder console. Browser-safe: zod only.
 *
 * - Every figure is counted from svc-campaigns' own rows on each read; nothing here is stored as a total.
 * - A budget is a limit, never a balance: `reserved` is what open rewards hold of it, `spent` what booked rewards took,
 *   and `left` the limit less both, so `limit = reserved + spent + left` on every row. No money moves from this desk.
 * - A code made in a batch or imported is stored as its SHA-256 hash and its last four characters only. Its plain text
 *   is returned once, in the answer to the generate that made it, and by no door afterwards.
 */

const id = z.string().min(1).max(128);
const iso = z.string().datetime({ offset: true });
const asset = z.string().regex(/^[A-Z0-9]{2,12}$/);
const count = z.number().int().min(0);
/** A decimal that may read below zero: `left` once rewards drew more than a lowered limit. */
const signedDecimal = z.string().regex(/^-?(0|[1-9]\d{0,19})(\.\d{1,18})?$/);
const decimal = z.string().regex(/^(0|[1-9]\d{0,19})(\.\d{1,18})?$/);

/** The most rows of each part one read lists, newest first; the count beside it is every row. */
export const WATCH_LIST_LIMIT = 100;
/** How many days the redemption trend covers, today (UTC) included. */
export const TREND_DAYS = 14;
/** How many campaigns the top list names. */
export const TOP_CAMPAIGNS = 5;

/** A budget split: `limit = reserved + spent + left`. */
export const budgetSplitSchema = z.object({ asset, limit: decimal, reserved: decimal, spent: decimal, left: signedDecimal });
export type BudgetSplit = z.infer<typeof budgetSplitSchema>;

/**
 * Alerts the desk can raise. Each reads its threshold from an owner value; a blank threshold reads "not set" and refuses
 * to be switched on (`campaigns.alert_threshold_unset`), never a default.
 * - `budget_low`: a running campaign has less than the threshold percent of its budget left.
 * - `redemptions_spike`: more rewards and redemptions than the threshold in the last hour, across every campaign.
 */
export const ALERT_KINDS = ['budget_low', 'redemptions_spike'] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];
export const ALERT_SETTING: Record<AlertKind, string> = {
  budget_low: 'CAMPAIGNS_ALERT_BUDGET_LEFT_PERCENT',
  redemptions_spike: 'CAMPAIGNS_ALERT_REDEMPTIONS_PER_HOUR',
};

export const watchAlertSchema = z.object({
  kind: z.enum(ALERT_KINDS),
  title: z.string(),
  /** The owner value as set, or null: "not set". */
  threshold: z.string().nullable(),
  setting: z.string(),
  enabled: z.boolean(),
  /** What trips it now; empty while it is off or its threshold is blank. */
  firing: z.array(z.object({ campaignId: id.nullable(), name: z.string(), detail: z.string() })),
});
export type WatchAlert = z.infer<typeof watchAlertSchema>;

export const watchOverviewSchema = z.object({
  asOf: iso,
  kpis: z.object({
    /** Campaigns that went live (scheduled, active, paused, ended or closed). */
    running: count,
    live: count,
    participants: count,
    vouchersIssued: count,
    vouchersClaimed: count,
    /** Rewards and voucher redemptions that hold or spent budget (not failed, forfeited or withheld). */
    redemptions: count,
  }),
  /** Summed over running campaigns, one row per budget asset. */
  budgets: z.array(budgetSplitSchema),
  trend: z.array(z.object({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), redemptions: count })),
  top: z.array(z.object({ campaignId: id, name: z.string(), state: z.enum(CAMPAIGN_STATES), redemptions: count, participants: count })),
  /** Every running campaign, newest first (at most `WATCH_LIST_LIMIT`), to open one. */
  campaigns: z.array(z.object({ campaignId: id, name: z.string(), state: z.enum(CAMPAIGN_STATES) })),
  alerts: z.array(watchAlertSchema),
});
export type WatchOverview = z.infer<typeof watchOverviewSchema>;

export const alertEnableInputSchema = z.object({ kind: z.enum(ALERT_KINDS), enabled: z.boolean() }).strict();

// ── Code batches (CM-campaign-types-03) ─────────────────────────────────────────────────────────────────────────────

export const CODE_BATCH_SOURCES = ['generated', 'imported'] as const;
export const codeBatchSchema = z.object({
  id,
  campaignId: id,
  /** The operator's name for the batch: with the campaign it is the batch's business key. */
  reference: z.string(),
  source: z.enum(CODE_BATCH_SOURCES),
  count: z.number().int().positive(),
  state: z.enum(['generated', 'published']),
  createdBy: z.string(),
  createdAt: iso,
  publishedBy: z.string().nullable(),
  publishedAt: iso.nullable(),
});
export type CodeBatch = z.infer<typeof codeBatchSchema>;

const reference = z.string().regex(/^[A-Za-z0-9 _.:-]{1,80}$/);
/** The most codes one generate or import carries on the wire; the owner's batch limit is read below it. */
export const CODE_BATCH_WIRE_MAX = 20_000;

export const codeGenerateInputSchema = z
  .object({ campaignId: id, reference, count: z.number().int().min(1).max(CODE_BATCH_WIRE_MAX) })
  .strict();
export const codeImportInputSchema = z
  .object({ campaignId: id, reference, codes: z.array(voucherCode).min(1).max(CODE_BATCH_WIRE_MAX) })
  .strict();
export const codeBatchResultSchema = z.object({
  batch: codeBatchSchema,
  /**
   * The plain codes, only in the answer to the generate that made the batch: they are not stored, so a second generate
   * under the same reference returns the batch with `codes: null`. An import returns null too: the operator holds the file.
   */
  codes: z.array(z.string()).nullable(),
  created: z.boolean(),
});
export type CodeBatchResult = z.infer<typeof codeBatchResultSchema>;
export const codePublishInputSchema = z.object({ batchId: id }).strict();
export const voucherDeactivateInputSchema = z.object({ voucherId: id }).strict();

export const watchVoucherSchema = z.object({
  id,
  /** The last four characters of the code; the plain code is never returned. */
  codeLastFour: z.string(),
  state: z.enum(VOUCHER_STATES),
  batchId: id.nullable(),
  claimedBy: z.string().nullable(),
  claimedAt: iso.nullable(),
  issuedAt: iso,
});
export type WatchVoucher = z.infer<typeof watchVoucherSchema>;

// ── Exports (CM-campaign-admin-02) ──────────────────────────────────────────────────────────────────────────────────

export const EXPORT_DATASETS = ['participants', 'redemptions', 'vouchers'] as const;
export type ExportDataset = (typeof EXPORT_DATASETS)[number];
/** The fields each export may carry; a voucher export carries the last four characters, never a code. */
export const EXPORT_FIELDS = {
  participants: ['accountId', 'joinedAt'],
  redemptions: ['rewardKey', 'accountId', 'asset', 'amount', 'state', 'createdAt', 'postedAt'],
  vouchers: ['voucherId', 'codeLastFour', 'state', 'batchId', 'claimedBy', 'claimedAt'],
} as const satisfies Record<ExportDataset, readonly string[]>;
export type ExportField = (typeof EXPORT_FIELDS)[ExportDataset][number];

export const exportRequestInputSchema = z
  .object({
    campaignId: id,
    dataset: z.enum(EXPORT_DATASETS),
    fields: z
      .array(z.string().min(1).max(40))
      .min(1)
      .max(10)
      .refine((f) => new Set(f).size === f.length, 'Each field once'),
  })
  .strict()
  .refine((i) => i.fields.every((f) => (EXPORT_FIELDS[i.dataset] as readonly string[]).includes(f)), {
    message: 'A field this export does not carry',
    path: ['fields'],
  });
export type ExportRequestInput = z.infer<typeof exportRequestInputSchema>;

export const exportJobSchema = z.object({
  id,
  campaignId: id,
  dataset: z.enum(EXPORT_DATASETS),
  fields: z.array(z.string()),
  state: z.enum(['queued', 'running', 'ready', 'failed']),
  requestedBy: z.string(),
  requestedAt: iso,
  readyAt: iso.nullable(),
  /** When the download link stops working; after it the file refuses `campaigns.export_expired` and is deleted. */
  expiresAt: iso.nullable(),
  rows: count.nullable(),
});
export type ExportJob = z.infer<typeof exportJobSchema>;
export const exportRequestResultSchema = z.object({
  job: exportJobSchema,
  /** False when the same export was asked for while its job was open or its link valid: that job is returned. */
  created: z.boolean(),
});
export type ExportRequestResult = z.infer<typeof exportRequestResultSchema>;
export const exportDownloadInputSchema = z.object({ id }).strict();
export const exportFileSchema = z.object({ filename: z.string(), body: z.string(), rows: count });
export type ExportFile = z.infer<typeof exportFileSchema>;

// ── One campaign (CM-campaign-admin-01) ─────────────────────────────────────────────────────────────────────────────

export const watchCampaignInputSchema = z.object({ id }).strict();
export const watchCampaignSchema = z.object({
  asOf: iso,
  campaign: z.object({ id, name: z.string(), type: z.enum(CAMPAIGN_TYPES), state: z.enum(CAMPAIGN_STATES) }),
  budget: budgetSplitSchema.nullable(),
  participation: z.object({ count, rows: z.array(z.object({ accountId: z.string(), joinedAt: iso })) }),
  vouchers: z.object({
    count,
    byState: z.array(z.object({ state: z.enum(VOUCHER_STATES), count })),
    rows: z.array(watchVoucherSchema),
  }),
  redemptions: z.object({
    count,
    rows: z.array(
      z.object({ rewardKey: z.string(), accountId: z.string(), asset, amount: decimal, state: z.enum(REWARD_STATES), createdAt: iso }),
    ),
  }),
  publications: z.object({
    count,
    rows: z.array(z.object({ id, batchId: id, reference: z.string(), vouchers: count, publishedBy: z.string(), publishedAt: iso })),
  }),
  batches: z.array(codeBatchSchema),
  exports: z.array(exportJobSchema),
});
export type WatchCampaign = z.infer<typeof watchCampaignSchema>;
