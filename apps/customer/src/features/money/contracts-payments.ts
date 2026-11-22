/** Money paid out: scheduled and personal transfers, direct debits, the calendar and reminders, cash out and bank-rail sends. */
import { z } from 'zod';
import { decimalSchema as money } from '../../shared/money';
import { linkedAccountSchema } from './contracts-accounts';
import { BANK_TRANSFERS_LIST_SCHEDULES, BANK_TRANSFERS_TO_USER } from '@intafaced/contracts/bank-transfers-procedures';

export const scheduleSchema = z.object({
  id: z.string(),
  assetId: z.string(),
  amount: money,
  cadence: z.string(),
  startsAt: z.string(),
  endsAt: z.string().nullable(),
  nextRunAt: z.string(),
  status: z.string(),
  revision: z.number().int().positive(),
  /** The person's own space the order pays from. */
  fromSpaceId: z.string().optional(),
  /** The person's own space it pays into, or null when it pays another person. */
  toSpaceId: z.string().nullable().optional(),
});

/** `bank.transfers.quote`: the published limits and fee for one personal send, and how much of today is used. */
const quoteAmount = money.refine((v) => /^\d+(\.\d{1,18})?$/.test(v));
export const transferQuoteSchema = z.object({
  assetId: z.string().min(1).max(16),
  amount: quoteAmount,
  perTransferLimit: quoteAmount,
  dailyLimit: quoteAmount,
  spentToday: quoteAmount,
  /** The daily limit less what was sent today, from the bank (BK-acct-04). Older bank builds leave it out. */
  remainingToday: quoteAmount.optional(),
  fee: quoteAmount,
  feeBlocker: z.string().nullable(),
  /** The partner's fee on the move: absent when none is reported, null when the partner has not said ("not known"). */
  networkFee: quoteAmount.nullable().optional(),
  withinPerTransfer: z.boolean(),
  withinDaily: z.boolean(),
});

/** svc-bank `bank.directDebits.*` (J-bank-06 #4, BK-xfer-11): mandates, their collections and refund requests. */
const directDebitCollectionSchema = z.object({
  id: z.string(),
  mandateId: z.string(),
  collectionId: z.string(),
  creditorName: z.string(),
  assetId: z.string(),
  amount: money,
  dueAt: z.string(),
  status: z.enum(['upcoming', 'processing', 'collected', 'failed', 'rejected']),
  failureCode: z.string().nullable(),
  ledgerTxId: z.string().nullable(),
  /** The partner's move that collected it, when the partner bank holds the money (OWNER 226); null otherwise. */
  partnerMoveId: z.string().nullable().default(null),
  presentedAt: z.string(),
  settledAt: z.string().nullable(),
  failureFee: z.null(),
  failureFeeBlocker: z.literal('bank.dd_failure_fee_unset').nullable(),
  refund: z.object({
    state: z.enum(['none', 'available', 'requested', 'closed', 'unset']),
    endsAt: z.string().nullable(),
    requestedAt: z.string().nullable(),
  }),
});
export type DirectDebitCollection = z.infer<typeof directDebitCollectionSchema>;
const directDebitMandateSchema = z.object({
  id: z.string(),
  creditorId: z.string(),
  creditorName: z.string(),
  reference: z.string(),
  assetId: z.string(),
  status: z.enum(['active', 'blocked']),
  blockedAt: z.string().nullable(),
  createdAt: z.string(),
  upcoming: z.array(directDebitCollectionSchema),
});
export type DirectDebitMandate = z.infer<typeof directDebitMandateSchema>;
const directDebitsViewSchema = z.object({
  scheme: z.object({
    status: z.enum(['unset', 'live']),
    standIn: z.string().nullable(),
    guaranteeDays: z.number().int().nullable(),
    blocker: z.literal('rail.bank').nullable(),
  }),
  mandates: z.array(directDebitMandateSchema),
  collections: z.array(directDebitCollectionSchema),
});
export type DirectDebitsView = z.infer<typeof directDebitsViewSchema>;
/** svc-bank `bank.calendar.window` (J-bank-06 #5, BK-acct-10): what is dated in a window, and how each source answered. */
export const calendarSources = ['standing_orders', 'bills', 'direct_debits', 'loans', 'earn'] as const;
export type CalendarSource = (typeof calendarSources)[number];
const calendarItemSchema = z.object({
  source: z.enum(calendarSources),
  refId: z.string(),
  key: z.string(),
  date: z.string(),
  label: z.string().nullable(),
  assetId: z.string(),
  amount: money.nullable(),
  status: z.enum(['upcoming', 'paused', 'done', 'failed', 'skipped', 'refused']),
  reasonCode: z.string().nullable(),
});
export type CalendarItem = z.infer<typeof calendarItemSchema>;
const calendarViewSchema = z.object({
  from: z.string(),
  to: z.string(),
  items: z.array(calendarItemSchema),
  sources: z.array(
    z.object({
      source: z.enum(calendarSources),
      state: z.enum(['ok', 'not_set', 'refused', 'unavailable']),
      count: z.number().int(),
      code: z.string().nullable(),
      complete: z.boolean(),
    }),
  ),
});
export type CalendarView = z.infer<typeof calendarViewSchema>;
/** svc-bank `bank.rules.*` (J-bank-06 #6, BK-acct-10): the payment reminder rule, and money rules waiting on the owner. */
export const reminderLeadChoices = [24, 48, 72, 168] as const;
const reminderRuleSchema = z.object({
  ruleKey: z.string(),
  leadHours: z.literal(reminderLeadChoices).nullable(),
  revision: z.number().int(),
  updatedAt: z.string(),
});
export type ReminderRule = z.infer<typeof reminderRuleSchema>;
const rulesViewSchema = z.object({
  reminder: reminderRuleSchema.nullable(),
  leadChoices: z.array(z.number().int()),
  moneyRules: z.object({ state: z.literal('not_set'), code: z.string() }),
});
export type RulesView = z.infer<typeof rulesViewSchema>;
export const rulesWrites = {
  setReminder: reminderRuleSchema,
  createMoneyRule: z.never(),
};
/** svc-bank `bank.cashOut.*` (J-bank-03): cash out to a linked bank account, with what stands in the way. */
const cashOutQuoteSchema = z.object({
  assetId: z.string(),
  amount: money,
  available: money,
  /** Who holds the balance read: the partner bank's label when it holds this person's money, else null (the ledger). */
  heldAt: z.string().nullable().default(null),
  account: linkedAccountSchema,
  rail: z.literal('rail.bank'),
  fee: money.nullable(),
  receiveAmount: money.nullable(),
  receiveCurrency: z.string().nullable().default(null),
  /** What stands in the way, or null when the bank's partner can take it. */
  blocker: z.string().nullable(),
  /** The TEST label when the partner pricing it is the local stack's stand-in. */
  standIn: z.string().nullable().default(null),
});
export type CashOutQuote = z.infer<typeof cashOutQuoteSchema>;
const CASH_OUT_STATUSES = ['refused', 'processing', 'completed', 'failed', 'cancelled', 'returned'] as const;
const cashOutRequestSchema = z.object({
  requestId: z.string(),
  assetId: z.string(),
  amount: money,
  linkedAccountId: z.string(),
  rail: z.literal('rail.bank'),
  status: z.enum(CASH_OUT_STATUSES),
  refusalCode: z.string().nullable(),
  fee: money.nullable().default(null),
  receiveAmount: money.nullable().default(null),
  receiveCurrency: z.string().nullable().default(null),
  payoutRef: z.string().nullable().default(null),
  ledgerTxId: z.string().nullable().default(null),
  heldAt: z.string().nullable().default(null),
  partnerMoveId: z.string().nullable().default(null),
  failureCode: z.string().nullable().default(null),
  returnedAmount: money.nullable().default(null),
  remainsPaidOut: money.nullable().default(null),
  createdAt: z.string(),
  completedAt: z.string().nullable().default(null),
  failedAt: z.string().nullable().default(null),
  cancelledAt: z.string().nullable().default(null),
  returnedAt: z.string().nullable().default(null),
});
export type CashOutRequest = z.infer<typeof cashOutRequestSchema>;
const cashOutReceiptSchema = z.object({
  fileName: z.string(),
  text: z.string(),
  /** The ledger transaction that paid it out; null when the partner bank holds the money and the ledger posted nothing. */
  ledgerTxId: z.string().nullable(),
  partnerMoveId: z.string().nullable().default(null),
  sha256: z.string(),
  signature: z.string(),
});
export type CashOutReceipt = z.infer<typeof cashOutReceiptSchema>;
/** svc-bank `bank.railSends.*` (J-bank-04 #1): send to a bank account over a bank rail, each rail with its own form. */
const BANK_RAILS = ['ach', 'wire', 'instant', 'sepa', 'proxy'] as const;
/** `bank.safety.regionNotice` (BK-safe-01, J-bank-18 #1): why a transfer refuses from a blocked region. */
const regionNoticeSchema = z.object({
  region: z.string(),
  blocked: z.boolean(),
  code: z.string().nullable(),
  restriction: z.string().nullable(),
  blockedBy: z.string().nullable(),
  wording: z.string().nullable(),
});
export type RegionNotice = z.infer<typeof regionNoticeSchema>;

const railRequirementsSchema = z.object({
  rails: z.array(
    z.object({
      rail: z.enum(BANK_RAILS),
      fields: z.array(z.object({ name: z.string(), required: z.boolean(), choices: z.array(z.string()).nullable() })),
      // Null while no banking partner carries the rail; the blocker names what is missing.
      partner: z.string().nullable(),
      blocker: z.string().nullable(),
    }),
  ),
  // The countries the recipient book takes (J-bank-04 #2), each with the rails its forms come from.
  countries: z.array(z.object({ country: z.string(), rails: z.array(z.enum(BANK_RAILS)) })),
});
export type RailRequirements = z.infer<typeof railRequirementsSchema>;
export const railSendSchema = z.object({
  requestId: z.string(),
  fromSpaceId: z.string(),
  assetId: z.string(),
  amount: money,
  rail: z.enum(BANK_RAILS),
  recipient: z.string(),
  status: z.literal('refused'),
  refusalCode: z.string(),
  createdAt: z.string(),
});
export type RailSend = z.infer<typeof railSendSchema>;
export const railSendCheckSchema = z.object({ assetId: z.string(), amount: money, available: money });
/** svc-bank `bank.railSends.payees` (J-bank-04 #2): the recipient book, each with its name check and cooling-off. */
export const railPayeeSchema = z.object({
  payeeId: z.string(),
  nickname: z.string(),
  country: z.string(),
  rail: z.enum(BANK_RAILS),
  recipient: z.string(),
  verification: z.literal('cannot_check'),
  verificationRail: z.string(),
  addedAt: z.string(),
  cooling: z.object({ state: z.enum(['unset', 'active', 'open']), endsAt: z.string().nullable() }),
  /** The first-time payee scam warning (J-bank-18 #2): unread until the person reads it for this recipient. */
  scamWarning: z.object({ state: z.enum(['unread', 'read']), readAt: z.string().nullable() }),
});
export type RailPayee = z.infer<typeof railPayeeSchema>;
export const railPayeeCheckSchema = z.object({
  nickname: z.string(),
  country: z.string(),
  rail: z.enum(BANK_RAILS),
  recipient: z.string(),
});

/** This area's reads of svc-bank `bank.*`, composed into `bankReads` in contracts.ts. */
export const paymentsReads = {
  'calendar.window': calendarViewSchema,
  // Read by name through Activity's source table; its schema is the record's own, so it cannot drift from the bank's.
  'transfers.listSchedules': BANK_TRANSFERS_LIST_SCHEDULES.output,
} as const;

/** This area's writes to svc-bank `bank.*`, composed into `bankWrites` in contracts.ts. */
export const paymentsWrites = {
  // A move into a space: the ledger's transaction, or, where the partner bank holds both sides (OWNER 226), the partner's
  // one move and no ledger transaction. Exactly one book made it; a reply naming neither, or both, is never a confirmation.
  'transfers.create': z
    .object({
      ledgerTxId: z.string().min(1).nullable(),
      amount: money,
      partnerMove: z
        .object({ id: z.string().min(1), label: z.string().min(1), movedAt: z.string() })
        .nullable()
        .optional(),
    })
    .refine((data) => (data.ledgerTxId === null) === (data.partnerMove != null)),
  // The ActionSpec dispatch table names this write; its reply schema is the record's own (the send itself goes through
  // the money client's transfer, which checks the reply against the review).
  'transfers.toUser': BANK_TRANSFERS_TO_USER.output,
  'transfers.schedule': z.object({ id: z.string(), nextRunAt: z.string() }),
  'transfers.scheduleToUser': z.object({ id: z.string(), nextRunAt: z.string() }),
  'transfers.pause': z.object({ status: z.string(), nextRunAt: z.string() }),
  'transfers.resume': z.object({ status: z.string(), nextRunAt: z.string(), skipped: z.array(z.number().int()) }),
  'transfers.cancel': z.object({ cancelled: z.literal(true) }),
  'transfers.updateSchedule': z.object({
    id: z.string(),
    revision: z.number().int(),
    amount: money,
    endsAt: z.string().nullable(),
    nextRunAt: z.string(),
  }),
} as const;
