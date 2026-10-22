import { z } from 'zod';
import { payAmountStringSchema, payAssetCodeSchema } from './merchant-control.js';

/**
 * BK-earn-01 (contracts first): personal earn only. Business earn (`business.earn.*`) and money-market funds
 * (`business.treasury.funds`) belong to BK-pots-04 (D51) and are not here.
 *
 * Amounts are unsigned decimal strings, never JSON numbers. Owner values are never defaulted:
 *   - auto program per-asset cap: blank refuses enabling with `bank.autoearn_cap_unset`;
 *   - frozen-account withdraw rule: blank refuses the withdraw (fail closed), `bank.earn_frozen_withdraw_rule_unset`;
 *   - per-pool availability rule: blank FOLLOWS the module gate (it does not refuse), so `rule: null` is offered.
 */
const id = z.string().uuid();
const timestamp = z.string().datetime({ offset: true });

/** A positive decimal string: a partial withdraw of zero is not a withdraw. */
const positiveAmountString = payAmountStringSchema.refine((v) => /[1-9]/.test(v), 'amount must be greater than zero');

/** Client event id: half of the idempotency key (`earn-dep:<userId>:<id>`, `earn-wd:<positionId>:<id>`). */
export const bankEarnClientEventIdSchema = z.string().min(8).max(64);

export const BANK_EARN_POOL_KINDS = ['flexible', 'fixed'] as const;
export const bankEarnPoolKindSchema = z.enum(BANK_EARN_POOL_KINDS);

/**
 * Position states. `waiting_accrual`: active, but opened today (UTC), so it earns from the next UTC day.
 * `deallocating`: a withdraw is claimed and its ledger post is in flight; it ends active (partial) or closed.
 */
export const BANK_EARN_POSITION_STATES = ['pending', 'waiting_accrual', 'active', 'deallocating', 'closed'] as const;
export const bankEarnPositionStateSchema = z.enum(BANK_EARN_POSITION_STATES);
export type BankEarnPositionState = z.infer<typeof bankEarnPositionStateSchema>;

/** Why a pool is not offered to this caller. Null rule = follows the module gate. */
export const BANK_EARN_NOT_OFFERED_REASONS = ['country', 'verification_tier', 'pool_closed'] as const;
export const bankEarnAvailabilitySchema = z.discriminatedUnion('offered', [
  z.object({ offered: z.literal(true) }).strict(),
  z.object({ offered: z.literal(false), reason: z.enum(BANK_EARN_NOT_OFFERED_REASONS) }).strict(),
]);
export type BankEarnAvailability = z.infer<typeof bankEarnAvailabilitySchema>;

/** An owner-set per-pool availability rule. Null fields mean "no extra rule on top of the module gate". */
export const bankEarnPoolAvailabilityRuleSchema = z
  .object({
    allowedCountries: z
      .array(z.string().regex(/^[A-Z]{2}$/))
      .min(1)
      .nullable(),
    minVerificationTier: z.number().int().min(0).max(10).nullable(),
  })
  .strict();

export const bankEarnPoolsInputSchema = z
  .object({
    assetId: payAssetCodeSchema.optional(),
    kind: bankEarnPoolKindSchema.optional(),
    /** Optional so omit reaches `bank.earn_pools_list_limit_unset`; blank is not 50. */
    limit: z.number().int().min(1).max(200).optional(),
  })
  .strict();

export const bankEarnPoolSchema = z
  .object({
    id,
    assetId: payAssetCodeSchema,
    kind: bankEarnPoolKindSchema,
    name: z.string(),
    aprBps: z.number().int(),
    termDays: z.number().int().nullable(),
    minDeposit: payAmountStringSchema,
    availability: bankEarnAvailabilitySchema,
  })
  .strict();
export type BankEarnPool = z.infer<typeof bankEarnPoolSchema>;

export const bankEarnDepositInputSchema = z
  .object({ poolId: id, amount: positiveAmountString, positionId: id, clientEventId: bankEarnClientEventIdSchema.optional() })
  .strict();

/** Omit `amount` to withdraw the whole position; a partial withdraw needs its own `clientEventId` per request. */
export const bankEarnWithdrawInputSchema = z
  .object({ positionId: id, amount: positiveAmountString.optional(), clientEventId: bankEarnClientEventIdSchema.optional() })
  .strict()
  .refine((v) => v.amount === undefined || v.clientEventId !== undefined, {
    path: ['clientEventId'],
    message: 'a partial withdraw needs a clientEventId',
  });
export type BankEarnWithdrawInput = z.infer<typeof bankEarnWithdrawInputSchema>;

export const bankEarnWithdrawResultSchema = z
  .object({ positionId: id, withdrawn: payAmountStringSchema, remaining: payAmountStringSchema, state: bankEarnPositionStateSchema })
  .strict();

export const bankEarnPositionsInputSchema = z
  .object({ assetId: payAssetCodeSchema.optional(), limit: z.number().int().min(1).max(200).optional() })
  .strict();

export const bankEarnPositionSchema = z
  .object({
    id,
    poolId: id,
    assetId: payAssetCodeSchema,
    principal: payAmountStringSchema,
    state: bankEarnPositionStateSchema,
    openedAt: timestamp,
    /** First UTC day this position earns (the day after it opened). */
    accruesFrom: timestamp,
    maturesAt: timestamp.nullable(),
  })
  .strict();
export type BankEarnPosition = z.infer<typeof bankEarnPositionSchema>;

/** Auto program: sweep idle balance of an asset into a pool, capped per asset. A blank cap refuses enabling. */
export const bankEarnAutoProgramSchema = z
  .object({ assetId: payAssetCodeSchema, poolId: id, enabled: z.boolean(), cap: payAmountStringSchema.nullable() })
  .strict()
  .refine((v) => !v.enabled || v.cap !== null, { path: ['cap'], message: 'bank.autoearn_cap_unset' });

export const bankEarnSettingsSchema = z
  .object({ autoPrograms: z.array(bankEarnAutoProgramSchema).max(32) })
  .strict()
  .refine((v) => new Set(v.autoPrograms.map((p) => p.assetId)).size === v.autoPrograms.length, {
    path: ['autoPrograms'],
    message: 'One auto program per asset',
  });
export type BankEarnSettings = z.infer<typeof bankEarnSettingsSchema>;

export const bankEarnSettingsSetInputSchema = z.object({ settings: bankEarnSettingsSchema, commandId: z.string().min(8).max(64) }).strict();

/** Refusal codes added by BK-earn-01. */
export const BANK_EARN_CODES = [
  'bank.autoearn_cap_unset',
  'bank.earn_pool_not_offered',
  'bank.earn_pool_closed',
  'bank.earn_not_matured',
  'bank.earn_withdraw_exceeds_principal',
  'bank.earn_frozen_withdraw_rule_unset',
  'bank.account_frozen',
] as const;
export type BankEarnCode = (typeof BANK_EARN_CODES)[number];
