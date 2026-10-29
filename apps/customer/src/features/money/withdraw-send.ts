import { z } from 'zod';
import type { ApiClient, ApiResult } from '../../shared/api';
import { decimalSchema, parseAmount } from '../../shared/money';
import { withdrawalSchema, type WithdrawalRecord } from './withdrawal-reads';

// hand-declared-ok: svc-pay declares these answers in its router (`withdrawal.limits`, `withdrawal.quote`), not in a
// browser-safe @intafaced/contracts export. Amounts are decimal strings, kept as strings and compared as scaled bigints.
const amount = z
  .string()
  .regex(/^\d+(\.\d{1,18})?$/)
  .pipe(decimalSchema);

/** svc-pay `withdrawal.limits`: the owner-set figures for the caller's tier, what 24 hours used, and the most one send may be now. */
export const withdrawLimitsSchema = z.object({
  tier: z.string(),
  assetId: z.string(),
  perTx: amount,
  rolling24h: amount,
  used24h: amount,
  remaining: z.object({ perTx: amount, rolling24h: amount }),
  maxNow: amount,
});
export type WithdrawLimits = z.infer<typeof withdrawLimitsSchema>;

/** svc-pay `withdrawal.quote`: the fee parts, net amount, total debit and expiry for one withdrawal. */
export const withdrawQuoteSchema = z.object({
  quoteRef: z.string(),
  assetId: z.string(),
  networkId: z.string(),
  amount,
  feeMode: z.enum(['on_top', 'deducted']),
  fees: z.array(z.object({ kind: z.string(), amount })),
  feeTotal: amount,
  netAmount: amount,
  totalDebit: amount,
  feeSource: z.string(),
  quotedAt: z.string().datetime({ offset: true }),
  expiresAt: z.string().datetime({ offset: true }),
  expired: z.boolean(),
  acceptedBy: z.string().nullable(),
});
export type WithdrawQuote = z.infer<typeof withdrawQuoteSchema>;

/** svc-pay `withdrawal.networkRules` (W-withdraw-02): the owner's minimum, maximum and step for one asset on one network, and its tag rule. */
export const withdrawNetworkRulesSchema = z.object({
  assetId: z.string(),
  networkId: z.string(),
  minimum: amount,
  maximum: amount,
  step: amount,
  tag: z.enum(['none', 'required']),
});
export type WithdrawNetworkRules = z.infer<typeof withdrawNetworkRulesSchema>;

/** Where an amount stands against a network's rules: inside them, or the rule it breaks. A malformed amount is the field's to say. */
export function rulesProblem(value: string, rules: WithdrawNetworkRules): 'nrBelow' | 'nrAbove' | 'nrOffStep' | null {
  let sent: bigint;
  try {
    sent = parseAmount(value.trim());
  } catch {
    return null;
  }
  if (sent < parseAmount(rules.minimum)) return 'nrBelow';
  if (sent > parseAmount(rules.maximum)) return 'nrAbove';
  if (sent % parseAmount(rules.step) !== 0n) return 'nrOffStep';
  return null;
}

/**
 * One send: the asset, its network, a saved address and the amount, with the client reference fixed when it was reviewed and
 * the quote it was reviewed under. svc-pay accepts that quote inside the claim and holds its fee with the amount.
 */
export type WithdrawSend = { assetId: string; networkId: string; address: string; amount: string; clientRef: string; quoteRef: string };

/** The svc-pay rail that pays out to a wallet address. */
export const WALLET_RAIL = 'crypto-native';

export function createWithdrawSend(api: ApiClient) {
  return {
    limits(assetId: string, signal?: AbortSignal): Promise<ApiResult<WithdrawLimits>> {
      return api.query('pay', 'withdrawal.limits', { assetId }, withdrawLimitsSchema, { signal });
    },
    networkRules(assetId: string, networkId: string, signal?: AbortSignal): Promise<ApiResult<WithdrawNetworkRules>> {
      return api.query('pay', 'withdrawal.networkRules', { assetId, networkId }, withdrawNetworkRulesSchema, { signal });
    },
    /** Stores a quote under `quoteRef` and moves nothing. The same reference and terms read the same quote back. */
    quote(input: { quoteRef: string; assetId: string; networkId: string; amount: string }): Promise<ApiResult<WithdrawQuote>> {
      return api.mutate('pay', 'withdrawal.quote', input, withdrawQuoteSchema);
    },
    /**
     * The send itself, with the short step-up token as this one call's bearer. The network and the accepted quote go with it
     * (J-wallet-05 #6): svc-pay refuses a send whose address is not saved and ready on that network, and holds the quote's
     * fee with the amount, so what leaves the balance is the quote's total debit.
     */
    send(input: WithdrawSend, token: string): Promise<ApiResult<WithdrawalRecord>> {
      return api.mutate(
        'pay',
        'withdrawal.create',
        {
          assetId: input.assetId,
          amount: input.amount,
          railId: WALLET_RAIL,
          destination: { kind: 'crypto', ref: input.address },
          clientRef: input.clientRef,
          networkId: input.networkId,
          quoteRef: input.quoteRef,
        },
        withdrawalSchema,
        { bearer: token },
      );
    },
  };
}

/** Whether the quote in hand still covers this exact send: same asset, network and amount, and not past its expiry. */
export function quoteCovers(quote: WithdrawQuote, send: { assetId: string; networkId: string; amount: string }, now: number): boolean {
  if (quote.expired || Date.parse(quote.expiresAt) <= now) return false;
  if (quote.assetId !== send.assetId || quote.networkId !== send.networkId) return false;
  try {
    return parseAmount(quote.amount) === parseAmount(send.amount.trim());
  } catch {
    return false;
  }
}

/** True when `value` is above `limit`, both exact decimal strings. An unreadable value is never under a limit. */
export function above(value: string, limit: string): boolean {
  try {
    return parseAmount(value.trim()) > parseAmount(limit);
  } catch {
    return true;
  }
}

/**
 * The refusals of a send, a quote or the limit line that have their own words. svc-pay's typed code is the key; any
 * other refusal keeps the service's own message. `wallet_withdraw_unavailable` is the door that is shut while no custody
 * signer is connected: every rail refuses it before anything is claimed or held.
 */
export const SEND_REFUSAL_KEYS = {
  'pay.wallet_withdraw_unavailable': 'sNoSigner',
  'pay.withdrawal_destination_not_saved': 'sNotSaved',
  'pay.withdrawal_destination_network_mismatch': 'sOtherNetwork',
  'pay.withdrawal_destination_unapproved': 'sUnapproved',
  'pay.withdrawal_destination_cooling': 'sCooling',
  'pay.withdrawal_destination_cooling_unset': 'sCoolingUnset',
  'pay.withdrawal_destination_locked': 'sLocked',
  'pay.withdrawal_destination_unavailable': 'sBookUnreadable',
  'pay.withdrawal_fee_unbound': 'sFeeUnbound',
  'withdrawal_quote.required': 'sQuoteTerms',
  'withdrawal_quote.not_found': 'sQuoteTerms',
  'withdrawal_quote.terms_differ': 'sQuoteTerms',
  'withdrawal_quote.expired': 'qExpired',
  'withdrawal_quote.already_used': 'sQuoteUsed',
  'withdrawal_quote.fee_mode_unsupported': 'sFeeMode',
  'pay.wallet_withdraw_disabled': 'sDisabled',
  'pay.wallet_typed_address': 'sNotSaved',
  'pay.wallet_cooling': 'sCooling',
  'pay.wallet_allowlist': 'sAllowlist',
  'pay.guard_withdrawal_limit_exceeded': 'sOverLimit',
  'pay.guard_withdrawal_limit_unset': 'lUnset',
  'pay.guard_withdrawal_limits_off': 'lOff',
  'pay.guard_withdrawal_tier_unwired': 'lTier',
  'pay.guard_withdrawal_limits_unwired': 'lOff',
  'ledger.insufficient_funds': 'sNotEnough',
  'withdrawal_approval.required': 'sApproval',
  'withdrawal_quote.policy_unset': 'qPolicyUnset',
  'pay.fee_unset': 'qFeeUnset',
  'withdrawal_quote.fee_source_unwired': 'qFeeUnset',
  'withdrawal_quote.network_unknown': 'qNetwork',
  'withdrawal_quote.network_disabled': 'qNetwork',
  'withdrawal_quote.asset_not_on_network': 'qNetwork',
  'withdrawal_quote.fee_exceeds_amount': 'qFeeTooBig',
  'withdrawal_network_rules.unset': 'nrUnset',
  'withdrawal_quote.below_minimum': 'qOutsideRules',
  'withdrawal_quote.above_maximum': 'qOutsideRules',
  'withdrawal_quote.off_step': 'qOutsideRules',
} as const;
export type SendRefusalKey = (typeof SEND_REFUSAL_KEYS)[keyof typeof SEND_REFUSAL_KEYS];

export function sendRefusalKey(code: string | undefined): SendRefusalKey | undefined {
  return code && Object.hasOwn(SEND_REFUSAL_KEYS, code) ? SEND_REFUSAL_KEYS[code as keyof typeof SEND_REFUSAL_KEYS] : undefined;
}
