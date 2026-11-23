import {
  P2P_CHAT_MESSAGES_LIST,
  P2P_CHAT_MESSAGES_SEND,
  P2P_CONTACTS_LIST,
  P2P_INSTRUMENTS_LIST,
  P2P_INSTRUMENTS_METHODS_LIST,
  P2P_INSTRUMENTS_REMOVAL_IMPACT,
  P2P_INSTRUMENTS_REVEAL_MASKED,
  P2P_MERCHANTS_ADVERTISER_TERMS,
  P2P_MERCHANTS_POSTING_ELIGIBILITY,
  P2P_MERCHANTS_PRESENCE,
  P2P_MERCHANTS_TODOS,
  P2P_BOARD_SORTS,
  P2P_OFFERS_BULK,
  P2P_OFFERS_EDIT_QUOTA,
  P2P_OFFERS_GET,
  P2P_OFFERS_PAGE,
  P2P_OFFERS_SHARE_LINKS_LIST,
  P2P_REPUTATION_APPEAL,
  P2P_REPUTATION_GET,
  P2P_REVIEWS_FOR_TRADE,
  P2P_REVIEWS_LEAVE,
  P2P_SETTLEMENT,
  P2P_TRADES_CONTRACT_ESCROW,
  P2P_TRADES_EXPORT,
  P2P_TRADES_GET,
  P2P_TRADES_PAGE,
  P2P_TRADES_PAYMENT_INSTRUMENT,
  P2P_TRADES_QUOTE,
  P2P_TRADES_RECEIPT,
  P2P_TRADES_REMARK_CASE,
  P2P_TRADES_REMIND,
  P2P_TRADES_REPORT_MISMATCH,
  P2P_TRADES_REPORT_SENSITIVE_REMARK,
  P2P_TRADES_TAKE,
} from '@intafaced/contracts/p2p-procedures';
import type { ProcedureOutput } from '@intafaced/contracts/procedure';
import { z } from 'zod';
import type { ApiResult } from '../../shared/api';
import { asset, amount } from '@intafaced/contracts/pay-call-schemas';

/** A list procedure now returns `{ items, nextCursor }`. Callers that still render an array keep the items. */
export function listed<T>(result: ApiResult<{ items: T[] }>): ApiResult<T[]> {
  return result.ok ? { ok: true, data: result.data.items } : result;
}

// Browser projections of the mounted service outputs. No service/server roots are imported.
// Authorities: svc-bank/router.ts, svc-p2p/router.ts, svc-pay/{router,subscription-router,submerchant-router}.ts.
export const id = z.string().guid();
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
/** One board page (`offers.page`): continue with `nextCursor` under the same filters and sort. */
export type OfferPage = ProcedureOutput<typeof P2P_OFFERS_PAGE>;
export type BoardSort = (typeof P2P_BOARD_SORTS)[number];
/** What the board asks the service for. Everything is filtered and sorted there, so paging never misses a row. */
export type BoardQuery = {
  asset?: string;
  fiatCurrency?: string;
  side?: 'buy' | 'sell';
  methodId?: string;
  fiatAmount?: string;
  sort?: BoardSort;
};
/** One of the person's payment methods, headers only: a list never carries a value. */
export type Instrument = ProcedureOutput<typeof P2P_INSTRUMENTS_LIST>[number];
/** `instruments.revealMasked`: the owner's own values as svc-p2p masks them, read only on request and logged like every read. */
export type RevealedInstrument = ProcedureOutput<typeof P2P_INSTRUMENTS_REVEAL_MASKED>;
/** What a payment method needs in one market, as svc-p2p's registry publishes it. About the method, never about a person. */
export type MethodSchema = ProcedureOutput<typeof P2P_INSTRUMENTS_METHODS_LIST>[number];
export type MethodField = MethodSchema['fields'][number];
/** A versioned acceptance: the owner-published version and when this person accepted it (advertiser terms). */
export type P2PRiskNotice = ProcedureOutput<typeof P2P_MERCHANTS_ADVERTISER_TERMS>;
/** P-ads-merchant-01: the caller's free balance of one coin, as svc-p2p reads it from the ledger. */
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
const merchantSchema = z.object({
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
export type Offer = ProcedureOutput<typeof P2P_OFFERS_GET>;
/** P-ads-merchant-06: the person's ad edits today against the daily cap, and when the count starts again. */
export type OfferEditQuota = ProcedureOutput<typeof P2P_OFFERS_EDIT_QUOTA>;
export type MethodSettlement = z.infer<typeof P2P_SETTLEMENT>;
type TradeBase = ProcedureOutput<typeof P2P_TRADES_TAKE>;
/** One order: every trade call's fields, and the ones only `trades.get` adds (its terms, readable status, fee split and more). */
export type Trade = TradeBase & Partial<Omit<ProcedureOutput<typeof P2P_TRADES_GET>, keyof TradeBase>>;
export type TradeReminders = ProcedureOutput<typeof P2P_TRADES_REMIND>;
export type TradeMismatch = ProcedureOutput<typeof P2P_TRADES_REPORT_MISMATCH>;
export type RemarkCase = ProcedureOutput<typeof P2P_TRADES_REPORT_SENSITIVE_REMARK>;
export type RemarkCasesOn = ProcedureOutput<typeof P2P_TRADES_REMARK_CASE>;
export type TradeDestination = ProcedureOutput<typeof P2P_TRADES_PAYMENT_INSTRUMENT>;
export type OrderPage = ProcedureOutput<typeof P2P_TRADES_PAGE>;
export type OrderTab = OrderPage['trades'][number]['tab'];
export type OrderExport = ProcedureOutput<typeof P2P_TRADES_EXPORT>;
export type OrderReceipt = ProcedureOutput<typeof P2P_TRADES_RECEIPT>;
/** A take's figures: a preview quote, or a locked one, which carries its `quoteId` and counts down on this device. */
export type TakeQuote = ProcedureOutput<typeof P2P_TRADES_QUOTE> & { quoteId?: string };
export type ContractEscrowOffer = ProcedureOutput<typeof P2P_TRADES_CONTRACT_ESCROW>;
/** svc-p2p `reviews.*`: one good/bad review per party of a released order. */
export type OrderReview = ProcedureOutput<typeof P2P_REVIEWS_LEAVE>;
/** `reviews.forTrade`: the viewer's own review of the order and the visible one about them. */
export type TradeReviews = ProcedureOutput<typeof P2P_REVIEWS_FOR_TRADE>;
/** svc-p2p `chat.messages.list`: oldest first; `nextCursor` is set while a full page was returned. */
export type ChatPage = ProcedureOutput<typeof P2P_CHAT_MESSAGES_LIST>;
export type ChatMessage = ChatPage['messages'][number];
/** `chat.messages.send`: the stored message, `created: false` when the same client id had already been stored. */
export type ChatSent = ProcedureOutput<typeof P2P_CHAT_MESSAGES_SEND>;
/** `contacts.list` and every contacts change answer with the caller's whole lists of account ids. */
export type Contacts = ProcedureOutput<typeof P2P_CONTACTS_LIST>;
export type Reputation = ProcedureOutput<typeof P2P_REPUTATION_GET>;
/** P-trade-orders-21: the person's one completion appeal (`reputation.myAppeal`, `reputation.appeal`). */
export type CompletionAppeal = ProcedureOutput<typeof P2P_REPUTATION_APPEAL>;
export type Merchant = z.infer<typeof merchantSchema>;
export type Payment = z.infer<typeof paymentSchema>;

/** P-ads-merchant-18: the person's active sell ads that list a method, and which ones lose their last payable method. */
export type MethodRemovalImpact = ProcedureOutput<typeof P2P_INSTRUMENTS_REMOVAL_IMPACT>;

/** P-ads-merchant-08: the person's presence. A scheduled week is a list of windows in their own time zone. */
export type Presence = ProcedureOutput<typeof P2P_MERCHANTS_PRESENCE>;
export type PresenceWindow = Presence['windows'][number];
/** P-ads-merchant-08: one open order that waits on someone, with its deadline and where it is answered. */
export type TodoItem = ProcedureOutput<typeof P2P_MERCHANTS_TODOS>['items'][number];

/** P-ads-merchant-08: a bulk action's answer, one result per ad. */
export type BulkOutcome = ProcedureOutput<typeof P2P_OFFERS_BULK>;

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
export type ShareLink = ProcedureOutput<typeof P2P_OFFERS_SHARE_LINKS_LIST>[number];
export { asset, amount };
