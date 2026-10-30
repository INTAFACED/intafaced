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
export const spaceSchema = z.object({
  id: z.string(),
  assetId: asset,
  kind: z.enum(['primary', 'named']),
  name: z.string(),
  goalTarget: amount.nullable(),
  lockedUntil: z.string().nullable(),
  balance: amount,
  ledgerAccount: z.object({ ownerType: z.string(), ownerId: z.string(), assetId: asset, kind: z.string() }),
});
export const sendInput = z.object({
  transferId: z.string().min(8).max(64),
  fromSpaceId: id,
  toUserId: z.string().min(1).max(64),
  amount: positiveAmount,
  /** Shown to the recipient as well as the sender. Omitted means no note. */
  note: z.string().min(1).max(140).optional(),
});
/** `bank.transfers.quote`: the published limits and fee for one personal send, and how much of today is used. */
export const transferQuoteSchema = z.object({
  assetId: asset,
  amount,
  perTransferLimit: amount,
  dailyLimit: amount,
  spentToday: amount,
  fee: amount,
  feeBlocker: z.string().nullable(),
  withinPerTransfer: z.boolean(),
  withinDaily: z.boolean(),
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
/** svc-p2p `chat.messages.list`: oldest first; `nextCursor` is set while a full page was returned. */
export const chatMessageSchema = z.object({
  id,
  tradeId: id,
  senderId: z.string(),
  clientId: z.string(),
  text: z.string(),
  createdAt: z.string(),
});
export const chatPageSchema = z.object({
  messages: z.array(chatMessageSchema),
  nextCursor: z.string().nullable(),
  unread: z.number().int().nonnegative(),
});
/** `chat.messages.send`: the stored message, `created: false` when the same client id had already been stored. */
export const chatSentSchema = chatMessageSchema.extend({
  created: z.boolean(),
  notify: z.object({
    delivered: z.boolean(),
    code: z.enum(['p2p.chat_notify_delivered', 'p2p.chat_notify_unwired', 'p2p.chat_notify_failed']),
  }),
});
export const chatUnreadSchema = z.object({ tradeId: id, unread: z.number().int().nonnegative() });
/** `contacts.list` and every contacts mutation answer with the caller's whole lists of account ids. */
export const contactsSchema = z.object({ following: z.array(z.string()), blocking: z.array(z.string()) });
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
export const fiatSchema = z.object({ code: z.string(), name: z.string(), symbol: z.string(), minorUnits: z.number().int() });
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
export const moderationSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('absent'), code: z.literal('p2p.moderation_unreachable') }),
  z.object({ status: z.literal('configured'), code: z.literal('p2p.moderation_unprobed') }),
]);
export const p2pHealthSchema = z.object({
  ok: z.literal(true),
  service: z.literal('svc-p2p'),
  moderationConfigured: z.boolean(),
  moderation: moderationSchema,
  offerLimitsConfigured: z.boolean(),
  offerLimitsPosture: z.enum(['unset', 'unlimited', 'configured']),
  instrumentKmsConfigured: z.literal(false),
  /** `local-test` is the test stack's seal; anything else refuses new ads until the owner's key service is wired. */
  instrumentKeyProvider: z.enum(['none', 'local-test']).optional(),
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
  moderation: moderationSchema,
});
export const reputationSchema = z
  .object({
    tradesTotal: z.number().int().nonnegative().max(2147483647),
    completed: z.number().int().nonnegative().max(2147483647),
    cancelled: z.number().int().nonnegative().max(2147483647),
    disputed: z.number().int().nonnegative().max(2147483647),
    disputesLost: z.number().int().nonnegative().max(2147483647),
    completionRate: z.number().finite().min(0).max(1),
    avgReleaseSecs: z.number().int().nonnegative().max(2147483647),
    badges: z.array(z.string()),
    merchant: z.boolean().nullable(),
    /** Public handle from identity. Null or absent when the service has none to give; never guessed. */
    handle: z.string().nullish(),
    memberSince: z.string().nullish(),
    /** Whether identity's public profile was read: `unwired` and `absent` explain a missing handle. */
    profile: z
      .object({ status: z.enum(['unwired', 'found', 'absent']) })
      .passthrough()
      .optional(),
  })
  .refine((record) => record.completed + record.cancelled <= record.tradesTotal && record.disputesLost <= record.disputed);
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
export const p2pStandingSchema = z.object({
  userId: z.string(),
  status: z.enum(['applied', 'approved', 'rejected', 'suspended', 'withdrawn']),
  appliedCompletionRate: z.number(),
  appliedTradesTotal: z.number().int(),
  appliedAt: z.string(),
  decidedAt: z.string().nullable(),
});
/** `access.eligibility`: each check before a take, in the service's order. `fix` is an app path or null. */
export const p2pEligibilitySchema = z.object({
  checks: z.array(
    z.object({
      id: z.enum(['verification', 'contact', 'jurisdiction', 'deposit']),
      state: z.enum(['met', 'not_met', 'unknown']),
      reason: z.string(),
      fix: z.string().nullable(),
    }),
  ),
  canTake: z.boolean(),
});
export type P2PEligibility = z.infer<typeof p2pEligibilitySchema>;
/** A versioned acceptance: the owner-published version and when this person accepted it (advertiser terms). */
export const p2pRiskNoticeSchema = z.object({ version: z.string(), acceptedAt: z.string().nullable() });
export type P2PRiskNotice = z.infer<typeof p2pRiskNoticeSchema>;
/** P-ads-merchant-01: the caller's free balance of one coin, as svc-p2p reads it from the ledger. */
export const p2pSellBalanceSchema = z.object({ asset: z.string(), available: amount });
/** P-ads-merchant-02 (`limits.verification`): the per-order band the caller's verification level allows, in one fiat. */
export const p2pLevelLimitsSchema = z.object({
  tier: z.enum(['none', 'basic', 'full', 'institutional']),
  currency: z.string(),
  orderMin: amount,
  orderMax: amount,
});
export type P2PLevelLimits = z.infer<typeof p2pLevelLimitsSchema>;
/** P-ads-merchant-12: the posting checklist for one fiat, every check with the person's value and the target. */
export const p2pPostingEligibilitySchema = z.object({
  fiatCurrency: z.string(),
  policy: z.enum(['thresholds', 'none', 'unset', 'invalid']),
  checks: z.array(
    z.object({
      id: z.enum(['kyc_tier', 'completed_orders', 'completion_rate']),
      state: z.enum(['met', 'not_met', 'unknown']),
      current: z.string().nullable(),
      required: z.string().nullable(),
      reason: z.string(),
    }),
  ),
});
export type P2PPostingEligibility = z.infer<typeof p2pPostingEligibilitySchema>;
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
export const p2pApiAccessSchema = z.object({
  eligible: z.boolean(),
  credential: z.enum(['session', 'api_key']),
  merchantStatus: p2pStandingSchema.shape.status.nullable(),
  keyPlane: z.literal('identity'),
  rateLimitPlane: z.literal('edge'),
  disputeResolution: z.literal('interactive_human_only'),
});
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
  status: z.enum(['pending', 'delivered', 'failed', 'dead']),
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
export const orderReviewSchema = z.object({
  id,
  /** Null for a viewer who is neither the author nor the subject (`reviews.list`). */
  tradeId: id.nullable(),
  authorId: z.string().nullable(),
  subjectId: z.string(),
  rating: z.enum(['good', 'bad']),
  comment: z.string(),
  explanation: z.string().nullable(),
  reply: z.string().nullable(),
  repliedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  hidden: z.boolean(),
  hiddenReason: z.string().nullable(),
});
/** `reviews.forTrade`: the viewer's own review of the order and the visible one about them. */
export const tradeReviewsSchema = z.object({ mine: orderReviewSchema.nullable(), theirs: orderReviewSchema.nullable() });
export type OrderReview = z.infer<typeof orderReviewSchema>;
export type TradeReviews = z.infer<typeof tradeReviewsSchema>;
export type OrderReceipt = z.infer<typeof orderReceiptSchema>;
export type ChatMessage = z.infer<typeof chatMessageSchema>;
export type ChatPage = z.infer<typeof chatPageSchema>;
export type ChatSent = z.infer<typeof chatSentSchema>;
export type Contacts = z.infer<typeof contactsSchema>;
export type TakeQuote = z.infer<typeof takeQuoteSchema>;
export type Reputation = z.infer<typeof reputationSchema>;
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
export const presenceWindowSchema = z.object({ day: z.number().int().min(1).max(7), start: z.string(), end: z.string() });
export type PresenceWindow = z.infer<typeof presenceWindowSchema>;
export const presenceSchema = z.object({
  mode: z.enum(['online', 'offline', 'scheduled']),
  timezone: z.string(),
  windows: z.array(presenceWindowSchema),
  onBoard: z.boolean(),
  nextChangeAt: z.string().datetime().nullable(),
  updatedAt: z.string().datetime().nullable(),
});
export type Presence = z.infer<typeof presenceSchema>;

/** P-ads-merchant-08: one open order that waits on someone, with its deadline and where it is answered. */
export const todoItemSchema = z.object({
  kind: z.enum(['payment_required', 'release_required', 'counterparty_action', 'dispute_open']),
  tradeId: z.string(),
  role: z.enum(['buyer', 'seller']),
  status: z.string(),
  asset: z.string(),
  amount: amount,
  fiatCurrency: z.string(),
  fiatAmount: amount,
  deadlineAt: z.string().datetime().nullable(),
  link: z.string().regex(/^\/uc\/order\?tradeId=[0-9a-f-]{36}$/),
});
export type TodoItem = z.infer<typeof todoItemSchema>;
export const todosSchema = z.object({ items: z.array(todoItemSchema) });

/** P-ads-merchant-08: a bulk action's answer, one result per ad. */
export const bulkOutcomeSchema = z.object({
  action: z.enum(['pause', 'resume', 'remove']),
  replayed: z.boolean(),
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
