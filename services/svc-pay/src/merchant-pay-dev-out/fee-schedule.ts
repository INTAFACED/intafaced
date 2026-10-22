import type { Sql } from 'postgres';
import { z } from 'zod';
import { formatAmount, type Amount } from '@intafaced/ledger-client';
import { loadMerchantControl } from '../control/store.js';
import type { PricingRule } from '../control/pricing.js';
import type { MerchantRole } from '../merchant-ops/roles.js';

/**
 * M-money-out-06: the processing fee schedule and the payout fee line, read only.
 *
 * Payout fee: no payout fee exists in code (settlement and payout book none), so
 * every quote and the schedule say `not_charged`. Nothing invents a figure.
 *
 * Channels: a pricing rule is per asset (global → tier → merchant layer), not per
 * channel. A payment link, an API payment and a hosted checkout are priced by the
 * same resolved rule, so the schedule lists each channel against the same row and
 * says so (`samePricingForEveryChannel: true`) instead of publishing per-channel
 * figures the tier does not hold.
 *
 * Who sees what: the owner and the finance role see the full schedule (bands,
 * minimum, maximum, spread, layer). Every other viewer sees the headline rate
 * only (the first band's fee per asset). No rule for any asset reads
 * `not_configured` ("Pricing has not been assigned").
 */
export const PAYOUT_FEE_NOT_CHARGED = { status: 'not_charged' } as const;
export const payoutFeeLineSchema = z.object({ status: z.literal('not_charged') }).strict();

export const FEE_CHANNELS = ['payment_link', 'api', 'checkout'] as const;

const bandSchema = z.object({ fromAmount: z.string(), feeBps: z.number().int(), flatFee: z.string().nullable() }).strict();

const fullRowSchema = z
  .object({
    assetCode: z.string(),
    layer: z.enum(['global', 'tier', 'merchant']),
    ruleId: z.string().uuid(),
    version: z.string(),
    bands: z.array(bandSchema).min(1),
    minFee: z.string().nullable(),
    maxFee: z.string().nullable(),
    spreadBps: z.number().int().nullable(),
  })
  .strict();

const headlineRowSchema = z.object({ assetCode: z.string(), headlineFeeBps: z.number().int() }).strict();

export const merchantFeeScheduleSchema = z.union([
  z.object({ status: z.literal('not_configured'), merchantId: z.string().uuid(), payoutFee: payoutFeeLineSchema }).strict(),
  z
    .object({
      status: z.literal('configured'),
      merchantId: z.string().uuid(),
      view: z.literal('full'),
      channels: z.array(z.enum(FEE_CHANNELS)),
      samePricingForEveryChannel: z.literal(true),
      rows: z.array(fullRowSchema),
      payoutFee: payoutFeeLineSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal('configured'),
      merchantId: z.string().uuid(),
      view: z.literal('headline'),
      rows: z.array(headlineRowSchema),
      payoutFee: payoutFeeLineSchema,
    })
    .strict(),
]);
export type MerchantFeeSchedule = z.infer<typeof merchantFeeScheduleSchema>;

const SCHEDULE_ROLES: ReadonlySet<MerchantRole> = new Set<MerchantRole>(['owner', 'finance']);

export async function readFeeSchedule(
  sql: Sql,
  merchantId: string,
  role: MerchantRole | null,
  loadRules: (merchantId: string, tierId: string | null) => Promise<PricingRule[]>,
): Promise<MerchantFeeSchedule> {
  const control = await loadMerchantControl(sql, merchantId);
  const rules = await loadRules(merchantId, control.tier?.id ?? null);
  if (rules.length === 0) return { status: 'not_configured', merchantId, payoutFee: PAYOUT_FEE_NOT_CHARGED };
  if (!role || !SCHEDULE_ROLES.has(role)) {
    return {
      status: 'configured',
      merchantId,
      view: 'headline',
      rows: rules.map((r) => ({ assetCode: r.assetCode, headlineFeeBps: r.bands[0]!.feeBps })),
      payoutFee: PAYOUT_FEE_NOT_CHARGED,
    };
  }
  const f = (a: Amount | null) => (a === null ? null : formatAmount(a));
  return {
    status: 'configured',
    merchantId,
    view: 'full',
    channels: [...FEE_CHANNELS],
    samePricingForEveryChannel: true,
    rows: rules.map((r) => ({
      assetCode: r.assetCode,
      layer: r.layer,
      ruleId: r.id,
      version: r.version.toString(),
      bands: r.bands.map((b) => ({ fromAmount: formatAmount(b.fromAmount), feeBps: b.feeBps, flatFee: f(b.flatFee) })),
      minFee: f(r.minFee),
      maxFee: f(r.maxFee),
      spreadBps: r.spreadBps,
    })),
    payoutFee: PAYOUT_FEE_NOT_CHARGED,
  };
}

/**
 * The fee as a rate of the amount, in basis points, as a decimal string with four
 * places, rounded down (a quote never overstates the rate it shows). Zero amount:
 * null (no rate).
 */
export function effectiveRateBps(fee: Amount, amount: Amount): string | null {
  if (amount <= 0n) return null;
  const scaled = (fee * 10_000n * 10_000n) / amount;
  const whole = scaled / 10_000n;
  const frac = (scaled % 10_000n).toString().padStart(4, '0');
  return `${whole}.${frac}`;
}
