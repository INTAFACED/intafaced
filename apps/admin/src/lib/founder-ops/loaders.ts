import 'server-only';
import { isTestData } from '@/components/merchants/test-data-badge';
import { payCall, type PayCallContext, type PayCallResult } from '@/lib/merchants/pay-call';
import {
  loadApprovalQueue,
  type ApprovalQueueData,
  loadDashboard,
  type DashboardData,
  loadTreasury,
  type TreasuryData,
} from '@/lib/merchants/loaders';
import type { FounderMerchantSection, FounderMerchantSectionPage, MerchantMetricsSnapshot } from '@intafaced/contracts';
import type { TierView } from '@/lib/merchants/control-model';
import type { FounderScreen } from './screens';
import type { NotePage } from './notes';
import { loadControlAudit, loadLimitRequests, loadTiers } from './control-reads';
import { auditInput, type ControlAuditList, type LimitRequestList } from './control-model';
import { parseRiskWindow, one, SCREEN_SECTIONS, slugOf, type Query, type RiskWindowKey } from './read-model';
import {
  loadBalances,
  loadDisputeList,
  loadNotes,
  loadLiveSummary,
  loadPayoutList,
  loadRecentMerchants,
  loadRiskSummary,
  loadSection,
} from './reads';

export interface FraudRow {
  id: string;
  merchantId: string;
  paymentId: string | null;
  amount: string;
  assetId: string;
  status: 'open' | 'allowed' | 'declined';
  createdAt: string;
  reasons: { ruleId: string; detail: string }[];
}
export function parseFraud(raw: unknown): FraudRow[] | null {
  if (!Array.isArray(raw) || raw.length > 100) return null;
  const out: FraudRow[] = [];
  for (const value of raw) {
    if (!value || typeof value !== 'object') return null;
    const r = value as Record<string, unknown>;
    if (
      ['id', 'merchantId', 'assetId', 'createdAt'].some((k) => typeof r[k] !== 'string' || !r[k]) ||
      typeof r.amount !== 'string' ||
      !/^\d+(\.\d{1,18})?$/.test(r.amount) ||
      (r.paymentId !== null && typeof r.paymentId !== 'string') ||
      !['open', 'allowed', 'declined'].includes(String(r.status)) ||
      !Number.isFinite(Date.parse(String(r.createdAt))) ||
      !Array.isArray(r.reasons) ||
      !r.reasons.every(
        (v: unknown) =>
          v && typeof v === 'object' && 'ruleId' in v && typeof v.ruleId === 'string' && 'detail' in v && typeof v.detail === 'string',
      )
    )
      return null;
    out.push({
      id: r.id as string,
      merchantId: r.merchantId as string,
      paymentId: r.paymentId,
      amount: r.amount,
      assetId: r.assetId as string,
      status: r.status as FraudRow['status'],
      createdAt: r.createdAt as string,
      reasons: r.reasons as FraudRow['reasons'],
    });
  }
  return out;
}
export interface OpsData {
  readAt: string;
  testData?: boolean;
  userId: string;
  expiresAt: string;
  fraud?: PayCallResult<FraudRow[]>;
  treasury?: TreasuryData;
  metrics?: DashboardData;
  approvals?: PayCallResult<ApprovalQueueData>;
  /** F07-F23: each merchant section the page shows, read on its own so one failure never hides the rest. */
  sections?: Partial<Record<FounderMerchantSection, PayCallResult<FounderMerchantSectionPage>>>;
  balances?: PayCallResult<MerchantMetricsSnapshot>;
  notes?: PayCallResult<NotePage>;
  recent?: PayCallResult<ReadOf<typeof loadRecentMerchants>>;
  payouts?: PayCallResult<ReadOf<typeof loadPayoutList>>;
  disputes?: PayCallResult<ReadOf<typeof loadDisputeList>>;
  live?: PayCallResult<ReadOf<typeof loadLiveSummary>>;
  risk?: PayCallResult<ReadOf<typeof loadRiskSummary>>;
  riskWindow?: RiskWindowKey;
  /** F54 */
  tiers?: PayCallResult<TierView[]>;
  /** F58 */
  limitRequests?: PayCallResult<LimitRequestList>;
  /** F64: the read, or the reasons the filters could not be sent. */
  audit?: PayCallResult<ControlAuditList>;
  auditErrors?: string[];
}
type ReadOf<F extends (...args: never[]) => Promise<PayCallResult<unknown>>> = Extract<Awaited<ReturnType<F>>, { kind: 'ok' }>['data'];
export interface OpsOptions {
  /** Present on a merchant drilldown page. */
  readonly merchantId?: string | undefined;
  /** The page's own query string: cursors, status filters and search per list. */
  readonly query?: Query | undefined;
}
export async function loadOps(
  ctx: PayCallContext,
  screen: FounderScreen,
  merchant?: string,
  days: 1 | 7 | 30 = 7,
  options: OpsOptions = {},
): Promise<OpsData> {
  const data: OpsData = {
    testData: isTestData(),
    readAt: new Date().toISOString(),
    userId: ctx.session.userId,
    expiresAt: ctx.session.expiresAt,
  };
  if (screen.id === 'F30' || screen.id === 'F31')
    data.fraud = await payCall(
      ctx,
      'fraud.listOpenReviews',
      'GET',
      { limit: 100, ...(merchant ? { merchantId: merchant } : {}) },
      parseFraud,
    );
  if (screen.id === 'F02' || screen.id === 'F03' || screen.id === 'F51' || screen.id === 'F61') data.treasury = await loadTreasury(ctx);
  if (screen.id === 'F69' || screen.id === 'F70') data.metrics = await loadDashboard(ctx, new Date(), days);
  if (screen.id === 'F25') data.approvals = await loadApprovalQueue(ctx);
  const { merchantId, query } = options;
  if (merchantId) {
    const sections = SCREEN_SECTIONS[slugOf(screen.route)] ?? [];
    const [pages, balances] = await Promise.all([
      Promise.all(sections.map((section) => loadSection(ctx, merchantId, section, query))),
      screen.id === 'F11' ? loadBalances(ctx, merchantId) : Promise.resolve(undefined),
    ]);
    data.sections = Object.fromEntries(sections.map((section, i) => [section, pages[i]!]));
    if (balances) data.balances = balances;
  }
  if (merchantId && screen.id === 'F22') data.notes = await loadNotes(ctx, merchantId, query);
  if (screen.id === 'F05') data.recent = await loadRecentMerchants(ctx, query);
  if (screen.id === 'F37' || screen.id === 'F35') data.payouts = await loadPayoutList(ctx, query);
  if (screen.id === 'F32') data.disputes = await loadDisputeList(ctx, query);
  if (screen.id === 'F54') data.tiers = await loadTiers(ctx);
  if (screen.id === 'F58') data.limitRequests = await loadLimitRequests(ctx, query);
  if (screen.id === 'F64') {
    const asked = auditInput(query);
    if (asked.ok) data.audit = await loadControlAudit(ctx, asked.input);
    else data.auditErrors = asked.errors;
  }
  if (screen.id === 'F02') data.live = await loadLiveSummary(ctx);
  if (screen.id === 'F03') {
    data.riskWindow = parseRiskWindow(one(query, 'window'));
    data.risk = await loadRiskSummary(ctx, data.riskWindow);
  }
  return data;
}
