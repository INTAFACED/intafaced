import 'server-only';

/**
 * The merchants feature's entry: another console feature imports it only from here
 * (`garden/no-cross-feature-import`); a piece it needs that is not listed is exported here first.
 * This entry is for server code: it holds the call to svc-pay as the signed-in founder.
 */
export { asTier, type TierView } from './control-model';
export { loadApprovalQueue, loadDashboard, loadTreasury, type ApprovalQueueData, type DashboardData, type TreasuryData } from './loaders';
export { parseWith, payCall, payRecordCall, type PayCallContext, type PayCallResult } from './pay-call';
export { asList } from './registry-model';
export type { ChipSpec } from './chips';
