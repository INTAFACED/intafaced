import 'server-only';
import {
  founderDisputeListSchema,
  founderLiveSummarySchema,
  founderMerchantSectionSchema,
  founderPayoutListSchema,
  founderRecentMerchantsSchema,
  founderRiskSummarySchema,
  merchantMetricsSnapshotSchema,
  payHaltPendingClearListSchema,
  type FounderDisputeListInput,
  type FounderMerchantSection,
  type FounderMerchantSectionPage,
  type FounderPayoutListInput,
  type FounderRiskSummaryInput,
} from '@intafaced/contracts';
import { parseWith, payCall, type PayCallContext, type PayCallResult } from '@/lib/merchants/pay-call';
import { asNotePage } from './notes';
import { one, PAGE_LIMIT, RISK_TOP_N, RISK_WINDOWS, sectionRequest, type Query, type RiskWindowKey } from './read-model';

/**
 * The founder reads added in #4870, one loader each. Every loader returns a named outcome and never invents a row: a
 * service that is off, slow or answering in a shape this console does not know shows as that, not as an empty list.
 */

/** One merchant section. The answer must be the section that was asked for, or it is treated as unreadable. */
export function loadSection(
  ctx: PayCallContext,
  merchantId: string,
  section: FounderMerchantSection,
  query: Query | undefined,
): Promise<PayCallResult<FounderMerchantSectionPage>> {
  return payCall(ctx, 'founderAdmin.merchants.section', 'GET', sectionRequest(merchantId, section, query), (raw) => {
    const parsed = founderMerchantSectionSchema.safeParse(raw);
    return parsed.success && parsed.data.section === section ? parsed.data : null;
  });
}

export function loadRecentMerchants(ctx: PayCallContext, query: Query | undefined) {
  const cursor = one(query, 'cursor');
  return payCall(
    ctx,
    'founderAdmin.merchants.recent',
    'GET',
    { limit: PAGE_LIMIT, ...(cursor ? { cursor } : {}) },
    parseWith(founderRecentMerchantsSchema),
  );
}

export const PAYOUT_STATUSES = ['pending', 'posted', 'paid_out', 'failed'] as const;
export const DISPUTE_STATUSES = ['open', 'contested', 'accepted', 'won', 'lost'] as const;

export function payoutListInput(query: Query | undefined): FounderPayoutListInput {
  const cursor = one(query, 'cursor');
  const status = one(query, 'status');
  return {
    limit: PAGE_LIMIT,
    ...(cursor ? { cursor } : {}),
    ...(status && (PAYOUT_STATUSES as readonly string[]).includes(status) ? { status: status as (typeof PAYOUT_STATUSES)[number] } : {}),
  };
}

export function loadPayoutList(ctx: PayCallContext, query: Query | undefined) {
  return payCall(ctx, 'founderAdmin.payouts.list', 'GET', payoutListInput(query), parseWith(founderPayoutListSchema));
}

export function disputeListInput(query: Query | undefined): FounderDisputeListInput {
  const cursor = one(query, 'cursor');
  const status = one(query, 'status');
  const deadline = one(query, 'deadline');
  return {
    limit: PAGE_LIMIT,
    ...(cursor ? { cursor } : {}),
    ...(status && (DISPUTE_STATUSES as readonly string[]).includes(status) ? { status: status as (typeof DISPUTE_STATUSES)[number] } : {}),
    ...(deadline === 'set' || deadline === 'unset' ? { deadline } : {}),
  };
}

export function loadDisputeList(ctx: PayCallContext, query: Query | undefined) {
  return payCall(ctx, 'founderAdmin.disputes.list', 'GET', disputeListInput(query), parseWith(founderDisputeListSchema));
}

export function loadLiveSummary(ctx: PayCallContext) {
  return payCall(ctx, 'founderAdmin.live.summary', 'GET', {}, parseWith(founderLiveSummarySchema));
}

/** The caller picks the cutoff (there is no default N) and the window; "all projected days" sends no window at all. */
export function riskInput(window: RiskWindowKey): FounderRiskSummaryInput {
  const preset = RISK_WINDOWS.find((w) => w.key === window)?.preset ?? null;
  return { topN: RISK_TOP_N, ...(preset ? { window: { kind: 'preset' as const, preset } } : {}) };
}

export function loadRiskSummary(ctx: PayCallContext, window: RiskWindowKey) {
  return payCall(ctx, 'founderAdmin.risk.summary', 'GET', riskInput(window), parseWith(founderRiskSummarySchema));
}

/** Clears waiting for a second founder. The same read the Halts desk uses. */
export function loadPendingClears(ctx: PayCallContext) {
  return payCall(ctx, 'payHalts.pendingClears', 'GET', { limit: 50 }, parseWith(payHaltPendingClearListSchema));
}

/** The merchant's 30-day snapshot, used here only for its per-asset balances. */
export function loadBalances(ctx: PayCallContext, merchantId: string) {
  return payCall(
    ctx,
    'founderAdmin.metrics.merchant',
    'GET',
    { merchantId, window: { kind: 'preset', preset: 'rolling_30d' } },
    parseWith(merchantMetricsSnapshotSchema),
  );
}

/** A merchant's operator notes, newest first. Retracted notes are listed only when asked for. */
export function loadNotes(ctx: PayCallContext, merchantId: string, query: Query | undefined) {
  const cursor = one(query, 'cursor');
  return payCall(
    ctx,
    'founderAdmin.ops.notes.list',
    'GET',
    {
      merchantId,
      limit: PAGE_LIMIT,
      ...(cursor ? { cursor } : {}),
      ...(one(query, 'flagged') === '1' ? { flaggedOnly: true } : {}),
      ...(one(query, 'retracted') === '1' ? { includeRetracted: true } : {}),
    },
    asNotePage,
  );
}
