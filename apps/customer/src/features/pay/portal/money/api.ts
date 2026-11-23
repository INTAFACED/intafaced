import { type PayCap } from '@intafaced/contracts/merchant-control';
import { payPageSchema } from '@intafaced/contracts/pay-merchant-reads';
import { payExportJobSchema, payPayoutListItemSchema } from '@intafaced/contracts/pay-portal-reads';
import { z } from 'zod';
import * as p from '../schemas';
import { type PortalTools } from '../api-tools';
import { pageOrArray } from '../ui/page';
import { feeRatesReadSchema } from './fee-rate-schema';
import { PAY_PAYMENT_REFUNDS_GET, PAY_PAYMENT_REFUNDS_LIST, PAY_PAYMENT_LIST } from '@intafaced/contracts/pay-payment-procedures';
import {
  PAY_MERCHANT_CONTROL_GET,
  PAY_MERCHANT_CONTROL_RESERVE,
  PAY_MERCHANT_CONTROL_TOP_UP_OPTIONS,
  PAY_MERCHANT_CONTROL_USAGE,
  PAY_MERCHANT_CONTROL_PRICING_PREVIEW,
  PAY_MERCHANT_CONTROL_APPROVALS_CANCEL,
  PAY_MERCHANT_CONTROL_APPROVALS_REQUEST,
  PAY_MERCHANT_CONTROL_LIMITS_OPEN,
  PAY_MERCHANT_CONTROL_LIMITS_WITHDRAW,
  PAY_MERCHANT_CONTROL_PRICING_HISTORY,
  PAY_MERCHANT_CONTROL_LIMITS_REQUEST_INCREASE,
  PAY_MERCHANT_CONTROL_TIERS_LIST,
} from '@intafaced/contracts/pay-merchant-control-procedures';
import {
  PAY_SETTLEMENT_LINES,
  PAY_SETTLEMENT_CLEARING,
  PAY_SETTLEMENT_LIFECYCLE,
  PAY_SETTLEMENT_PAYOUT,
  PAY_SETTLEMENT_GET,
  PAY_SETTLEMENT_LIST,
} from '@intafaced/contracts/pay-settlement-procedures';
import {
  PAY_MERCHANT_STATEMENT_LIST,
  PAY_MERCHANT_PAYOUT_DESTINATIONS_LIST,
  PAY_MERCHANT_PAYOUT_DESTINATIONS_CANCEL_HOLD,
  PAY_MERCHANT_PAYOUT_DESTINATIONS_SET_DEFAULT,
  PAY_MERCHANT_PAYOUT_DESTINATIONS_REMOVE,
  PAY_MERCHANT_PAYOUT_DESTINATIONS_ADD,
} from '@intafaced/contracts/pay-merchant-procedures';
import {
  PAY_CONVERSION_LIST,
  PAY_CONVERSION_GET,
  PAY_CONVERSION_QUOTE,
  PAY_CONVERSION_EXECUTE,
} from '@intafaced/contracts/pay-conversion-procedures';

/** The filters a list sends to the service. A blank one is left out, never sent empty. */
export type ListQuery = { status?: string; assetId?: string; from?: string; to?: string; search?: string };
const only = (q: ListQuery) => Object.fromEntries(Object.entries(q).filter(([, v]) => v !== undefined && v !== ''));
const tolerantPage = <T extends z.ZodTypeAny>(item: T) => z.union([z.array(item), p.page(item)]);

export const moneyApi = ({ query, mutate, queryRecord, mutateRecord }: PortalTools) => ({
  // ---- reads that were here first ------------------------------------------------------------------
  settlements: async (merchantId: string, status: string, limit: number, signal?: AbortSignal) => {
    const page = await queryRecord(PAY_SETTLEMENT_LIST, { merchantId, limit, ...(status ? { status } : {}) }, signal);
    return page.ok ? { ok: true as const, data: page.data.items } : page;
  },
  settlement: (settlementId: string, signal?: AbortSignal) => queryRecord(PAY_SETTLEMENT_GET, { settlementId }, signal),
  control: (merchantId: string, signal?: AbortSignal) => queryRecord(PAY_MERCHANT_CONTROL_GET, { merchantId }, signal),
  reserve: (merchantId: string, signal?: AbortSignal) => queryRecord(PAY_MERCHANT_CONTROL_RESERVE, { merchantId }, signal),
  /** M-money-out-02. With no top-up rail the service always refuses `pay.topup_unconfigured`; there is no answer shape yet. */
  topUpOptions: (merchantId: string, signal?: AbortSignal) => queryRecord(PAY_MERCHANT_CONTROL_TOP_UP_OPTIONS, { merchantId }, signal),
  usage: (merchantId: string, signal?: AbortSignal) => queryRecord(PAY_MERCHANT_CONTROL_USAGE, { merchantId }, signal),
  pricingPreview: (input: { merchantId: string; assetCode: string; amount: string; monthlyVolume?: string; conversion?: boolean }) =>
    queryRecord(PAY_MERCHANT_CONTROL_PRICING_PREVIEW, input),
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
  cancelApproval: (input: { approvalId: string; reason: string }) => mutateRecord(PAY_MERCHANT_CONTROL_APPROVALS_CANCEL, input),

  // ---- pages (a server cursor each) ----------------------------------------------------------------
  settlementPage: (merchantId: string, q: ListQuery, cursor: string | undefined, signal?: AbortSignal) =>
    queryRecord(PAY_SETTLEMENT_LIST, { merchantId, limit: 25, ...only(q), ...(cursor ? { cursor } : {}) }, signal),
  settlementLines: (settlementId: string, cursor: string | undefined, signal?: AbortSignal) =>
    queryRecord(PAY_SETTLEMENT_LINES, { settlementId, limit: 25, ...(cursor ? { cursor } : {}) }, signal),
  /** RC-merchant-10: captured payments the rail has not made available yet, with the day it named. */
  clearing: (merchantId: string, signal?: AbortSignal) => queryRecord(PAY_SETTLEMENT_CLEARING, { merchantId }, signal),
  /** mirrors feat/pay-portal-be-reads-money settlement.lifecycle */
  settlementLifecycle: (settlementId: string, signal?: AbortSignal) => queryRecord(PAY_SETTLEMENT_LIFECYCLE, { settlementId }, signal),
  payoutPage: (q: ListQuery, cursor: string | undefined, signal?: AbortSignal, limit = 25) =>
    query('merchantOps.payouts.list', { limit, ...only(q), ...(cursor ? { cursor } : {}) }, payPageSchema(payPayoutListItemSchema), signal),
  statementPage: (merchantId: string, q: ListQuery, cursor: string | undefined, signal?: AbortSignal, limit = 50) =>
    queryRecord(PAY_MERCHANT_STATEMENT_LIST, { merchantId, limit, ...only(q), ...(cursor ? { cursor } : {}) }, signal),
  refundPage: (merchantId: string, q: ListQuery & { paymentId?: string }, cursor: string | undefined, signal?: AbortSignal) =>
    queryRecord(PAY_PAYMENT_REFUNDS_LIST, { merchantId, limit: 25, ...only(q), ...(cursor ? { cursor } : {}) }, signal),
  refundGet: (refundEventId: string, signal?: AbortSignal) => queryRecord(PAY_PAYMENT_REFUNDS_GET, { refundEventId }, signal),
  destinationPage: (merchantId: string, cursor: string | undefined, signal?: AbortSignal) =>
    queryRecord(PAY_MERCHANT_PAYOUT_DESTINATIONS_LIST, { merchantId, limit: 50, ...(cursor ? { cursor } : {}) }, signal),
  /**
   * Owner or admin. Saves a destination unverified (J-merchant-02 #5): nothing is paid to it until it is verified with a
   * fresh confirmation (`setPayoutDestination`), and then only after the hold.
   */
  destinationAdd: (input: { merchantId: string; railId: string; kind: string; ref: string }) =>
    mutateRecord(PAY_MERCHANT_PAYOUT_DESTINATIONS_ADD, input),
  /** Owner only. A held destination goes back to unverified; nothing is paid to it until it is verified again. */
  destinationCancelHold: (input: { merchantId: string; destinationId: string }) =>
    mutateRecord(PAY_MERCHANT_PAYOUT_DESTINATIONS_CANCEL_HOLD, input),
  /** Owner only. Marks one saved destination as the default; the previous mark is cleared by the service. */
  destinationSetDefault: (input: { merchantId: string; destinationId: string }) =>
    mutateRecord(PAY_MERCHANT_PAYOUT_DESTINATIONS_SET_DEFAULT, input),
  /** Owner only. Refuses with `pay.payout_destination_in_flight` while a payout to it is waiting or on its way. */
  destinationRemove: (input: { merchantId: string; destinationId: string }) => mutateRecord(PAY_MERCHANT_PAYOUT_DESTINATIONS_REMOVE, input),
  approvalPage: (merchantId: string, q: ListQuery, cursor: string | undefined, signal?: AbortSignal) =>
    query(
      'merchantControl.approvals.list',
      { merchantId, limit: 50, ...only(q), ...(cursor ? { cursor } : {}) },
      tolerantPage(p.approvalSchema),
      signal,
    ),
  /** The payments that can be refunded, found by the words a merchant remembers (customer, reference), not by an id. */
  refundablePayments: (merchantId: string, search: string, signal?: AbortSignal) =>
    queryRecord(PAY_PAYMENT_LIST, { merchantId, limit: 10, ...(search ? { search } : {}) }, signal),

  // ---- payout: ask, or send ------------------------------------------------------------------------
  /** Asks for a second person's approval. The service answers `approval_not_required` below the approval limit. */
  requestPayoutApproval: (input: { merchantId: string; settlementId: string; railId: string }) =>
    mutateRecord(PAY_MERCHANT_CONTROL_APPROVALS_REQUEST, input),
  /** Sends the payout straight away to the saved destination, when no approval is needed. */
  sendPayout: (input: { settlementId: string; railId: string }) => mutateRecord(PAY_SETTLEMENT_PAYOUT, input),

  // ---- limits, tiers, pricing history --------------------------------------------------------------
  limitOpen: (merchantId: string, signal?: AbortSignal) => queryRecord(PAY_MERCHANT_CONTROL_LIMITS_OPEN, { merchantId }, signal),
  limitRequestIncrease: (input: { merchantId: string; requestId: string; caps: PayCap[]; reason: string }) =>
    mutateRecord(PAY_MERCHANT_CONTROL_LIMITS_REQUEST_INCREASE, input),
  limitWithdraw: (input: { merchantId: string; requestId: string; reason: string }) =>
    mutateRecord(PAY_MERCHANT_CONTROL_LIMITS_WITHDRAW, input),
  tiersList: (merchantId: string, signal?: AbortSignal) => queryRecord(PAY_MERCHANT_CONTROL_TIERS_LIST, { merchantId }, signal),
  pricingHistory: (merchantId: string, signal?: AbortSignal) =>
    queryRecord(PAY_MERCHANT_CONTROL_PRICING_HISTORY, { merchantId, limit: 50 }, signal),

  /** The effective fee rate per asset over a window (fees ÷ gross, by INTAFACED). One small page: only `rates` is read. */
  feeRates: (input: { merchantId: string; from: string; to: string; assetId?: string }, signal?: AbortSignal) =>
    query('merchantAnalytics.fees', { ...input, bucket: 'day', limit: 1 }, feeRatesReadSchema, signal),

  // ---- conversion (sandbox) ------------------------------------------------------------------------
  conversionList: (merchantId: string, signal?: AbortSignal) => queryRecord(PAY_CONVERSION_LIST, { merchantId, limit: 50 }, signal),
  conversionGet: (conversionId: string, signal?: AbortSignal) => queryRecord(PAY_CONVERSION_GET, { conversionId }, signal),
  conversionQuote: (input: { merchantId: string; settlementId: string; fromAsset: string; toAsset: string; fromAmount: string }) =>
    mutateRecord(PAY_CONVERSION_QUOTE, input),
  conversionExecute: (input: { requestId: string; quoteId: string }) => mutateRecord(PAY_CONVERSION_EXECUTE, input),

  // ---- exports -------------------------------------------------------------------------------------
  moneyExportCreate: (input: {
    requestId: string;
    kind: string;
    filters: { from?: string; to?: string; status?: string; assetId?: string };
  }) => mutate('merchantOps.exports.create', input, payExportJobSchema),
});
