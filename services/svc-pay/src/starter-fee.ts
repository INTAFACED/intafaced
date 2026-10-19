/**
 * Local-test starter fee.
 *
 * The product rule stays "starter fee not set yet": an unset
 * `PAY_MERCHANT_STARTER_FEE_BPS` is null on every APP_ENV, including the
 * local stack. A set value is honoured only when the raw APP_ENV is exactly
 * `dev` or `test` (the local test stack sets `dev`). Staging, production,
 * `prod`, and an unset APP_ENV refuse to boot. The schema default that turns
 * a missing APP_ENV into `dev` is not read here.
 */

import { MAX_FEE_BPS } from './fee-bps-bound.js';

export const STARTER_FEE_ENV = 'PAY_MERCHANT_STARTER_FEE_BPS';

export class MerchantStarterFeeBootError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MerchantStarterFeeBootError';
  }
}

export type MerchantStarterFee = { readonly bps: number; readonly source: 'local_test' };

/** The stored fee on a merchant row is not an integer from 0 to 9999. */
export class MerchantStoredFeeError extends Error {
  constructor() {
    super('Merchant pricing fee is malformed');
    this.name = 'MerchantStoredFeeError';
  }
}

/**
 * The fee stored on `pay.merchants.pricing.feeBps`.
 * Absent is null. A present value that is not an integer from 0 to 9999 refuses.
 * This is the same check `toMerchant` uses before `merchant.me` returns the fee.
 */
export function normalizeStoredFeeBps(pricing: unknown): number | null {
  if (pricing == null) return null;
  if (typeof pricing !== 'object' || Array.isArray(pricing)) throw new MerchantStoredFeeError();
  const feeBps = (pricing as { feeBps?: unknown }).feeBps;
  if (feeBps !== undefined && (typeof feeBps !== 'number' || !Number.isInteger(feeBps) || feeBps < 0 || feeBps > MAX_FEE_BPS)) {
    throw new MerchantStoredFeeError();
  }
  return typeof feeBps === 'number' ? feeBps : null;
}

/**
 * Fee fields shared by `merchant.me` and the founder merchant profile.
 * `feeBps` is the merchant row. `starterFee` is the published local-test fee, or null when unset.
 */
export function merchantFeeView(
  pricing: unknown,
  starterFee: MerchantStarterFee | null,
): { feeBps: number | null; starterFee: MerchantStarterFee | null } {
  return { feeBps: normalizeStoredFeeBps(pricing), starterFee };
}

export type StarterFeeEnv = Record<string, string | undefined>;

function appEnvName(env: StarterFeeEnv): string {
  const raw = env.APP_ENV;
  if (typeof raw !== 'string' || raw.trim() === '') return '(unset)';
  return raw.trim();
}

/** True only for the local test stack's APP_ENV. Unset is not local. */
export function isLocalTestAppEnv(env: StarterFeeEnv): boolean {
  return env.APP_ENV === 'dev' || env.APP_ENV === 'test';
}

/**
 * Read the starter fee. Unset or blank → null (not configured).
 * Set outside the local test stack, or set to a non-integer, → boot refusal.
 */
export function readMerchantStarterFee(env: StarterFeeEnv): MerchantStarterFee | null {
  const raw = env[STARTER_FEE_ENV];
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;

  if (!isLocalTestAppEnv(env)) {
    throw new MerchantStarterFeeBootError(
      `PAY_MERCHANT_STARTER_FEE_BPS is set but APP_ENV=${appEnvName(env)} is not the local test stack (APP_ENV must be exactly "dev" or "test"). The starter fee is a LOCAL-TEST value, not INTAFACED pricing. Refusing to boot.`,
    );
  }
  if (!/^\d+$/.test(trimmed)) {
    throw new MerchantStarterFeeBootError(
      'PAY_MERCHANT_STARTER_FEE_BPS must be an integer from 0 to 9999 on the local test stack. Refusing to boot.',
    );
  }
  const bps = Number(trimmed);
  if (!Number.isSafeInteger(bps) || bps > MAX_FEE_BPS) {
    throw new MerchantStarterFeeBootError(
      'PAY_MERCHANT_STARTER_FEE_BPS must be an integer from 0 to 9999 on the local test stack. Refusing to boot.',
    );
  }
  return { bps, source: 'local_test' };
}
