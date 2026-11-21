import { conversionOrderSchema, conversionQuoteSchema } from '@intafaced/contracts/conversion';
import {
  merchantLimitIncreaseResultSchema,
  merchantLimitOpenSchema,
  merchantLimitWithdrawResultSchema,
  merchantPricingHistorySchema,
  merchantReserveViewSchema,
  merchantTierListSchema,
  type PayCap,
} from '@intafaced/contracts/merchant-control';
import {
  payPageSchema,
  paySettlementClearingSchema,
  paySettlementLineSchema,
  paySettlementViewSchema,
} from '@intafaced/contracts/pay-merchant-reads';
import {
  payDestinationAddOutputSchema,
  payDestinationCancelHoldOutputSchema,
  payDestinationRemoveOutputSchema,
  payExportJobSchema,
  payPayoutDestinationItemSchema,
  payPayoutLifecycleSchema,
  payPayoutListItemSchema,
  payRefundItemSchema,
  payStatementPageSchema,
} from '@intafaced/contracts/pay-portal-reads';
import { z } from 'zod';
import * as p from '../schemas';
import { type PortalTools } from '../api-tools';
import { pageOrArray } from '../ui/page';
import { feeRatesReadSchema } from './fee-rate-schema';

/** The filters a list sends to the service. A blank one is left out, never sent empty. */
export type ListQuery = { status?: string; assetId?: string; from?: string; to?: string; search?: string };
const only = (q: ListQuery) => Object.fromEntries(Object.entries(q).filter(([, v]) => v !== undefined && v !== ''));
const tolerantPage = <T extends z.ZodTypeAny>(item: T) => z.union([z.array(item), p.page(item)]);

export const moneyApi = ({ query, mutate }: PortalTools) => ({
  // ---- reads that were here first ------------------------------------------------------------------
  settlements: async (merchantId: string, status: string, limit: number, signal?: AbortSignal) => {
    const page = await query('settlement.list', { merchantId, limit, ...(status ? { status } : {}) }, p.page(p.settlementSchema), signal);
    return page.ok ? { ok: true as const, data: page.data.items } : page;
  },
  settlement: (settlementId: string, signal?: AbortSignal) => query('settlement.get', { settlementId }, p.settlementSchema, signal),
  control: (merchantId: string, signal?: AbortSignal) => query('merchantControl.get', { merchantId }, p.controlProfileSchema, signal),
  reserve: (merchantId: string, signal?: AbortSignal) =>
    query('merchantControl.reserve', { merchantId }, merchantReserveViewSchema, signal),
  /** M-money-out-02. With no top-up rail the service always refuses `pay.topup_unconfigured`; there is no answer shape yet. */
  topUpOptions: (merchantId: string, signal?: AbortSignal) => query('merchantControl.topUp.options', { merchantId }, z.never(), signal),
  usage: (merchantId: string, signal?: AbortSignal) => query('merchantControl.usage', { merchantId }, p.usageSchema, signal),
  pricingPreview: (input: { merchantId: string; assetCode: string; amount: string; monthlyVolume?: string; conversion?: boolean }) =>
    query('merchantControl.pricing.preview', input, p.quoteSchema),
  approvals: async (merchantId: string, status: string, signal?: AbortSignal) => {
    const result = await query(
      'merchantControl.approvals.list',
      { merchantId, limit: 200, ...(status ? { status } : {}) },
      tolerantPage(p.approvalSchema),
      signal,
    );
    return result.ok ? { ok: true as const, data: pageOrArray(result.data).items } : result;
  },
  decideApproval: (input: { approvalId: string; decision: 'approve' | 'reject'; expectedPayloadHash: string; reason: string }) =>
    mutate('merchantControl.approvals.decide', input, p.approvalSchema),
  cancelApproval: (input: { approvalId: string; reason: string }) => mutate('merchantControl.approvals.cancel', input, p.approvalSchema),

  // ---- pages (a server cursor each) ----------------------------------------------------------------
  settlementPage: (merchantId: string, q: ListQuery, cursor: string | undefined, signal?: AbortSignal) =>
    query('settlement.list', { merchantId, limit: 25, ...only(q), ...(cursor ? { cursor } : {}) }, p.page(p.settlementSchema), signal),
  settlementLines: (settlementId: string, cursor: string | undefined, signal?: AbortSignal) =>
    query('settlement.lines', { settlementId, limit: 25, ...(cursor ? { cursor } : {}) }, p.page(paySettlementLineSchema), signal),
  /** RC-merchant-10: captured payments the rail has not made available yet, with the day it named. */
  clearing: (merchantId: string, signal?: AbortSignal) => query('settlement.clearing', { merchantId }, paySettlementClearingSchema, signal),
  /** mirrors feat/pay-portal-be-reads-money settlement.lifecycle */
  settlementLifecycle: (settlementId: string, signal?: AbortSignal) =>
    query('settlement.lifecycle', { settlementId }, payPayoutLifecycleSchema, signal),
  payoutPage: (q: ListQuery, cursor: string | undefined, signal?: AbortSignal, limit = 25) =>
    query('merchantOps.payouts.list', { limit, ...only(q), ...(cursor ? { cursor } : {}) }, payPageSchema(payPayoutListItemSchema), signal),
  statementPage: (merchantId: string, q: ListQuery, cursor: string | undefined, signal?: AbortSignal, limit = 50) =>
    query('merchant.statement.list', { merchantId, limit, ...only(q), ...(cursor ? { cursor } : {}) }, payStatementPageSchema, signal),
  refundPage: (merchantId: string, q: ListQuery & { paymentId?: string }, cursor: string | undefined, signal?: AbortSignal) =>
    query(
      'payment.refunds.list',
      { merchantId, limit: 25, ...only(q), ...(cursor ? { cursor } : {}) },
      p.page(payRefundItemSchema),
      signal,
    ),
  refundGet: (refundEventId: string, signal?: AbortSignal) => query('payment.refunds.get', { refundEventId }, payRefundItemSchema, signal),
  destinationPage: (merchantId: string, cursor: string | undefined, signal?: AbortSignal) =>
    query(
      'merchant.payoutDestinations.list',
      { merchantId, limit: 50, ...(cursor ? { cursor } : {}) },
      p.page(payPayoutDestinationItemSchema),
      signal,
    ),
  /**
   * Owner or admin. Saves a destination unverified (J-merchant-02 #5): nothing is paid to it until it is verified with a
   * fresh confirmation (`setPayoutDestination`), and then only after the hold.
   */
  destinationAdd: (input: { merchantId: string; railId: string; kind: string; ref: string }) =>
    mutate('merchant.payoutDestinations.add', input, payDestinationAddOutputSchema),
  /** Owner only. A held destination goes back to unverified; nothing is paid to it until it is verified again. */
  destinationCancelHold: (input: { merchantId: string; destinationId: string }) =>
    mutate('merchant.payoutDestinations.cancelHold', input, payDestinationCancelHoldOutputSchema),
  /** Owner only. Marks one saved destination as the default; the previous mark is cleared by the service. */
  destinationSetDefault: (input: { merchantId: string; destinationId: string }) =>
    mutate('merchant.payoutDestinations.setDefault', input, payPayoutDestinationItemSchema),
  /** Owner only. Refuses with `pay.payout_destination_in_flight` while a payout to it is waiting or on its way. */
  destinationRemove: (input: { merchantId: string; destinationId: string }) =>
    mutate('merchant.payoutDestinations.remove', input, payDestinationRemoveOutputSchema),
  approvalPage: (merchantId: string, q: ListQuery, cursor: string | undefined, signal?: AbortSignal) =>
    query(
      'merchantControl.approvals.list',
      { merchantId, limit: 50, ...only(q), ...(cursor ? { cursor } : {}) },
      tolerantPage(p.approvalSchema),
      signal,
    ),
  /** The payments that can be refunded, found by the words a merchant remembers (customer, reference), not by an id. */
  refundablePayments: (merchantId: string, search: string, signal?: AbortSignal) =>
    query('payment.list', { merchantId, limit: 10, ...(search ? { search } : {}) }, p.page(p.paymentSchema), signal),

  // ---- payout: ask, or send ------------------------------------------------------------------------
  /** Asks for a second person's approval. The service answers `approval_not_required` below the approval limit. */
  requestPayoutApproval: (input: { merchantId: string; settlementId: string; railId: string }) =>
    mutate('merchantControl.approvals.request', input, p.approvalSchema),
  /** Sends the payout straight away to the saved destination, when no approval is needed. */
  sendPayout: (input: { settlementId: string; railId: string }) => mutate('settlement.payout', input, paySettlementViewSchema),

  // ---- limits, tiers, pricing history --------------------------------------------------------------
  limitOpen: (merchantId: string, signal?: AbortSignal) =>
    query('merchantControl.limits.open', { merchantId }, merchantLimitOpenSchema, signal),
  limitRequestIncrease: (input: { merchantId: string; requestId: string; caps: PayCap[]; reason: string }) =>
    mutate('merchantControl.limits.requestIncrease', input, merchantLimitIncreaseResultSchema),
  limitWithdraw: (input: { merchantId: string; requestId: string; reason: string }) =>
    mutate('merchantControl.limits.withdraw', input, merchantLimitWithdrawResultSchema),
  tiersList: (merchantId: string, signal?: AbortSignal) =>
    query('merchantControl.tiers.list', { merchantId }, merchantTierListSchema, signal),
  pricingHistory: (merchantId: string, signal?: AbortSignal) =>
    query('merchantControl.pricing.history', { merchantId, limit: 50 }, merchantPricingHistorySchema, signal),

  /** The effective fee rate per asset over a window (fees ÷ gross, by INTAFACED). One small page: only `rates` is read. */
  feeRates: (input: { merchantId: string; from: string; to: string; assetId?: string }, signal?: AbortSignal) =>
    query('merchantAnalytics.fees', { ...input, bucket: 'day', limit: 1 }, feeRatesReadSchema, signal),

  // ---- conversion (sandbox) ------------------------------------------------------------------------
  conversionList: (merchantId: string, signal?: AbortSignal) =>
    query('conversion.list', { merchantId, limit: 50 }, z.array(conversionOrderSchema), signal),
  conversionGet: (conversionId: string, signal?: AbortSignal) => query('conversion.get', { conversionId }, conversionOrderSchema, signal),
  conversionQuote: (input: { merchantId: string; settlementId: string; fromAsset: string; toAsset: string; fromAmount: string }) =>
    mutate('conversion.quote', input, conversionQuoteSchema),
  conversionExecute: (input: { requestId: string; quoteId: string }) => mutate('conversion.execute', input, conversionOrderSchema),

  // ---- exports -------------------------------------------------------------------------------------
  moneyExportCreate: (input: {
    requestId: string;
    kind: string;
    filters: { from?: string; to?: string; status?: string; assetId?: string };
  }) => mutate('merchantOps.exports.create', input, payExportJobSchema),
});
