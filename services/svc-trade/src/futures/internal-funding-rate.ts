/**
 * Internal funding-rate publish (trade.futures residual).
 *
 * S2S only — oracle/ops publish rates here. Never invents a rate on GET;
 * public surface only reflects what was published.
 */
import type { FastifyInstance } from 'fastify';
import { retainRawBody, verifyServiceRequest, type ServiceAuthMode, type ServiceVerifier } from '@intafaced/contracts';
import { payloadHash, type ApprovalBook, type AuditWrite } from '../admin/common.js';
import { periodIdFor, type FundingRateEntry } from './funding-rate-source.js';
import { assertFundingRateWithinBound, FundingRateBoundError } from './funding-rate-bound.js';
import type { FundingHistoryRow } from './funding-history.js';

export const FUNDING_PUBLISH_TWO_APPROVALS_REQUIRED = 'trade.funding_publish_two_approvals_required' as const;
export const FUNDING_PUBLISH_APPROVERS_NOT_DISTINCT = 'trade.funding_publish_approvers_not_distinct' as const;

/** Clock-skew allowance on a publisher's `asOfMs`. Anything beyond is refused. */
const FUTURE_SKEW_MS = 60_000;

export interface InternalFundingRateDeps {
  internalSecret: string;
  /** Per-service keys (S2S v3). Unset: the shared secret alone, as before. */
  readonly s2s?: { readonly verifier: ServiceVerifier; readonly mode: ServiceAuthMode };
  publishFundingRate: (entry: FundingRateEntry) => void;
  /**
   * Absolute max |rate| (TRADE_FUTURES_FUNDING_MAX_ABS_RATE).
   * Null = unconfigured → refuse publish (fail-closed; no invented ceiling).
   */
  maxAbsRate: string | null;
  /** Optional clock for asOf default. */
  now?: () => number;
  /**
   * Append-only history. Called once, after a consumed four-eyes approval,
   * and not on a replay of the same market, period and rate.
   */
  recordFundingHistory?: (row: FundingHistoryRow) => void;
  /**
   * Identity approval book. Null refuses: a missing book never allows a publish.
   * Free-text operator names are not an approval.
   */
  approvals: ApprovalBook | null;
  /**
   * Operator audit (`trade.operator_audit`), one row per stored publish carrying both approver ids.
   * Absent in isolated tests only; production wires `writeOperatorAudit`.
   */
  writeAudit?: (row: AuditWrite) => Promise<unknown>;
  /**
   * Isolated tests install retention. Production index already called
   * `retainRawBody` on the same Fastify instance.
   */
  installRawBody?: boolean;
}

/**
 * POST /internal/futures/funding-rate
 * Body: { marketId, rate, periodId?, asOfMs?, approvals: [{ approvalId, operationId }, { approvalId, operationId }] }
 * (each slot carries its approval row and the operationId identity minted for that row, so they can never mispair)
 * Auth: service headers (INTERNAL_SERVICE_SECRET), then TWO consumed four-eyes approvals by two distinct
 * approvers, neither of whom requested either approval (RC-derivatives-01).
 */
function publishKey(marketId: string, periodId: string, rate: string): string {
  return `${marketId}\n${periodId}\n${rate}`;
}

function positiveDecimal(value: string): boolean {
  return /^\d+(\.\d+)?$/.test(value) && /[1-9]/.test(value);
}

export function registerInternalFundingRate(app: FastifyInstance, deps: InternalFundingRateDeps): void {
  if (deps.installRawBody !== false) retainRawBody(app);
  const published = new Map<string, { entry: FundingRateEntry; markPrice: string | null; approverIds: readonly string[] }>();

  app.post<{
    Body: {
      marketId?: string;
      rate?: string;
      periodId?: string;
      asOfMs?: number;
      periodStartIso?: string;
      periodEndIso?: string;
      approvals?: unknown;
      markPrice?: string;
    };
  }>('/internal/futures/funding-rate', async (req, reply) => {
    if (
      verifyServiceRequest(req, {
        verifier: deps.s2s?.verifier,
        mode: deps.s2s?.mode,
        legacySecret: deps.internalSecret,
        bodyBindMode: 'require',
      }).service === null
    ) {
      return reply.code(401).send({ error: 'unauthorized', message: 'service auth required' });
    }

    const marketId = req.body?.marketId?.trim();
    const rate = req.body?.rate?.trim();
    if (!marketId || !rate) {
      return reply.code(400).send({
        error: 'trade.funding_rate_publish_invalid',
        message: 'marketId and rate are required (never invent either)',
      });
    }
    if (!/^-?\d+(\.\d+)?$/.test(rate)) {
      return reply.code(400).send({
        error: 'trade.funding_rate_publish_invalid',
        message: 'rate must be a decimal string',
      });
    }

    // Magnitude bound BEFORE the rate book accepts anything. An absurd rate
    // ("1000000") must never become the published quote a tick settles against.
    // Unset max is refuse, not invent (owner residual D2).
    try {
      assertFundingRateWithinBound(rate, deps.maxAbsRate);
    } catch (err) {
      if (err instanceof FundingRateBoundError) {
        return reply.code(400).send({ error: err.code, message: err.message });
      }
      throw err;
    }

    const nowMs = (deps.now ?? Date.now)();
    const asOfMs = req.body?.asOfMs ?? nowMs;
    if (!Number.isFinite(asOfMs) || asOfMs < 0) {
      return reply.code(400).send({ error: 'trade.funding_rate_publish_invalid', message: 'asOfMs invalid' });
    }
    // A future `asOfMs` is not a harmless oddity. `isRateFresh` requires
    // `now >= asOf`, so one publish stamped past the horizon makes `quote()`
    // return null for that market FOREVER — funding silently stops being
    // collected and the tick only writes skip rows. The same value makes
    // `new Date(asOfMs).toISOString()` throw, which the public
    // `GET /api/v1/funding-rate/:symbol` handler does not catch, so that
    // symbol 500s permanently too. One clock-skew allowance, then refuse.
    if (asOfMs > nowMs + FUTURE_SKEW_MS) {
      return reply.code(400).send({
        error: 'trade.funding_rate_publish_invalid',
        message:
          'asOfMs is in the future — a rate cannot be observed before it exists, and a future stamp silently stops funding for this market',
      });
    }

    // The period must be NAMED by the publisher. It is never derived from the
    // clock, and that is the same "never invent" rule as the rate itself.
    //
    // A funding period is a product fact — a window with a start, a length and
    // an anchor — and its identity is the only thing standing between a trader
    // and repeat settlement: `runFundingTick` skips a period it has already
    // settled, and it does so by id. Deriving that id from `asOfMs` defeated it
    // completely, because `toISOString()` is MILLISECOND resolution. An oracle
    // republishing the same rate every 60s minted a brand-new unsettled period
    // on every publish, so every trader was charged a full period again on
    // every tick. No crash required — that is ordinary polling behaviour.
    //
    // Bucketing the clock to 8h would swap one invention for another: doctrine
    // says funding is every 8h but names no anchor, so the service would be
    // choosing where the boundary falls. Refusing is the honest answer.
    //
    // WHAT THIS DOES NOT DO, stated plainly so the next reader does not see a
    // fixed file: requiring a name BOUNDS NOTHING BY ITSELF. A publisher that
    // sends `periodStartIso: new Date().toISOString()` on every poll gets a
    // fresh period every poll and the original over-charge, and that is the
    // most obvious way an author satisfies a new required field. What the
    // checks below buy is a smaller surface — the id must be a real instant,
    // canonicalised, and scoped to its own market — which takes it from "any
    // string" to "any valid instant". That is a reduction, not a bound.
    //
    // The bound is the ANCHOR: rejecting an instant that is not on the market's
    // funding boundary. That boundary is exactly the product fact this refuses
    // to invent, so it has to arrive as per-market config, not as a constant
    // here. Until it does, this endpoint trusts its publisher on cadence.
    const rawPeriodId = req.body?.periodId?.trim();
    const rawStartIso = req.body?.periodStartIso?.trim();
    if (!rawPeriodId && !rawStartIso) {
      return reply.code(400).send({
        error: 'trade.funding_rate_publish_invalid',
        message:
          'periodId or periodStartIso is required — a funding period is a product fact and is never derived from the clock. ' +
          'A publisher that does not name its period cannot be settled idempotently, and every republish would charge a full period again.',
      });
    }

    let periodId: string;
    if (rawPeriodId) {
      // A supplied id must belong to the market it is published for.
      // `funding_periods` is keyed on `period_id` ALONE, so one id copy-pasted
      // across two markets means the second market's period reads as already
      // settled and its longs and shorts never exchange collateral — no error,
      // no log. `markSettled` also infers `market_id` by slicing to the first
      // colon, so an id without this prefix writes a garbage attribution.
      if (rawPeriodId !== marketId && !rawPeriodId.startsWith(`${marketId}:`)) {
        return reply.code(400).send({
          error: 'trade.funding_rate_publish_invalid',
          message: `periodId must be scoped to its market — expected it to start with "${marketId}:"`,
        });
      }
      periodId = rawPeriodId;
    } else {
      // Canonicalise the instant before it becomes an identity.
      //
      // `periodIdFor` is a bare concat, so `...T22:13:20.000Z`,
      // `...T22:13:20Z` and `...T00:13:20+02:00` are the SAME moment and three
      // different chargeable periods. An oracle that changes its date library —
      // or a second publisher with a different one — double-charges without
      // anyone changing a period.
      const parsed = Date.parse(rawStartIso!);
      if (!Number.isFinite(parsed)) {
        return reply.code(400).send({
          error: 'trade.funding_rate_publish_invalid',
          message: 'periodStartIso must be a valid ISO-8601 instant',
        });
      }
      periodId = periodIdFor(marketId, new Date(parsed).toISOString());
    }

    const rawEndIso = req.body?.periodEndIso?.trim();
    let periodEndIso: string | undefined;
    if (rawEndIso) {
      const parsedEnd = Date.parse(rawEndIso);
      if (!Number.isFinite(parsedEnd)) {
        return reply.code(400).send({
          error: 'trade.funding_rate_publish_invalid',
          message: 'periodEndIso must be a valid ISO-8601 instant',
        });
      }
      periodEndIso = new Date(parsedEnd).toISOString();
    }

    const rawMark = req.body?.markPrice?.trim();
    let markPrice: string | null = null;
    if (rawMark) {
      if (!positiveDecimal(rawMark)) {
        return reply.code(400).send({
          error: 'trade.funding_rate_publish_invalid',
          message: 'markPrice must be a positive decimal string when it is sent — a missing mark stays absent',
        });
      }
      markPrice = rawMark;
    }

    const entry: FundingRateEntry = { marketId, rate, periodId, asOfMs, ...(periodEndIso ? { periodEndIso } : {}) };
    const key = publishKey(marketId, periodId, rate);
    const already = published.get(key);
    if (already) {
      return reply.code(200).send({
        ok: true,
        duplicate: true,
        marketId,
        periodId,
        rate,
        asOfMs: already.entry.asOfMs,
        approverIds: already.approverIds,
        ...(already.entry.periodEndIso ? { periodEndIso: already.entry.periodEndIso } : {}),
      });
    }

    // The service secret authenticates the caller. It is not an approval.
    // RC-derivatives-01: a rate that moves every open perpetual's funding legs needs TWO consumed approvals
    // from the existing identity ApprovalBook, bound to the same payload hash. The single `approvalId` form
    // is gone: a body that only carries it is refused like a body with none. Bound and ceiling checks above
    // already ran, so a refused rate burns no approval.
    const nonBlank = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
    const pairs = (raw: unknown): Array<{ approvalId: string; operationId: string }> | null => {
      if (!Array.isArray(raw) || raw.length !== 2) return null;
      const out: Array<{ approvalId: string; operationId: string }> = [];
      for (const slot of raw) {
        if (typeof slot !== 'object' || slot === null || Array.isArray(slot)) return null;
        const keys = Object.keys(slot);
        if (keys.length !== 2 || !keys.includes('approvalId') || !keys.includes('operationId')) return null;
        const { approvalId, operationId } = slot as { approvalId: unknown; operationId: unknown };
        if (!nonBlank(approvalId) || !nonBlank(operationId)) return null;
        out.push({ approvalId: approvalId.trim(), operationId: operationId.trim() });
      }
      return out;
    };
    const approvals = pairs(req.body?.approvals);
    if (deps.approvals === null || approvals === null) {
      return reply.code(403).send({
        error: FUNDING_PUBLISH_TWO_APPROVALS_REQUIRED,
        message:
          'a service secret is not an approval — funding rate publish needs exactly two four-eyes approvals, each as { approvalId, operationId } with the operationId identity minted for it',
      });
    }
    const approvalIds = approvals.map((a) => a.approvalId);
    if (approvalIds[0] === approvalIds[1] || approvals[0]!.operationId === approvals[1]!.operationId) {
      return reply.code(403).send({
        error: FUNDING_PUBLISH_APPROVERS_NOT_DISTINCT,
        message: 'the two approvals must be two different approval rows with two different operationIds — nothing was consumed',
      });
    }
    const consumeInput = {
      actionType: 'trade.funding_rate.publish',
      targetId: marketId,
      expectedVersion: periodId,
      payloadHash: payloadHash({
        actionType: 'trade.funding_rate.publish',
        marketId,
        periodId,
        rate,
        markPrice,
      }),
    };
    // Fails closed: both are consumed before any write, and any refused consume returns 403 with nothing
    // stored. A consume that succeeded stays consumed (single use) even when the other fails; the operators
    // request again and the rate is never half stored.
    // The approver of a row is only known once identity consumes it, so the distinct-approver check below
    // runs after both consumes: a refused pair leaves BOTH approvals spent, and the operators request again.
    const consumed: Array<{ approverId: string; requesterId: string }> = [];
    for (const { approvalId, operationId } of approvals) {
      const result = await deps.approvals.consume({ ...consumeInput, approvalId, operationId });
      if (!result.ok) {
        return reply.code(403).send({
          error: 'trade.funding_rate_publish_invalid',
          approvalCode: result.code,
          message: 'an approval is missing, reused, or does not match this market, period, rate and mark — nothing was stored',
        });
      }
      consumed.push({ approverId: result.approverId, requesterId: result.requesterId });
    }
    const norm = (id: string) => id.trim().toLowerCase();
    const approvers = consumed.map((c) => norm(c.approverId));
    const requesters = new Set(consumed.map((c) => norm(c.requesterId)));
    if (approvers[0] === approvers[1] || approvers.some((a) => requesters.has(a))) {
      return reply.code(403).send({
        error: FUNDING_PUBLISH_APPROVERS_NOT_DISTINCT,
        message:
          'the two approvers must differ from each other and from both requesters — the approvals stay consumed and nothing was stored',
      });
    }
    const approverIds = consumed.map((c) => c.approverId);

    // The audit row is written first: a publish that cannot be audited is not stored.
    await deps.writeAudit?.({
      id: `funding.publish:${marketId}:${periodId}:${rate}`,
      kind: 'futures.funding_rate.publish',
      operatorId: consumed[0]!.requesterId,
      accountId: null,
      objectId: periodId,
      approverId: approverIds.join(','),
      reason: null,
      detail: { marketId, periodId, rate, markPrice, approvals, approverIds, requesterIds: consumed.map((c) => c.requesterId) },
    });
    published.set(key, { entry, markPrice, approverIds });
    deps.publishFundingRate(entry);
    deps.recordFundingHistory?.({
      marketId,
      periodId,
      periodTimestamp: asOfMs,
      fundingRate: rate,
      markPrice,
      approverIds,
    });
    return reply.code(200).send({ ok: true, marketId, periodId, rate, asOfMs, approverIds, ...(periodEndIso ? { periodEndIso } : {}) });
  });
}
