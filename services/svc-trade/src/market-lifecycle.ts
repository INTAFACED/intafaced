import { createHash } from 'node:crypto';
import { LOCAL_TEST_MARKER_PREFIX, hasLocalTestMarker, isExplicitDevOrTest } from '@intafaced/config';
import type { Sql } from 'postgres';
import { z } from 'zod';
import {
  decideMarketAdmission,
  marketAdmissionDossierSchema,
  marketStateSnapshotSchema,
  marketTransitionRecordSchema,
  correctionLinkSchema,
  type AdmissionReadiness,
  type AuthorityEvidence,
  type MarketAction,
  type MarketAdmissionDossier,
  type MarketAdmissionDecision,
  type MarketLifecycleState,
  type MarketStateSnapshot,
  type MarketTransitionRecord,
  type CorrectionLink,
} from '@intafaced/exchange-contract';
import { authorityEvidenceSchema } from '@intafaced/exchange-contract';
import { isScheduleKey, isScheduleOpen, TRADING_SCHEDULES } from '@intafaced/contracts';
import type { Market } from './spot/types.js';
import type { MatchingClient, MatchingUnavailableError } from './spot/matching-client.js';

/** Technical publication clock policy; owner/legal evidence remains external. */
export const MARKET_LIFECYCLE_CLOCK_SKEW_MS = 5 * 60_000;

/**
 * PX-S01 authority boundary for svc-trade.
 *
 * This module deliberately owns no market rows, balances, or matching book.
 * It only turns the market row plus published authority/readiness evidence into
 * one immutable snapshot. A missing input is a named refusal, never a default
 * OPEN. The port is optional at the service boundary while the upstream
 * authority publisher is being deployed; callers that install it get the
 * refuse-closed gate on both projection and order admission.
 */

export const MARKET_LIFECYCLE_REASON = {
  AUTHORITY_UNAVAILABLE: 'trade.lifecycle_authority_unavailable',
  DOSSIER_REQUIRED: 'trade.lifecycle_dossier_required',
  DOSSIER_INVALID: 'trade.lifecycle_dossier_invalid',
  READINESS_SOCKET: 'trade.lifecycle_readiness_socket',
  UNKNOWN_SCHEDULE: 'trade.unknown_schedule',
  MARKET_CLOSED: 'trade.market_closed',
  MARKET_HALTED: 'trade.market_halted',
  MARKET_SUSPENDED: 'trade.market_suspended',
  TRANSITION_PARTIAL: 'trade.lifecycle_transition_partial',
  TRANSITION_UNKNOWN: 'trade.lifecycle_transition_unknown',
  RECOVERY_REQUIRED: 'trade.lifecycle_recovery_required',
} as const;

export type MarketLifecycleReason = (typeof MARKET_LIFECYCLE_REASON)[keyof typeof MARKET_LIFECYCLE_REASON];

export interface MarketLifecycleReadiness {
  /** The same schedule authority used by risk.assertMarketOpen. */
  readonly schedule: AdmissionReadiness;
  /** Risk/limits readiness; a socket keeps the market closed to new risk. */
  readonly risk: AdmissionReadiness;
  /** Matching transport/writer readiness; a socket keeps PLACE closed. */
  readonly matching: AdmissionReadiness;
}

export interface MarketLifecycleEvidence {
  readonly dossier?: MarketAdmissionDossier | null;
  readonly authority?: AuthorityEvidence | null;
  readonly readiness?: Partial<MarketLifecycleReadiness> | null;
  /** An unresolved transition never becomes OPEN by accident. */
  readonly transition?: MarketTransitionRecord | null;
}

export interface MarketLifecycleSnapshotOptions {
  readonly now?: string;
  readonly effectiveAt?: string;
  readonly evidence?: MarketLifecycleEvidence;
}

export interface MarketLifecyclePort {
  snapshot(market: Market, options?: MarketLifecycleSnapshotOptions): MarketStateSnapshot | Promise<MarketStateSnapshot>;
  admit(snapshot: MarketStateSnapshot, action: MarketAction): MarketActionDecision;
}

export interface MarketActionDecision {
  readonly decision: 'ELIGIBLE' | 'REFUSED';
  readonly action: MarketAction;
  readonly state: MarketLifecycleState;
  readonly checkedAt: string;
  readonly reasonCode: string | null;
  readonly evidenceRefs: readonly string[];
  readonly recovery: boolean;
}

const allReady = (readiness: AdmissionReadiness | undefined): boolean => readiness?.status === 'READY';

function stableId(namespace: string, value: string): string {
  return `${namespace}:${createHash('sha256').update(value).digest('hex').slice(0, 32)}`;
}

export function lifecycleTransitionId(marketId: string, expectedState: string, requestedState: string, idempotencyKey: string): string {
  return stableId('trade.lifecycle.transition', `${marketId}|${expectedState}|${requestedState}|${idempotencyKey}`);
}

export function lifecycleReconciliationKey(marketId: string, transitionId: string): string {
  return stableId('trade.lifecycle.reconcile', `${marketId}|${transitionId}`);
}

/**
 * The only externally publishable lifecycle input.  The wrapper is important:
 * authority and dossier schemas describe their contents, while this schema
 * binds them to the market, versions, causality, and an operator retry key.
 */
export const marketLifecyclePublicationSchema = z
  .object({
    marketId: z.string().trim().min(1),
    idempotencyKey: z.string().trim().min(1),
    causalPredecessorId: z.string().trim().min(1).nullable(),
    authoritySubject: z.string().trim().min(1),
    authorityScope: z.string().trim().min(1),
    ruleVersion: z.string().trim().min(1),
    instrumentVersion: z.string().trim().min(1),
    observedAt: z.string().datetime({ offset: true }),
    effectiveAt: z.string().datetime({ offset: true }),
    expiresAt: z.string().datetime({ offset: true }),
    authority: authorityEvidenceSchema,
    dossier: marketAdmissionDossierSchema,
  })
  .superRefine((publication, context) => {
    if (publication.marketId !== publication.dossier.marketId)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['dossier', 'marketId'],
        message: 'dossier marketId must equal publication marketId',
      });
    if (publication.ruleVersion !== publication.dossier.ruleVersion)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['dossier', 'ruleVersion'],
        message: 'dossier ruleVersion must equal publication ruleVersion',
      });
    if (publication.instrumentVersion !== publication.dossier.instrumentVersion)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['dossier', 'instrumentVersion'],
        message: 'dossier instrumentVersion must equal publication instrumentVersion',
      });
    if (publication.authoritySubject !== publication.authority.actorId)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['authoritySubject'],
        message: 'authoritySubject must equal authority actorId',
      });
    if (!publication.authorityScope.startsWith(`market:${publication.marketId}:`))
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['authorityScope'], message: 'authorityScope must be market-bound' });
    const observed = Date.parse(publication.observedAt);
    const effective = Date.parse(publication.effectiveAt);
    const expires = Date.parse(publication.expiresAt);
    const approved = Date.parse(publication.dossier.approvedAt);
    const decided = Date.parse(publication.authority.decidedAt);
    const freshness = Date.parse(publication.authority.freshnessAt);
    if (effective > observed)
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['effectiveAt'], message: 'effectiveAt cannot follow observedAt' });
    if (expires < observed)
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['expiresAt'], message: 'expiresAt cannot precede observedAt' });
    if (approved > observed)
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['dossier', 'approvedAt'], message: 'approvedAt cannot follow observedAt' });
    if (decided > observed)
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['authority', 'decidedAt'], message: 'decidedAt cannot follow observedAt' });
    if (freshness > observed)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['authority', 'freshnessAt'],
        message: 'freshnessAt cannot follow observedAt',
      });
  });
export type MarketLifecyclePublication = z.infer<typeof marketLifecyclePublicationSchema>;

export class MarketLifecyclePublicationConflict extends Error {
  readonly code = 'trade.lifecycle_publication_conflict';
  constructor(message = 'lifecycle publication idempotency identity conflicts with an existing publication') {
    super(message);
    this.name = 'MarketLifecyclePublicationConflict';
  }
}

export class MarketLifecyclePublicationChainError extends Error {
  readonly code = 'trade.lifecycle_publication_chain_conflict';
  constructor(message: string) {
    super(message);
    this.name = 'MarketLifecyclePublicationChainError';
  }
}

/**
 * LOCAL-TEST STAND-INS (Nitro-approved 2026-10-13, local only).
 *
 * The local test stack publishes lifecycle records whose `authority.actorId`,
 * `authority.grantId` or `dossier.dossierId` start with `local-test:`. Such a
 * record is a stand-in for a real authority decision. It may exist only when
 * `APP_ENV` is exactly `dev` or `test`; an unset or empty `APP_ENV` counts as
 * NOT dev (the raw value is read, never the schema's `dev` default).
 *
 *   publish  outside dev/test -> 409 `trade.lifecycle_local_test_fixture_refused`, nothing written
 *   read     outside dev/test -> treated as no authority (AUTHORITY_UNAVAILABLE, orders refused)
 *   boot     outside dev/test -> `assertNoLocalTestLifecycleRows` throws if a marked row exists
 */
export class MarketLifecycleLocalTestFixtureError extends Error {
  readonly code = 'trade.lifecycle_local_test_fixture_refused';
  constructor(readonly fields: readonly string[]) {
    super(
      `lifecycle publication carries a ${LOCAL_TEST_MARKER_PREFIX} marker (${fields.join(', ')}) and APP_ENV is not explicitly dev or test`,
    );
    this.name = 'MarketLifecycleLocalTestFixtureError';
  }
}

/** The publication fields that carry a `local-test:` marker. Empty means the record is not a stand-in. */
export function lifecycleLocalTestMarkerFields(publication: MarketLifecyclePublication): string[] {
  const fields: string[] = [];
  if (hasLocalTestMarker(publication.authority.actorId)) fields.push('authority.actorId');
  if (hasLocalTestMarker(publication.authority.grantId)) fields.push('authority.grantId');
  if (hasLocalTestMarker(publication.dossier.dossierId)) fields.push('dossier.dossierId');
  return fields;
}

type LifecycleEnv = Record<string, string | undefined>;

/** True when this publication must be refused under `env` (marked AND not explicit dev/test). */
function isRefusedLocalTestPublication(publication: MarketLifecyclePublication, env: LifecycleEnv): boolean {
  return !isExplicitDevOrTest(env.APP_ENV) && lifecycleLocalTestMarkerFields(publication).length > 0;
}

/**
 * Boot guard for svc-trade. Outside explicit dev/test, throws if any stored
 * lifecycle publication carries a `local-test:` marker, so a database restored
 * from a local run cannot quietly authorise orders. Mirrors the schema-missing
 * check in index.ts: a top-level throw before `app.listen`, so the process
 * crashes and never becomes ready.
 */
export async function assertNoLocalTestLifecycleRows(sql: Sql, env: LifecycleEnv = process.env): Promise<void> {
  if (isExplicitDevOrTest(env.APP_ENV)) return;
  const pattern = `${LOCAL_TEST_MARKER_PREFIX}%`;
  const rows = await sql<Array<{ evidence_id: string }>>`
    SELECT evidence_id FROM trade.market_lifecycle_evidence
    WHERE evidence_kind = 'AUTHORITY_DOSSIER'
      AND (   lower(btrim(publication #>> '{authority,actorId}')) LIKE ${pattern}
           OR lower(btrim(publication #>> '{authority,grantId}')) LIKE ${pattern}
           OR lower(btrim(publication #>> '{dossier,dossierId}')) LIKE ${pattern})
    LIMIT 5
  `;
  if (rows.length > 0) {
    throw new Error(
      `svc-trade refuses to start: ${rows.length}+ stored market-lifecycle publication(s) carry a ${LOCAL_TEST_MARKER_PREFIX} marker ` +
        `(e.g. ${rows[0]?.evidence_id}) and APP_ENV is not explicitly dev or test. Remove the local-test rows or restore a clean database.`,
    );
  }
}

function assertPublicationNotFuture(publication: MarketLifecyclePublication, now = Date.now()): void {
  if (Date.parse(publication.observedAt) > now + MARKET_LIFECYCLE_CLOCK_SKEW_MS)
    throw new MarketLifecyclePublicationChainError('observedAt exceeds the publication clock-skew policy');
}

export function lifecyclePublicationId(marketId: string, idempotencyKey: string): string {
  return stableId('trade.lifecycle.publication', `${marketId}|${idempotencyKey}`);
}

function clockNow(value?: string): string {
  return value ?? new Date().toISOString();
}

function evidenceId(market: Market, suffix: string): string {
  return stableId('trade.lifecycle.evidence', `${market.id}|${suffix}`);
}

function scheduleReadiness(market: Market, at: string): AdmissionReadiness {
  if (!isScheduleKey(market.schedule)) {
    return {
      status: 'SOCKET',
      socketId: evidenceId(market, 'schedule'),
      reasonCode: MARKET_LIFECYCLE_REASON.UNKNOWN_SCHEDULE,
      evidenceRefs: [],
    };
  }
  const schedule = TRADING_SCHEDULES[market.schedule];
  if (!schedule) {
    return {
      status: 'SOCKET',
      socketId: evidenceId(market, 'schedule'),
      reasonCode: MARKET_LIFECYCLE_REASON.UNKNOWN_SCHEDULE,
      evidenceRefs: [],
    };
  }
  if (!isScheduleOpen(schedule, new Date(at))) {
    return {
      status: 'SOCKET',
      socketId: evidenceId(market, 'session'),
      reasonCode: MARKET_LIFECYCLE_REASON.MARKET_CLOSED,
      evidenceRefs: [],
    };
  }
  return { status: 'READY', evidenceRefs: [evidenceId(market, `schedule:${market.schedule}`)] };
}

function listingLifecycleState(market: Market): MarketLifecycleState | null {
  if (market.status === 'halted') return 'HALTED';
  if (market.status === 'delisted') return 'DELISTING';
  if (market.status === 'pending') return 'PRELAUNCH';
  return null;
}

function allowedActions(state: MarketLifecycleState, safeRecovery = false): MarketAction[] {
  if (safeRecovery || state === 'HALTED' || state === 'REDUCE_ONLY' || state === 'EXPIRING' || state === 'DELISTING') {
    return ['CANCEL', 'REDUCE', 'CLOSE'];
  }
  if (state === 'CANCEL_ONLY') return ['CANCEL'];
  if (state === 'POST_ONLY') return ['PLACE_POST_ONLY', 'AMEND', 'CANCEL', 'REDUCE', 'CLOSE', 'QUOTE'];
  if (state === 'OPEN') return ['PLACE', 'PLACE_POST_ONLY', 'AMEND', 'CANCEL', 'REDUCE', 'CLOSE', 'TRIGGER', 'QUOTE', 'RFQ'];
  return [];
}

function refusalState(
  market: Market,
  reasonCode: string,
  now: string,
  lastGoodState: MarketLifecycleState | null,
  evidenceRefs: readonly string[],
  transitionId: string,
  safeRecovery = false,
): MarketStateSnapshot {
  const state = safeRecovery && lastGoodState !== null ? lastGoodState : 'REFUSED';
  return marketStateSnapshotSchema.parse({
    marketId: market.id,
    ruleVersion: stableId('trade.lifecycle.rules', market.id),
    instrumentId: market.id,
    instrumentVersion: stableId('trade.lifecycle.instrument', market.id),
    state,
    reasonCategory: reasonCode.includes('closed') ? 'NORMAL' : 'TECHNICAL',
    reasonCode,
    effectiveAt: now,
    observedAt: now,
    lastGoodState,
    allowedActions: allowedActions(state, safeRecovery),
    transitionId,
    evidenceRefs: evidenceRefs.length > 0 ? [...evidenceRefs] : [evidenceId(market, 'refusal')],
  });
}

/** Pure mapping of existing schedule/status/risk facts into PX-S01. */
export function deriveMarketLifecycleSnapshot(market: Market, options: MarketLifecycleSnapshotOptions = {}): MarketStateSnapshot {
  const now = clockNow(options.now);
  const effectiveAt = options.effectiveAt ?? now;
  const evidence = options.evidence ?? {};
  const transition = evidence.transition ?? null;
  const transitionId = transition?.transitionId ?? stableId('trade.lifecycle.snapshot', `${market.id}|${now}`);
  const lastGoodState = transition?.expectedState ?? null;

  let applied: MarketTransitionRecord | null = null;
  if (transition !== null) {
    const parsed = marketTransitionRecordSchema.safeParse(transition);
    if (!parsed.success)
      return refusalState(
        market,
        MARKET_LIFECYCLE_REASON.RECOVERY_REQUIRED,
        now,
        lastGoodState,
        [evidenceId(market, 'transition-invalid')],
        transitionId,
      );
    if (parsed.data.outcome.outcome === 'PARTIAL' || parsed.data.outcome.outcome === 'OUTCOME_UNKNOWN') {
      return refusalState(
        market,
        parsed.data.outcome.outcome === 'PARTIAL' ? MARKET_LIFECYCLE_REASON.TRANSITION_PARTIAL : MARKET_LIFECYCLE_REASON.TRANSITION_UNKNOWN,
        now,
        parsed.data.expectedState,
        [...parsed.data.outcome.unresolvedTargets, ...parsed.data.recoveryEvidenceRefs],
        parsed.data.transitionId,
        true,
      );
    }
    if (parsed.data.outcome.outcome === 'APPLIED' || parsed.data.outcome.outcome === 'REFUSED') applied = parsed.data;
  }

  const authority = evidence.authority;
  if (authority == null || authority.decision !== 'AUTHORIZED') {
    return refusalState(
      market,
      authority?.reasonCode === 'trade.lifecycle_authority_stale' ? authority.reasonCode : MARKET_LIFECYCLE_REASON.AUTHORITY_UNAVAILABLE,
      now,
      lastGoodState,
      [evidenceId(market, 'authority')],
      transitionId,
    );
  }

  const dossier = evidence.dossier;
  if (dossier == null)
    return refusalState(
      market,
      MARKET_LIFECYCLE_REASON.DOSSIER_REQUIRED,
      now,
      lastGoodState,
      [evidenceId(market, 'dossier')],
      transitionId,
    );
  const parsedDossier = marketAdmissionDossierSchema.safeParse(dossier);
  if (!parsedDossier.success)
    return refusalState(
      market,
      MARKET_LIFECYCLE_REASON.DOSSIER_INVALID,
      now,
      lastGoodState,
      [evidenceId(market, 'dossier-invalid')],
      transitionId,
    );
  const admission = decideMarketAdmission(parsedDossier.data, now);
  if (admission.decision === 'REFUSED') {
    return refusalState(market, MARKET_LIFECYCLE_REASON.READINESS_SOCKET, now, lastGoodState, admission.blockingSockets, transitionId);
  }

  const readiness = evidence.readiness ?? {};
  // Schedule is canonical service fact, never externally asserted readiness.
  // A publisher cannot turn an unknown key or closed session into READY.
  const schedule = scheduleReadiness(market, now);
  const risk =
    readiness.risk ??
    ({
      status: 'SOCKET',
      socketId: evidenceId(market, 'risk'),
      reasonCode: MARKET_LIFECYCLE_REASON.READINESS_SOCKET,
      evidenceRefs: [],
    } as const);
  const matching =
    readiness.matching ??
    ({
      status: 'SOCKET',
      socketId: evidenceId(market, 'matching'),
      reasonCode: MARKET_LIFECYCLE_REASON.READINESS_SOCKET,
      evidenceRefs: [],
    } as const);
  const sockets = [schedule, risk, matching].flatMap((item) => (item?.status === 'SOCKET' ? [item.socketId] : []));
  if (sockets.length === 1 && schedule.status === 'SOCKET' && schedule.reasonCode !== MARKET_LIFECYCLE_REASON.READINESS_SOCKET) {
    return refusalState(market, schedule.reasonCode, now, lastGoodState, schedule.evidenceRefs, transitionId);
  }
  const specificSocket = [risk, matching].find((item) => item?.status === 'SOCKET' && item.reasonCode.startsWith('trade.'));
  if (specificSocket?.status === 'SOCKET') {
    return refusalState(market, specificSocket.reasonCode, now, lastGoodState, specificSocket.evidenceRefs, transitionId);
  }
  if (sockets.length > 0 || !allReady(schedule) || !allReady(risk) || !allReady(matching)) {
    return refusalState(market, MARKET_LIFECYCLE_REASON.READINESS_SOCKET, now, lastGoodState, sockets, transitionId);
  }

  // Listing status only names halt, delist, and prelaunch. An applied (or
  // refused) transition's resolvedState is the stored name — post-only,
  // cancel-only, and the rest. Collapsing every active listing to OPEN is
  // what dropped that name on the public row. A listing halt still wins over
  // a stored OPEN so a halted book is not published as open.
  const listing = listingLifecycleState(market);
  const stored = applied?.resolvedState ?? null;
  const useStored = stored !== null && stored !== 'OPEN';
  const state: MarketLifecycleState = useStored ? stored : (listing ?? stored ?? 'OPEN');
  const reasonCategory = useStored && applied ? applied.reasonCategory : state === 'OPEN' ? 'NORMAL' : 'OPERATOR';
  const reasonCode =
    useStored && applied ? applied.reasonCode : state === 'OPEN' ? 'trade.lifecycle.ready' : `trade.market_${market.status}`;
  const publishedLastGood = useStored && applied ? applied.expectedState : state === 'OPEN' ? 'OPEN' : null;

  return marketStateSnapshotSchema.parse({
    marketId: market.id,
    ruleVersion: parsedDossier.data.ruleVersion,
    instrumentId: market.id,
    instrumentVersion: parsedDossier.data.instrumentVersion,
    state,
    reasonCategory,
    reasonCode,
    effectiveAt,
    observedAt: now,
    lastGoodState: publishedLastGood,
    allowedActions: allowedActions(state),
    transitionId,
    evidenceRefs: [
      ...parsedDossier.data.approvalRefs,
      ...schedule.evidenceRefs,
      ...(risk?.evidenceRefs ?? []),
      ...(matching?.evidenceRefs ?? []),
      ...(authority.decision === 'AUTHORIZED' ? [authority.grantId] : []),
    ],
  });
}

export function decideMarketAction(
  snapshot: MarketStateSnapshot,
  action: MarketAction,
  checkedAt = snapshot.observedAt,
): MarketActionDecision {
  const parsed = marketStateSnapshotSchema.parse(snapshot);
  const eligible = parsed.allowedActions.includes(action);
  return {
    decision: eligible ? 'ELIGIBLE' : 'REFUSED',
    action,
    state: parsed.state,
    checkedAt,
    reasonCode: eligible ? null : parsed.reasonCode,
    evidenceRefs: parsed.evidenceRefs,
    recovery: parsed.state !== 'OPEN' && parsed.state !== 'POST_ONLY',
  };
}

export class MarketLifecycleAuthority implements MarketLifecyclePort {
  constructor(private readonly evidenceFor: (market: Market) => MarketLifecycleEvidence | null | undefined) {}

  snapshot(market: Market, options: MarketLifecycleSnapshotOptions = {}): MarketStateSnapshot {
    return deriveMarketLifecycleSnapshot(market, { ...options, evidence: options.evidence ?? this.evidenceFor(market) ?? undefined });
  }

  admit(snapshot: MarketStateSnapshot, action: MarketAction): MarketActionDecision {
    return decideMarketAction(snapshot, action);
  }
}

/** SQL-backed authority used by every projection and fresh-order gate. */
export class SqlMarketLifecycleAuthority implements MarketLifecyclePort {
  constructor(
    private readonly sql: Sql,
    private readonly matching: MatchingClient,
    private readonly options: { readonly spotEnabled: boolean; readonly futuresEnabled: boolean; readonly env?: LifecycleEnv },
  ) {}

  async snapshot(market: Market, options: MarketLifecycleSnapshotOptions = {}): Promise<MarketStateSnapshot> {
    const now = clockNow(options.now);
    const publication = await this.readLatest(market.id, Date.parse(now));
    if (!publication) return deriveMarketLifecycleSnapshot(market, { ...options, now, evidence: { transition: null } });

    const readiness: {
      schedule?: AdmissionReadiness;
      risk?: AdmissionReadiness;
      matching?: AdmissionReadiness;
    } = {};
    const productEnabled = market.kind === 'futures' ? this.options.futuresEnabled : this.options.spotEnabled;
    const status = String(market.status);
    const knownStatus = new Set(['pending', 'active', 'halted', 'delisted']).has(status);
    if (!knownStatus) {
      readiness.risk = {
        status: 'SOCKET',
        socketId: evidenceId(market, 'status-unknown'),
        reasonCode: 'trade.market_status_unknown',
        evidenceRefs: [evidenceId(market, 'status-unknown')],
      };
    } else if (!productEnabled) {
      readiness.risk = {
        status: 'SOCKET',
        socketId: evidenceId(market, 'product-kill-switch'),
        reasonCode: 'trade.product_disabled',
        evidenceRefs: [evidenceId(market, 'product-kill-switch')],
      };
    } else {
      readiness.risk = { status: 'READY', evidenceRefs: [evidenceId(market, 'status-risk')] };
    }
    try {
      const memberships = await this.matching.listMarkets();
      readiness.matching = memberships.markets.includes(market.id)
        ? { status: 'READY', evidenceRefs: [evidenceId(market, 'matching-membership')] }
        : {
            status: 'SOCKET',
            socketId: evidenceId(market, 'matching-missing'),
            reasonCode: 'trade.matching_market_missing',
            evidenceRefs: [evidenceId(market, 'matching-membership')],
          };
    } catch (error) {
      readiness.matching = {
        status: 'SOCKET',
        socketId: evidenceId(market, 'matching-unreachable'),
        reasonCode: (error as MatchingUnavailableError).code ?? 'trade.matching_unavailable',
        evidenceRefs: [],
      };
    }

    const authority = publication.authority;
    const publicationRef = lifecyclePublicationId(publication.marketId, publication.idempotencyKey);
    const dossier = {
      ...publication.dossier,
      approvalRefs: [
        ...publication.dossier.approvalRefs,
        publicationRef,
        ...(publication.causalPredecessorId ? [publication.causalPredecessorId] : []),
      ],
    };
    if (publication.marketId !== market.id || dossier.marketId !== market.id) {
      const refusedAuthority = authorityEvidenceSchema.parse({
        ...authority,
        decision: 'REFUSED',
        reasonCode: 'trade.lifecycle_wrong_market',
      });
      return deriveMarketLifecycleSnapshot(market, {
        ...options,
        now,
        effectiveAt: options.effectiveAt ?? publication.effectiveAt,
        evidence: {
          authority: refusedAuthority,
          dossier,
          readiness,
        },
      });
    }
    if (publication.ruleVersion !== dossier.ruleVersion || publication.instrumentVersion !== dossier.instrumentVersion) {
      return refusalState(
        market,
        MARKET_LIFECYCLE_REASON.DOSSIER_INVALID,
        now,
        null,
        [publicationRef, ...(publication.causalPredecessorId ? [publication.causalPredecessorId] : [])],
        publicationRef,
      );
    }
    const storedTransition = await this.readLatestTransition(market.id);
    return deriveMarketLifecycleSnapshot(market, {
      ...options,
      now,
      effectiveAt: options.effectiveAt ?? publication.effectiveAt,
      evidence: { authority, dossier, readiness, transition: (storedTransition ?? null) as MarketTransitionRecord | null },
    });
  }

  private async readLatestTransition(marketId: string): Promise<unknown | null> {
    const [row] = await this.sql<Array<{ transition: unknown }>>`
      SELECT transition FROM trade.market_lifecycle_evidence
      WHERE market_id = ${marketId} AND evidence_kind = 'TRANSITION'
      ORDER BY observed_at DESC
      LIMIT 1
    `;
    return row?.transition ?? null;
  }

  admit(snapshot: MarketStateSnapshot, action: MarketAction): MarketActionDecision {
    return decideMarketAction(snapshot, action);
  }

  async readLatest(marketId: string, now = Date.now()): Promise<MarketLifecyclePublication | null> {
    const [row] = await this.sql<Array<{ publication: unknown }>>`
      SELECT publication FROM trade.market_lifecycle_evidence
      WHERE market_id = ${marketId} AND evidence_kind = 'AUTHORITY_DOSSIER'
      ORDER BY created_at DESC LIMIT 1
    `;
    if (!row) return null;
    const parsed = marketLifecyclePublicationSchema.safeParse(row.publication);
    if (!parsed.success) return null;
    // A local-test stand-in outside explicit dev/test is no authority at all:
    // the caller derives AUTHORITY_UNAVAILABLE and the order is refused.
    if (isRefusedLocalTestPublication(parsed.data, this.options.env ?? process.env)) return null;
    if (parsed.data.authority.decision === 'AUTHORIZED' && now > Date.parse(parsed.data.expiresAt)) {
      const stale = authorityEvidenceSchema.parse({
        ...parsed.data.authority,
        decision: 'STALE',
        reasonCode: 'trade.lifecycle_authority_stale',
      });
      return { ...parsed.data, authority: stale };
    }
    return parsed.data;
  }
}

/** Immutable local evidence log for transition/correction reconciliation. */
export class AppendOnlyMarketLifecycleLog {
  private readonly records: MarketTransitionRecord[] = [];
  private readonly corrections: CorrectionLink[] = [];

  append(record: MarketTransitionRecord): MarketTransitionRecord {
    const parsed = marketTransitionRecordSchema.parse(record);
    const existing = this.records.find((item) => item.transitionId === parsed.transitionId);
    if (existing) return existing;
    this.records.push(parsed);
    return parsed;
  }

  list(marketId?: string): readonly MarketTransitionRecord[] {
    return this.records.filter((record) => marketId === undefined || record.marketId === marketId);
  }

  appendCorrection(correction: CorrectionLink): CorrectionLink {
    const parsed = correctionLinkSchema.parse(correction);
    const existing = this.corrections.find((item) => item.correctionId === parsed.correctionId);
    if (existing) return existing;
    this.corrections.push(parsed);
    return parsed;
  }

  listCorrections(): readonly CorrectionLink[] {
    return this.corrections;
  }
}

/** Durable append-only adapter used by the service process when SQL is available. */
export class SqlMarketLifecycleEvidenceStore {
  constructor(
    private readonly sql: Sql,
    private readonly options: { readonly env?: LifecycleEnv } = {},
  ) {}

  async readLatest(marketId: string): Promise<MarketLifecyclePublication | null> {
    const [row] = await this.sql<Array<{ publication: unknown }>>`
      SELECT publication FROM trade.market_lifecycle_evidence
      WHERE market_id = ${marketId} AND evidence_kind = 'AUTHORITY_DOSSIER'
      ORDER BY created_at DESC LIMIT 1
    `;
    if (!row) return null;
    const parsed = marketLifecyclePublicationSchema.safeParse(row.publication);
    if (!parsed.success) return null;
    return isRefusedLocalTestPublication(parsed.data, this.options.env ?? process.env) ? null : parsed.data;
  }

  async publish(publication: MarketLifecyclePublication): Promise<MarketLifecyclePublication> {
    const parsed = marketLifecyclePublicationSchema.parse(publication);
    // Before any SQL: a refused stand-in must leave nothing behind.
    if (isRefusedLocalTestPublication(parsed, this.options.env ?? process.env)) {
      throw new MarketLifecycleLocalTestFixtureError(lifecycleLocalTestMarkerFields(parsed));
    }
    assertPublicationNotFuture(parsed);
    const evidenceId = lifecyclePublicationId(parsed.marketId, parsed.idempotencyKey);
    // `::text::jsonb`, not `::jsonb`: postgres.js serialises a string bound to a jsonb parameter as a JSON
    // string, so the row would store the text of the object instead of the object. Read-back then failed
    // the schema and every publish answered `trade.lifecycle_publication_conflict`. The fakes in the tests
    // never saw it; the real driver does.
    const payload = JSON.stringify(parsed);
    const [existing] = await this.sql<Array<{ publication: unknown }>>`
      SELECT publication FROM trade.market_lifecycle_evidence WHERE evidence_id = ${evidenceId} LIMIT 1
    `;
    if (existing) {
      const prior = marketLifecyclePublicationSchema.safeParse(existing.publication);
      if (!prior.success || JSON.stringify(prior.data) !== JSON.stringify(parsed)) throw new MarketLifecyclePublicationConflict();
      return prior.data;
    }
    const [latest] = await this.sql<Array<{ evidence_id: string; publication: unknown }>>`
      SELECT evidence_id, publication FROM trade.market_lifecycle_evidence
      WHERE market_id = ${parsed.marketId} AND evidence_kind = 'AUTHORITY_DOSSIER'
      ORDER BY created_at DESC LIMIT 1
    `;
    const expectedPredecessor = latest?.evidence_id ?? null;
    if (parsed.causalPredecessorId !== expectedPredecessor) {
      throw new MarketLifecyclePublicationChainError(
        expectedPredecessor === null
          ? 'first lifecycle publication must have a null predecessor'
          : 'publication predecessor must equal the current latest publication',
      );
    }
    if (latest) {
      const prior = marketLifecyclePublicationSchema.safeParse(latest.publication);
      if (!prior.success) throw new MarketLifecyclePublicationChainError('current lifecycle head is invalid');
      if (
        Date.parse(parsed.observedAt) < Date.parse(prior.data.observedAt) ||
        Date.parse(parsed.effectiveAt) < Date.parse(prior.data.effectiveAt)
      ) {
        throw new MarketLifecyclePublicationChainError('publication timestamps regress before the current lifecycle head');
      }
    }
    try {
      await this.sql`
        INSERT INTO trade.market_lifecycle_evidence
          (evidence_id, market_id, evidence_kind, publication, causal_predecessor_id, reconciliation_key, observed_at)
        VALUES (${evidenceId}, ${parsed.marketId}, 'AUTHORITY_DOSSIER', ${payload}::text::jsonb,
          ${parsed.causalPredecessorId}, ${evidenceId}, ${parsed.observedAt}::timestamptz)
        ON CONFLICT (evidence_id) DO NOTHING
      `;
    } catch (error) {
      // The partial unique chain indexes make this atomic across replicas. A
      // concurrent child is a deterministic fork refusal, never an overwrite.
      if ((error as { code?: string }).code === '23505') {
        throw new MarketLifecyclePublicationChainError('publication predecessor was concurrently claimed');
      }
      throw error;
    }
    const [stored] = await this.sql<Array<{ publication: unknown }>>`
      SELECT publication FROM trade.market_lifecycle_evidence WHERE evidence_id = ${evidenceId} LIMIT 1
    `;
    const prior = stored ? marketLifecyclePublicationSchema.safeParse(stored.publication) : null;
    if (!prior?.success || JSON.stringify(prior.data) !== JSON.stringify(parsed)) throw new MarketLifecyclePublicationConflict();
    return prior.data;
  }

  async appendTransition(record: MarketTransitionRecord): Promise<MarketTransitionRecord> {
    const parsed = marketTransitionRecordSchema.parse(record);
    const reconciliationKey =
      parsed.outcome.outcome === 'OUTCOME_UNKNOWN' || parsed.outcome.outcome === 'PARTIAL'
        ? lifecycleReconciliationKey(parsed.marketId, parsed.transitionId)
        : null;
    await this.sql`
      INSERT INTO trade.market_lifecycle_evidence
        (evidence_id, market_id, evidence_kind, transition, correction, causal_predecessor_id, reconciliation_key, observed_at)
      VALUES
        (${parsed.transitionId}, ${parsed.marketId}, 'TRANSITION', ${JSON.stringify(parsed)}::text::jsonb, NULL,
         ${parsed.authorityRef}, ${reconciliationKey}, ${parsed.requestedAt}::timestamptz)
      ON CONFLICT (evidence_id) DO NOTHING
    `;
    return parsed;
  }

  async appendCorrection(correction: CorrectionLink): Promise<CorrectionLink> {
    const parsed = correctionLinkSchema.parse(correction);
    await this.sql`
      INSERT INTO trade.market_lifecycle_evidence
        (evidence_id, market_id, evidence_kind, transition, correction, causal_predecessor_id, reconciliation_key, observed_at)
      VALUES
        (${parsed.correctionId}, NULL, 'CORRECTION', NULL, ${JSON.stringify(parsed)}::text::jsonb,
         ${parsed.causalPredecessorId}, NULL, ${parsed.correctedAt}::timestamptz)
      ON CONFLICT (evidence_id) DO NOTHING
    `;
    return parsed;
  }
}

export function marketAdmissionDecisionFor(
  snapshot: MarketStateSnapshot,
  action: MarketAction,
  checkedAt = snapshot.observedAt,
): MarketAdmissionDecision {
  const decision = decideMarketAction(snapshot, action, checkedAt);
  return decision.decision === 'ELIGIBLE'
    ? { decision: 'ELIGIBLE', dossierId: snapshot.transitionId, checkedAt, blockingSockets: [] }
    : {
        decision: 'REFUSED',
        dossierId: snapshot.transitionId,
        checkedAt,
        blockingSockets: [decision.reasonCode ?? 'trade.lifecycle.refused'],
      };
}
