import { isExplicitDevOrTest } from '@intafaced/config';

/**
 * PAY_MERCHANT_CONTROLS = off | required
 *
 *   off       legal only when the raw APP_ENV is exactly `dev` or `test`.
 *             The W1 guards are no-ops: payments and payouts behave as they
 *             did before the control room existed. Procedures that read and
 *             configure tiers, caps and pricing work in both modes.
 *   required  the production value. Caps, pricing and payout thresholds are
 *             enforced. A merchant with no tier, an unconfigured cap, rule or
 *             threshold is refused with a typed error (pay.tier_unassigned,
 *             pay.caps_unconfigured, pay.pricing_unconfigured,
 *             pay.approval_threshold_unconfigured). A payout at or above the
 *             maker-checker threshold consumes one approval inside the
 *             admission transaction, or the admission is not written.
 *
 * Unset, blank, and `off` refuse to boot when APP_ENV is anything other than
 * exactly `dev` or `test` (unset, blank, staging, prod, production, a typo,
 * a different case). There is no schema default of `off`: that default wrote
 * a payout admission without consuming the approval. Any other flag value
 * fails boot and never falls through to `off`.
 *
 * The raw APP_ENV is read. `baseEnvSchema` defaults an unset APP_ENV to `dev`,
 * and using that default here would let a host that forgot APP_ENV run with
 * the controls off. JURISFAIL has not merged (`assertScreeningConfigured`
 * still uses `APP_ENV ?? 'dev'`). This guard does not. Unset APP_ENV is not
 * an explicit dev/test value, which is the same rule JURISFAIL will land.
 */
export type MerchantControlsMode = 'off' | 'required';

export const MERCHANT_CONTROLS_BOOT_CODE = 'pay.merchant_controls_boot_refused' as const;

export class MerchantControlsModeError extends Error {
  readonly code = MERCHANT_CONTROLS_BOOT_CODE;
  constructor(message: string) {
    super(message);
    this.name = 'MerchantControlsModeError';
  }
}

export type MerchantControlsEnv = {
  readonly APP_ENV?: string | null;
  readonly PAY_MERCHANT_CONTROLS?: string | null;
};

function appEnvLabel(appEnv: string | null | undefined): string {
  if (typeof appEnv !== 'string' || appEnv.trim() === '') return '(unset)';
  return appEnv.trim();
}

/**
 * Resolve the flag against the raw env map. `required` is accepted in every
 * APP_ENV. `off` and an unset or blank flag are accepted only for exact
 * `dev` or `test`, where they mean `off`.
 */
export function parseMerchantControlsMode(env: MerchantControlsEnv): MerchantControlsMode {
  const raw = env.PAY_MERCHANT_CONTROLS;
  const unset = raw == null || (typeof raw === 'string' && raw.trim() === '');
  const local = isExplicitDevOrTest(env.APP_ENV);
  const named = appEnvLabel(env.APP_ENV);

  if (unset) {
    if (local) return 'off';
    throw new MerchantControlsModeError(
      `PAY_MERCHANT_CONTROLS is unset and APP_ENV=${named} is not exactly "dev" or "test". The production value is "required". Refusing to boot (${MERCHANT_CONTROLS_BOOT_CODE}).`,
    );
  }

  const value = raw as string;
  if (value === 'required') return 'required';
  if (value === 'off') {
    if (local) return 'off';
    throw new MerchantControlsModeError(
      `PAY_MERCHANT_CONTROLS=off is refused when APP_ENV=${named} is not exactly "dev" or "test". The production value is "required". Refusing to boot (${MERCHANT_CONTROLS_BOOT_CODE}).`,
    );
  }
  throw new MerchantControlsModeError(
    `PAY_MERCHANT_CONTROLS must be "off" or "required", got ${JSON.stringify(value)}. Refusing to boot (${MERCHANT_CONTROLS_BOOT_CODE}).`,
  );
}
