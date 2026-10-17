import 'server-only';
import type { ActionApproval } from '@intafaced/contracts';
import { edgeCall, trpcSpec, type TradeCtx } from './edge';
import { serviceCode } from './approvals';
import { parseApproval } from './approvals-parse';
import {
  MATCHING_EXPECTED_VERSION,
  MATCHING_POLICY_VERSION,
  MATCHING_TARGET_SERVICE,
  matchingEdgePath,
  matchingIdempotencyKey,
  matchingTargetId,
  checkMatchingRequest,
  type MatchingActionSpec,
} from './matching-controls';
import { matchingPayloadHash } from './matching-hash';
import { refused, type Outcome } from './outcome';
import { parseDetectors, parseSurveillanceCases, type DetectorsView, type SurveillanceCase } from './surveillance-model';

/**
 * The trade desk's calls to the svc-edge operator doors added in EDGEOPSBE (#4948): matching health, surveillance cases and
 * the nine matching controls. Server only, signed with the founder's own session token. Every answer is an Outcome: the
 * service's own typed refusal (for example `matching_unconfigured`, `action_approval.missing`) comes back as-is, and a
 * timeout is `unknown`, never a success.
 */

export interface MatchingHealth {
  readonly venueHalted: boolean;
  readonly restingOrders: number;
  readonly journalRecords: number;
  /** When svc-edge received matching's answer. */
  readonly asOf: string;
  /** How long the read took at the edge. */
  readonly ageMs: number;
}

function parseHealth(raw: unknown): MatchingHealth | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.venueHalted !== 'boolean' || typeof r.restingOrders !== 'number' || typeof r.journalRecords !== 'number') return null;
  if (typeof r.asOf !== 'string' || typeof r.ageMs !== 'number') return null;
  return { venueHalted: r.venueHalted, restingOrders: r.restingOrders, journalRecords: r.journalRecords, asOf: r.asOf, ageMs: r.ageMs };
}

export const readMatchingHealth = (ctx: TradeCtx): Promise<Outcome<MatchingHealth>> =>
  edgeCall(ctx, { method: 'GET', path: '/admin/trade-ops/matching/health', parse: parseHealth });

/** The page size is this desk's own and shown on the page; svc-edge refuses a missing limit and invents none. */
export const SURVEILLANCE_PAGE = 100;

export interface SurveillanceRead {
  readonly cases: readonly SurveillanceCase[];
  readonly limit: number;
  /** svc-matching's detector state; null = unknown (no block, or not that shape). A missing block never fails the case read. */
  readonly detectors: DetectorsView | null;
}

export const readSurveillanceCases = (ctx: TradeCtx, limit: number = SURVEILLANCE_PAGE): Promise<Outcome<SurveillanceRead>> =>
  edgeCall(ctx, {
    method: 'GET',
    path: '/admin/trade-ops/surveillance/cases',
    query: { limit },
    parse: (raw) => {
      const cases = raw && typeof raw === 'object' ? parseSurveillanceCases((raw as { cases?: unknown }).cases) : null;
      if (cases === null) return null;
      const upstream = (raw as { upstream?: unknown }).upstream;
      const detectors = upstream && typeof upstream === 'object' ? parseDetectors((upstream as { detectors?: unknown }).detectors) : null;
      return { cases, limit, detectors };
    },
  });

/** Put the identity service's own code (it hides in the message) on a refusal, so the UI can say it in words. */
function withServiceCode<T>(o: Outcome<T>): Outcome<T> {
  if (o.kind !== 'refused') return o;
  const code = serviceCode(o.code, o.message);
  return code === o.code ? o : { ...o, code };
}

/** Operator A files the approval svc-edge and svc-matching will later check: this action, this target, version 1. */
export async function proposeMatchingApproval(
  ctx: TradeCtx,
  action: MatchingActionSpec,
  marketId: string | null,
): Promise<Outcome<ActionApproval>> {
  return withServiceCode(
    await edgeCall(
      ctx,
      trpcSpec(
        'identity',
        'actionApproval.propose',
        'mutation',
        {
          actionType: action.actionType,
          targetService: MATCHING_TARGET_SERVICE,
          targetId: matchingTargetId(action, marketId),
          expectedVersion: MATCHING_EXPECTED_VERSION,
          payloadHash: matchingPayloadHash(action, marketId),
          policyVersion: MATCHING_POLICY_VERSION,
        },
        parseApproval,
      ),
    ),
  );
}

export async function readMatchingApproval(ctx: TradeCtx, approvalId: string): Promise<Outcome<ActionApproval>> {
  return withServiceCode(await edgeCall(ctx, trpcSpec('identity', 'actionApproval.get', 'query', { approvalId }, parseApproval)));
}

export interface MatchingRunResult {
  readonly audit: {
    readonly at: string;
    readonly action: string;
    readonly marketId: string | null;
    readonly requesterId: string;
    readonly approverId: string;
    readonly idempotencyKey: string;
  };
}

function parseRun(raw: unknown): MatchingRunResult | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as { outcome?: unknown; audit?: unknown };
  if (r.outcome !== 'accepted' || !r.audit || typeof r.audit !== 'object') return null;
  const a = r.audit as Record<string, unknown>;
  if (
    typeof a.at !== 'string' ||
    typeof a.action !== 'string' ||
    typeof a.requesterId !== 'string' ||
    typeof a.approverId !== 'string' ||
    typeof a.idempotencyKey !== 'string'
  )
    return null;
  return {
    audit: {
      at: a.at,
      action: a.action,
      marketId: typeof a.marketId === 'string' ? a.marketId : null,
      requesterId: a.requesterId,
      approverId: a.approverId,
      idempotencyKey: a.idempotencyKey,
    },
  };
}

/**
 * Run one control with an approval id. The approval is read first, only to say honestly why a PENDING one cannot run yet and
 * to get its operationId; svc-edge re-reads it and decides. Nothing is sent unless the approval is APPROVED.
 */
export async function runMatchingControl(
  ctx: TradeCtx,
  action: MatchingActionSpec,
  marketId: string | null,
  approvalId: string,
): Promise<Outcome<MatchingRunResult>> {
  const approval = await readMatchingApproval(ctx, approvalId);
  if (approval.kind !== 'ok') return approval;
  if (approval.data.status !== 'APPROVED') {
    const waiting = approval.data.status === 'PENDING';
    return refused(
      waiting ? 'action_approval.pending' : 'action_approval.not_approved',
      waiting
        ? 'This approval is still waiting for a second operator. Nothing was sent. The second operator approves it with the approval id and the payload hash shown here.'
        : `This approval is ${approval.data.status}, not APPROVED. Nothing was sent.`,
      409,
    );
  }
  return edgeCall(ctx, {
    method: 'POST',
    path: matchingEdgePath(action, marketId),
    body: { idempotencyKey: matchingIdempotencyKey(action, marketId, approvalId), approvalId, operationId: approval.data.operationId },
    parse: parseRun,
  });
}

/** One request from the Markets or Kill switch room: check it, then propose, read the approval, or run. */
export async function handleMatchingRequest(ctx: TradeCtx, body: Record<string, unknown>): Promise<Outcome<unknown>> {
  const check = checkMatchingRequest(body);
  if (!check.ok) return refused(check.code, check.message, 400);
  if (check.step === 'propose') return proposeMatchingApproval(ctx, check.action, check.marketId);
  if (check.step === 'status') return readMatchingApproval(ctx, check.approvalId as string);
  return runMatchingControl(ctx, check.action, check.marketId, check.approvalId as string);
}
