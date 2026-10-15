import 'server-only';
import {
  founderApprovalQueueSchema,
  founderGlobalMetricsSchema,
  founderMerchantDrilldownSchema,
  founderMerchantListSchema,
  founderTreasuryExposureSchema,
  merchantMetricsSeriesSchema,
  merchantControlProfileSchema,
  merchantMetricsSnapshotSchema,
  payHaltEventSchema,
  payHaltOperatorStatusSchema,
  type FounderGlobalMetrics,
  type FounderMerchantDrilldown,
  type FounderMerchantList,
  type FounderTreasuryExposure,
  type MerchantControlProfile,
  type MerchantMetricsSeries,
  type MerchantMetricsSnapshot,
  type PayHaltEvent,
  type PayHaltOperatorStatus,
  type PayoutApproval,
} from '@intafaced/contracts';
import { asPricingRule, asTier, asUsage, type PricingRuleView, type TierView, type UsageView } from './control-model';
import { addDays, dayOf, midnight } from './dates';
import { listInputFor, type MerchantListQuery } from './list-params';
import { payCall, parseWith, type PayCallContext, type PayCallResult } from './pay-call';
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

export async function loadDashboard(ctx: PayCallContext, now: Date = new Date()): Promise<DashboardData> {
  const todayDay = dayOf(now);
  const read = (window: unknown) => payCall(ctx, 'founderAdmin.metrics.global', 'GET', { window }, parseWith(founderGlobalMetricsSchema));
  const earlier = Array.from({ length: DASHBOARD_DAYS - 1 }, (_, i) => addDays(todayDay, i - (DASHBOARD_DAYS - 1)));
  const [today, ...rest] = await Promise.all([read(presetWindow('today')), ...earlier.map((day) => read(dayWindow(day)))]);
  return {
    today,
    days: [...earlier.map((day, i) => ({ day, result: rest[i]! })), { day: todayDay, result: today }],
    generatedAt: now.toISOString(),
  };
}

export function loadMerchantList(ctx: PayCallContext, query: MerchantListQuery): Promise<PayCallResult<FounderMerchantList>> {
  return payCall(ctx, 'founderAdmin.merchants.list', 'GET', listInputFor(query), parseWith(founderMerchantListSchema));
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
    payCall(
      ctx,
      'founderAdmin.metrics.merchant',
      'GET',
      { merchantId, window: presetWindow(preset) },
      parseWith(merchantMetricsSnapshotSchema),
    ),
    payCall(
      ctx,
      'founderAdmin.metrics.merchantSeries',
      'GET',
      { merchantId, from: midnight(addDays(today, -(SERIES_DAYS - 1))), to: midnight(addDays(today, 1)), bucket: 'day' },
      parseWith(merchantMetricsSeriesSchema),
    ),
    payCall(
      ctx,
      'founderAdmin.merchants.drilldown',
      'GET',
      { merchantId, window: presetWindow(preset) },
      parseWith(founderMerchantDrilldownSchema),
    ),
    payCall(ctx, 'founderAdmin.merchants.list', 'GET', { limit: 1, filter: { merchantId } }, parseWith(founderMerchantListSchema)),
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
  return payCall(ctx, 'founderAdmin.registries.history', 'GET', { registry: kind, entryKey, limit: 50 }, (raw) => asList(raw, asEvent));
}

const parseHalts = (raw: unknown) =>
  asList(raw, (item) => {
    const parsed = payHaltEventSchema.safeParse(item);
    return parsed.success ? parsed.data : null;
  });

export interface TreasuryData {
  readonly exposure: PayCallResult<FounderTreasuryExposure>;
  readonly halts: PayCallResult<PayHaltEvent[]>;
  /** Current halt switches and the auto-trip posture (`payHalts.operatorStatus`). */
  readonly status: PayCallResult<PayHaltOperatorStatus>;
  /** When the halt reads were taken. Halts are read live from the store, so this is the as-of time. */
  readonly readAt: string;
}

export async function loadTreasury(ctx: PayCallContext, now: Date = new Date()): Promise<TreasuryData> {
  const [exposure, halts, status] = await Promise.all([
    payCall(ctx, 'founderAdmin.treasury.exposure', 'GET', {}, parseWith(founderTreasuryExposureSchema)),
    payCall(ctx, 'payHalts.history', 'GET', { limit: 50 }, parseHalts),
    payCall(ctx, 'payHalts.operatorStatus', 'GET', {}, parseWith(payHaltOperatorStatusSchema)),
  ]);
  return { exposure, halts, status, readAt: now.toISOString() };
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
    payCall(ctx, 'founderAdmin.control.merchant.get', 'GET', { merchantId }, parseWith(merchantControlProfileSchema)),
    payCall(ctx, 'founderAdmin.control.merchant.usage', 'GET', { merchantId }, asUsage),
    payCall(ctx, 'founderAdmin.control.tiers.list', 'GET', {}, (raw) => asList(raw, asTier)),
  ]);
  // The tier layer is only asked for when the merchant has a tier; the first failure of the three layers is the one shown.
  const layers: Array<Promise<PayCallResult<PricingRuleView[]>>> = [
    payCall(ctx, 'founderAdmin.control.pricing.rules', 'GET', { layer: 'global' }, parseRules),
    payCall(ctx, 'founderAdmin.control.pricing.rules', 'GET', { layer: 'merchant', scopeId: merchantId }, parseRules),
  ];
  if (profile.kind === 'ok' && profile.data.tierId !== null) {
    layers.push(payCall(ctx, 'founderAdmin.control.pricing.rules', 'GET', { layer: 'tier', scopeId: profile.data.tierId }, parseRules));
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
  readonly approvals: PayoutApproval[];
  /** True when the queue is longer than the pages read; the page says so rather than implying it is complete. */
  readonly truncated: boolean;
}

/** Every payout approval waiting at the founder step, oldest first. The service pages by sequence; this reads a bounded number of pages. */
export async function loadApprovalQueue(ctx: PayCallContext): Promise<PayCallResult<ApprovalQueueData>> {
  const approvals: PayoutApproval[] = [];
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
      const r = await payCall(
        ctx,
        'founderAdmin.merchants.list',
        'GET',
        { limit: 1, filter: { merchantId } },
        parseWith(founderMerchantListSchema),
      );
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
  readonly readAt: string;
}

export async function loadMerchantHalts(ctx: PayCallContext, merchantId: string, now: Date = new Date()): Promise<MerchantHaltsData> {
  const [status, history] = await Promise.all([
    payCall(ctx, 'payHalts.operatorStatus', 'GET', {}, parseWith(payHaltOperatorStatusSchema)),
    payCall(ctx, 'payHalts.history', 'GET', { target: { level: 'merchant', merchantId }, limit: 50 }, parseHalts),
  ]);
  return { status, history, readAt: now.toISOString() };
}

export interface MerchantListPageData {
  readonly list: PayCallResult<FounderMerchantList>;
  /** Status and KYB counts for the KPI strip. A failure here only removes the strip. */
  readonly counts: PayCallResult<FounderGlobalMetrics>;
}

export async function loadMerchantListPage(ctx: PayCallContext, query: MerchantListQuery): Promise<MerchantListPageData> {
  const [list, counts] = await Promise.all([
    loadMerchantList(ctx, query),
    payCall(ctx, 'founderAdmin.metrics.global', 'GET', { window: presetWindow('today') }, parseWith(founderGlobalMetricsSchema)),
  ]);
  return { list, counts };
}
