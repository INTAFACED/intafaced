import { isExplicitDevOrTest } from '@intafaced/config';

/**
 * PAY_MERCHANT_CONTROLS = off | required
 *
 * There is no default outside an explicit dev or test run. Unset or blank
 * refuses boot, and `off` refuses boot, unless APP_ENV is exactly `dev` or
 * `test` (read raw: an unset APP_ENV is production). `required` is the value
 * for every real deployment. See `resolveMerchantControlsMode`.
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
 * has configured tiers (see control/README.md, pre-enable checklist).
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

export type MerchantControlsBootCode = 'pay.merchant_controls_unset' | 'pay.merchant_controls_off_refused';

/** Boot refusal: the merchant controls would have been silently off outside dev or test. */
export class MerchantControlsBootError extends Error {
  constructor(
    readonly code: MerchantControlsBootCode,
    appEnv: string | undefined | null,
  ) {
    const named = typeof appEnv === 'string' && appEnv.trim() !== '' ? appEnv.trim() : '(unset)';
    super(
      code === 'pay.merchant_controls_unset'
        ? `PAY_MERCHANT_CONTROLS is unset or blank and APP_ENV=${named} is not an explicit dev or test run. Set it to "required". Refusing to boot.`
        : `PAY_MERCHANT_CONTROLS=off is only allowed when APP_ENV is exactly "dev" or "test" (APP_ENV=${named}). Set it to "required". Refusing to boot.`,
    );
    this.name = 'MerchantControlsBootError';
  }
}

/**
 * The mode the process boots with. Reads the RAW `APP_ENV`, never the service
 * schema's default (an unset APP_ENV there becomes `dev`, which would let a
 * production host that forgot it run with the controls off).
 *
 *   explicit dev or test   unset or blank is `off`; `off` and `required` are allowed
 *   anything else          unset or blank refuses boot; `off` refuses boot; `required` is the only value
 *
 * Any value that is not `off` or `required` fails boot in every environment.
 */
export function resolveMerchantControlsMode(raw: string | undefined | null, appEnv: string | undefined | null): MerchantControlsMode {
  const devOrTest = isExplicitDevOrTest(appEnv);
  if (raw === undefined || raw === null || raw.trim() === '') {
    if (!devOrTest) throw new MerchantControlsBootError('pay.merchant_controls_unset', appEnv);
    return 'off';
  }
  const mode = parseMerchantControlsMode(raw);
  if (mode === 'off' && !devOrTest) throw new MerchantControlsBootError('pay.merchant_controls_off_refused', appEnv);
  return mode;
}
