import { z } from 'zod';

/**
 * svc-identity `account.status.mine` (I-signin-sessions-22): what holds this account back, read from the states identity
 * already keeps, never a copy. Each restriction names only what its own guard refuses today, so "you cannot" never
 * promises more than the service does:
 * - `staff_freeze` (`users.status = frozen`): sign-in and every door refuse (`auth.account_frozen`). Only staff lift it.
 * - `closed` (`users.status = closed`): the same; `reasonCode` is the closure code staff recorded.
 * - `self_freeze` (the owner's own freeze): every session and key was revoked when it was set, and a new API key
 *   refuses. It lifts through `selfFreezeManage` after the owner's wait (`IDENTITY_SELF_FREEZE_LIFT_WAIT_SECONDS`).
 * - `security_lock` (the owner's or support's lock): password and sign-in method changes, resets, recovery keys and
 *   support recovery refuse here, and svc-bank refuses withdrawal addresses and sending to them.
 * - `trading_restricted` (founder controls, trading area): trading refuses. Only staff lift it.
 * Staff write a restriction's reason as free text, which never reaches the customer: a restriction with no reason code
 * reads `reasonCode: null`, which the page shows as "No reason recorded". The ledger's platform-wide posting freeze is
 * never part of this shape (it has its own banner); KYC capability switch-offs are listed by `kyc.capabilities.get`.
 */
export const ACCOUNT_ACTIONS = [
  'sign_in',
  'trade',
  'create_api_key',
  'change_password',
  'change_signin_methods',
  'reset_password',
  'reset_second_factor',
  'recovery_keys',
  'manage_withdrawal_addresses',
  'withdraw_to_address',
] as const;
export const accountActionSchema = z.enum(ACCOUNT_ACTIONS);
export type AccountAction = z.infer<typeof accountActionSchema>;

export const ACCOUNT_RESTRICTION_KINDS = ['closed', 'staff_freeze', 'self_freeze', 'security_lock', 'trading_restricted'] as const;
export const accountRestrictionKindSchema = z.enum(ACCOUNT_RESTRICTION_KINDS);
export type AccountRestrictionKind = z.infer<typeof accountRestrictionKindSchema>;

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
    reasonCode: z.string().min(1).max(64).nullable(),
    /** When it started; null when identity keeps no time for it. */
    since: z.string().datetime({ offset: true }).nullable(),
    blocks: z.array(accountActionSchema),
    lift: accountLiftSchema,
  })
  .strict();
export type AccountRestriction = z.infer<typeof accountRestrictionSchema>;

export const accountStatusSchema = z
  .object({
    /** closed, then a staff freeze, then the owner's own freeze, then any other restriction; active when none holds. */
    state: z.enum(['active', 'restricted', 'frozen_self', 'closed']),
    /** The first restriction's code and start, as the summary line names them. */
    reasonCode: z.string().min(1).max(64).nullable(),
    since: z.string().datetime({ offset: true }).nullable(),
    restrictions: z.array(accountRestrictionSchema),
    canStill: z.array(accountActionSchema),
    cannot: z.array(z.object({ action: accountActionSchema, kind: accountRestrictionKindSchema }).strict()),
  })
  .strict();
export type AccountStatus = z.infer<typeof accountStatusSchema>;
