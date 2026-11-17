/** Spaces and pots: shared pots, the income sorter, and a space's goal and lock. */
import { z } from 'zod';
import { decimalSchema as money } from '../../shared/money';
import { spaceSchema } from './client';

/** Shared pots (BK-acct-09, J-bank-07 #6): who shares which pot, invites with their lifetime, from the bank. */
const sharedPotRoleSchema = z.enum(['contributor', 'viewer']);
const sharedPotPersonSchema = z.object({ userId: z.string(), handle: z.string().nullable() });
const sharedPotMemberSchema = sharedPotPersonSchema.extend({ role: sharedPotRoleSchema, joinedAt: z.string() });
const sharedPotInviteSchema = z.object({
  inviteId: z.string(),
  spaceId: z.string(),
  role: sharedPotRoleSchema,
  createdAt: z.string(),
  expiresAt: z.string(),
  expired: z.boolean(),
});
const sharedPotSchema = z.object({ id: z.string(), name: z.string(), assetId: z.string() });
/** The owner's card linked to a pot so its holders can freeze it: four digits and its status, never a number. */
export const sharedPotCardSchema = z.object({
  cardId: z.string(),
  panTail: z.string(),
  status: z.enum(['active', 'frozen', 'closed']),
  /** Who froze it; `operator` is the bank, and only the bank lifts that. */
  frozenBy: z.enum(['owner', 'holder', 'operator']).nullable(),
});
export const sharedPotsSchema = z.object({
  terms: z.object({ inviteMinutes: z.number().int().nullable(), peopleCap: z.number().int().nullable() }),
  owned: z.array(
    z.object({
      pot: sharedPotSchema,
      card: sharedPotCardSchema.nullable(),
      members: z.array(sharedPotMemberSchema),
      invites: z.array(sharedPotInviteSchema.extend({ invitee: sharedPotPersonSchema })),
    }),
  ),
  shared: z.array(
    z.object({
      pot: sharedPotSchema.extend({ balance: money }),
      card: sharedPotCardSchema.nullable(),
      owner: sharedPotPersonSchema,
      role: sharedPotRoleSchema,
      members: z.array(sharedPotMemberSchema),
    }),
  ),
  invites: z.array(sharedPotInviteSchema.extend({ pot: sharedPotSchema.omit({ id: true }), owner: sharedPotPersonSchema })),
});
export const sharedPotActivitySchema = z.object({
  id: z.string(),
  kind: z.enum([
    'invited',
    'cancelled',
    'joined',
    'declined',
    'left',
    'removed',
    'card_linked',
    'card_unlinked',
    'card_frozen',
    'card_unfrozen',
  ]),
  actor: sharedPotPersonSchema,
  subject: sharedPotPersonSchema.nullable(),
  role: sharedPotRoleSchema.nullable(),
  card: z.object({ cardId: z.string(), panTail: z.string() }).nullable(),
  at: z.string(),
});

/** One income sorter (BK-pots-03): whole basis points of each payment from another person into the person's own spaces. */
export const sorterSchema = z.object({
  id: z.string(),
  assetId: z.string(),
  status: z.enum(['active', 'cancelled']),
  legs: z.array(z.object({ spaceId: z.string(), shareBp: z.number().int() })),
  createdAt: z.string(),
  cancelledAt: z.string().nullable(),
});
export const sorterListSchema = z.object({
  terms: z.discriminatedUnion('state', [
    z.object({ state: z.literal('set'), minCredit: money }),
    z.object({ state: z.literal('not_set'), code: z.literal('bank.sorter_terms_unset') }),
  ]),
  /** Each leg names its space and says whether it was archived since: its share then stays in the account. */
  sorters: z.array(
    sorterSchema.extend({
      legs: z.array(z.object({ spaceId: z.string(), shareBp: z.number().int(), spaceName: z.string(), archived: z.boolean() })),
    }),
  ),
});
/** What one sorted payment came to: each split's amount and what became of it. */
export const sorterRunSchema = z.object({
  id: z.string(),
  creditTransferId: z.string(),
  creditTxId: z.string(),
  creditAmount: money,
  /** When the payment posted; `createdAt` is when it was sorted. */
  creditPostedAt: z.string(),
  /** Recorded and not split: under the bank's smallest sorted payment, or no terms stood. */
  skippedReason: z.enum(['below_minimum', 'terms_unset']).nullable(),
  createdAt: z.string(),
  legs: z.array(
    z.object({
      position: z.number().int(),
      spaceId: z.string(),
      amount: money,
      status: z.enum(['pending', 'settled', 'rejected']),
      ledgerTxId: z.string().nullable(),
      rejectionCode: z.string().nullable(),
    }),
  ),
});

/** A space's goal and lock after its owner changed one (BK-pots-02). `unlocksAt` is an early unlock still waiting. */
export const spaceLockStateSchema = z.object({
  id: z.string(),
  goalTarget: money.nullable(),
  lockedUntil: z.string().datetime({ offset: true }).nullable(),
  unlocksAt: z.string().datetime({ offset: true }).nullable(),
  unlockRequestedAt: z.string().datetime({ offset: true }).nullable(),
});

/** This area's reads of svc-bank `bank.*`, composed into `bankReads` in contracts.ts. */
export const spacesReads = {
  'sorter.list': sorterListSchema,
  'sorter.runs': z.array(sorterRunSchema),
  'sharedPots.list': sharedPotsSchema,
  'sharedPots.activity': z.array(sharedPotActivitySchema),
  'spaces.list': z.array(spaceSchema),
  'spaces.unnamed': z.array(z.object({ assetId: z.string(), balance: money })),
} as const;

/** This area's writes to svc-bank `bank.*`, composed into `bankWrites` in contracts.ts. */
export const spacesWrites = {
  'spaces.create': z.object({ id: z.string(), name: z.string() }),
  'spaces.archive': z.object({ archived: z.literal(true) }),
  'spaces.setGoal': spaceLockStateSchema,
  'spaces.setLock': spaceLockStateSchema,
  'spaces.requestUnlock': spaceLockStateSchema,
  'spaces.cancelUnlock': spaceLockStateSchema,
  // The bills pot (BK-pots-03): the space that pays bills, and whether a standing order from it tops it up from the account.
  'spaces.setBillsPot': z.object({ spaceId: z.string(), assetId: z.string(), fallback: z.boolean() }),
  'spaces.clearBillsPot': z.object({ spaceId: z.string(), billsPot: z.null() }),
  'sorter.create': sorterSchema,
  'sorter.cancel': sorterSchema,
  'sharedPots.invite': sharedPotInviteSchema.extend({ invitee: sharedPotPersonSchema }),
  'sharedPots.cancelInvite': z.object({ cancelled: z.literal(true) }),
  'sharedPots.accept': z.object({ spaceId: z.string(), role: sharedPotRoleSchema }),
  'sharedPots.decline': z.object({ declined: z.literal(true) }),
  'sharedPots.leave': z.object({ left: z.literal(true) }),
  'sharedPots.remove': z.object({ removed: z.literal(true) }),
  'sharedPots.linkCard': sharedPotCardSchema,
  'sharedPots.unlinkCard': z.object({ unlinked: z.literal(true) }),
  'sharedPots.freezeCard': sharedPotCardSchema,
} as const;
