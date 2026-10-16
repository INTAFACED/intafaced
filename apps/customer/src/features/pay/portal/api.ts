import { z, type ZodType } from 'zod';
import type { ApiClient, ApiResult } from '../../../shared/api';
import * as p from './schemas';
import { cycleSchema } from './billing-schemas';
import { subscriptionSchema, mandateSchema, executionSchema, subscriptionPostureSchema } from '../schemas';
import { linkSchema } from '../schemas';
import { portalRefusal, refusalText } from './refusal';

/**
 * The merchant portal's own client. Every procedure here scopes itself on the server from the signed
 * session: the merchant is never taken from this client, so there is no id to forge (M1/M2). The one
 * thing checked here is that someone is signed in. Money stays a decimal string end to end.
 */
export type PortalApi = ReturnType<typeof createPortalApi>;

export const PAGE_SIZE = 25;

export function createPortalApi(api: ApiClient, userId: string | null) {
  const signedIn = () => (userId ? null : portalRefusal('signInRequired', 'unauthorized'));
  async function query<T>(procedure: string, input: unknown, schema: ZodType<T>, signal?: AbortSignal): Promise<ApiResult<T>> {
    return signedIn() ?? api.query('pay', procedure, input, schema, { signal });
  }
  /** A refused change comes back with its message already in plain words, because the shared review dialog prints `message` as it finds it. */
  async function mutate<T>(procedure: string, input: unknown, schema: ZodType<T>): Promise<ApiResult<T>> {
    const denied = signedIn();
    if (denied) return denied;
    const result = await api.mutate('pay', procedure, input, schema);
    return result.ok ? result : { ...result, message: refusalText(result) };
  }
  const list = <T extends z.ZodTypeAny>(procedure: string, item: T, input: Record<string, unknown>, signal?: AbortSignal) =>
    query(procedure, { limit: PAGE_SIZE, ...input }, p.page(item), signal);
  return {
    userId,
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
    merchant: (signal?: AbortSignal) => query('merchant.me', undefined, p.merchantRecordSchema, signal),
    rails: (signal?: AbortSignal) => query('railHealth', undefined, p.railSchema, signal),
    snapshot: (merchantId: string, preset: p.MetricPreset, signal?: AbortSignal) =>
      query('merchantMetrics.snapshot', { merchantId, window: { kind: 'preset', preset } }, p.snapshotSchema, signal),
    series: (merchantId: string, from: string, to: string, signal?: AbortSignal) =>
      query('merchantMetrics.series', { merchantId, from, to, bucket: 'day' }, p.seriesSchema, signal),

    /** The names are the merchant's own, stored on the account the service derives from the session (never from this call). */
    createMerchant: (feeBps: number, businessDetails: Record<string, string>, names: { legalName: string; displayName?: string }) =>
      mutate(
        'merchant.create',
        { mode: 'gateway', pricing: { feeBps }, settlementPrefs: { businessDetails }, ...names },
        p.merchantCreatedSchema,
      ),
    submitKyb: (merchantId: string, kybRef: string) => mutate('merchant.submitKyb', { merchantId, kybRef }, p.kybSubmitSchema),
    setPayoutDestination: (merchantId: string, railId: string, kind: string, ref: string) =>
      mutate('merchant.setPayoutDestination', { merchantId, railId, kind, ref }, p.destinationSchema),
    kybCurrent: (signal?: AbortSignal) => query('merchantOps.kyb.current', {}, p.kybCurrentSchema, signal),
    kybHistory: (cursor: string | undefined, signal?: AbortSignal) =>
      list('merchantOps.kyb.history', p.kybEventSchema, { ...(cursor ? { cursor } : {}) }, signal),

    teamMe: (signal?: AbortSignal) => query('merchantOps.team.me', {}, p.teamMeSchema, signal),
    teamList: (cursor: string | undefined, status: string, signal?: AbortSignal) =>
      list('merchantOps.team.list', p.memberSchema, { ...(cursor ? { cursor } : {}), ...(status ? { status } : {}) }, signal),
    teamHistory: (cursor: string | undefined, signal?: AbortSignal) =>
      list('merchantOps.team.history', p.teamEventSchema, { ...(cursor ? { cursor } : {}) }, signal),
    myInvitations: (signal?: AbortSignal) => query('merchantOps.team.myInvitations', {}, p.invitationSchema, signal),
    invite: (input: { userId: string; role: p.TeamRole; label?: string }) => mutate('merchantOps.team.invite', input, p.memberSchema),
    changeRole: (memberId: string, role: p.TeamRole) => mutate('merchantOps.team.changeRole', { memberId, role }, p.memberSchema),
    removeMember: (memberId: string) => mutate('merchantOps.team.remove', { memberId }, p.memberSchema),
    acceptInvite: (memberId: string) => mutate('merchantOps.team.acceptInvite', { memberId }, p.memberSchema),
    declineInvite: (memberId: string) => mutate('merchantOps.team.declineInvite', { memberId }, z.object({ declined: z.literal(true) })),

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

    exportsList: (cursor: string | undefined, kind: string, status: string, signal?: AbortSignal) =>
      list(
        'merchantOps.exports.list',
        p.exportJobSchema,
        { ...(cursor ? { cursor } : {}), ...(kind ? { kind } : {}), ...(status ? { status } : {}) },
        signal,
      ),
    createExport: (input: {
      requestId: string;
      kind: p.ExportKind;
      filters: { from?: string; to?: string; status?: string; assetId?: string };
    }) => mutate('merchantOps.exports.create', input, p.exportJobSchema),
    exportDownload: (jobId: string) => query('merchantOps.exports.download', { jobId }, p.exportDownloadSchema),

    // ---- payments, settlements, payouts (W3b). The list reads take a page size and a status, nothing more; the browser
    // narrows further (search, dates, asset) over what it has loaded and says so on the page.
    payments: (merchantId: string, status: string, limit: number, signal?: AbortSignal) =>
      query('payment.list', { merchantId, limit, ...(status ? { status } : {}) }, z.array(p.paymentSchema), signal),
    payment: (paymentId: string, signal?: AbortSignal) => query('payment.get', { paymentId }, p.paymentSchema, signal),
    paymentHistory: (paymentId: string, signal?: AbortSignal) =>
      query('payment.history', { paymentId, limit: 200 }, z.array(p.paymentEventSchema), signal),
    settlements: (merchantId: string, status: string, limit: number, signal?: AbortSignal) =>
      query('settlement.list', { merchantId, limit, ...(status ? { status } : {}) }, z.array(p.settlementSchema), signal),
    settlement: (settlementId: string, signal?: AbortSignal) => query('settlement.get', { settlementId }, p.settlementSchema, signal),

    control: (merchantId: string, signal?: AbortSignal) => query('merchantControl.get', { merchantId }, p.controlProfileSchema, signal),
    usage: (merchantId: string, signal?: AbortSignal) => query('merchantControl.usage', { merchantId }, p.usageSchema, signal),
    pricingPreview: (input: { merchantId: string; assetCode: string; amount: string; monthlyVolume?: string; conversion?: boolean }) =>
      query('merchantControl.pricing.preview', input, p.quoteSchema),
    approvals: (merchantId: string, status: string, signal?: AbortSignal) =>
      query('merchantControl.approvals.list', { merchantId, limit: 200, ...(status ? { status } : {}) }, z.array(p.approvalSchema), signal),
    decideApproval: (input: { approvalId: string; decision: 'approve' | 'reject'; expectedPayloadHash: string; reason: string }) =>
      mutate('merchantControl.approvals.decide', input, p.approvalSchema),
    cancelApproval: (input: { approvalId: string; reason: string }) => mutate('merchantControl.approvals.cancel', input, p.approvalSchema),
    haltStatus: (merchantId: string, signal?: AbortSignal) => query('payHalts.status', { merchantId }, p.haltStatusSchema, signal),

    notifications: (cursor: string | undefined, unreadOnly: boolean, kind: string, signal?: AbortSignal) =>
      list(
        'merchantOps.notifications.list',
        p.notificationSchema,
        { ...(cursor ? { cursor } : {}), ...(unreadOnly ? { unreadOnly } : {}), ...(kind ? { kind } : {}) },
        signal,
      ),
    unreadCount: (signal?: AbortSignal) => query('merchantOps.notifications.unreadCount', {}, p.unreadSchema, signal),
    markRead: (notificationIds: string[]) => mutate('merchantOps.notifications.markRead', { notificationIds }, p.markedSchema),
    markAllRead: () => mutate('merchantOps.notifications.markAllRead', {}, p.markedSchema),
    preferences: (signal?: AbortSignal) => query('merchantOps.notifications.preferences.list', {}, z.array(p.preferenceSchema), signal),
    setPreference: (input: { kind: p.NotificationKind; inApp: boolean; threshold?: string | null }) =>
      mutate('merchantOps.notifications.preferences.set', input, p.preferenceSchema),
  };
}
