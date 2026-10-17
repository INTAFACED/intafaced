/**
 * PAY_MERCHANT_CONTROLS = off | required   (default: off)
 *
 *   off       the W1 guards are no-ops: payments and payouts behave exactly as
 *             they did before the control room existed. The procedures that read
 *             and configure tiers, caps and pricing work in both modes.
 *   required  caps, pricing and payout thresholds are ENFORCED. A merchant with
 *             no tier, an unconfigured cap, rule or threshold is refused with a
 *             typed error (pay.tier_unassigned, pay.caps_unconfigured,
 *             pay.pricing_unconfigured, pay.approval_threshold_unconfigured).
 *
 * Any other value fails boot (never silently falls back to `off`), the same
 * refuse-closed shape as the other owner switches. Why a switch at all: no
 * business numbers are agreed, so on merge every merchant is unconfigured and
 * `required` would stop every payment. Turn it on per environment once an owner
 * has configured tiers.
 */
export type MerchantControlsMode = 'off' | 'required';

export class MerchantControlsModeError extends Error {
  constructor(raw: string) {
    super(`PAY_MERCHANT_CONTROLS must be "off" or "required", got ${JSON.stringify(raw)}`);
    this.name = 'MerchantControlsModeError';
  }
}

export function parseMerchantControlsMode(raw: string | undefined | null): MerchantControlsMode {
  if (raw === undefined || raw === null) return 'off';
  if (raw === 'off' || raw === 'required') return raw;
  throw new MerchantControlsModeError(raw);
}
