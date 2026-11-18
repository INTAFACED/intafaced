import 'server-only';
import type { ActionApproval } from '@intafaced/contracts';
import { parseApproval } from './approvals-parse';
import { edgeCall, trpcSpec, type TradeCtx } from './edge';
import type { Outcome } from './outcome';
import {
  CHART_FEED_ACTION_TYPE,
  CHART_FEED_POLICY_VERSION,
  CHART_FEED_TARGET_SERVICE,
  parseChartFeedApplied,
  parseChartFeedControlsView,
  parseChartFeedExport,
  parseChartFeedPrepared,
  type ChartFeedAction,
  type ChartFeedApplied,
  type ChartFeedControlsView,
  type ChartFeedExport,
  type ChartFeedPrepared,
} from './chart-feed-model';

/**
 * The chart feed control through svc-edge: svc-trade `admin.chartFeedControls.*` and the identity approval each change
 * needs (J-charts-desk-19). Server only; the operator's token never reaches the browser. Nothing here is retried.
 */

export interface ChartFeedChange {
  readonly symbol: string;
  readonly action: ChartFeedAction;
  readonly expectedVersion: string;
  readonly reason: string;
}

export function readChartFeedControls(ctx: TradeCtx): Promise<Outcome<ChartFeedControlsView>> {
  return edgeCall(ctx, trpcSpec('trade', 'admin.chartFeedControls.list', 'query', {}, parseChartFeedControlsView));
}

/** svc-trade checks the change (the owner's list, the version) and answers the hash; nothing is written. */
export function prepareChartFeedChange(ctx: TradeCtx, change: ChartFeedChange): Promise<Outcome<ChartFeedPrepared>> {
  return edgeCall(ctx, trpcSpec('trade', 'admin.chartFeedControls.prepare', 'query', change, parseChartFeedPrepared));
}

/** identity actionApproval.propose, bound to the market, the version and the hash svc-trade answered. */
export function proposeChartFeedChange(ctx: TradeCtx, prepared: ChartFeedPrepared): Promise<Outcome<ActionApproval>> {
  return edgeCall(
    ctx,
    trpcSpec(
      'identity',
      'actionApproval.propose',
      'mutation',
      {
        actionType: CHART_FEED_ACTION_TYPE,
        targetService: CHART_FEED_TARGET_SERVICE,
        targetId: prepared.symbol,
        expectedVersion: prepared.expectedVersion,
        payloadHash: prepared.payloadHash,
        policyVersion: CHART_FEED_POLICY_VERSION,
      },
      parseApproval,
    ),
  );
}

/** svc-trade applies an APPROVED change under the approval's own operation id. */
export function runChartFeedChange(
  ctx: TradeCtx,
  change: ChartFeedChange & { approvalId: string; operationId: string },
): Promise<Outcome<ChartFeedApplied>> {
  return edgeCall(ctx, trpcSpec('trade', 'admin.chartFeedControls.run', 'mutation', change, parseChartFeedApplied));
}

export function exportChartFeedControls(
  ctx: TradeCtx,
  window: { from: string | null; to: string | null },
): Promise<Outcome<ChartFeedExport>> {
  return edgeCall(ctx, trpcSpec('trade', 'admin.chartFeedControls.export', 'mutation', window, parseChartFeedExport));
}
