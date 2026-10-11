/**
 * OMS external arb legs execute door (P-04).
 *
 * Parent clientOrderId links the legged execution group. Each child uses the
 * shared OMS deterministic identity and EMS evidence primitives so a transport
 * exception remains unknown and a retry cannot duplicate a durable child.
 */
import { type ExecutionCommandOutcome } from '@intafaced/exchange-contract';
import { parseAmount } from '@intafaced/ledger-client';
import type { OmsVenueExecution as VenueExecution } from './oms-trade-submit.js';
import { childFromAck, childIds, commandOutcome, type OmsChildExecution, type OmsExecutionLineage } from './oms-execute.js';
import { planOmsArbAtomicLegs, type OmsArbPlanLegsInput, type OmsArbPlanLegsResult } from './oms-arb-plan-legs.js';
import type { EmsOrderStore } from './oms-ems-store.js';
import type { OmsSubmitFn } from './oms-trade-submit.js';

export type OmsArbExecuteLegsInput = OmsArbPlanLegsInput & {
  readonly parentClientOrderId: string;
  readonly executionGroupId?: string;
  readonly buyLimitPrice: string;
  readonly sellLimitPrice: string;
};

export type OmsArbExecuteLegsOk = {
  readonly ok: true;
  readonly parentClientOrderId: string;
  readonly executionGroupId: string;
  readonly executions: readonly VenueExecution[];
  readonly children: readonly OmsChildExecution[];
};

export type OmsArbExecuteLegsPlanRefuse = Extract<OmsArbPlanLegsResult, { readonly ok: false }> & {
  readonly parentClientOrderId: string;
  readonly executionGroupId: string;
  readonly executions: readonly VenueExecution[];
  readonly children: readonly OmsChildExecution[];
};

export type OmsArbExecuteLegsSubmitFailed = {
  readonly ok: false;
  readonly reason: 'submit_failed';
  readonly detail: string;
  /** Canonical deterministic-spine outcome; transport errors are not refusal. */
  readonly outcome: 'REFUSED' | 'OUTCOME_UNKNOWN';
  readonly state: 'ENGINE_REJECTED' | 'SUBMIT_UNKNOWN';
  /** Completed executions, including a venue-rejected execution when returned. */
  readonly executions: readonly VenueExecution[];
  /** Every completed/refused/unwired/unknown child, including the current child. */
  readonly children: readonly OmsChildExecution[];
  readonly parentClientOrderId: string;
  readonly executionGroupId: string;
  readonly reconciliationKey: string | null;
  readonly commandOutcome: ExecutionCommandOutcome;
};

export type OmsArbExecuteLegsIdentityRefuse = {
  readonly ok: false;
  readonly reason: 'missing_identity';
  readonly detail: string;
  readonly parentClientOrderId: string;
  readonly executionGroupId: string;
  readonly executions: readonly VenueExecution[];
  readonly children: readonly OmsChildExecution[];
};

export type OmsArbExecuteLegsLimitRefuse = {
  readonly ok: false;
  readonly reason: 'invalid_limit';
  readonly detail: string;
  readonly parentClientOrderId: string;
  readonly executionGroupId: string;
  readonly executions: readonly VenueExecution[];
  readonly children: readonly OmsChildExecution[];
};

export type OmsArbExecuteLegsResult =
  | OmsArbExecuteLegsPlanRefuse
  | OmsArbExecuteLegsOk
  | OmsArbExecuteLegsSubmitFailed
  | OmsArbExecuteLegsIdentityRefuse
  | OmsArbExecuteLegsLimitRefuse;

function submitErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function failure(
  lineageIds: OmsExecutionLineage,
  executions: readonly VenueExecution[],
  children: readonly OmsChildExecution[],
  outcome: 'REFUSED' | 'OUTCOME_UNKNOWN',
  detail: string,
  command: ExecutionCommandOutcome,
): OmsArbExecuteLegsSubmitFailed {
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

export async function executeOmsArbAtomicLegs(
  input: OmsArbExecuteLegsInput,
  submitByVenue: Readonly<Record<string, OmsSubmitFn>>,
  emsStore?: EmsOrderStore,
): Promise<OmsArbExecuteLegsResult> {
  const parentClientOrderId = input.parentClientOrderId.trim();
  const providedGroupId = input.executionGroupId?.trim() ?? '';
  if (parentClientOrderId.length === 0) {
    return {
      ok: false,
      reason: 'missing_identity',
      detail: 'caller-owned parentClientOrderId is required',
      parentClientOrderId,
      executionGroupId: providedGroupId,
      executions: [],
      children: [],
    };
  }
  const lineageIds: OmsExecutionLineage = {
    parentClientOrderId,
    executionGroupId: providedGroupId || parentClientOrderId,
  };
  const planned = planOmsArbAtomicLegs(input);
  if (!planned.ok) {
    return {
      ...planned,
      parentClientOrderId: lineageIds.parentClientOrderId,
      executionGroupId: lineageIds.executionGroupId,
      executions: [],
      children: [],
    };
  }

  let sellLimit;
  let buyLimit;
  try {
    sellLimit = parseAmount(input.sellLimitPrice);
    buyLimit = parseAmount(input.buyLimitPrice);
  } catch (err) {
    return {
      ok: false,
      reason: 'invalid_limit',
      detail: submitErrorMessage(err),
      parentClientOrderId: lineageIds.parentClientOrderId,
      executionGroupId: lineageIds.executionGroupId,
      executions: [],
      children: [],
    };
  }
  const limits = { buy: buyLimit, sell: sellLimit } as const;

  const executions: VenueExecution[] = [];
  const children: OmsChildExecution[] = [];
  const occurrences = new Map<string, number>();

  for (const [legIndex, leg] of planned.legs.entries()) {
    const occurrence = occurrences.get(leg.venueId) ?? 0;
    occurrences.set(leg.venueId, occurrence + 1);
    const ids = childIds(lineageIds, legIndex, occurrence, leg.venueId);

    // Durable EMS evidence is authoritative. Applied, refused, unwired, and
    // unknown children all fence a same-parent/group retry before submission.
    const existing = emsStore?.get(ids.clientOrderId);
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

    const submit = submitByVenue[leg.venueId];
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
      emsStore?.record({
        ...child,
        execution: null,
        state: 'UNWIRED',
        commandOutcome: command,
        reconciliationKey: null,
        symbol: leg.symbol,
        side: leg.side,
      });
      return failure(lineageIds, executions, children, 'REFUSED', `venue ${leg.venueId} is not wired for submit`, command);
    }

    const amount = parseAmount(leg.amount);
    let execution: VenueExecution;
    try {
      execution = await submit({
        symbol: leg.symbol,
        side: leg.side,
        amount,
        limitPrice: limits[leg.side],
        clientOrderId: ids.clientOrderId,
      });
    } catch (err) {
      // There is no reliable dispatch boundary here. Preserve the child and
      // durable reconciliation key; never classify a thrown submit as reject.
      const reconciliationKey = `lookup:${ids.clientOrderId}`;
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
      emsStore?.record({
        ...child,
        execution: null,
        state: 'SUBMIT_UNKNOWN',
        commandOutcome: command,
        reconciliationKey,
        symbol: leg.symbol,
        side: leg.side,
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
      emsStore?.record({
        ...child,
        execution,
        state: 'REJECTED',
        commandOutcome: command,
        reconciliationKey: null,
        symbol: leg.symbol,
        side: leg.side,
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
    emsStore?.record({
      ...child,
      execution,
      state: 'ACKNOWLEDGED',
      commandOutcome: command,
      reconciliationKey: null,
      symbol: leg.symbol,
      side: leg.side,
    });
    executions.push(execution);
    children.push(child);
  }

  return {
    ok: true,
    parentClientOrderId: lineageIds.parentClientOrderId,
    executionGroupId: lineageIds.executionGroupId,
    executions,
    children,
  };
}
