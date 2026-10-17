import { z } from 'zod';
import * as p from '../schemas';
import { subscriptionSchema, mandateSchema, executionSchema, subscriptionPostureSchema, linkSchema } from '../../schemas';
import { cycleSchema } from './billing-schemas';
import { PAGE_SIZE, type PortalTools } from '../api-tools';

export const paymentsApi = ({ query, mutate, list }: PortalTools) => ({
  subscriptions: (merchantId: string, limit: number, signal?: AbortSignal) =>
    query('subscription.list', { merchantId, limit }, z.array(subscriptionSchema.refine((row) => row.merchantId === merchantId)), signal),
  subscription: (merchantId: string, subscriptionId: string, signal?: AbortSignal) =>
    query(
      'subscription.get',
      { subscriptionId },
      subscriptionSchema.refine((row) => row.merchantId === merchantId && row.id === subscriptionId),
      signal,
    ),
  mandates: (merchantId: string, signal?: AbortSignal) =>
    query('mandate.list', { merchantId, limit: 200 }, z.array(mandateSchema.refine((row) => row.merchantId === merchantId)), signal),
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
    query('merchant.listLinks', { merchantId, limit }, z.array(linkSchema), signal),
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
  payment: (paymentId: string, signal?: AbortSignal) => query('payment.get', { paymentId }, p.paymentSchema, signal),
  paymentHistory: (paymentId: string, signal?: AbortSignal) =>
    query('payment.history', { paymentId, limit: 200 }, z.array(p.paymentEventSchema), signal),
});
