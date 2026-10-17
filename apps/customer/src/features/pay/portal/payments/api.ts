import { z } from 'zod';
import * as p from '../schemas';
import { subscriptionSchema, mandateSchema, executionSchema, subscriptionPostureSchema, linkSchema, listed } from '../../schemas';
import { cycleSchema } from './billing-schemas';
import * as pay from './schemas';
import { PAGE_SIZE, type PortalTools } from '../api-tools';

export const paymentsApi = ({ query, mutate, list }: PortalTools) => ({
  subscriptions: (merchantId: string, limit: number, signal?: AbortSignal) =>
    query(
      'subscription.list',
      { merchantId, limit },
      p.page(subscriptionSchema.refine((row) => row.merchantId === merchantId)),
      signal,
    ).then(listed),
  subscription: (merchantId: string, subscriptionId: string, signal?: AbortSignal) =>
    query(
      'subscription.get',
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
    list(
      'subscription.list',
      subscriptionSchema.refine((row) => row.merchantId === merchantId),
      { merchantId, ...(cursor ? { cursor } : {}), ...Object.fromEntries(Object.entries(filters).filter(([, value]) => value)) },
      signal,
    ),
  mandates: (merchantId: string, signal?: AbortSignal) =>
    query('mandate.list', { merchantId, limit: 200 }, p.page(mandateSchema.refine((row) => row.merchantId === merchantId)), signal).then(
      listed,
    ),
  mandate: (merchantId: string, mandateId: string, signal?: AbortSignal) =>
    query(
      'mandate.get',
      { mandateId },
      mandateSchema.refine((row) => row.merchantId === merchantId && row.id === mandateId),
      signal,
    ),
  subscriptionPosture: (signal?: AbortSignal) => query('subscription.productReady', undefined, subscriptionPostureSchema, signal),
  subscriptionExecutions: (subscriptionId: string, signal?: AbortSignal) =>
    query(
      'subscription.listExecutions',
      { subscriptionId, limit: 200 },
      z.array(executionSchema.refine((row) => row.subscriptionId === subscriptionId)),
      signal,
    ),
  subscriptionCycles: (subscriptionId: string, signal?: AbortSignal) =>
    query(
      'subscription.cycles',
      { subscriptionId, limit: 200 },
      z.object({ subscriptionId: z.literal(subscriptionId), cycles: z.array(cycleSchema) }),
      signal,
    ),
  links: (merchantId: string, limit: number, signal?: AbortSignal) =>
    query('merchant.listLinks', { merchantId, limit }, p.page(linkSchema), signal).then(listed),
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
  }) => mutate('merchantOps.disputes.uploadEvidence', input, p.evidenceSchema),
  evidenceFile: (evidenceId: string) => query('merchantOps.disputes.getEvidence', { evidenceId }, pay.evidenceFileSchema),
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
    query('merchantOps.customers.series', { customerRef, from, to, bucket: 'day', limit: 200 }, pay.customerSeriesSchema, signal),
  customerSummary: (activeSince: string, signal?: AbortSignal) =>
    query('merchantOps.customers.summary', { activeSince }, p.customerSummarySchema, signal),
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
    filters: { status?: string; search?: string; assetId?: string; from?: string; to?: string },
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
  paymentActivity: (paymentId: string, signal?: AbortSignal) =>
    list('merchantOps.activity.list', pay.activityItemSchema, { objectType: 'payment', search: paymentId, limit: 100 }, signal),
  ownTier: (merchantId: string, signal?: AbortSignal) => query('merchantControl.tiers.list', { merchantId }, pay.ownTierSchema, signal),
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
  createInvoice: (input: { requestId: string; assetId: string; amount: string; customerRef?: string; description?: string }) =>
    mutate('merchantOps.invoices.create', input, pay.invoiceSchema),
  sendInvoice: (input: { requestId: string; invoiceId: string }) => mutate('merchantOps.invoices.send', input, pay.invoiceSentSchema),
  reissueInvoiceLink: (input: { requestId: string; invoiceId: string }) =>
    mutate('merchantOps.invoices.reissueLink', input, pay.invoiceSentSchema),
  voidInvoice: (input: { requestId: string; invoiceId: string }) => mutate('merchantOps.invoices.void', input, pay.invoiceSchema),
  markInvoicePaid: (input: { requestId: string; invoiceId: string; paymentId: string }) =>
    mutate('merchantOps.invoices.markPaidByPayment', input, pay.invoiceSchema),
  payment: (paymentId: string, signal?: AbortSignal) => query('payment.get', { paymentId }, p.paymentSchema, signal),
  paymentHistory: (paymentId: string, signal?: AbortSignal) =>
    query('payment.history', { paymentId, limit: 200 }, z.array(p.paymentEventSchema), signal),
});
