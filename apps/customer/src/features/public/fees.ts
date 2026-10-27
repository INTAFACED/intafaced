// hand-declared-ok: svc-trade's GET /api/v1/fees/published has no schema in packages/contracts; this mirrors its answer
/**
 * The public trading fee schedule (`GET /api/v1/fees/published`, svc-trade), signed in or not. Rates are basis points
 * of the traded value; nothing here invents one. A pair group the owner named but gave no row for a tier has no row in
 * the answer, and the page says "not set" for it.
 */
import { z } from 'zod';
import type { ApiClient, ApiResult } from '../../shared/api';
import type { Fetcher } from '../../data/poll';

const bpsSchema = z.number().int().min(0).max(9999);

export const publicFeeRowSchema = z.object({
  tierId: z.string().min(1),
  zeroFee: z.boolean(),
  makerBps: bpsSchema,
  takerBps: bpsSchema,
  makerRebateBps: bpsSchema.nullable(),
  minFee: z.string().nullable().optional(),
  /** Published, but an order on it is refused (a rebate or minimum fee the ledger cannot post): never shown as a rate. */
  refusal: z.string().optional(),
});

export const publicFeeScheduleSchema = z.object({
  version: z.string().min(1),
  groups: z.array(
    z.object({
      pairGroup: z.string().min(1),
      isDefault: z.boolean(),
      symbols: z.array(z.string()),
      rows: z.array(publicFeeRowSchema),
    }),
  ),
  tiers: z.array(z.string().min(1)).min(1),
});

export type PublicFeeSchedule = z.infer<typeof publicFeeScheduleSchema>;
export type PublicFeeRow = z.infer<typeof publicFeeRowSchema>;

/** The service answers an unpublished schedule with 503 and this code: an answer ("not set", here `null`), not an outage. */
export const FEE_SCHEDULE_BLANK = 'trade.fee_schedule_blank';

export const publicFeesFetcher =
  (api: ApiClient): Fetcher<PublicFeeSchedule | null> =>
  async (signal): Promise<ApiResult<PublicFeeSchedule | null>> => {
    const result = await api.rest('/fees/published', publicFeeScheduleSchema, { signal });
    return !result.ok && result.code === FEE_SCHEDULE_BLANK ? { ok: true, data: null } : result;
  };

/** 8 bps as the page writes it: "0.08%". Integer basis points only, so no float ever touches the rate. */
export function bpsAsPercent(bps: number): string {
  return `${Math.floor(bps / 100)}.${String(bps % 100).padStart(2, '0')}%`;
}

/** One tier's cell in one group: its published row, or null when the owner left it blank. */
export function rowFor(group: PublicFeeSchedule['groups'][number], tierId: string): PublicFeeRow | null {
  return group.rows.find((row) => row.tierId === tierId) ?? null;
}
