import { z } from 'zod';
import { accountCloseReasonCodes } from './account-controls.js';
import { kycCapabilitySchema } from './identity-kyc-capabilities.js';
import { kycReasonCodeSchema } from './identity-kyc-cases.js';

/**
 * svc-identity `account.status.mine` (I-signin-sessions-22): what holds this account back, read from the states identity
 * already keeps, never a copy. Each restriction names only what its own guard refuses today, so "you cannot" never
 * promises more than the service does:
 * - `staff_freeze` (`users.status = frozen`): sign-in and every door refuse (`auth.account_frozen`). Only staff lift it.
 * - `closed` (`users.status = closed`): the same; `reasonCode` is the closure code staff recorded, or
 *   `customer_request` when the person closed it through the closure flow.
 * - `self_freeze` (the owner's own freeze): every session and key was revoked when it was set, and a new API key
 *   refuses. It lifts through `selfFreezeManage` after the owner's wait (`IDENTITY_SELF_FREEZE_LIFT_WAIT_SECONDS`).
 * - `security_lock` (the owner's or support's lock): password and sign-in method changes, password and second-factor
 *   resets, adding recovery keys or changing their plan, and support recovery refuse here; svc-bank refuses adding a
 *   withdrawal address and starting a send to one. Removing an address and revoking a recovery key are not stopped.
 * - `trading_restricted` (founder controls, trading area): identity cancels every fresh svc-trade operation (placing or
 *   enlarging an order, starting a bot, a bot's or a copy's child order) with `trade.account_restricted`, so it blocks
 *   `trade`. Cancelling an order is not an admission and goes on, and an armed futures stop still fires its reduce-only
 *   order. Only staff lift it; identity keeps no start. When staff restrict with a code from the owner's trading
 *   restriction reason list (`IDENTITY_TRADING_RESTRICTION_REASONS`), identity stores the code and its words and next
 *   step travel in `owner`, as for `capability_off`.
 * - `capability_off` (I-kyc-compliance-17): compliance switched a KYC capability off for good, with a code from the
 *   owner's capability reason list (`IDENTITY_KYC_CAPABILITY_REASONS`), whose words and next step travel in `owner`.
 *   Identity refuses a new request for a level that grants it (`kyc.capability_inactive`); no service outside identity
 *   reads capability states, so orders and transfers are not stopped by it. Nothing lifts it.
 * Staff write a restriction's reason as free text, which never reaches the customer: a restriction with no reason code
 * reads `reasonCode: null`, which the page shows as "No reason recorded". The ledger's platform-wide posting freeze is
 * never part of this shape (it has its own banner). `state` counts only restrictions that block something: one that
 * blocks nothing is listed, and the account still reads active.
 */
export const ACCOUNT_ACTIONS = [
  'sign_in',
  'trade',
  'create_api_key',
  'change_password',
  'change_signin_methods',
  'reset_password',
  'reset_second_factor',
  'add_recovery_keys',
  'add_withdrawal_address',
  'withdraw_to_address',
  'request_level_with_switched_off_capability',
] as const;
export const accountActionSchema = z.enum(ACCOUNT_ACTIONS);
export type AccountAction = z.infer<typeof accountActionSchema>;

export const ACCOUNT_RESTRICTION_KINDS = [
  'closed',
  'staff_freeze',
  'self_freeze',
  'security_lock',
  'trading_restricted',
  'capability_off',
] as const;
export const accountRestrictionKindSchema = z.enum(ACCOUNT_RESTRICTION_KINDS);
export type AccountRestrictionKind = z.infer<typeof accountRestrictionKindSchema>;

/** The owner's own freeze reasons (`account_self_freezes.reason`). */
export const SELF_FREEZE_REASONS = ['compromise', 'temporary', 'personal'] as const;
/** Every reason code the status can carry: closure codes, self-freeze reasons, and who set a security lock. */
export const ACCOUNT_STATUS_REASONS = [...accountCloseReasonCodes, ...SELF_FREEZE_REASONS, 'set_by_you', 'set_by_support'] as const;
export const accountStatusReasonSchema = z.enum(ACCOUNT_STATUS_REASONS);
export type AccountStatusReason = z.infer<typeof accountStatusReasonSchema>;

/** How a restriction ends: only staff, the owner's own lift after a wait, or a lock that ends at a fixed time. */
export const accountLiftSchema = z.discriminatedUnion('by', [
  z.object({ by: z.literal('staff') }).strict(),
  z
    .object({
      by: z.literal('owner_after_wait'),
      /** When the owner may lift it; null when the owner has not published the wait, and then a lift refuses. */
      availableAt: z.string().datetime({ offset: true }).nullable(),
    })
    .strict(),
  /** Nothing lifts it (a capability compliance switched off). */
  z.object({ by: z.literal('none') }).strict(),
  z
    .object({
      by: z.literal('owner_unlock'),
      /** When the lock ends, fixed once an unlock is asked for; null while none is asked for. */
      endsAt: z.string().datetime({ offset: true }).nullable(),
    })
    .strict(),
]);
export type AccountLift = z.infer<typeof accountLiftSchema>;

export const accountRestrictionSchema = z
  .object({
    kind: accountRestrictionKindSchema,
    /** A code from a fixed list (the closure codes, the self-freeze reasons, who set a lock); null when none is on file. */
    reasonCode: accountStatusReasonSchema.nullable(),
    /** When it started; null when identity keeps no time for it. */
    since: z.string().datetime({ offset: true }).nullable(),
    blocks: z.array(accountActionSchema),
    lift: accountLiftSchema,
    /** For `capability_off`: which capability. Null for every other kind. */
    capability: kycCapabilitySchema.nullable(),
    /**
     * For `capability_off`: the owner's code, words and next step from the capability reason list. For
     * `trading_restricted` restricted with a code: the same from the trading restriction reason list. `text` and
     * `guidance` are null when the code is no longer on the list. Null for every other kind.
     */
    owner: z
      .object({ code: kycReasonCodeSchema, text: z.string().min(1).nullable(), guidance: z.string().min(1).nullable() })
      .strict()
      .nullable(),
  })
  .strict();
export type AccountRestriction = z.infer<typeof accountRestrictionSchema>;

export const accountStatusSchema = z
  .object({
    /** closed, then frozen by staff, then frozen by the owner, then any other restriction; active when none holds. */
    state: z.enum(['active', 'restricted', 'frozen_self', 'frozen', 'closed']),
    /** The first restriction's code and start, as the summary line names them. */
    reasonCode: accountStatusReasonSchema.nullable(),
    since: z.string().datetime({ offset: true }).nullable(),
    restrictions: z.array(accountRestrictionSchema),
    canStill: z.array(accountActionSchema),
    cannot: z.array(z.object({ action: accountActionSchema, kind: accountRestrictionKindSchema }).strict()),
  })
  .strict();
export type AccountStatus = z.infer<typeof accountStatusSchema>;
