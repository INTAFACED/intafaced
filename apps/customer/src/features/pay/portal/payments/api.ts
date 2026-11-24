import { z } from 'zod';
import { paymentViewSchema, type PaymentViewColumn, type PaymentViewFilters } from '@intafaced/contracts/pay-payment-views';
import * as p from '../schemas';
import { subscriptionSchema, mandateSchema, executionSchema, listed } from '../../schemas';
import * as pay from './schemas';
import { PAGE_SIZE, type PortalTools } from '../api-tools';
import {
  PAY_PAYMENT_VIEWS_LIST,
  PAY_PAYMENT_HISTORY,
  PAY_PAYMENT_VIEWS_DELETE,
  PAY_PAYMENT_UNMASK,
} from '@intafaced/contracts/pay-payment-procedures';
import {
  PAY_MERCHANT_OPS_CUSTOMERS_SERIES,
  PAY_MERCHANT_OPS_DISPUTES_GET_EVIDENCE,
  PAY_MERCHANT_OPS_CUSTOMERS_SUMMARY,
  PAY_MERCHANT_OPS_ACTIVITY_LIST,
  PAY_MERCHANT_OPS_DISPUTES_UPLOAD_EVIDENCE,
} from '@intafaced/contracts/pay-merchant-ops-procedures';
import {
  PAY_SUBSCRIPTION_PRODUCT_READY,
  PAY_SUBSCRIPTION_CYCLES,
  PAY_SUBSCRIPTION_LIST,
  PAY_SUBSCRIPTION_GET,
  PAY_SUBSCRIPTION_LIST_EXECUTIONS,
} from '@intafaced/contracts/pay-subscription-procedures';
import { PAY_MERCHANT_LIST_LINKS, PAY_MERCHANT_CHECKOUT_SETTINGS_GET } from '@intafaced/contracts/pay-merchant-procedures';
import { PAY_MANDATE_LIST, PAY_MANDATE_GET } from '@intafaced/contracts/pay-mandate-procedures';
import { PAY_MERCHANT_CONTROL_TIERS_LIST } from '@intafaced/contracts/pay-merchant-control-procedures';

const REFUND_PAGES = 5;

export const paymentsApi = ({ query, mutate, list, queryRecord, mutateRecord, queryRecordAs, listRecordAs }: PortalTools) => ({
  subscriptions: (merchantId: string, limit: number, signal?: AbortSignal) =>
    queryRecordAs(
      PAY_SUBSCRIPTION_LIST,
      { merchantId, limit },
      p.page(subscriptionSchema.refine((row) => row.merchantId === merchantId)),
      signal,
    ).then(listed),
  subscription: (merchantId: string, subscriptionId: string, signal?: AbortSignal) =>
    queryRecordAs(
      PAY_SUBSCRIPTION_GET,
      { subscriptionId },
      subscriptionSchema.refine((row) => row.merchantId === merchantId && row.id === subscriptionId),
      signal,
    ),
  subscriptionPage: (
    merchantId: string,
    filters: { status?: string; search?: string; from?: string; to?: string },
    cursor: string | undefined,
    signal?: AbortSignal,
  ) =>
    listRecordAs(
      PAY_SUBSCRIPTION_LIST,
      { merchantId, ...(cursor ? { cursor } : {}), ...Object.fromEntries(Object.entries(filters).filter(([, value]) => value)) },
      subscriptionSchema.refine((row) => row.merchantId === merchantId),
      signal,
    ),
  mandates: (merchantId: string, signal?: AbortSignal) =>
    queryRecordAs(
      PAY_MANDATE_LIST,
      { merchantId, limit: 200 },
      p.page(mandateSchema.refine((row) => row.merchantId === merchantId)),
      signal,
    ).then(listed),
  mandate: (merchantId: string, mandateId: string, signal?: AbortSignal) =>
    queryRecordAs(
      PAY_MANDATE_GET,
      { mandateId },
      mandateSchema.refine((row) => row.merchantId === merchantId && row.id === mandateId),
      signal,
    ),
  subscriptionPosture: (signal?: AbortSignal) => queryRecord(PAY_SUBSCRIPTION_PRODUCT_READY, undefined, signal),
  subscriptionExecutions: (subscriptionId: string, signal?: AbortSignal) =>
    queryRecordAs(
      PAY_SUBSCRIPTION_LIST_EXECUTIONS,
      { subscriptionId, limit: 200 },
      z.array(executionSchema.refine((row) => row.subscriptionId === subscriptionId)),
      signal,
    ),
  subscriptionCycles: (subscriptionId: string, signal?: AbortSignal) =>
    queryRecord(PAY_SUBSCRIPTION_CYCLES, { subscriptionId, limit: 200 }, signal),
  links: (merchantId: string, limit: number, signal?: AbortSignal) =>
    queryRecord(PAY_MERCHANT_LIST_LINKS, { merchantId, limit }, signal).then(listed),
  disputePage: (
    filters: { status?: string; search?: string; from?: string; to?: string; dueBefore?: string; deadline?: string },
    cursor: string | undefined,
    signal?: AbortSignal,
  ) =>
    list(
      'merchantOps.disputes.list',
      p.disputeSchema,
      { ...(cursor ? { cursor } : {}), ...Object.fromEntries(Object.entries(filters).filter(([, value]) => value)) },
      signal,
    ),
  uploadEvidence: (input: {
    disputeId: string;
    kind: p.EvidenceKind;
    fileName: string;
    contentType: string;
    contentBase64: string;
    sha256: string;
    note?: string;
  }) => mutateRecord(PAY_MERCHANT_OPS_DISPUTES_UPLOAD_EVIDENCE, input),
  evidenceFile: (evidenceId: string) => queryRecord(PAY_MERCHANT_OPS_DISPUTES_GET_EVIDENCE, { evidenceId }),
  disputeSummary: (signal?: AbortSignal) => query('merchantOps.disputes.summary', {}, p.disputeSummarySchema, signal),
  disputes: (cursor: string | undefined, status: string, signal?: AbortSignal) =>
    list('merchantOps.disputes.list', p.disputeSchema, { ...(cursor ? { cursor } : {}), ...(status ? { status } : {}) }, signal),
  dispute: (disputeId: string, signal?: AbortSignal) => query('merchantOps.disputes.get', { disputeId }, p.disputeDetailSchema, signal),
  addEvidence: (input: {
    disputeId: string;
    kind: p.EvidenceKind;
    fileName: string;
    contentType: string;
    sizeBytes: number;
    sha256: string;
    note?: string;
  }) => mutate('merchantOps.disputes.addEvidence', input, p.evidenceSchema),
  respond: (input: { requestId: string; disputeId: string; action: 'contest' | 'accept_liability'; note?: string }) =>
    mutate('merchantOps.disputes.respond', input, p.disputeDetailSchema),
  customerSeries: (customerRef: string, from: string, to: string, signal?: AbortSignal) =>
    queryRecord(PAY_MERCHANT_OPS_CUSTOMERS_SERIES, { customerRef, from, to, bucket: 'day', limit: 200 }, signal),
  customerSummary: (activeSince: string, signal?: AbortSignal) => queryRecord(PAY_MERCHANT_OPS_CUSTOMERS_SUMMARY, { activeSince }, signal),
  customers: (cursor: string | undefined, search: string, signal?: AbortSignal) =>
    list('merchantOps.customers.list', p.customerSchema, { ...(cursor ? { cursor } : {}), ...(search ? { search } : {}) }, signal),
  customer: (customerRef: string, signal?: AbortSignal) =>
    query('merchantOps.customers.get', { customerRef, recentPaymentsLimit: PAGE_SIZE }, p.customerDetailSchema, signal),
  payments: async (merchantId: string, status: string, limit: number, signal?: AbortSignal) => {
    const page = await query('payment.list', { merchantId, limit, ...(status ? { status } : {}) }, p.page(p.paymentSchema), signal);
    return page.ok ? { ok: true as const, data: page.data.items } : page;
  },
  paymentPage: (
    merchantId: string,
    filters: { status?: string; search?: string; assetId?: string; linkId?: string; from?: string; to?: string },
    cursor: string | undefined,
    signal?: AbortSignal,
  ) =>
    list(
      'payment.list',
      p.paymentSchema,
      {
        merchantId,
        ...(cursor ? { cursor } : {}),
        ...Object.fromEntries(Object.entries(filters).filter(([, value]) => value)),
      },
      signal,
    ),
  paymentRefundRows: (paymentId: string, merchantId: string, signal?: AbortSignal) =>
    list('payment.refunds.list', pay.paymentRefundRowSchema, { merchantId, paymentId, limit: 200 }, signal),
  /**
   * Refunds issued inside a window, worked out from the refunds list itself (the day the refund was made), not from the
   * day the payment was taken. Reads at most `REFUND_PAGES` pages and says when it stopped early.
   */
  refundsIssued: async (merchantId: string, window: { from?: string; to?: string }, signal?: AbortSignal) => {
    const rows: pay.PaymentRefundRow[] = [];
    let cursor: string | undefined;
    for (let pages = 0; pages < REFUND_PAGES; pages += 1) {
      const next = await query(
        'payment.refunds.list',
        {
          merchantId,
          limit: 200,
          ...(window.from ? { from: window.from } : {}),
          ...(window.to ? { to: window.to } : {}),
          ...(cursor ? { cursor } : {}),
        },
        p.page(pay.paymentRefundRowSchema),
        signal,
      );
      if (!next.ok) return next;
      rows.push(...next.data.items);
      if (!next.data.nextCursor) return { ok: true as const, data: { rows, complete: true } };
      cursor = next.data.nextCursor;
    }
    return { ok: true as const, data: { rows, complete: false } };
  },
  paymentActivity: (paymentId: string, signal?: AbortSignal) =>
    queryRecord(PAY_MERCHANT_OPS_ACTIVITY_LIST, { objectType: 'payment', search: paymentId, limit: 100 }, signal),
  checkoutSettings: (merchantId: string, signal?: AbortSignal) => queryRecord(PAY_MERCHANT_CHECKOUT_SETTINGS_GET, { merchantId }, signal),
  ownTier: (merchantId: string, signal?: AbortSignal) => queryRecord(PAY_MERCHANT_CONTROL_TIERS_LIST, { merchantId }, signal),
  invoices: (
    filters: { status?: string; search?: string; assetId?: string; from?: string; to?: string },
    cursor: string | undefined,
    signal?: AbortSignal,
  ) =>
    list(
      'merchantOps.invoices.list',
      pay.invoiceSchema,
      { ...(cursor ? { cursor } : {}), ...Object.fromEntries(Object.entries(filters).filter(([, value]) => value)) },
      signal,
    ),
  invoice: (invoiceId: string, signal?: AbortSignal) => query('merchantOps.invoices.get', { invoiceId }, pay.invoiceSchema, signal),
  createInvoice: (input: {
    requestId: string;
    assetId: string;
    amount: string;
    customerRef?: string;
    customerEmail?: string;
    description?: string;
    dueAt?: string;
    lineItems?: Array<{ kind: 'charge' | 'credit'; description: string; quantity: string; unitAmount: string }>;
  }) => mutate('merchantOps.invoices.create', input, pay.invoiceSchema),
  sendInvoice: (input: { requestId: string; invoiceId: string }) => mutate('merchantOps.invoices.send', input, pay.invoiceSentSchema),
  reissueInvoiceLink: (input: { requestId: string; invoiceId: string }) =>
    mutate('merchantOps.invoices.reissueLink', input, pay.invoiceSentSchema),
  voidInvoice: (input: { requestId: string; invoiceId: string }) => mutate('merchantOps.invoices.void', input, pay.invoiceSchema),
  markInvoicePaid: (input: { requestId: string; invoiceId: string; paymentId: string }) =>
    mutate('merchantOps.invoices.markPaidByPayment', input, pay.invoiceSchema),
  payment: (paymentId: string, signal?: AbortSignal) => query('payment.get', { paymentId }, p.paymentSchema, signal),
  /** The caller's own saved views and the team's shared ones (M-adv-payments-core-01). */
  paymentViews: (signal?: AbortSignal) => queryRecord(PAY_PAYMENT_VIEWS_LIST, { limit: 200 }, signal),
  createPaymentView: (input: {
    name: string;
    visibility: 'private' | 'shared';
    filters: PaymentViewFilters;
    columns: PaymentViewColumn[];
  }) => mutate('payment.views.create', input, paymentViewSchema),
  deletePaymentView: (viewId: string) => mutateRecord(PAY_PAYMENT_VIEWS_DELETE, { viewId }),
  unmaskPayment: (input: { paymentId: string; field: 'customerEmail'; reason: string }) => mutateRecord(PAY_PAYMENT_UNMASK, input),
  paymentHistory: (paymentId: string, signal?: AbortSignal) => queryRecord(PAY_PAYMENT_HISTORY, { paymentId, limit: 200 }, signal),
});
