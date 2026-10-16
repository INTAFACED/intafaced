import type { FounderMerchantDrilldown, PayMetricWindow } from '@intafaced/contracts';
import { toContractApproval } from '../control/approvals.js';
import type { ControlService } from '../control/service.js';
import type { PayHaltStore } from '../halts/store.js';
import { merchantNotFound, type MetricsRuntime } from '../metrics/index.js';

/**
 * Founder one-merchant view. Every section is an existing read: the merchant row,
 * the control profile, the metrics snapshot (payment and settlement summary for
 * the window), halt switches for this merchant, pending payout approvals, the
 * open limit-increase ask, and recent `pay.control_audit` rows. Nothing here
 * posts money or changes caps.
 *
 * 200 is the existing founder list ceiling, not a business magnitude.
 */
const RECENT_LIMIT = 200;

export async function readMerchantDrilldown(deps: {
  metrics: MetricsRuntime;
  control: ControlService;
  halts: PayHaltStore;
  merchantId: string;
  window: PayMetricWindow;
}): Promise<FounderMerchantDrilldown> {
  const { control, metrics, halts, window } = deps;
  // Postgres returns uuid text in lowercase. Compare and answer in that form so an
  // uppercase id still finds the merchant it names.
  const merchantId = deps.merchantId.toLowerCase();
  const [listed, record, metricsSnapshot, controlProfile, haltsView, pendingApprovals, openLimit, audit] = await Promise.all([
    metrics.reader.merchantList({ limit: 1, filter: { merchantId } }),
    control.merchantRecord(merchantId),
    metrics.reader.merchantSnapshot(merchantId, window),
    control.profile(merchantId),
    halts.operatorStatusForMerchant(merchantId),
    control.approvals.pendingForMerchant(merchantId, RECENT_LIMIT),
    control.openLimitRequest(merchantId),
    control.recentAudit(merchantId, RECENT_LIMIT),
  ]);
  const row = listed.rows[0];
  if (!record || !row || row.merchantId.toLowerCase() !== merchantId) throw merchantNotFound();
  return {
    merchantId,
    displayName: record.displayName,
    legalName: record.legalName,
    status: record.status,
    metrics: metricsSnapshot,
    control: controlProfile,
    halts: haltsView,
    pendingApprovals: pendingApprovals.map(toContractApproval),
    pendingLimitRequests: openLimit.status === 'pending' ? [openLimit.request] : [],
    recentAudit: audit.events,
    auditTruncated: audit.truncated,
    operator: {
      kybStatus: record.kybStatus,
      openFraudReviews: row.openFlags,
      parentMerchantId: record.parentMerchantId,
    },
  };
}
