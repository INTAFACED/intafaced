import 'server-only';
import type { ActionApproval } from '@intafaced/contracts';
import { parseApproval } from './approvals-parse';
import { edgeCall, trpcSpec, type TradeCtx } from './edge';
import type { Outcome } from './outcome';
import {
  CHART_DATA_CLASS_ACTION_TYPE,
  CHART_DATA_CLASS_POLICY_VERSION,
  CHART_DATA_CLASS_TARGET_SERVICE,
  parseChartOwnerValuesView,
  type ChartOwnerValuesView,
  type ChartScalarKey,
} from './charts-owner-values-model';
import { chartDataClassPayloadHash, type ChartDataClassPayload } from './charts-owner-values-hash';

/**
 * Charts owner values through svc-edge: svc-trade `admin.chartOwnerValues.*` and the identity approval that a data
 * class change needs. Server only; the founder's token never reaches the browser. Nothing here is retried.
 */

/** admin.chartOwnerValues.get: the scalars, every listed market's data class, and whether this caller may write. */
export function readChartOwnerValues(ctx: TradeCtx): Promise<Outcome<ChartOwnerValuesView>> {
  return edgeCall(ctx, trpcSpec('trade', 'admin.chartOwnerValues.get', 'query', {}, parseChartOwnerValuesView));
}

export interface ChartScalarWrite {
  readonly key: ChartScalarKey;
  readonly value: number | null;
  readonly expectedVersion: string;
  readonly reason: string;
  readonly clientRequestId: string;
}

/** admin.chartOwnerValues.set for one count. A blank value clears it back to not set. */
export function writeChartScalar(ctx: TradeCtx, input: ChartScalarWrite): Promise<Outcome<ChartOwnerValuesView>> {
  return edgeCall(ctx, trpcSpec('trade', 'admin.chartOwnerValues.set', 'mutation', input, parseChartOwnerValuesView));
}

export interface ChartDataClassWrite extends ChartDataClassPayload {
  /** The approval's own id, from a second founder. */
  readonly approvalId: string;
  /** The approval's operation id, read from identity: svc-trade consumes the approval only with this key. */
  readonly clientRequestId: string;
}

/** admin.chartOwnerValues.set for one market's data class. Needs a consumed, second-founder approval. */
export function writeChartDataClass(ctx: TradeCtx, input: ChartDataClassWrite): Promise<Outcome<ChartOwnerValuesView>> {
  return edgeCall(
    ctx,
    trpcSpec(
      'trade',
      'admin.chartOwnerValues.set',
      'mutation',
      {
        key: 'dataClass',
        symbol: input.symbol,
        value: input.dataClass,
        expectedVersion: input.expectedVersion,
        reason: input.reason,
        approvalId: input.approvalId,
        clientRequestId: input.clientRequestId,
      },
      parseChartOwnerValuesView,
    ),
  );
}

/**
 * identity actionApproval.propose for a data class change: bound to the symbol, the version the page read and the hash of
 * exactly what will be written. A second founder approves it in the Approvals room.
 */
export function proposeChartDataClass(ctx: TradeCtx, body: ChartDataClassPayload): Promise<Outcome<ActionApproval>> {
  return edgeCall(
    ctx,
    trpcSpec(
      'identity',
      'actionApproval.propose',
      'mutation',
      {
        actionType: CHART_DATA_CLASS_ACTION_TYPE,
        targetService: CHART_DATA_CLASS_TARGET_SERVICE,
        targetId: body.symbol,
        expectedVersion: body.expectedVersion,
        payloadHash: chartDataClassPayloadHash(body),
        policyVersion: CHART_DATA_CLASS_POLICY_VERSION,
      },
      parseApproval,
    ),
  );
}
