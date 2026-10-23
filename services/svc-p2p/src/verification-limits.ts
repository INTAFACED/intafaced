/**
 * P-disputes-security-15. Verification-level buy caps and the security-change
 * sell lock.
 *
 * Caps are the owner's table, in one fiat currency, as decimal strings. A blank
 * table is not a cap and is not zero. A partial or numeric JSON value is not a
 * table either: there is no FX and no float. The security-change lock has no
 * timestamp on the signed-in principal and no existing identity event, so a
 * published duration cannot be applied and is not invented as 24 hours.
 */
import { add, compare, formatAmount, parseAmount, sub, ZERO, type Amount } from '@intafaced/ledger-client';

export const VERIFICATION_TIERS = ['none', 'basic', 'full', 'institutional'] as const;
export type VerificationTier = (typeof VERIFICATION_TIERS)[number];

export interface TierCaps {
  orderMin: Amount;
  orderMax: Amount;
  dailyMax: Amount;
  lifetimeMax: Amount;
}

export interface ActiveVerificationLimits {
  status: 'active';
  currency: string;
  tiers: Record<VerificationTier, TierCaps>;
}

export type VerificationLimitConfig = { status: 'absent' } | { status: 'invalid' } | ActiveVerificationLimits;

const AMOUNT_KEY = /^(orderMin|orderMax|dailyMax|lifetimeMax)$/;

export function isVerificationTier(value: string | undefined): value is VerificationTier {
  return VERIFICATION_TIERS.some((tier) => tier === value);
}

function decimalString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!/^\d+(\.\d{1,18})?$/.test(trimmed)) return null;
  return trimmed;
}

/** Blank or omitted is absent. Anything else that is not a complete table is invalid. */
export function parseVerificationLimits(raw: unknown): VerificationLimitConfig {
  if (raw == null) return { status: 'absent' };
  if (typeof raw === 'string' && raw.trim() === '') return { status: 'absent' };
  let parsed: unknown = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      return { status: 'invalid' };
    }
  }
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) return { status: 'invalid' };
  const body = parsed as Record<string, unknown>;
  if (typeof body.currency !== 'string' || !/^[A-Za-z]{3}$/.test(body.currency)) return { status: 'invalid' };
  const currency = body.currency.toUpperCase();
  if (body.tiers == null || typeof body.tiers !== 'object' || Array.isArray(body.tiers)) return { status: 'invalid' };
  const tiersIn = body.tiers as Record<string, unknown>;
  const tiers = {} as Record<VerificationTier, TierCaps>;
  for (const tier of VERIFICATION_TIERS) {
    const row = tiersIn[tier];
    if (row == null || typeof row !== 'object' || Array.isArray(row)) return { status: 'invalid' };
    const cells = row as Record<string, unknown>;
    const keys = Object.keys(cells);
    if (keys.length !== 4 || keys.some((key) => !AMOUNT_KEY.test(key))) return { status: 'invalid' };
    const orderMin = decimalString(cells.orderMin);
    const orderMax = decimalString(cells.orderMax);
    const dailyMax = decimalString(cells.dailyMax);
    const lifetimeMax = decimalString(cells.lifetimeMax);
    if (!orderMin || !orderMax || !dailyMax || !lifetimeMax) return { status: 'invalid' };
    let caps: TierCaps;
    try {
      caps = {
        orderMin: parseAmount(orderMin),
        orderMax: parseAmount(orderMax),
        dailyMax: parseAmount(dailyMax),
        lifetimeMax: parseAmount(lifetimeMax),
      };
    } catch {
      return { status: 'invalid' };
    }
    if (compare(caps.orderMin, caps.orderMax) > 0) return { status: 'invalid' };
    if (compare(caps.orderMax, caps.dailyMax) > 0) return { status: 'invalid' };
    if (compare(caps.dailyMax, caps.lifetimeMax) > 0) return { status: 'invalid' };
    tiers[tier] = caps;
  }
  if (Object.keys(tiersIn).some((key) => !isVerificationTier(key))) return { status: 'invalid' };
  return { status: 'active', currency, tiers };
}

export type LimitRefusal =
  | 'p2p.verification_limits_invalid'
  | 'p2p.verification_level_unwired'
  | 'p2p.verification_limit_currency'
  | 'p2p.verification_order_min'
  | 'p2p.verification_order_max'
  | 'p2p.verification_daily_limit'
  | 'p2p.verification_lifetime_limit';

/**
 * Whether this buy may proceed. `null` means the owner has not published a table,
 * so the existing take is unchanged. A published table never skips a buy in
 * another fiat: that would be an invented conversion.
 */
export function verificationBuyRefusal(
  config: VerificationLimitConfig,
  input: {
    tier: string | undefined;
    fiatCurrency: string;
    fiatAmount: Amount;
    dailyUsed: Amount;
    lifetimeUsed: Amount;
  },
): LimitRefusal | null {
  if (config.status === 'absent') return null;
  if (config.status === 'invalid') return 'p2p.verification_limits_invalid';
  if (!isVerificationTier(input.tier)) return 'p2p.verification_level_unwired';
  if (input.fiatCurrency.toUpperCase() !== config.currency) return 'p2p.verification_limit_currency';
  const caps = config.tiers[input.tier];
  if (compare(input.fiatAmount, caps.orderMin) < 0) return 'p2p.verification_order_min';
  if (compare(input.fiatAmount, caps.orderMax) > 0) return 'p2p.verification_order_max';
  if (compare(add(input.dailyUsed, input.fiatAmount), caps.dailyMax) > 0) return 'p2p.verification_daily_limit';
  if (compare(add(input.lifetimeUsed, input.fiatAmount), caps.lifetimeMax) > 0) return 'p2p.verification_lifetime_limit';
  return null;
}

export function remaining(cap: Amount, used: Amount): Amount {
  return compare(used, cap) >= 0 ? ZERO : sub(cap, used);
}

export function formatCaps(caps: TierCaps): { orderMin: string; orderMax: string; dailyMax: string; lifetimeMax: string } {
  return {
    orderMin: formatAmount(caps.orderMin),
    orderMax: formatAmount(caps.orderMax),
    dailyMax: formatAmount(caps.dailyMax),
    lifetimeMax: formatAmount(caps.lifetimeMax),
  };
}
