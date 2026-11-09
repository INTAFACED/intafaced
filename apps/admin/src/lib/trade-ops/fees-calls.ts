import 'server-only';
import { createHash } from 'node:crypto';
import type { ActionApproval } from '@intafaced/contracts';
import { parseApproval } from './approvals-parse';
import { edgeCall, trpcSpec, type TradeCtx } from './edge';
import { ok, type Outcome } from './outcome';
import { parseFeeHistory, type FeeHistory, type FeeVersionRow } from './fees-versions-model';
import {
  parseConvertQuotes,
  parseConvertSettings,
  parseFeeNotice,
  parseNoticeProposal,
  parseOnrampFeesNotKnown,
  parseOnrampQuotes,
  parseSnapshotRuns,
  type ConvertQuote,
  type ConvertSettings,
  type FeeNotice,
  type OnrampFeesNotKnown,
  type OnrampQuote,
  type SnapshotRun,
} from './fees-desk-parse';
import {
  FEE_SCHEDULE_POLICY_VERSION,
  FEE_SCHEDULE_SET_ACTION_TYPE,
  FEE_SCHEDULE_TARGET_ID,
  FEE_SCHEDULE_TARGET_SERVICE,
  feeScheduleSetPayloadHash,
  type FeeScheduleSetBody,
} from './fees-hash';

/**
 * The calls behind the Fees and convert room (J-cex-spot-17). Server only: each is a real call through svc-edge with the
 * signed-in founder's own token, to svc-trade (`admin.fees.*`, `admin.convertDesk.*`), svc-bank (`ops.onrampQuotes`, `ops.onrampFeesNotKnown`),
 * svc-notify (the fee-change notice) or svc-identity (the second founder's approval). Nothing is cached or retried.
 */

/** How many rows each finance list shows: recent history, not an export. */
export const FEES_DESK_ROWS = 50;

export const readFeeHistory = (ctx: TradeCtx): Promise<Outcome<FeeHistory>> =>
  edgeCall(ctx, trpcSpec('trade', 'admin.fees.get', 'query', undefined, parseFeeHistory));

export const readSnapshotRuns = (ctx: TradeCtx): Promise<Outcome<SnapshotRun[]>> =>
  edgeCall(ctx, trpcSpec('trade', 'admin.fees.snapshots', 'query', { limit: 20 }, parseSnapshotRuns));

export const readConvertSettings = (ctx: TradeCtx): Promise<Outcome<ConvertSettings>> =>
  edgeCall(ctx, trpcSpec('trade', 'admin.convertDesk.settings', 'query', undefined, parseConvertSettings));

export const readSellQuotes = (ctx: TradeCtx): Promise<Outcome<ConvertQuote[]>> =>
  edgeCall(ctx, trpcSpec('trade', 'admin.convertDesk.quotes', 'query', { side: 'sell', limit: FEES_DESK_ROWS }, parseConvertQuotes));

export const readOnrampQuotes = (ctx: TradeCtx): Promise<Outcome<OnrampQuote[]>> =>
  edgeCall(ctx, trpcSpec('bank', 'ops.onrampQuotes', 'query', { limit: FEES_DESK_ROWS }, parseOnrampQuotes));

/** The buy asks the partner's ramp gave no fee for: "not known", never 0. */
export const readOnrampFeesNotKnown = (ctx: TradeCtx): Promise<Outcome<OnrampFeesNotKnown>> =>
  edgeCall(ctx, trpcSpec('bank', 'ops.onrampFeesNotKnown', 'query', { limit: FEES_DESK_ROWS }, parseOnrampFeesNotKnown));

export interface FeesDeskView {
  readonly fees: Outcome<FeeHistory>;
  readonly snapshots: Outcome<SnapshotRun[]>;
  readonly convert: Outcome<ConvertSettings>;
  readonly sellQuotes: Outcome<ConvertQuote[]>;
  readonly onrampQuotes: Outcome<OnrampQuote[]>;
  readonly onrampFeesNotKnown: Outcome<OnrampFeesNotKnown>;
  /** When the console read it all, so the room's "now" is the read's, not the browser's. */
  readonly asOf: string;
}

/** Every read of the room at once. A read that fails says so in its own section and hides no other. */
export async function loadFeesDesk(ctx: TradeCtx): Promise<FeesDeskView> {
  const [fees, snapshots, convert, sellQuotes, onrampQuotes, onrampFeesNotKnown] = await Promise.all([
    readFeeHistory(ctx),
    readSnapshotRuns(ctx),
    readConvertSettings(ctx),
    readSellQuotes(ctx),
    readOnrampQuotes(ctx),
    readOnrampFeesNotKnown(ctx),
  ]);
  return { fees, snapshots, convert, sellQuotes, onrampQuotes, onrampFeesNotKnown, asOf: new Date().toISOString() };
}

/** identity actionApproval.propose for one fee schedule version, bound to the hash of exactly what will be written. */
export function proposeFeeSchedule(ctx: TradeCtx, body: FeeScheduleSetBody): Promise<Outcome<ActionApproval>> {
  return edgeCall(
    ctx,
    trpcSpec(
      'identity',
      'actionApproval.propose',
      'mutation',
      {
        actionType: FEE_SCHEDULE_SET_ACTION_TYPE,
        targetService: FEE_SCHEDULE_TARGET_SERVICE,
        targetId: FEE_SCHEDULE_TARGET_ID,
        expectedVersion: body.expectedVersion,
        payloadHash: feeScheduleSetPayloadHash(body),
        policyVersion: FEE_SCHEDULE_POLICY_VERSION,
      },
      parseApproval,
    ),
  );
}

const parseVersionRow = (raw: unknown): FeeVersionRow | null => parseFeeHistory({ version: '0', history: [raw] })?.history[0] ?? null;

/** admin.fees.set: svc-trade consumes the approval under its own operation id and writes the next version. */
export function writeFeeSchedule(
  ctx: TradeCtx,
  body: FeeScheduleSetBody & { readonly approvalId: string; readonly operationId: string },
): Promise<Outcome<FeeVersionRow>> {
  return edgeCall(ctx, trpcSpec('trade', 'admin.fees.set', 'mutation', body, parseVersionRow));
}

/**
 * A fee-change notice draft for one version: svc-notify takes `startsAt` as the time the version takes effect and refuses
 * one already past. The key is the version and the words, so a lost reply sent again finds the same draft.
 */
export function draftFeeNotice(
  ctx: TradeCtx,
  input: { readonly version: string; readonly effectiveAt: string; readonly title: string; readonly body: string },
): Promise<Outcome<FeeNotice>> {
  const key = createHash('sha256')
    .update(JSON.stringify([ctx.session.userId, input.version, input.effectiveAt, input.title, input.body]))
    .digest('hex')
    .slice(0, 48);
  return edgeCall(
    ctx,
    trpcSpec(
      'notify',
      'notify.draftNotice',
      'mutation',
      { kind: 'fee_change', title: input.title, body: input.body, startsAt: input.effectiveAt, clientRequestId: `fee-notice:${key}` },
      parseFeeNotice,
    ),
  );
}

/** Ask identity for the approval a notice's publish spends, bound to the draft exactly as svc-notify holds it now. */
export async function requestFeeNoticePublish(
  ctx: TradeCtx,
  noticeId: string,
): Promise<Outcome<{ approval: ActionApproval; payloadHash: string }>> {
  const proposal = await edgeCall(ctx, trpcSpec('notify', 'notify.noticeProposal', 'query', { id: noticeId }, parseNoticeProposal));
  if (proposal.kind !== 'ok') return proposal;
  const { actionType, targetService, targetId, expectedVersion, payloadHash } = proposal.data;
  const approval = await edgeCall(
    ctx,
    trpcSpec(
      'identity',
      'actionApproval.propose',
      'mutation',
      { actionType, targetService, targetId, expectedVersion, payloadHash, policyVersion: 'v1' },
      parseApproval,
    ),
  );
  return approval.kind === 'ok' ? ok({ approval: approval.data, payloadHash }, approval.asOf) : approval;
}

/** svc-notify spends the approval once; the approval is the key, so sending it again replays the stored answer. */
export function publishFeeNotice(
  ctx: TradeCtx,
  input: { readonly noticeId: string; readonly approvalId: string; readonly operationId: string },
): Promise<Outcome<FeeNotice>> {
  return edgeCall(
    ctx,
    trpcSpec(
      'notify',
      'notify.publishNotice',
      'mutation',
      {
        id: input.noticeId,
        approvalId: input.approvalId,
        operationId: input.operationId,
        clientRequestId: `fee-notice-publish:${input.approvalId}`,
      },
      parseFeeNotice,
    ),
  );
}
