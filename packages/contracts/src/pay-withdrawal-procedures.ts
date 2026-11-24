import { z } from 'zod';
import { assetIdSchema } from './asset-id.js';
import {
  PAY_WITHDRAWAL_SHOWN,
  payCanceledWithdrawalSchema,
  payWithdrawalHistoryPageSchema,
  payWithdrawalSchema,
  payWithdrawDestinationSchema,
  payWithdrawNetworkRulesSchema,
  payWithdrawQuoteSchema,
} from './pay-money-room.js';
import { payWithdrawalTierLimitsOutputSchema } from './pay-withdrawal-tier-limits.js';
import { defineProcedure, type Refusals, type RefusalStatus } from './procedure.js';
import { withdrawalAllowanceSchema } from './withdrawal-allowance.js';

/**
 * svc-pay `withdrawal.*`: a person's own balance leaving the book, and the reads around it, one record per call. The
 * caller is always the token's user: no input names an account. Sending takes `trade:withdraw` (interactive, step-up),
 * quoting and cancelling `trade:write`, reading `trade:read`; module `ledger`, which holds the balance. svc-pay mounts
 * each from here (`router.ts`) and the customer app calls each by its record.
 */

const amount = z.string().regex(/^\d+(\.\d{1,18})?$/, 'amounts are unsigned decimal strings with at most 18 decimal places');
/** The asset id the withdrawal doors have always taken. */
const assetId = assetIdSchema.min(1).max(16);
const id = z.string().guid();
/** A quote's or a send's network: the registry's lower-case id. */
const sendNetworkId = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/);
/** The caller's own business key for one quote, kept across a retry so a retry reads the same quote. */
const quoteRef = z.string().regex(/^[A-Za-z0-9:_.-]{1,64}$/);

/** Each refusal by its code, with the status svc-pay sends it with (`router.ts` `toTrpcError` and each error's own table). */
const STATUS = {
  // The send's own door (`withdrawals/send-out/door.ts`, `user-money-service.ts`).
  'pay.invalid_amount': 'BAD_REQUEST',
  'pay.wallet_withdraw_unavailable': 'BAD_REQUEST',
  'pay.withdraw_confirmations_unset': 'BAD_REQUEST',
  'pay.withdrawal_destination_not_saved': 'BAD_REQUEST',
  'pay.withdrawal_destination_network_mismatch': 'BAD_REQUEST',
  'pay.withdrawal_destination_blocked': 'BAD_REQUEST',
  'pay.withdrawal_destination_unapproved': 'PRECONDITION_FAILED',
  'pay.withdrawal_destination_cooling': 'PRECONDITION_FAILED',
  'pay.withdrawal_destination_cooling_unset': 'PRECONDITION_FAILED',
  'pay.withdrawal_destination_unavailable': 'PRECONDITION_FAILED',
  'pay.withdrawal_destination_locked': 'FORBIDDEN',
  'pay.withdrawal_fee_unbound': 'PRECONDITION_FAILED',
  'pay.withdrawal_tag_not_taken': 'BAD_REQUEST',
  'pay.withdrawal_tag_unsupported': 'PRECONDITION_FAILED',
  'pay.withdrawal_self_send': 'BAD_REQUEST',
  'pay.withdrawal_platform_address': 'BAD_REQUEST',
  'pay.withdrawal_amount_held': 'CONFLICT',
  'pay.withdrawal_conflict': 'CONFLICT',
  'pay.withdrawal_canceled': 'CONFLICT',
  'pay.internal_asset_unsupported': 'BAD_REQUEST',
  'pay.internal_destination_external': 'BAD_REQUEST',
  'pay.internal_destination_unavailable': 'BAD_REQUEST',
  'pay.internal_settlement_refused': 'BAD_REQUEST',
  'pay.internal_settlement_unwired': 'PRECONDITION_FAILED',
  'pay.rail_failed': 'BAD_REQUEST',
  'pay.rail_amount_mismatch': 'BAD_REQUEST',
  'pay.rail_outcome_unknown': 'PRECONDITION_FAILED',
  'pay.ledger_outcome_unknown': 'PRECONDITION_FAILED',
  // The guards every send passes (`seams/guards.ts`): a rule said no is FORBIDDEN, could not decide SERVICE_UNAVAILABLE.
  'pay.guard_unavailable': 'SERVICE_UNAVAILABLE',
  'pay.guard_halted': 'SERVICE_UNAVAILABLE',
  'pay.guard_halt_store_unavailable': 'SERVICE_UNAVAILABLE',
  'pay.guard_screening_refuse': 'FORBIDDEN',
  'pay.guard_screening_review': 'SERVICE_UNAVAILABLE',
  'pay.guard_screening_unavailable': 'SERVICE_UNAVAILABLE',
  'pay.guard_destination_not_allowlisted': 'FORBIDDEN',
  'pay.guard_withdrawal_approval_required': 'FORBIDDEN',
  'pay.guard_withdrawal_approval_terms': 'FORBIDDEN',
  'pay.guard_withdrawal_limit_exceeded': 'FORBIDDEN',
  'pay.guard_withdrawal_limit_unset': 'FORBIDDEN',
  'pay.guard_withdrawal_limits_off': 'SERVICE_UNAVAILABLE',
  'pay.guard_withdrawal_limits_unwired': 'SERVICE_UNAVAILABLE',
  'pay.guard_withdrawal_tier_unwired': 'SERVICE_UNAVAILABLE',
  // The direct door's approval gate (`withdrawals/approvals`).
  'withdrawal_approval.required': 'PRECONDITION_FAILED',
  'withdrawal_approval.amount_invalid': 'BAD_REQUEST',
  // Fee quotes (`withdrawals/quotes/errors.ts`).
  'pay.fee_unset': 'PRECONDITION_FAILED',
  'withdrawal_quote.policy_unset': 'PRECONDITION_FAILED',
  'withdrawal_quote.fee_source_unwired': 'PRECONDITION_FAILED',
  'withdrawal_quote.network_unknown': 'BAD_REQUEST',
  'withdrawal_quote.network_disabled': 'PRECONDITION_FAILED',
  'withdrawal_quote.asset_not_on_network': 'BAD_REQUEST',
  'withdrawal_quote.below_minimum': 'BAD_REQUEST',
  'withdrawal_quote.above_maximum': 'BAD_REQUEST',
  'withdrawal_quote.off_step': 'BAD_REQUEST',
  'withdrawal_quote.tag_required': 'PRECONDITION_FAILED',
  'withdrawal_quote.amount_invalid': 'BAD_REQUEST',
  'withdrawal_quote.fee_exceeds_amount': 'BAD_REQUEST',
  'withdrawal_quote.quote_differs': 'CONFLICT',
  'withdrawal_quote.not_found': 'NOT_FOUND',
  'withdrawal_quote.expired': 'PRECONDITION_FAILED',
  'withdrawal_quote.already_used': 'CONFLICT',
  'withdrawal_quote.client_ref_taken': 'CONFLICT',
  'withdrawal_quote.unwired': 'SERVICE_UNAVAILABLE',
  'withdrawal_quote.required': 'BAD_REQUEST',
  'withdrawal_quote.terms_differ': 'CONFLICT',
  'withdrawal_quote.fee_mode_unsupported': 'PRECONDITION_FAILED',
  // A network's own rules (`withdrawals/network-rules/service.ts`).
  'withdrawal_network_rules.unset': 'PRECONDITION_FAILED',
  'withdrawal_network_rules.unwired': 'SERVICE_UNAVAILABLE',
  // Reading and cancelling one's own.
  'pay.withdrawal_not_found': 'NOT_FOUND',
  'pay.withdrawal_not_cancellable': 'CONFLICT',
  'pay.withdrawal_list_limit_unset': 'PRECONDITION_FAILED',
  'pay.withdrawal_cursor_invalid': 'BAD_REQUEST',
  'pay.withdrawal_history_unwired': 'PRECONDITION_FAILED',
} as const satisfies Record<string, RefusalStatus>;
type Code = keyof typeof STATUS;
const refuse = (...codes: Code[]): Refusals => Object.freeze(Object.fromEntries(codes.map((c) => [c, STATUS[c]])));

/** What the owner's limits refuse with: a blank limit is never shown as room (`limits/reader.ts`). */
const LIMITS = [
  'pay.guard_unavailable',
  'pay.guard_withdrawal_limit_unset',
  'pay.guard_withdrawal_limits_off',
  'pay.guard_withdrawal_limits_unwired',
  'pay.guard_withdrawal_tier_unwired',
] as const;
/** The rules for one asset on one network: unpublished, or no database to read them from. */
const RULES = ['withdrawal_network_rules.unset', 'withdrawal_network_rules.unwired'] as const;
/** A quote's own refusals, before anything is stored. */
const QUOTE = [
  'withdrawal_quote.unwired',
  'withdrawal_quote.policy_unset',
  'withdrawal_quote.amount_invalid',
  'withdrawal_quote.fee_source_unwired',
  'withdrawal_quote.network_unknown',
  'withdrawal_quote.network_disabled',
  'withdrawal_quote.asset_not_on_network',
  'pay.fee_unset',
  'withdrawal_quote.tag_required',
  'withdrawal_quote.below_minimum',
  'withdrawal_quote.above_maximum',
  'withdrawal_quote.off_step',
  'withdrawal_quote.fee_exceeds_amount',
  'withdrawal_quote.quote_differs',
  ...RULES,
] as const;
/** The codes a send never refuses with: reading, listing and cancelling one's own, and a quote's own checks. */
const NOT_SEND: ReadonlySet<string> = new Set([
  'pay.withdrawal_not_found',
  'pay.withdrawal_not_cancellable',
  'pay.withdrawal_list_limit_unset',
  'pay.withdrawal_cursor_invalid',
  'pay.withdrawal_history_unwired',
  ...QUOTE.filter((code) => code !== 'withdrawal_network_rules.unset'),
]);
/** Everything a send may refuse with, before or after it is claimed. */
const SEND: Refusals = Object.freeze(Object.fromEntries(Object.entries(STATUS).filter(([code]) => !NOT_SEND.has(code))));

const base = { service: 'svc-pay', module: 'pay', transport: 'trpc' } as const;
const READ = { caller: 'scope', scope: 'trade:read' } as const;
const WRITE = { caller: 'scope', scope: 'trade:write', module: 'ledger' } as const;
/** `trade:withdraw` is interactive only: no API key holds it and a session needs a fresh step-up. */
const WITHDRAW = { caller: 'scope', scope: 'trade:withdraw', module: 'ledger' } as const;
const WITHDRAWAL_ID = '33333333-3333-4333-8333-333333333333';
const ADDRESS = '0x1111111111111111111111111111111111111111';

export const PAY_WITHDRAWAL_LIMITS = defineProcedure({
  ...base,
  name: 'pay.withdrawal.limits',
  kind: 'query',
  path: 'withdrawal.limits',
  access: READ,
  refusals: refuse(...LIMITS),
  input: z.object({ assetId }),
  output: withdrawalAllowanceSchema,
  samples: [
    { verdict: 'accept', input: { assetId: 'USDC' } },
    { verdict: 'refuse', input: { assetId: '' } },
  ],
});

export const PAY_WITHDRAWAL_TIER_LIMITS = defineProcedure({
  ...base,
  name: 'pay.withdrawal.tierLimits',
  kind: 'query',
  path: 'withdrawal.tierLimits',
  access: READ,
  refusals: refuse(...LIMITS),
  input: z.object({}).strict().optional(),
  output: payWithdrawalTierLimitsOutputSchema,
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: { tier: 'full' } },
  ],
});

export const PAY_WITHDRAWAL_NETWORK_RULES = defineProcedure({
  ...base,
  name: 'pay.withdrawal.networkRules',
  kind: 'query',
  path: 'withdrawal.networkRules',
  access: READ,
  refusals: refuse(...RULES),
  input: z.object({ assetId, networkId: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/) }).strict(),
  output: payWithdrawNetworkRulesSchema,
  samples: [
    { verdict: 'accept', input: { assetId: 'USDC', networkId: 'ethereum' } },
    { verdict: 'refuse', input: { assetId: 'USDC', networkId: 'not a network' } },
  ],
});

export const PAY_WITHDRAWAL_DESTINATION = defineProcedure({
  ...base,
  name: 'pay.withdrawal.destination',
  kind: 'query',
  path: 'withdrawal.destination',
  access: READ,
  refusals: refuse(),
  input: z.object({ destination: z.object({ kind: z.string().min(1).max(32), ref: z.string().min(1).max(256) }).strict() }).strict(),
  output: payWithdrawDestinationSchema,
  samples: [
    { verdict: 'accept', input: { destination: { kind: 'crypto', ref: ADDRESS } } },
    { verdict: 'refuse', input: { destination: { kind: 'crypto', ref: '' } } },
  ],
});

export const PAY_WITHDRAWAL_QUOTE = defineProcedure({
  ...base,
  name: 'pay.withdrawal.quote',
  kind: 'mutation',
  path: 'withdrawal.quote',
  access: WRITE,
  refusals: refuse(...QUOTE),
  input: z.object({ quoteRef, assetId: assetIdSchema.regex(/^[A-Za-z0-9._-]{1,32}$/), networkId: sendNetworkId, amount }).strict(),
  output: payWithdrawQuoteSchema,
  samples: [
    { verdict: 'accept', input: { quoteRef: 'q:1', assetId: 'USDC', networkId: 'ethereum', amount: '25.5' } },
    { verdict: 'refuse', input: { quoteRef: 'q:1', assetId: 'USDC', networkId: 'ethereum', amount: 25.5 } },
  ],
});

export const PAY_WITHDRAWAL_CREATE = defineProcedure({
  ...base,
  name: 'pay.withdrawal.create',
  kind: 'mutation',
  path: 'withdrawal.create',
  access: WITHDRAW,
  refusals: SEND,
  input: z
    .object({
      assetId,
      amount,
      railId: z.string().min(1),
      /** A tag or memo, when the sender names one: refused by name, never silently dropped. */
      destination: z.object({ kind: z.string().min(1), ref: z.string().min(1), tag: z.string().min(1).max(64).optional() }).strict(),
      /** Required: a retried send without one would open a second withdrawal, a second debit. */
      clientRef: z.string().min(1).max(64),
      /** A send out of the platform names its network and the quote the person accepted; a send inside takes neither. */
      networkId: sendNetworkId.optional(),
      quoteRef: quoteRef.optional(),
    })
    .strict(),
  output: payWithdrawalSchema,
  samples: [
    {
      verdict: 'accept',
      input: {
        assetId: 'USDC',
        amount: '25.5',
        railId: 'crypto-native',
        destination: { kind: 'crypto', ref: ADDRESS },
        clientRef: 'w-1',
        networkId: 'ethereum',
        quoteRef: 'q:1',
      },
    },
    {
      verdict: 'refuse',
      input: { assetId: 'USDC', amount: '25.5', railId: 'crypto-native', destination: { kind: 'crypto', ref: ADDRESS } },
    },
  ],
});

export const PAY_WITHDRAWAL_CANCEL = defineProcedure({
  ...base,
  name: 'pay.withdrawal.cancel',
  kind: 'mutation',
  path: 'withdrawal.cancel',
  access: WRITE,
  refusals: refuse('pay.withdrawal_not_found', 'pay.withdrawal_not_cancellable', 'pay.ledger_outcome_unknown'),
  input: z.object({ withdrawalId: id }).strict(),
  output: payCanceledWithdrawalSchema,
  samples: [
    { verdict: 'accept', input: { withdrawalId: WITHDRAWAL_ID } },
    { verdict: 'refuse', input: { withdrawalId: 'not-a-uuid' } },
  ],
});

export const PAY_WITHDRAWAL_GET = defineProcedure({
  ...base,
  name: 'pay.withdrawal.get',
  kind: 'query',
  path: 'withdrawal.get',
  access: READ,
  refusals: refuse('pay.withdrawal_not_found'),
  input: z.object({ withdrawalId: id }),
  output: payWithdrawalSchema,
  samples: [
    { verdict: 'accept', input: { withdrawalId: WITHDRAWAL_ID } },
    { verdict: 'refuse', input: { withdrawalId: 'not-a-uuid' } },
  ],
});

export const PAY_WITHDRAWAL_HISTORY = defineProcedure({
  ...base,
  name: 'pay.withdrawal.history',
  kind: 'query',
  path: 'withdrawal.history',
  access: READ,
  refusals: refuse('pay.withdrawal_list_limit_unset', 'pay.withdrawal_cursor_invalid', 'pay.withdrawal_history_unwired'),
  input: z
    .object({
      assetId: assetId.optional(),
      status: z.enum(PAY_WITHDRAWAL_SHOWN).optional(),
      id: id.optional(),
      since: z.string().datetime({ offset: true }).optional(),
      until: z.string().datetime({ offset: true }).optional(),
      /** Optional so a missing one reaches `pay.withdrawal_list_limit_unset`: there is no default page size. */
      limit: z.number().int().min(1).max(200).optional(),
      after: z.string().max(200).optional(),
    })
    .strict(),
  output: payWithdrawalHistoryPageSchema,
  samples: [
    { verdict: 'accept', input: { limit: 50 } },
    { verdict: 'accept', input: { id: WITHDRAWAL_ID, limit: 1 } },
    { verdict: 'refuse', input: { limit: 50, userId: WITHDRAWAL_ID } },
  ],
});

/** Every `withdrawal.*` record svc-pay serves the customer, in the router's order. */
export const PAY_WITHDRAWAL_PROCEDURES = [
  PAY_WITHDRAWAL_CREATE,
  PAY_WITHDRAWAL_DESTINATION,
  PAY_WITHDRAWAL_CANCEL,
  PAY_WITHDRAWAL_GET,
  PAY_WITHDRAWAL_LIMITS,
  PAY_WITHDRAWAL_TIER_LIMITS,
  PAY_WITHDRAWAL_HISTORY,
  PAY_WITHDRAWAL_QUOTE,
  PAY_WITHDRAWAL_NETWORK_RULES,
] as const;
