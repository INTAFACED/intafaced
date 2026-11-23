import 'server-only';
import {
  founderApprovalQueueSchema,
  type FounderGlobalMetrics,
  type FounderMerchantDrilldown,
  type FounderMerchantList,
  type FounderTreasuryExposure,
  type MerchantControlProfile,
  type MerchantMetricsSeries,
  type MerchantMetricsSnapshot,
  type PayHaltEvent,
  type PayHaltOperatorStatus,
  type PayHaltPendingClear,
  type FounderApprovalQueueItem,
} from '@intafaced/contracts';
import { asPricingRule, asTier, asUsage, type PricingRuleView, type TierView, type UsageView } from './control-model';
import { addDays, dayOf, midnight } from './dates';
import { listInputFor, type MerchantListQuery } from './list-params';
import { PAY_HALTS_HISTORY, PAY_HALTS_OPERATOR_STATUS } from '@intafaced/contracts/pay-halt-procedures';
import { payCall, payRecordCall, parseWith, type PayCallContext, type PayCallResult, payRecordRead } from './pay-call';
import { loadPendingClears } from '@/lib/founder-ops';
import {
  asEvent,
  asList,
  asNetwork,
  asVenue,
  asWalletRoute,
  REGISTRY_INFO,
  type NetworkView,
  type RegistryEventView,
  type RegistryKind,
  type VenueView,
  type WalletRouteView,
} from './registry-model';
import {
  PAY_FOUNDER_ADMIN_CONTROL_TIERS_LIST,
  PAY_FOUNDER_ADMIN_METRICS_MERCHANT,
  PAY_FOUNDER_ADMIN_METRICS_GLOBAL,
  PAY_FOUNDER_ADMIN_MERCHANTS_LIST,
  PAY_FOUNDER_ADMIN_METRICS_MERCHANT_SERIES,
  PAY_FOUNDER_ADMIN_MERCHANTS_DRILLDOWN,
  PAY_FOUNDER_ADMIN_REGISTRIES_HISTORY,
  PAY_FOUNDER_ADMIN_TREASURY_EXPOSURE,
  PAY_FOUNDER_ADMIN_CONTROL_MERCHANT_GET,
  PAY_FOUNDER_ADMIN_CONTROL_MERCHANT_USAGE,
  PAY_FOUNDER_ADMIN_CONTROL_PRICING_RULES,
} from '@intafaced/contracts/pay-founder-admin-procedures';

/**
 * One loader per page. Each returns named outcomes (`PayCallResult`), never
 * throws on a refusal, and never fills a gap with a made-up number: a stubbed
 * procedure (`pay.not_built`) comes back as `not_built` and the page says so.
 */

export const DASHBOARD_DAYS = 7;
export const SERIES_DAYS = 30;

export const METRIC_PRESETS = ['today', 'rolling_7d', 'rolling_30d'] as const;
export type MetricPreset = (typeof METRIC_PRESETS)[number];

export function parsePreset(value: string | string[] | undefined): MetricPreset {
  const one = Array.isArray(value) ? value[0] : value;
  return (METRIC_PRESETS as readonly string[]).includes(one ?? '') ? (one as MetricPreset) : 'rolling_30d';
}

const presetWindow = (preset: MetricPreset) => ({ kind: 'preset' as const, preset });
const dayWindow = (day: string) => ({ kind: 'range' as const, from: midnight(day), to: midnight(addDays(day, 1)) });

export interface DashboardData {
  readonly today: PayCallResult<FounderGlobalMetrics>;
  /** Oldest first, ending with today. `result` for today re-uses the preset read. */
  readonly days: readonly { day: string; result: PayCallResult<FounderGlobalMetrics> }[];
  readonly generatedAt: string;
}

export async function loadDashboard(
  ctx: PayCallContext,
  now: Date = new Date(),
  days: 1 | 7 | 30 = DASHBOARD_DAYS,
): Promise<DashboardData> {
  const todayDay = dayOf(now);
  const read = (window: ReturnType<typeof presetWindow> | ReturnType<typeof dayWindow>) =>
    payRecordCall(ctx, PAY_FOUNDER_ADMIN_METRICS_GLOBAL, { window });
  const earlier = Array.from({ length: days - 1 }, (_, i) => addDays(todayDay, i - (days - 1)));
  const [today, ...rest] = await Promise.all([read(presetWindow('today')), ...earlier.map((day) => read(dayWindow(day)))]);
  return {
    today,
    days: [...earlier.map((day, i) => ({ day, result: rest[i]! })), { day: todayDay, result: today }],
    generatedAt: now.toISOString(),
  };
}

export function loadMerchantList(ctx: PayCallContext, query: MerchantListQuery): Promise<PayCallResult<FounderMerchantList>> {
  return payRecordCall(ctx, PAY_FOUNDER_ADMIN_MERCHANTS_LIST, listInputFor(query));
}

export interface MerchantDetailData {
  readonly metrics: PayCallResult<MerchantMetricsSnapshot>;
  readonly series: PayCallResult<MerchantMetricsSeries>;
  readonly drilldown: PayCallResult<FounderMerchantDrilldown>;
  /**
   * The merchant's own list row, read for its name. The drill-down is the intended
   * source and is not built on the service yet; this keeps the page title honest
   * in the meantime. A failed read means "name unknown", never "no name".
   */
  readonly identity: PayCallResult<FounderMerchantList>;
}

export async function loadMerchantDetail(
  ctx: PayCallContext,
  merchantId: string,
  preset: MetricPreset,
  now: Date = new Date(),
): Promise<MerchantDetailData> {
  const today = dayOf(now);
  const [metrics, series, drilldown, identity] = await Promise.all([
    payRecordCall(ctx, PAY_FOUNDER_ADMIN_METRICS_MERCHANT, { merchantId, window: presetWindow(preset) }),
    payRecordCall(ctx, PAY_FOUNDER_ADMIN_METRICS_MERCHANT_SERIES, {
      merchantId,
      from: midnight(addDays(today, -(SERIES_DAYS - 1))),
      to: midnight(addDays(today, 1)),
      bucket: 'day',
    }),
    payRecordCall(ctx, PAY_FOUNDER_ADMIN_MERCHANTS_DRILLDOWN, { merchantId, window: presetWindow(preset) }),
    payRecordCall(ctx, PAY_FOUNDER_ADMIN_MERCHANTS_LIST, { limit: 1, filter: { merchantId } }),
  ]);
  return { metrics, series, drilldown, identity };
}

export type RegistryRows = VenueView[] | NetworkView[] | WalletRouteView[];

export function loadRegistry(ctx: PayCallContext, kind: 'venue'): Promise<PayCallResult<VenueView[]>>;
export function loadRegistry(ctx: PayCallContext, kind: 'network'): Promise<PayCallResult<NetworkView[]>>;
export function loadRegistry(ctx: PayCallContext, kind: 'wallet_route'): Promise<PayCallResult<WalletRouteView[]>>;
export function loadRegistry(ctx: PayCallContext, kind: RegistryKind): Promise<PayCallResult<RegistryRows>>;
export function loadRegistry(ctx: PayCallContext, kind: RegistryKind): Promise<PayCallResult<RegistryRows>> {
  const procedure = `founderAdmin.registries.${REGISTRY_INFO[kind].listProcedure}`;
  const each = kind === 'venue' ? asVenue : kind === 'network' ? asNetwork : asWalletRoute;
  return payCall(
    ctx,
    procedure,
    'GET',
    {},
    (raw) => asList(raw, each as (x: unknown) => VenueView | NetworkView | WalletRouteView | null) as RegistryRows | null,
  );
}

export function loadRegistryHistory(
  ctx: PayCallContext,
  kind: RegistryKind,
  entryKey: string,
): Promise<PayCallResult<RegistryEventView[]>> {
  return payRecordRead(ctx, PAY_FOUNDER_ADMIN_REGISTRIES_HISTORY, { registry: kind, entryKey, limit: 50 }, (raw) => asList(raw, asEvent));
}

export interface TreasuryData {
  readonly exposure: PayCallResult<FounderTreasuryExposure>;
  readonly halts: PayCallResult<PayHaltEvent[]>;
  /** Current halt switches and the auto-trip posture (`payHalts.operatorStatus`). */
  readonly status: PayCallResult<PayHaltOperatorStatus>;
  /** Clears one founder proposed and a different founder has not yet confirmed (`payHalts.pendingClears`). */
  readonly pending: PayCallResult<{ proposals: PayHaltPendingClear[]; nextCursor: string | null }>;
  /** When the halt reads were taken. Halts are read live from the store, so this is the as-of time. */
  readonly readAt: string;
}

export async function loadTreasury(ctx: PayCallContext, now: Date = new Date()): Promise<TreasuryData> {
  const [exposure, halts, status, pending] = await Promise.all([
    payRecordCall(ctx, PAY_FOUNDER_ADMIN_TREASURY_EXPOSURE, {}),
    payRecordCall(ctx, PAY_HALTS_HISTORY, { limit: 50 }),
    payRecordCall(ctx, PAY_HALTS_OPERATOR_STATUS, undefined),
    loadPendingClears(ctx),
  ]);
  return { exposure, halts, status, pending, readAt: now.toISOString() };
}

// ── merchant drill-down tabs: Controls, Approvals, Halts ────────────────────

export interface ControlsData {
  readonly profile: PayCallResult<MerchantControlProfile>;
  readonly usage: PayCallResult<UsageView>;
  readonly tiers: PayCallResult<TierView[]>;
  /** Live pricing rules of the global layer, this merchant's tier layer and this merchant's own layer. */
  readonly pricing: PayCallResult<PricingRuleView[]>;
  readonly readAt: string;
}

const parseRules = (raw: unknown) => asList(raw, asPricingRule);

export async function loadMerchantControls(ctx: PayCallContext, merchantId: string, now: Date = new Date()): Promise<ControlsData> {
  const [profile, usage, tiers] = await Promise.all([
    payRecordCall(ctx, PAY_FOUNDER_ADMIN_CONTROL_MERCHANT_GET, { merchantId }),
    payRecordRead(ctx, PAY_FOUNDER_ADMIN_CONTROL_MERCHANT_USAGE, { merchantId }, asUsage),
    payRecordRead(ctx, PAY_FOUNDER_ADMIN_CONTROL_TIERS_LIST, {}, (raw) => asList(raw, asTier)),
  ]);
  // The tier layer is only asked for when the merchant has a tier; the first failure of the three layers is the one shown.
  const layers: Array<Promise<PayCallResult<PricingRuleView[]>>> = [
    payRecordRead(ctx, PAY_FOUNDER_ADMIN_CONTROL_PRICING_RULES, { layer: 'global' }, parseRules),
    payRecordRead(ctx, PAY_FOUNDER_ADMIN_CONTROL_PRICING_RULES, { layer: 'merchant', scopeId: merchantId }, parseRules),
  ];
  if (profile.kind === 'ok' && profile.data.tierId !== null) {
    layers.push(payRecordRead(ctx, PAY_FOUNDER_ADMIN_CONTROL_PRICING_RULES, { layer: 'tier', scopeId: profile.data.tierId }, parseRules));
  }
  const results = await Promise.all(layers);
  const failed = results.find((r) => r.kind !== 'ok');
  const pricing: PayCallResult<PricingRuleView[]> = failed
    ? (failed as PayCallResult<PricingRuleView[]>)
    : { kind: 'ok', data: results.flatMap((r) => (r.kind === 'ok' ? r.data : [])) };
  return { profile, usage, tiers, pricing, readAt: now.toISOString() };
}

export const APPROVAL_PAGE = 200;
export const APPROVAL_MAX_PAGES = 5;

export interface ApprovalQueueData {
  readonly approvals: FounderApprovalQueueItem[];
  /** True when the queue is longer than the pages read; the page says so rather than implying it is complete. */
  readonly truncated: boolean;
}

/** Every payout approval waiting at the founder step, oldest first. The service pages by sequence; this reads a bounded number of pages. */
export async function loadApprovalQueue(ctx: PayCallContext): Promise<PayCallResult<ApprovalQueueData>> {
  const approvals: FounderApprovalQueueItem[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < APPROVAL_MAX_PAGES; page += 1) {
    const result = await payCall(
      ctx,
      'founderAdmin.approvals.list',
      'GET',
      { limit: APPROVAL_PAGE, ...(cursor ? { cursor } : {}) },
      parseWith(founderApprovalQueueSchema),
    );
    if (result.kind !== 'ok') return result;
    approvals.push(...result.data.approvals);
    if (result.data.nextCursor === null) return { kind: 'ok', data: { approvals, truncated: false } };
    cursor = result.data.nextCursor;
  }
  return { kind: 'ok', data: { approvals, truncated: true } };
}

/** Merchant names for a set of ids, one exact-id read each, bounded. A merchant whose name could not be read maps to `undefined`. */
export async function loadMerchantNames(ctx: PayCallContext, ids: readonly string[]): Promise<Map<string, string | null>> {
  const unique = [...new Set(ids)].slice(0, 40);
  const out = new Map<string, string | null>();
  await Promise.all(
    unique.map(async (merchantId) => {
      const r = await payRecordCall(ctx, PAY_FOUNDER_ADMIN_MERCHANTS_LIST, { limit: 1, filter: { merchantId } });
      const row = r.kind === 'ok' ? r.data.rows[0] : undefined;
      if (row) out.set(merchantId, row.displayName);
    }),
  );
  return out;
}

export interface ApprovalsPageData {
  readonly queue: PayCallResult<ApprovalQueueData>;
  readonly names: Map<string, string | null>;
  readonly readAt: string;
}

export async function loadApprovalsPage(ctx: PayCallContext, now: Date = new Date()): Promise<ApprovalsPageData> {
  const queue = await loadApprovalQueue(ctx);
  const names =
    queue.kind === 'ok'
      ? await loadMerchantNames(
          ctx,
          queue.data.approvals.map((a) => a.merchantId),
        )
      : new Map<string, string | null>();
  return { queue, names, readAt: now.toISOString() };
}

export interface MerchantApprovalsData {
  readonly queue: PayCallResult<ApprovalQueueData>;
  readonly readAt: string;
}

export async function loadMerchantApprovals(ctx: PayCallContext, now: Date = new Date()): Promise<MerchantApprovalsData> {
  return { queue: await loadApprovalQueue(ctx), readAt: now.toISOString() };
}

export interface MerchantHaltsData {
  readonly status: PayCallResult<PayHaltOperatorStatus>;
  readonly history: PayCallResult<PayHaltEvent[]>;
  readonly pending: PayCallResult<{ proposals: PayHaltPendingClear[]; nextCursor: string | null }>;
  readonly readAt: string;
}

export async function loadMerchantHalts(ctx: PayCallContext, merchantId: string, now: Date = new Date()): Promise<MerchantHaltsData> {
  const [status, history, pending] = await Promise.all([
    payRecordCall(ctx, PAY_HALTS_OPERATOR_STATUS, undefined),
    payRecordCall(ctx, PAY_HALTS_HISTORY, { target: { level: 'merchant', merchantId }, limit: 50 }),
    loadPendingClears(ctx),
  ]);
  return { status, history, pending, readAt: now.toISOString() };
}

export interface MerchantListPageData {
  readonly list: PayCallResult<FounderMerchantList>;
  /** Status and KYB counts for the KPI strip. A failure here only removes the strip. */
  readonly counts: PayCallResult<FounderGlobalMetrics>;
}

export async function loadMerchantListPage(ctx: PayCallContext, query: MerchantListQuery): Promise<MerchantListPageData> {
  const [list, counts] = await Promise.all([
    loadMerchantList(ctx, query),
    payRecordCall(ctx, PAY_FOUNDER_ADMIN_METRICS_GLOBAL, { window: presetWindow('today') }),
  ]);
  return { list, counts };
}
