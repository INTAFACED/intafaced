import { P2P_CANCEL_REASONS, P2P_CANCELLED_BY } from '@intafaced/contracts/p2p-cancel';
import {
  P2P_CHAT_MESSAGES_LIST,
  P2P_CHAT_MESSAGES_SEND,
  P2P_CONTACTS_LIST,
  P2P_MERCHANTS_ADVERTISER_TERMS,
  P2P_MERCHANTS_POSTING_ELIGIBILITY,
  P2P_MERCHANTS_PRESENCE,
  P2P_MERCHANTS_TODOS,
  P2P_MODERATION,
  P2P_REPUTATION_APPEAL,
  P2P_REPUTATION_GET,
  P2P_REVIEWS_FOR_TRADE,
  P2P_REVIEWS_LEAVE,
} from '@intafaced/contracts/p2p-procedures';
import type { ProcedureOutput } from '@intafaced/contracts/procedure';
import { z } from 'zod';
import type { ApiResult } from '../../shared/api';
import { decimalSchema } from '../../shared/money';

/** A list procedure now returns `{ items, nextCursor }`. Callers that still render an array keep the items. */
export function listed<T>(result: ApiResult<{ items: T[] }>): ApiResult<T[]> {
  return result.ok ? { ok: true, data: result.data.items } : result;
}

// Browser projections of the mounted service outputs. No service/server roots are imported.
// Authorities: svc-bank/router.ts, svc-p2p/router.ts, svc-pay/{router,subscription-router,submerchant-router}.ts.
export const id = z.string().guid();
export const asset = z.string().min(1).max(16);
export const amount = decimalSchema.refine((v) => /^\d+(\.\d{1,18})?$/.test(v));
export const positiveAmount = amount.refine((v) => /[1-9]/.test(v), 'Enter an amount greater than zero');
export const sendInput = z.object({
  transferId: z.string().min(8).max(64),
  fromSpaceId: id,
  toUserId: z.string().min(1).max(64),
  amount: positiveAmount,
  /** Shown to the recipient as well as the sender. Omitted means no note. */
  note: z.string().min(1).max(140).optional(),
  /** The open payment request this send settles; its transfer id is then `request:<requestId>`. */
  requestId: id.optional(),
  /** The single-use fresh confirmation for exactly this send, when the bank's money-out rule asks for one. */
  stepUpApprovalId: z.string().min(1).max(64).optional(),
});
export const sendOutput = z.object({ ledgerTxId: z.string().min(1), amount });
export const offerSchema = z.object({
  id,
  makerId: z.string(),
  side: z.enum(['buy', 'sell']),
  asset,
  fiatCurrency: z.string(),
  priceType: z.enum(['fixed', 'float']),
  price: amount,
  minAmount: amount,
  maxAmount: amount,
  remainingAmount: amount,
  methods: z.array(z.unknown()),
  /**
   * P-disputes-security-09: the listed methods whose money arrives within a settlement window, with the longest window
   * any market sets (null: the published payment time applies). Instant methods are not listed.
   */
  nonInstantMethods: z.array(z.object({ methodId: z.string(), windowSeconds: z.number().int().positive().nullable() })).optional(),
  /** P-disputes-security-09: the seller accepted non-instant methods when posting. */
  acceptsNonInstant: z.boolean().optional(),
  terms: z.string(),
  status: z.enum(['active', 'paused', 'closed']),
  /** P-ads-merchant-18: why the service paused the ad; null when it was not the service (or it is not paused). */
  pauseReason: z.enum(['method_removed']).nullable().optional(),
  /** P-ads-merchant-06: why the ad is closed (by the person, or sold out); null when not closed or closed before reasons. */
  closeReason: z.enum(['by_you', 'sold_out']).nullable().optional(),
  /** P-ads-merchant-07: `public` (on the board) or `private` (by share link only). */
  visibility: z.enum(['public', 'private']).optional(),
  /** P-ads-merchant-06: when the ad came into its present status. */
  statusSince: z.string().optional(),
  /** P-ads-merchant-06: the closed ad this one relisted. */
  relistedFrom: id.nullable().optional(),
  /** P-ads-merchant-06: on My Ads' closed list, the ad this closed one was relisted as. */
  relistedAs: id.nullable().optional(),
  createdAt: z.string(),
  /** Board reads, floating ads only: the market reference, or null when no market feed prices the pair. */
  referencePrice: amount.nullable().optional(),
});
/** One board page (`offers.page`): continue with `nextCursor` under the same filters and sort. */
export const offerPageSchema = z.object({ offers: z.array(offerSchema), nextCursor: z.string().nullable() });
export type OfferPage = z.infer<typeof offerPageSchema>;
export const BOARD_SORTS = ['price_asc', 'price_desc'] as const;
export type BoardSort = (typeof BOARD_SORTS)[number];
/** What the board asks the service for. Everything is filtered and sorted there, so paging never misses a row. */
export type BoardQuery = {
  asset?: string;
  fiatCurrency?: string;
  side?: 'buy' | 'sell';
  methodId?: string;
  fiatAmount?: string;
  sort?: BoardSort;
};
/** svc-p2p's readable status, derived on the server from the state, the resolution and how it was reached. */
export const displayStatuses = [
  'waiting_for_escrow',
  'waiting_for_buyer_to_pay',
  'waiting_for_seller_to_release',
  'appealing',
  'completed',
  'completed_by_dispute_ruling',
  'cancelled',
  'cancelled_by_timeout',
  'cancelled_by_dispute_ruling',
] as const;
/** How money on a payment method arrives in one market (svc-p2p settlement profile). */
export const methodSettlementSchema = z.union([
  z.object({ instant: z.literal(true) }),
  z.object({ instant: z.literal(false), windowSeconds: z.number().int().positive().nullable() }),
]);
export type MethodSettlement = z.infer<typeof methodSettlementSchema>;
export const tradeSchema = z.object({
  id,
  offerId: id,
  /** P-ads-merchant-07: the order was taken through a share link. */
  sharedFrom: z.boolean().optional(),
  sellerId: z.string(),
  buyerId: z.string(),
  asset,
  amount,
  fiatCurrency: z.string(),
  fiatAmount: amount,
  price: amount,
  method: z.string(),
  status: z.enum(['created', 'escrowed', 'fiat_sent', 'released', 'cancelled', 'disputed']),
  resolution: z.enum(['released', 'refunded', 'voided']).nullable(),
  deadlineAt: z.string().nullable(),
  createdAt: z.string(),
  escrowedAt: z.string().nullable(),
  resolvedAt: z.string().nullable(),
  settledAt: z.string().nullable(),
  /** RC-p2p-02: who holds the coins: the ledger, or the escrow contract (no ledger entry). Fixed at take. */
  escrowKind: z.enum(['ledger', 'contract']).optional(),
  /** RC-p2p-02: the contract deal's terms (fixed at take) and, once the seller attached it, the deal. Null on a ledger order. */
  contract: z
    .object({
      chainId: z.number().int().positive(),
      token: z.string(),
      units: z.string().regex(/^[1-9][0-9]*$/),
      buyerWallet: z.string(),
      disputeWindowSeconds: z.number().int().positive(),
      timeout: z.literal('refund_seller'),
      dealId: z.string().nullable(),
      sellerWallet: z.string().nullable(),
    })
    .nullable()
    .optional(),
  /** `trades.get` only: the ad's terms when the order was placed (later ad edits never change them); null when the order predates the copy. */
  terms: z.string().nullable().optional(),
  /** `trades.get` only: the readable status the order list shows. */
  displayStatus: z.enum(displayStatuses).optional(),
  /** `trades.get` only: the fee rate frozen at take, and for a released order the split the ledger posted from it (null otherwise). */
  feeBps: z.number().int().min(0).max(9_999).optional(),
  fee: amount.nullable().optional(),
  netAmount: amount.nullable().optional(),
  /** `trades.get` only: the method's settlement profile in the market the buyer pays into, copied at take. */
  settlement: methodSettlementSchema.optional(),
  /** `trades.get` only: while the escrow is held, the split a release would post (null once it is not held). */
  releasePreview: z.object({ fee: amount, netAmount: amount }).nullable().optional(),
  /** `trades.get` only: what of this order is still in escrow (zero once the release or refund posted; null while `created`). */
  escrowHeld: amount.nullable().optional(),
  /** `trades.get` only: the buyer's reminders to the seller (P-trade-orders-15). */
  reminders: z.lazy(() => tradeRemindersSchema).optional(),
  mismatch: z.lazy(() => tradeMismatchSchema.nullable()).optional(),
  /** svc-p2p `trades.get` `paymentValidation`: what stops the bank rail checking this order, or null. */
  paymentValidation: z.object({ blocker: z.enum(['rail.bank', 'p2p.method_not_rail_validated']).nullable() }).optional(),
  /** svc-p2p `trades.get` `cancelReason` (P-trade-orders-19): on a cancelled order, who cancelled it and the code they chose. */
  cancelReason: z
    .object({ by: z.enum(P2P_CANCELLED_BY), code: z.enum(P2P_CANCEL_REASONS).nullable().catch(null) })
    .nullable()
    .optional(),
});
/** svc-p2p `trades.remind` and `trades.get` `reminders`: how many went, the last, when the next may go, the owner's count. */
export const tradeRemindersSchema = z.object({
  count: z.number().int().nonnegative(),
  lastAt: z.string().datetime().nullable(),
  nextAt: z.string().datetime().nullable(),
  max: z.number().int().positive().nullable(),
});
export type TradeReminders = z.infer<typeof tradeRemindersSchema>;
/** svc-p2p `trades.reportSensitiveRemark` (P-ads-merchant-19): the case a party's report of a payment-note remark opened. */
export const remarkCaseSchema = z.object({
  id,
  tradeId: id,
  reporterId: z.string(),
  reportedId: z.string(),
  reporterRole: z.enum(['buyer', 'seller']),
  remark: z.string(),
  status: z.literal('open'),
  openedAt: z.string(),
});
export type RemarkCase = z.infer<typeof remarkCaseSchema>;
/** svc-p2p `trades.remarkCase`: the person's own report on the order, and whether the other party reported them (no quote). */
export const remarkCasesOnSchema = z.object({
  mine: remarkCaseSchema.nullable(),
  againstMe: z.object({ caseId: id, openedAt: z.string() }).nullable(),
});
export type RemarkCasesOn = z.infer<typeof remarkCasesOnSchema>;
/**
 * svc-p2p `trades.reportMismatch` and `trades.get` `mismatch`: the seller's report of what arrived, and the owner's band
 * it was classified by (`reported` when the band is blank and a person decides).
 */
export const tradeMismatchSchema = z.object({
  kind: z.enum(['under', 'over', 'partial']),
  amountReceived: z.string(),
  expected: z.string(),
  classification: z.enum(['within_tolerance', 'outside_tolerance', 'reported']),
  toleranceBps: z.number().int().nonnegative().nullable(),
  reportedAt: z.string().datetime(),
});
export type TradeMismatch = z.infer<typeof tradeMismatchSchema>;
/** svc-p2p `trades.validatePayment`: released on an exact match, or pending while the bank shows nothing. */
export const validatePaymentSchema = z.object({ outcome: z.enum(['released', 'pending']), trade: tradeSchema });
/** svc-p2p `trades.page`: one keyset page newest first, the server's tab and readable status per row, and exact per-tab counts. */
export const orderTabs = ['in_progress', 'in_dispute', 'completed', 'cancelled'] as const;
export const orderPageSchema = z.object({
  trades: z.array(
    tradeSchema.extend({
      tab: z.enum(orderTabs),
      displayStatus: z.enum(displayStatuses),
    }),
  ),
  nextCursor: z.string().nullable(),
  counts: z.object({
    in_progress: z.number().int().nonnegative(),
    in_dispute: z.number().int().nonnegative(),
    completed: z.number().int().nonnegative(),
    cancelled: z.number().int().nonnegative(),
  }),
});
/** svc-p2p `trades.export`: the CSV the service generated, its row count and its per-pair totals as decimal strings. */
export const orderExportSchema = z.object({
  csv: z.string(),
  rows: z.number().int().nonnegative(),
  format: z.literal('csv'),
  totals: z.array(z.object({ asset, fiatCurrency: z.string(), amount, fiatAmount: amount })),
});
/** svc-p2p `trades.receipt`: one released trade, the caller's own side only, and what is left of the download quotas. */
export const orderReceiptSchema = z.object({
  receipt: z.object({
    tradeId: id,
    offerId: id,
    role: z.enum(['buyer', 'seller']),
    asset,
    amount,
    fiatCurrency: z.string(),
    fiatAmount: amount,
    price: amount,
    feeBps: z.number().int().nonnegative(),
    method: z.string(),
    createdAt: z.string(),
    escrowedAt: z.string().nullable(),
    fiatSentAt: z.string().nullable(),
    resolvedAt: z.string().nullable(),
  }),
  dailyRemaining: z.number().int().nonnegative(),
  tradeRemaining: z.number().int().nonnegative(),
});
export const instrumentSchema = z.object({
  id,
  methodId: z.string(),
  country: z.string(),
  fiatCurrency: z.string(),
  label: z.string(),
  status: z.enum(['active', 'removed']),
  createdAt: z.string(),
  updatedAt: z.string(),
  removedAt: z.string().nullable(),
});
/** `instruments.revealMasked`: the owner's own values as svc-p2p masks them, read only on request and logged like every read. */
export const revealedInstrumentSchema = instrumentSchema.extend({ details: z.record(z.string(), z.string()) });
/** One field a payment method asks for, as svc-p2p's registry publishes it. About the method, never about a person. */
export const methodFieldSchema = z.object({
  key: z.string(),
  label: z.string(),
  required: z.boolean(),
  pattern: z.string().optional(),
  minLength: z.number().int().optional(),
  maxLength: z.number().int().optional(),
  sensitive: z.boolean().optional(),
  help: z.string().optional(),
  /** P-ads-merchant-18: the account holder, who must be the person themself. */
  holderName: z.boolean().optional(),
});
export type MethodField = z.infer<typeof methodFieldSchema>;
export const methodSchema = z.object({
  methodId: z.string(),
  country: z.string(),
  label: z.string(),
  fields: z.array(methodFieldSchema),
  enabled: z.boolean(),
  settlement: methodSettlementSchema.optional(),
  /** P-ads-merchant-19: the row's payment-note rules and cash-in-person rules (cash in person when set), or null. */
  noteRules: z
    .object({ guidance: z.string(), forbidden: z.array(z.string()) })
    .nullable()
    .optional(),
  cashRules: z.object({ meetingGuidance: z.string(), proof: z.string(), releaseWindowSeconds: z.number().int() }).nullable().optional(),
});
export const tradeDestinationSchema = z.object({
  tradeId: id,
  methodId: z.string(),
  country: z.string(),
  fiatCurrency: z.string(),
  label: z.string(),
  details: z.record(z.string(), z.string()),
  /** Each detail's label from the method schema, in its order. */
  fields: z.array(z.object({ key: z.string(), label: z.string() })),
  attachedAt: z.string(),
  /** The seller changed or removed this destination after the order was placed; the order still pays the details above. */
  payeeChange: z.object({ kind: z.enum(['changed', 'removed']) }).nullable(),
});
export const disputeSchema = z.object({
  id,
  tradeId: id,
  openedBy: z.string(),
  openedVia: z.enum(['party', 'timeout']),
  reason: z.string(),
  chatThreadId: id.nullable(),
  status: z.enum(['open', 'resolved']),
  moderatorId: z.string().nullable(),
  resolution: z.enum(['release', 'refund']).nullable(),
  resolutionNotes: z.string().nullable(),
  deadlineAt: z.string(),
  openedAt: z.string(),
  resolvedAt: z.string().nullable(),
  evidence: z.array(
    z.object({ seq: z.number().int(), submittedBy: z.string().nullable(), submittedAt: z.string().nullable(), item: z.unknown() }),
  ),
  overdue: z.boolean(),
  escalatedAt: z.string().nullable(),
  escalations: z.number().int(),
  lastSeenByModeratorAt: z.string().nullable(),
});
export const disputeOpenedSchema = z.object({
  disputeId: id,
  tradeId: id,
  chatThreadId: id,
  deadlineAt: z.string(),
  ifNobodyRules: z.literal('escalated_and_held'),
  moderationConfigured: z.boolean(),
  moderation: P2P_MODERATION,
});
/** `trades.stepUpWindow`: until when this session's takes need no new confirmation, or null. */
export const takeStepUpWindowSchema = z.object({ confirmedUntil: z.string().datetime({ offset: true }).nullable() });
/** What `trades.quote` returns: exact figures for one take, before anything is locked. */
export const takeQuoteSchema = z.object({
  amount: positiveAmount,
  price: amount,
  fiatAmount: amount,
  feeBps: z.number().int().nonnegative().max(9999),
  fee: amount,
  netAmount: amount,
  reservationExpiresAt: z.string().datetime({ offset: true }),
  /** Set only on a locked quote (`trades.lockQuote`): the take names it, and `reservationExpiresAt` is when it ends. */
  quoteId: id.optional(),
});
/** What `trades.lockQuote` returns: the quote held until `expiresAt`. */
export const lockedQuoteSchema = takeQuoteSchema
  .omit({ reservationExpiresAt: true, quoteId: true })
  .extend({ quoteId: id, expiresAt: z.string().datetime({ offset: true }), expiresInMs: z.number().int().nonnegative() });
/** A versioned acceptance: the owner-published version and when this person accepted it (advertiser terms). */
export type P2PRiskNotice = ProcedureOutput<typeof P2P_MERCHANTS_ADVERTISER_TERMS>;
/** P-ads-merchant-01: the caller's free balance of one coin, as svc-p2p reads it from the ledger. */
export const p2pSellBalanceSchema = z.object({ asset: z.string(), available: amount });
/** P-ads-merchant-12: the posting checklist for one fiat, every check with the person's value and the target. */
export type P2PPostingEligibility = ProcedureOutput<typeof P2P_MERCHANTS_POSTING_ELIGIBILITY>;
/** P-ads-merchant-01: what the post-an-ad form sends to `offers.create`, besides its key and the terms version. */
export type PostOfferInput = {
  side: 'buy' | 'sell';
  asset: string;
  fiatCurrency: string;
  priceType: 'fixed' | 'float';
  price: string;
  minAmount: string;
  maxAmount: string;
  totalAmount?: string;
  methods: string[];
  terms?: string;
  acceptsNonInstant?: boolean;
  /** The ad's own id, chosen once per form; the post's key names it too. */
  offerId?: string;
};
export const merchantSchema = z.object({
  id,
  userId: id,
  mode: z.enum(['gateway', 'psp', 'payfac']),
  status: z.enum(['pending', 'active', 'suspended', 'closed']),
  kybStatus: z.enum(['none', 'pending', 'approved', 'rejected']),
  kybRef: z.string().nullable(),
  feeBps: z.number().nullable(),
  starterFee: z
    .object({ bps: z.number().int().min(0).max(10_000), source: z.literal('local_test') })
    .nullable()
    .optional(),
});
export const balanceSchema = z.object({ clearing: amount, available: amount });
export const linkSchema = z.object({
  id,
  prefix: z.string(),
  label: z.string(),
  amount: amount.nullable(),
  currency: z.string().nullable(),
  active: z.boolean(),
  expiresAt: z.string().nullable(),
  maxUses: z.number().int().nullable(),
  uses: z.number().int(),
  createdAt: z.string(),
});
export const newLinkSchema = z.object({
  id,
  token: z.string(),
  prefix: z.string(),
  label: z.string(),
  expiresAt: z.string().datetime({ offset: true }),
  maxUses: z.number().int().nullable(),
  /** The service's own checkout address: a path from its public base, or a full web address. Older services omit it. */
  checkoutUrl: z.string().min(1).max(2048).nullish(),
});
export const resolvedLinkSchema = z.object({
  id,
  merchantId: id,
  profileId: id.nullable(),
  label: z.string(),
  amount: amount.nullable(),
  currency: z.string().nullable(),
  expiresAt: z.string().nullable(),
  remainingUses: z.number().int().nullable(),
  checkoutConfig: z.record(z.string(), z.unknown()),
});
export const checkoutSchema = z.object({
  id,
  status: z.enum(['open', 'completed', 'expired', 'cancelled']),
  label: z.string(),
  amount,
  currency: asset,
  method: z.string(),
  expiresAt: z.string().datetime({ offset: true }),
  instruction: z.object({ reference: z.string(), amount, currency: asset }).nullable(),
});
export const paymentSchema = z.object({
  id,
  customerRef: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  merchantId: id,
  profileId: id.nullable(),
  amount,
  assetId: asset,
  method: z.string(),
  railAdapter: z.string(),
  railRef: z.string().nullable(),
  status: z.enum(['created', 'authorized', 'captured', 'settled', 'refunded', 'disputed', 'failed']),
  capturedAmount: amount,
  refundedAmount: amount,
  createdAt: z.string().datetime({ offset: true }),
});
/**
 * Event times as Zod 3 read them: any two-digit offset, colon optional. Zod 4's
 * datetime refuses `+24:00` or `+0530`, and one such row would fail the whole
 * history read; the row parses here and the renderer leaves it unresolved.
 */
const eventTs = z
  .string()
  .regex(
    /^((\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29|\d{4}-((0[13578]|1[02])-(0[1-9]|[12]\d|3[01])|(0[469]|11)-(0[1-9]|[12]\d|30)|(02)-(0[1-9]|1\d|2[0-8])))T([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d+)?)?(Z|([+-]\d{2}:?\d{2}))$/,
    'Invalid ISO datetime',
  );
const paymentEventOwnerSchema = z.object({
  id,
  event: z.string(),
  payload: z.record(z.string(), z.unknown()),
  railEventId: z.string().nullable(),
  ts: eventTs,
});
/** Team reads. Amount and a catalog failure. No raw payload. */
const paymentEventTeamSchema = z
  .object({
    id,
    event: z.string(),
    ts: eventTs,
    amount: amount.nullable(),
    assetId: asset.nullable(),
    failure: z.object({ code: z.string(), message: z.string() }).strict().nullable(),
  })
  .strict();
export const paymentEventSchema = z.union([paymentEventOwnerSchema, paymentEventTeamSchema]);
export const settlementSchema = z.object({
  id,
  merchantId: id,
  window: z.string(),
  assetId: asset,
  gross: amount,
  fees: amount,
  net: amount,
  payoutMethod: z.string().nullable(),
  payoutRef: z.string().nullable(),
  status: z.enum(['pending', 'posted', 'paid_out', 'failed']),
});
export const mandateSchema = z.object({
  id,
  merchantId: id,
  customerId: z.string(),
  assetId: asset,
  amount,
  ceiling: amount.nullable(),
  cadence: z.enum(['daily', 'weekly', 'monthly']),
  startsAt: z.string(),
  endsAt: z.string().nullable(),
  railAdapter: z.string().nullable(),
  railMandateRef: z.string().nullable(),
  status: z.enum(['active', 'cancelled', 'expired']),
  cancelledAt: z.string().nullable(),
  createdAt: z.string(),
});
export const subscriptionSchema = z.object({
  id,
  mandateId: id,
  merchantId: id,
  customerId: z.string(),
  nextRunAt: z.string(),
  status: z.enum(['active', 'paused', 'cancelled', 'completed']),
  cancelledAt: z.string().nullable(),
  path: z.string(),
  createdAt: z.string(),
  anchorAt: z.string().nullable(),
  anchorOccurrence: z.number().int(),
  pausedAt: z.string().nullable(),
  resumedAt: z.string().nullable(),
  stalledAt: z.string().nullable(),
  stallReason: z.enum(['operator_pause', 'runner_outage', 'arrears', 'fee_unpublished', 'window_exhausted', 'due_pass_fault']).nullable(),
  /** The catalogue price it was started on; absent or null when it was started from a mandate alone. */
  priceId: id.nullish(),
});
export const executionSchema = z.object({
  id,
  subscriptionId: id,
  occurrence: z.number().int(),
  amount,
  status: z.enum(['pending', 'invoiced', 'settled', 'rejected', 'skipped']),
  paymentId: id.nullable(),
  rejectionCode: z.string().nullable(),
  attemptedAt: z.string(),
  settledAt: z.string().nullable(),
  createdAt: z.string(),
  notifyStatus: z.enum(['attempted', 'skipped_unwired', 'failed']).nullable(),
  notifyCode: z.string().nullable(),
});
export const subscriptionPostureSchema = z.object({
  paths: z.array(
    z.object({
      path: z.enum(['crypto_invoice', 'card']),
      charge: z.enum(['open_crypto_invoice', 'refuse']),
      opensMoney: z.boolean(),
      posture: z.string(),
    }),
  ),
  preChargeNotify: z.object({ status: z.literal('unwired'), notified: z.literal(false), merchantReadable: z.string() }),
  card: z.object({ status: z.literal('refuse_closed'), code: z.literal('pay.mandate_rail_absent') }),
});
export const submerchantSchema = z.object({
  id,
  userId: z.string(),
  parentMerchantId: id.nullable(),
  mode: z.enum(['gateway', 'psp', 'payfac']),
  status: z.enum(['pending', 'active', 'suspended', 'closed']),
  kybStatus: z.enum(['none', 'pending', 'approved', 'rejected']),
  settlingParty: z.string(),
  feeBps: z.number().int().nullable(),
  depth: z.number().int(),
  createdAt: z.string(),
});
export const grantSchema = z.object({
  granteeMerchantId: id,
  subjectMerchantId: id,
  area: z.string(),
  reason: z.string(),
  actorId: z.string(),
  actorMerchantId: id,
  grantedAt: z.string(),
});
export const permissionEventSchema = z.object({
  id,
  seq: z.string(),
  granteeMerchantId: id,
  subjectMerchantId: id,
  area: z.string(),
  action: z.enum(['grant', 'revoke']),
  reason: z.string(),
  actorId: z.string(),
  actorMerchantId: id,
  actorScope: z.string(),
  createdAt: z.string(),
});
export const keySchema = z.object({
  id: z.string(),
  name: z.string(),
  prefix: z.string(),
  scopes: z.array(z.string()),
  lastUsedAt: z.string().nullable(),
  revoked: z.boolean(),
  mode: z.enum(['live', 'sandbox']),
  requireSignature: z.boolean(),
  requireNonEmptyIpAllowlist: z.boolean(),
  ipAllowlist: z.array(z.string()),
});
export const webhookSchema = z.object({
  id,
  merchantId: id,
  url: z.string(),
  status: z.enum(['active', 'disabled']),
  disabledReason: z.string().nullable(),
  consecutiveFailures: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export const webhookDeliverySchema = z.object({
  id,
  endpointId: id,
  merchantId: id,
  eventId: z.string(),
  eventType: z.string(),
  status: z.enum(['pending', 'delivered', 'failed', 'dead', 'unknown']),
  attempts: z.number().int(),
  nextAttemptAt: z.string(),
  lastStatusCode: z.number().nullable(),
  lastError: z.string().nullable(),
  createdAt: z.string(),
  deliveredAt: z.string().nullable(),
});
export type Offer = z.infer<typeof offerSchema>;
export type Trade = z.infer<typeof tradeSchema>;
export type TradeDestination = z.infer<typeof tradeDestinationSchema>;
export type OrderPage = z.infer<typeof orderPageSchema>;
export type OrderTab = (typeof orderTabs)[number];
export type OrderExport = z.infer<typeof orderExportSchema>;
/** svc-p2p `reviews.*`: one good/bad review per party of a released order. */
export type OrderReview = ProcedureOutput<typeof P2P_REVIEWS_LEAVE>;
/** `reviews.forTrade`: the viewer's own review of the order and the visible one about them. */
export type TradeReviews = ProcedureOutput<typeof P2P_REVIEWS_FOR_TRADE>;
export type OrderReceipt = z.infer<typeof orderReceiptSchema>;
/** svc-p2p `chat.messages.list`: oldest first; `nextCursor` is set while a full page was returned. */
export type ChatPage = ProcedureOutput<typeof P2P_CHAT_MESSAGES_LIST>;
export type ChatMessage = ChatPage['messages'][number];
/** `chat.messages.send`: the stored message, `created: false` when the same client id had already been stored. */
export type ChatSent = ProcedureOutput<typeof P2P_CHAT_MESSAGES_SEND>;
/** `contacts.list` and every contacts change answer with the caller's whole lists of account ids. */
export type Contacts = ProcedureOutput<typeof P2P_CONTACTS_LIST>;
export type TakeQuote = z.infer<typeof takeQuoteSchema>;
export type Reputation = ProcedureOutput<typeof P2P_REPUTATION_GET>;
/** P-trade-orders-21: the person's one completion appeal (`reputation.myAppeal`, `reputation.appeal`). */
export type CompletionAppeal = ProcedureOutput<typeof P2P_REPUTATION_APPEAL>;
export type Merchant = z.infer<typeof merchantSchema>;
export type Payment = z.infer<typeof paymentSchema>;

/** P-ads-merchant-18: the person's active sell ads that list a method, and which ones lose their last payable method. */
export const methodRemovalImpactSchema = z.object({
  instrumentId: id,
  methodId: z.string(),
  fiatCurrency: z.string(),
  ads: z.array(z.object({ offerId: id, asset, fiatCurrency: z.string(), pauses: z.boolean() })),
});

/** P-ads-merchant-06: the person's ad edits today against the daily cap, and when the count starts again. */
export const offerEditQuotaSchema = z.object({
  limit: z.number().int().positive(),
  used: z.number().int().nonnegative(),
  remaining: z.number().int().nonnegative(),
  resetsAt: z.string().datetime(),
});

/** P-ads-merchant-08: the person's presence. A scheduled week is a list of windows in their own time zone. */
export type Presence = ProcedureOutput<typeof P2P_MERCHANTS_PRESENCE>;
export type PresenceWindow = Presence['windows'][number];
/** P-ads-merchant-08: one open order that waits on someone, with its deadline and where it is answered. */
export type TodoItem = ProcedureOutput<typeof P2P_MERCHANTS_TODOS>['items'][number];

/** P-ads-merchant-08: a bulk action's answer, one result per ad. */
export const bulkOutcomeSchema = z.object({
  action: z.enum(['pause', 'resume', 'remove']),
  replayed: z.boolean(),
  more: z.boolean(),
  results: z.array(
    z.object({
      offerId: z.string(),
      ok: z.boolean(),
      status: z.enum(['active', 'paused', 'closed']).nullable(),
      code: z.string().nullable(),
    }),
  ),
});
export type BulkOutcome = z.infer<typeof bulkOutcomeSchema>;

/** P-ads-merchant-06: the fields an edit of a published ad may change; only the changed ones are sent. */
export type OfferUpdateInput = {
  price?: string;
  minAmount?: string;
  maxAmount?: string;
  totalAmount?: string;
  methods?: string[];
  terms?: string;
};

/** P-ads-merchant-07: a share link to the person's own ad, as svc-p2p lists it (never its token). */
export const shareLinkSchema = z.object({
  id,
  offerId: id,
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  revokedAt: z.string().datetime().nullable(),
});
export type ShareLink = z.infer<typeof shareLinkSchema>;

/** RC-p2p-02 `trades.contractEscrow`: the contract escrow for one asset, offered or refused with its blocker. */
export const contractEscrowOfferSchema = z.object({
  available: z.boolean(),
  blocker: z.string().nullable(),
  reason: z.string().nullable(),
  network: z.object({ chainId: z.number().int().positive(), label: z.string(), escrow: z.string() }).nullable(),
  token: z.object({ address: z.string(), decimals: z.number().int() }).nullable(),
  disputeWindowSeconds: z.number().int().positive().nullable(),
  timeout: z.literal('refund_seller'),
  mainnet: z.object({ available: z.literal(false), blocker: z.literal('audit.external') }),
  audited: z.literal(false),
});
export type ContractEscrowOffer = z.infer<typeof contractEscrowOfferSchema>;
