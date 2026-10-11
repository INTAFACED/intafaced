/**
 * OMS execute door — plan with existing SOR, then submit the winning legs.
 *
 * External submission is a distributed command. A transport exception after
 * the request may have reached the venue is therefore SUBMIT_UNKNOWN, never a
 * definitive rejection. Stable parent/group-bound child IDs and the EMS
 * journal fence a retry until the original child is looked up and resolved.
 */
import { createHash } from 'node:crypto';
import { executionCommandOutcomeSchema, type ExecutionCommandOutcome } from '@intafaced/exchange-contract';
import { parseAmount } from '@intafaced/ledger-client';
import type { SealedHouseTenantRegistry } from '@intafaced/execution-house-tenant';
import type { ExecutionReport, LiquiditySource, VenueExecution } from '@intafaced/venue-adapter';
import type { EmsOrderEvidence, EmsOrderState, EmsOrderStore } from './oms-ems-store.js';
import type { AlgoPauseStore } from './oms-pause.js';
import { planOmsRoute, type OmsPlanInput, type OmsPlanRefuse, type OmsPlanVenue } from './oms-plan.js';
import { refuseLiveOmsIcebergDisplay } from './oms-iceberg-display.js';
import { refuseLiveOmsPeg } from './oms-peg-refuse.js';
import { refuseLiveOmsOco } from './oms-oco-refuse.js';
import { refuseUnsetBuyingPower } from './oms-buying-power.js';
import { refuseLiveOmsMmp } from './oms-mmp-refuse.js';
import { refuseUnsetDiscretionCap } from './oms-discretion-refuse.js';
import { refuseUnsetCancelOnDisconnect } from './oms-cod-refuse.js';
import { refuseUnsetTcaClaim } from './oms-tca-refuse.js';
import { refuseLiveOmsPaper } from './oms-paper-refuse.js';
import { refuseLiveOmsMultivenue } from './oms-multivenue-refuse.js';

export type OmsSubmitFn = LiquiditySource['submit'];
export type OmsExecuteVenue = OmsPlanVenue & { readonly submit?: OmsSubmitFn };

export type OmsExecuteInput = Omit<OmsPlanInput, 'venues'> & {
  readonly venues: readonly OmsExecuteVenue[];
  readonly submitByVenue?: Readonly<Record<string, OmsSubmitFn>>;
  readonly emsStore?: EmsOrderStore;
  readonly pauseStore?: AlgoPauseStore;
  /** Caller-owned stable lineage. Missing identity is refused closed. */
  readonly parentClientOrderId?: string;
  readonly executionGroupId?: string;
  readonly idempotencyKey?: string;
  readonly displayQty?: string | null;
  readonly iceberg?: boolean;
  readonly kind?: string | null;
  readonly peg?: boolean;
  readonly midpoint?: boolean;
  readonly relative?: boolean;
  readonly pegOffset?: string | null;
  readonly pegType?: string | null;
  readonly oco?: boolean;
  readonly bracket?: boolean;
  readonly takeProfit?: string | null;
  readonly stopLoss?: string | null;
  readonly ocoSiblingId?: string | null;
  readonly buyingPower?: string | null;
  readonly mmp?: boolean;
  readonly massQuote?: boolean;
  readonly delta?: string | null;
  readonly vega?: string | null;
  readonly discretionCap?: string | null;
  readonly care?: boolean;
  readonly cancelOnDisconnect?: string | boolean | null;
  readonly kill?: boolean;
  readonly drain?: boolean;
  readonly tca?: boolean;
  readonly ownerBenchmark?: string | null;
  readonly retainedMarketData?: string | boolean | null;
  readonly paper?: boolean;
  readonly bestEx?: boolean;
  readonly ownerBestExLaw?: string | null;
  readonly outage?: boolean;
  readonly inventedFill?: boolean;
  readonly gas?: string | boolean | null;
  readonly mev?: string | boolean | null;
  readonly reorg?: string | boolean | null;
  readonly wiredVenueIds?: readonly string[];
};

export type OmsChildOutcome = 'APPLIED' | 'REFUSED' | 'UNWIRED' | 'OUTCOME_UNKNOWN';
export type OmsChildExecution = {
  readonly executionGroupId: string;
  readonly parentClientOrderId: string;
  readonly childOrderId: string;
  readonly clientOrderId: string;
  readonly legIndex: number;
  readonly venueId: string;
  readonly outcome: OmsChildOutcome;
  readonly state: EmsOrderState;
  readonly execution: VenueExecution | null;
  readonly reconciliationKey: string | null;
};

export type OmsExecuteOk = {
  readonly ok: true;
  readonly report: ExecutionReport;
  readonly executions: readonly VenueExecution[];
  readonly children: readonly OmsChildExecution[];
  readonly parentClientOrderId: string;
  readonly executionGroupId: string;
};

export type OmsExecuteIdentityRefuse = {
  readonly ok: false;
  readonly reason:
    | 'missing_identity'
    | 'identity_conflict'
    | 'ems_store_unwired'
    | 'algo_paused'
    | 'not_matching_iceberg'
    | 'peg_unsupported'
    | 'midpoint_unsupported'
    | 'relative_unsupported'
    | 'oco_unsupported'
    | 'bracket_unsupported'
    | 'buying_power_unset'
    | 'scale_unsupported'
    | 'mmp_unsupported'
    | 'discretion_unset'
    | 'care_unsupported'
    | 'cod_unset'
    | 'kill_unsupported'
    | 'tca_claim_unset'
    | 'tca_unsupported'
    | 'paper_unsupported'
    | 'best_ex_unset'
    | 'outage_invented_fill'
    | 'dex_risk_unset'
    | 'invented_venue';
  readonly detail: string;
  readonly executions: readonly VenueExecution[];
  readonly children: readonly OmsChildExecution[];
  readonly parentClientOrderId: string;
  readonly executionGroupId: string;
};

type OmsExecuteFailureBase = {
  readonly ok: false;
  readonly reason: 'submit_failed';
  readonly detail: string;
  /** Canonical deterministic-spine outcome; callers must inspect this field. */
  readonly outcome: 'REFUSED' | 'OUTCOME_UNKNOWN';
  readonly state: 'ENGINE_REJECTED' | 'SUBMIT_UNKNOWN';
  readonly executions: readonly VenueExecution[];
  readonly children: readonly OmsChildExecution[];
  readonly parentClientOrderId: string;
  readonly executionGroupId: string;
  readonly reconciliationKey: string | null;
  readonly commandOutcome: ExecutionCommandOutcome;
};

export type OmsExecuteSubmitFailed = OmsExecuteFailureBase;
export type OmsExecuteRefuse = OmsPlanRefuse | OmsExecuteIdentityRefuse | OmsExecuteSubmitFailed;
export type OmsExecuteResult = OmsExecuteOk | OmsExecuteRefuse;

function submitFor(venue: OmsExecuteVenue, map: OmsExecuteInput['submitByVenue']): OmsSubmitFn | undefined {
  return venue.submit ?? map?.[venue.id];
}

function submitErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function executionRequestFingerprint(input: OmsExecuteInput): string {
  const stable = {
    symbol: input.symbol,
    side: input.side,
    amount: input.amount,
    venues: input.venues.map((venue) => ({
      id: venue.id,
      kind: venue.kind,
      amount: venue.amount,
      price: venue.price,
      feeBps: venue.feeBps,
      costTerms: venue.costTerms,
    })),
  };
  return createHash('sha256').update(JSON.stringify(stable)).digest('hex').slice(0, 32);
}

export type OmsExecutionLineage = { parentClientOrderId: string; executionGroupId: string };

function lineage(input: OmsExecuteInput): OmsExecutionLineage {
  const parentClientOrderId = input.parentClientOrderId?.trim() || input.idempotencyKey?.trim() || '';
  const executionGroupId = input.executionGroupId?.trim() || parentClientOrderId;
  return { parentClientOrderId, executionGroupId };
}

export type OmsChildIds = { childOrderId: string; clientOrderId: string };

/** Shared deterministic parent/group-bound child identity for all external legs. */
/** Parent-scoped claim id. It is not a child id, so a later leg lookup does not treat the claim as an execution. */
function fingerprintClaimClientOrderId(lineageIds: OmsExecutionLineage): string {
  const digest = createHash('sha256')
    .update(JSON.stringify({ parent: lineageIds.parentClientOrderId, group: lineageIds.executionGroupId, claim: 'request-fingerprint' }))
    .digest('hex')
    .slice(0, 24);
  const prefix = (lineageIds.parentClientOrderId.replace(/[^A-Za-z0-9._~-]/g, '_').slice(0, 48) || 'oms').replace(/[-_.]+$/, '');
  return `${prefix}/claim/${digest}`;
}

export function childIds(lineageIds: OmsExecutionLineage, legIndex: number, occurrence: number, venueId = ''): OmsChildIds {
  const suffix = `leg-${legIndex}-${occurrence}`;
  const digest = createHash('sha256')
    .update(JSON.stringify({ parent: lineageIds.parentClientOrderId, group: lineageIds.executionGroupId, venueId, legIndex, occurrence }))
    .digest('hex')
    .slice(0, 24);
  const prefix = (lineageIds.parentClientOrderId.replace(/[^A-Za-z0-9._~-]/g, '_').slice(0, 48) || 'oms').replace(/[-_.]+$/, '');
  return {
    childOrderId: `${prefix}/child/${suffix}-${digest}`,
    clientOrderId: `${prefix}/client/${suffix}-${digest}`,
  };
}

/** Shared canonical command outcome evidence for external child submission. */
export function commandOutcome(
  childOrderId: string,
  outcome: 'APPLIED' | 'REFUSED' | 'OUTCOME_UNKNOWN',
  reasonCode: string | null,
  reconciliationKey: string | null,
): ExecutionCommandOutcome {
  if (outcome === 'APPLIED') {
    return executionCommandOutcomeSchema.parse({
      outcome,
      commandId: childOrderId,
      state: 'APPLIED',
      reasonCode: null,
      reconciliationKey: null,
      observedAt: new Date().toISOString(),
    });
  }
  if (outcome === 'REFUSED') {
    return executionCommandOutcomeSchema.parse({
      outcome,
      commandId: childOrderId,
      state: 'ENGINE_REJECTED',
      reasonCode: reasonCode ?? 'venue.rejected',
      reconciliationKey: null,
      observedAt: new Date().toISOString(),
    });
  }
  return executionCommandOutcomeSchema.parse({
    outcome,
    commandId: childOrderId,
    state: 'SUBMIT_UNKNOWN',
    reasonCode: reasonCode ?? 'venue.timeout_after_dispatch',
    reconciliationKey: reconciliationKey ?? `lookup:${childOrderId}`,
    observedAt: new Date().toISOString(),
  });
}

/** Shared conversion of durable EMS evidence into a retry-fencing child result. */
export function childFromAck(
  ack: EmsOrderEvidence,
  fallback: OmsChildIds,
  legIndex: number,
  lineageIds: OmsExecutionLineage,
): OmsChildExecution {
  const outcome: OmsChildOutcome =
    ack.state === 'UNWIRED'
      ? 'UNWIRED'
      : ack.state === 'SUBMIT_UNKNOWN' || ack.state === 'OUTCOME_UNKNOWN' || ack.state === 'CANCELED' || ack.execution === null
        ? 'OUTCOME_UNKNOWN'
        : ack.state === 'REJECTED' || ack.execution.status === 'rejected'
          ? 'REFUSED'
          : 'APPLIED';
  return {
    executionGroupId: ack.executionGroupId ?? lineageIds.executionGroupId,
    parentClientOrderId: ack.parentClientOrderId ?? lineageIds.parentClientOrderId,
    childOrderId: ack.childOrderId ?? fallback.childOrderId,
    clientOrderId: ack.clientOrderId,
    legIndex: ack.legIndex ?? legIndex,
    venueId: ack.venueId,
    outcome,
    state: ack.state ?? (outcome === 'REFUSED' ? 'REJECTED' : outcome === 'OUTCOME_UNKNOWN' ? 'OUTCOME_UNKNOWN' : 'ACKNOWLEDGED'),
    execution: ack.execution,
    reconciliationKey: ack.reconciliationKey ?? null,
  };
}

function failure(
  lineageIds: ReturnType<typeof lineage>,
  executions: readonly VenueExecution[],
  children: readonly OmsChildExecution[],
  outcome: 'REFUSED' | 'OUTCOME_UNKNOWN',
  detail: string,
  command: ExecutionCommandOutcome,
): OmsExecuteSubmitFailed {
  return {
    ok: false,
    reason: 'submit_failed',
    detail,
    outcome,
    state: outcome === 'REFUSED' ? 'ENGINE_REJECTED' : 'SUBMIT_UNKNOWN',
    executions,
    children,
    parentClientOrderId: lineageIds.parentClientOrderId,
    executionGroupId: lineageIds.executionGroupId,
    reconciliationKey: command.reconciliationKey,
    commandOutcome: command,
  };
}

function identityRefusal(
  lineageIds: OmsExecutionLineage,
  reason: OmsExecuteIdentityRefuse['reason'],
  detail: string,
): OmsExecuteIdentityRefuse {
  return {
    ok: false,
    reason,
    detail,
    executions: [],
    children: [],
    parentClientOrderId: lineageIds.parentClientOrderId,
    executionGroupId: lineageIds.executionGroupId,
  };
}

function evidenceKillScope(
  input: OmsExecuteInput,
  lineageIds: OmsExecutionLineage,
): { readonly account?: string; readonly session?: string } {
  const account = input.tenantId?.trim();
  const session = lineageIds.executionGroupId.trim();
  return {
    ...(account ? { account } : {}),
    ...(session ? { session } : {}),
  };
}

function childReservation(
  lineageIds: OmsExecutionLineage,
  ids: OmsChildIds,
  legIndex: number,
  venueId: string,
  symbol: string,
  side: 'buy' | 'sell',
  requestFingerprint: string,
  killScope: { readonly account?: string; readonly session?: string },
): Omit<EmsOrderEvidence, 'execution' | 'recordedAtMs' | 'state' | 'commandOutcome' | 'reconciliationKey'> {
  return {
    requestFingerprint,
    executionGroupId: lineageIds.executionGroupId,
    parentClientOrderId: lineageIds.parentClientOrderId,
    childOrderId: ids.childOrderId,
    clientOrderId: ids.clientOrderId,
    legIndex,
    ...killScope,
    venueId,
    symbol,
    side,
  };
}

export async function executeOmsRoute(input: OmsExecuteInput, registry?: SealedHouseTenantRegistry): Promise<OmsExecuteResult> {
  const lineageIds = lineage(input);
  if (!lineageIds.parentClientOrderId) {
    return identityRefusal(lineageIds, 'missing_identity', 'caller-owned parentClientOrderId or idempotencyKey is required');
  }
  if (!input.emsStore) {
    return identityRefusal(lineageIds, 'ems_store_unwired', 'EMS evidence store is required for idempotent execution');
  }

  const omsIceberg = refuseLiveOmsIcebergDisplay({
    displayQty: input.displayQty,
    iceberg: input.iceberg,
    kind: input.kind,
  });
  if (omsIceberg) {
    return identityRefusal(lineageIds, 'not_matching_iceberg', omsIceberg.detail);
  }

  const omsPeg = refuseLiveOmsPeg({
    peg: input.peg,
    midpoint: input.midpoint,
    relative: input.relative,
    pegOffset: input.pegOffset,
    pegType: input.pegType,
    kind: input.kind,
  });
  if (omsPeg) {
    return identityRefusal(lineageIds, omsPeg.reason, omsPeg.detail);
  }

  const omsOco = refuseLiveOmsOco({
    oco: input.oco,
    bracket: input.bracket,
    takeProfit: input.takeProfit,
    stopLoss: input.stopLoss,
    ocoSiblingId: input.ocoSiblingId,
    kind: input.kind,
  });
  if (omsOco) {
    return identityRefusal(lineageIds, omsOco.reason, omsOco.detail);
  }

  const extraKind = input.kind?.trim().toLowerCase();
  if (
    extraKind === 'scale-in' ||
    extraKind === 'scale-out' ||
    extraKind === 'scale' ||
    extraKind === 'implementation_shortfall' ||
    extraKind === 'is' ||
    extraKind === 'sniper' ||
    extraKind === 'trailing' ||
    extraKind === 'trailing-stop'
  ) {
    return identityRefusal(
      lineageIds,
      'scale_unsupported',
      `live OMS kind ${String(input.kind)} is an extra — refusing rather than dual-implementing slice (twap|vwap|pov only)`,
    );
  }
  if (input.buyingPower !== undefined) {
    const buyingPower = refuseUnsetBuyingPower(input.buyingPower);
    if (!buyingPower.ok) {
      return identityRefusal(lineageIds, buyingPower.reason, buyingPower.detail);
    }
  }

  const omsMmp = refuseLiveOmsMmp({ kind: input.kind, mmp: input.mmp, massQuote: input.massQuote, delta: input.delta, vega: input.vega });
  if (omsMmp) return identityRefusal(lineageIds, omsMmp.reason, omsMmp.detail);

  if (
    extraKind === 'claim' ||
    extraKind === 'assign' ||
    extraKind === 'pass' ||
    extraKind === 'shift' ||
    extraKind === 'fill-confirm' ||
    extraKind === 'fill_confirm' ||
    extraKind === 'manual-fill' ||
    extraKind === 'manual_fill' ||
    extraKind === 'abandon' ||
    extraKind === 'care'
  ) {
    return identityRefusal(
      lineageIds,
      'care_unsupported',
      `live OMS kind ${String(input.kind)} is care-desk mill — refusing rather than dual-implementing execute`,
    );
  }
  if (input.care === true) {
    return identityRefusal(
      lineageIds,
      'care_unsupported',
      'live OMS care desk is mill helpers — refusing rather than dual-implementing execute',
    );
  }
  if (input.discretionCap !== undefined) {
    const cap = refuseUnsetDiscretionCap(input.discretionCap);
    if (!cap.ok) return identityRefusal(lineageIds, cap.reason, cap.detail);
  }

  if (
    extraKind === 'kill' ||
    extraKind === 'drain' ||
    extraKind === 'cod' ||
    extraKind === 'dead-man' ||
    extraKind === 'deadman' ||
    extraKind === 'cancel-on-disconnect' ||
    extraKind === 'halt'
  ) {
    return identityRefusal(
      lineageIds,
      'kill_unsupported',
      `live OMS kind ${String(input.kind)} is kill/drain/COD mill — refusing rather than dual-implementing execute`,
    );
  }
  if (input.kill === true || input.drain === true) {
    return identityRefusal(
      lineageIds,
      'kill_unsupported',
      'live OMS kill/drain is mill helpers — refusing rather than dual-implementing execute',
    );
  }
  if (input.cancelOnDisconnect !== undefined) {
    const cod = refuseUnsetCancelOnDisconnect(input.cancelOnDisconnect);
    if (!cod.ok) return identityRefusal(lineageIds, cod.reason, cod.detail);
  }

  if (
    extraKind === 'tca' ||
    extraKind === 'tca-claim' ||
    extraKind === 'tca_claim' ||
    extraKind === 'beat-vwap' ||
    extraKind === 'markout'
  ) {
    return identityRefusal(
      lineageIds,
      'tca_unsupported',
      `live OMS kind ${String(input.kind)} is TCA mill — refusing rather than dual-implementing execute`,
    );
  }
  if (input.tca === true) {
    return identityRefusal(lineageIds, 'tca_unsupported', 'live OMS TCA is mill helpers — refusing rather than dual-implementing execute');
  }
  if (input.ownerBenchmark !== undefined || input.retainedMarketData !== undefined) {
    const claim = refuseUnsetTcaClaim({
      ownerBenchmark: input.ownerBenchmark,
      retainedMarketData: input.retainedMarketData,
    });
    if (!claim.ok) return identityRefusal(lineageIds, claim.reason, claim.detail);
  }

  const omsPaper = refuseLiveOmsPaper({ kind: input.kind, paper: input.paper });
  if (omsPaper) return identityRefusal(lineageIds, omsPaper.reason, omsPaper.detail);

  const omsMulti = refuseLiveOmsMultivenue({
    kind: input.kind,
    bestEx: input.bestEx,
    ownerBestExLaw: input.ownerBestExLaw,
    outage: input.outage,
    inventedFill: input.inventedFill,
    gas: input.gas,
    mev: input.mev,
    reorg: input.reorg,
    wiredVenueIds: input.wiredVenueIds,
    venues: input.venues,
  });
  if (omsMulti) return identityRefusal(lineageIds, omsMulti.reason, omsMulti.detail);

  const killScope = evidenceKillScope(input, lineageIds);
  const requestFingerprint = executionRequestFingerprint(input);
  const prior = input.emsStore.list({ parentClientOrderId: lineageIds.parentClientOrderId });
  for (const evidence of prior) {
    if (evidence.executionGroupId !== lineageIds.executionGroupId) {
      return identityRefusal(
        lineageIds,
        'identity_conflict',
        `execution identity ${lineageIds.parentClientOrderId} is already bound to execution group ${evidence.executionGroupId ?? 'unknown'}`,
      );
    }
    if (!evidence.requestFingerprint) {
      return identityRefusal(
        lineageIds,
        'identity_conflict',
        `EMS evidence for ${evidence.clientOrderId} has no command fingerprint; reconcile it before reusing this identity`,
      );
    }
    if (evidence.requestFingerprint !== requestFingerprint) {
      return identityRefusal(
        lineageIds,
        'identity_conflict',
        `execution identity ${lineageIds.parentClientOrderId} is already bound to a different symbol, side, amount, or route`,
      );
    }
  }

  if (!input.pauseStore?.isPaused(lineageIds)) {
    input.emsStore.record({
      clientOrderId: fingerprintClaimClientOrderId(lineageIds),
      requestFingerprint,
      parentClientOrderId: lineageIds.parentClientOrderId,
      executionGroupId: lineageIds.executionGroupId,
      ...killScope,
      venueId: '',
      symbol: input.symbol,
      side: input.side,
      execution: null,
      state: 'UNWIRED',
      reconciliationKey: null,
    });
  }

  const planned = await planOmsRoute(input, registry);
  if (!planned.ok) return planned;

  const executions: VenueExecution[] = [];
  const children: OmsChildExecution[] = [];
  const occurrences = new Map<string, number>();

  for (const [legIndex, leg] of planned.report.venues.entries()) {
    const occurrence = occurrences.get(leg.venueId) ?? 0;
    occurrences.set(leg.venueId, occurrence + 1);
    const ids = childIds(lineageIds, legIndex, occurrence, leg.venueId);
    const venue = input.venues.find((v) => v.id === leg.venueId);

    const existing = input.emsStore?.get(ids.clientOrderId);
    if (existing) {
      const child = childFromAck(existing, ids, legIndex, lineageIds);
      children.push(child);
      if (existing.execution) executions.push(existing.execution);
      if (child.outcome === 'OUTCOME_UNKNOWN') {
        const command =
          existing.commandOutcome ?? commandOutcome(ids.childOrderId, 'OUTCOME_UNKNOWN', 'venue.prior_unknown', child.reconciliationKey);
        return failure(lineageIds, executions, children, 'OUTCOME_UNKNOWN', 'child outcome is unresolved; lookup before retry', command);
      }
      if (child.outcome === 'REFUSED' || child.outcome === 'UNWIRED') {
        const command = existing.commandOutcome ?? commandOutcome(ids.childOrderId, 'REFUSED', 'venue.prior_rejection', null);
        return failure(lineageIds, executions, children, 'REFUSED', 'child was already refused; retry is fenced', command);
      }
      continue;
    }

    if (input.pauseStore?.isPaused(lineageIds)) {
      return {
        ...identityRefusal(lineageIds, 'algo_paused', 'paused algo takes no new children'),
        executions,
        children,
      };
    }

    const submit = venue ? submitFor(venue, input.submitByVenue) : input.submitByVenue?.[leg.venueId];
    if (!submit) {
      const command = commandOutcome(ids.childOrderId, 'REFUSED', 'venue.unwired', null);
      const child: OmsChildExecution = {
        executionGroupId: lineageIds.executionGroupId,
        parentClientOrderId: lineageIds.parentClientOrderId,
        childOrderId: ids.childOrderId,
        clientOrderId: ids.clientOrderId,
        legIndex,
        venueId: leg.venueId,
        outcome: 'UNWIRED',
        state: 'UNWIRED',
        execution: null,
        reconciliationKey: null,
      };
      children.push(child);
      input.emsStore?.record({
        ...child,
        ...killScope,
        requestFingerprint,
        execution: null,
        state: 'UNWIRED',
        commandOutcome: command,
        reconciliationKey: null,
        venueId: leg.venueId,
        symbol: planned.report.symbol,
        side: planned.report.side,
      });
      return failure(lineageIds, executions, children, 'REFUSED', `venue ${leg.venueId} is not wired for submit`, command);
    }

    let execution: VenueExecution;
    const reconciliationKey = `lookup:${ids.clientOrderId}`;
    input.emsStore.record({
      ...childReservation(
        lineageIds,
        ids,
        legIndex,
        leg.venueId,
        planned.report.symbol,
        planned.report.side,
        requestFingerprint,
        killScope,
      ),
      execution: null,
      state: 'SUBMIT_UNKNOWN',
      commandOutcome: commandOutcome(ids.childOrderId, 'OUTCOME_UNKNOWN', 'venue.dispatch_unconfirmed', reconciliationKey),
      reconciliationKey,
    });
    try {
      execution = await submit({
        symbol: planned.report.symbol,
        side: planned.report.side,
        amount: parseAmount(leg.amount),
        limitPrice: parseAmount(leg.price),
        clientOrderId: ids.clientOrderId,
      });
    } catch (err) {
      const command = commandOutcome(ids.childOrderId, 'OUTCOME_UNKNOWN', 'venue.transport_after_possible_dispatch', reconciliationKey);
      const child: OmsChildExecution = {
        executionGroupId: lineageIds.executionGroupId,
        parentClientOrderId: lineageIds.parentClientOrderId,
        childOrderId: ids.childOrderId,
        clientOrderId: ids.clientOrderId,
        legIndex,
        venueId: leg.venueId,
        outcome: 'OUTCOME_UNKNOWN',
        state: 'SUBMIT_UNKNOWN',
        execution: null,
        reconciliationKey,
      };
      children.push(child);
      input.emsStore?.record({
        ...child,
        ...killScope,
        requestFingerprint,
        execution: null,
        state: 'SUBMIT_UNKNOWN',
        commandOutcome: command,
        reconciliationKey,
        venueId: leg.venueId,
        symbol: planned.report.symbol,
        side: planned.report.side,
      });
      return failure(lineageIds, executions, children, 'OUTCOME_UNKNOWN', submitErrorMessage(err), command);
    }

    if (execution.status === 'rejected') {
      const command = commandOutcome(ids.childOrderId, 'REFUSED', 'venue.rejected', null);
      const child: OmsChildExecution = {
        executionGroupId: lineageIds.executionGroupId,
        parentClientOrderId: lineageIds.parentClientOrderId,
        childOrderId: ids.childOrderId,
        clientOrderId: ids.clientOrderId,
        legIndex,
        venueId: leg.venueId,
        outcome: 'REFUSED',
        state: 'REJECTED',
        execution,
        reconciliationKey: null,
      };
      children.push(child);
      executions.push(execution);
      input.emsStore?.record({
        ...child,
        ...killScope,
        requestFingerprint,
        execution,
        state: 'REJECTED',
        commandOutcome: command,
        reconciliationKey: null,
        venueId: leg.venueId,
        symbol: planned.report.symbol,
        side: planned.report.side,
      });
      return failure(lineageIds, executions, children, 'REFUSED', `venue ${leg.venueId} rejected ${execution.venueOrderId}`, command);
    }

    const command = commandOutcome(ids.childOrderId, 'APPLIED', null, null);
    const child: OmsChildExecution = {
      executionGroupId: lineageIds.executionGroupId,
      parentClientOrderId: lineageIds.parentClientOrderId,
      childOrderId: ids.childOrderId,
      clientOrderId: ids.clientOrderId,
      legIndex,
      venueId: leg.venueId,
      outcome: 'APPLIED',
      state: 'ACKNOWLEDGED',
      execution,
      reconciliationKey: null,
    };
    input.emsStore?.record({
      ...child,
      ...killScope,
      requestFingerprint,
      execution,
      state: 'ACKNOWLEDGED',
      commandOutcome: command,
      reconciliationKey: null,
      venueId: leg.venueId,
      symbol: planned.report.symbol,
      side: planned.report.side,
    });
    executions.push(execution);
    children.push(child);
  }

  return {
    ok: true,
    report: planned.report,
    executions,
    children,
    parentClientOrderId: lineageIds.parentClientOrderId,
    executionGroupId: lineageIds.executionGroupId,
  };
}
