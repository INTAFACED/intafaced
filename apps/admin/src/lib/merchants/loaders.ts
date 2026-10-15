import 'server-only';
import {
  founderGlobalMetricsSchema,
  founderMerchantDrilldownSchema,
  founderMerchantListSchema,
  founderTreasuryExposureSchema,
  merchantMetricsSeriesSchema,
  merchantMetricsSnapshotSchema,
  payHaltEventSchema,
  type FounderGlobalMetrics,
  type FounderMerchantDrilldown,
  type FounderMerchantList,
  type FounderTreasuryExposure,
  type MerchantMetricsSeries,
  type MerchantMetricsSnapshot,
  type PayHaltEvent,
} from '@intafaced/contracts';
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
}

export async function loadMerchantDetail(
  ctx: PayCallContext,
  merchantId: string,
  preset: MetricPreset,
  now: Date = new Date(),
): Promise<MerchantDetailData> {
  const today = dayOf(now);
  const [metrics, series, drilldown] = await Promise.all([
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
  ]);
  return { metrics, series, drilldown };
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

export interface TreasuryData {
  readonly exposure: PayCallResult<FounderTreasuryExposure>;
  readonly halts: PayCallResult<PayHaltEvent[]>;
}

export async function loadTreasury(ctx: PayCallContext): Promise<TreasuryData> {
  const [exposure, halts] = await Promise.all([
    payCall(ctx, 'founderAdmin.treasury.exposure', 'GET', {}, parseWith(founderTreasuryExposureSchema)),
    payCall(ctx, 'payHalts.history', 'GET', { limit: 50 }, (raw) =>
      asList(raw, (item) => {
        const parsed = payHaltEventSchema.safeParse(item);
        return parsed.success ? parsed.data : null;
      }),
    ),
  ]);
  return { exposure, halts };
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
