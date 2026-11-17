// hand-declared-ok: svc-trade's GET /api/v1/account/fee-tier has no schema in packages/contracts; this mirrors its answer
/**
 * The signed-in person's own fee tier (`GET /api/v1/account/fee-tier`, svc-trade, SP-fees-vip-03): the tier their next
 * order is charged at, the volume counted toward the next snapshot, the owner's thresholds, and their snapshot rows.
 * Volumes are decimal strings; nothing here is a balance or a sample.
 */
import { z } from 'zod';
import type { ApiClient, ApiResult } from '../../shared/api';
import type { Fetcher } from '../../data/poll';
import { FEE_SCHEDULE_BLANK } from './fees';

const decimal = z.string().regex(/^[0-9]+(\.[0-9]+)?$/);

const snapshotSchema = z.object({
  key: z.string().min(1),
  instant: z.string().min(1),
  tierId: z.string().min(1),
  volume30d: decimal,
  countedFills: z.number().int().min(0),
  scheduleVersion: z.string().min(1),
});

const benefitsSchema = z.object({
  tierId: z.string().min(1),
  prioritySupport: z.boolean().nullable(),
  vipPortal: z.boolean().nullable(),
  ambassador: z.boolean().nullable(),
  subAccountCap: z.number().int().min(0).nullable(),
  withdrawalLimit24h: z.object({ asset: z.string().min(1), amount: decimal }).nullable(),
});

const passSchema = z.object({
  passKey: z.string().min(1),
  campaignId: z.string().min(1),
  tierId: z.string().min(1),
  startsAt: z.string().min(1),
  endsAt: z.string().min(1),
  grantedAt: z.string().min(1),
  endedAt: z.string().nullable(),
  endReason: z.enum(['expired', 'replaced']).nullable(),
  replacedBy: z.string().nullable(),
});
export type FeeTierPass = z.infer<typeof passSchema>;

export const EXCLUSIONS = ['other_quotes', 'futures_and_options', 'bots_and_copy', 'sub_accounts', 'assets'] as const;

export const feeTierSchema = z.object({
  tier: z.string().min(1),
  scheduleVersion: z.string().min(1),
  program: z
    .object({
      thresholds: z.array(z.object({ tierId: z.string().min(1), minVolume30d: decimal })).min(1),
      volumeQuotes: z.array(z.string().min(1)).min(1),
      snapshotTimeUtc: z.string().nullable(),
      /** The owner's benefits table, one row per tier; null: not published. */
      benefits: z.array(benefitsSchema).nullable(),
      downgradeGraceDays: z.null(),
      subAccounts: z.null(),
      botsAndCopy: z.null(),
      assets: z.null(),
    })
    .nullable(),
  volume: z
    .object({ amount: decimal, fills: z.number().int().min(0), from: z.string(), to: z.string(), reaches: z.string().min(1) })
    .nullable(),
  next: z.object({ tierId: z.string().min(1), minVolume30d: decimal, remaining: decimal }).nullable(),
  snapshotsRunning: z.boolean(),
  nextSnapshotAt: z.string().nullable(),
  lastSnapshot: snapshotSchema.nullable(),
  /** The VIP trial the tier comes from (an approved application), or none. */
  trial: z
    .object({ applicationId: z.string().min(1), tierId: z.string().min(1), startsAt: z.string().min(1), endsAt: z.string().min(1) })
    .nullable()
    .optional(),
  /** The VIP trial pass in force (a campaign reward, J-campaigns-14), or none. */
  pass: passSchema.nullable().optional(),
  /** The person's passes, newest grant first, each with how it ended. */
  passes: z.array(passSchema).optional(),
  /** Each tier's rates in the owner's default pair group, and its taker rate over regular's; null: no rows schedule. */
  rates: z
    .array(
      z.object({
        tierId: z.string().min(1),
        makerBps: z.number().int().min(0),
        takerBps: z.number().int().min(0),
        takerMultiplier: decimal.nullable(),
      }),
    )
    .nullable()
    .optional(),
  snapshots: z.array(snapshotSchema),
  excluded: z.array(z.enum(EXCLUSIONS)),
});

export type FeeTier = z.infer<typeof feeTierSchema>;
export type FeeTierSnapshot = z.infer<typeof snapshotSchema>;
export type FeeTierBenefits = z.infer<typeof benefitsSchema>;

/** An unpublished schedule answers 503 with the blank code: an answer ("not set", here `null`), not an outage. */
export const feeTierFetcher =
  (api: ApiClient): Fetcher<FeeTier | null> =>
  async (signal): Promise<ApiResult<FeeTier | null>> => {
    const result = await api.rest('/account/fee-tier', feeTierSchema, { signal });
    return !result.ok && result.code === FEE_SCHEDULE_BLANK ? { ok: true, data: null } : result;
  };

/** "2026-10-24 07:00 UTC": a snapshot is taken on the minute. */
export const snapshotTime = (iso: string): string => `${iso.slice(0, 16).replace('T', ' ')} UTC`;
