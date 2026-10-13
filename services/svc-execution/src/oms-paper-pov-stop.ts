/**
 * Stop one running paper POV parent.
 * Paper off refuses. Children take no new. Residual stays on the parent.
 * This door never invents a canceled order, never invents a live venue,
 * and does not touch matching.
 */
import type { PaperGate } from './oms-paper.js';

export type OmsPaperPovStopRefuseReason =
  'missing_parent' | 'not_running' | 'already_stopped' | 'not_live' | 'paper_gate_unwired' | 'paper_off';

export type OmsPaperPovStopRefusal = {
  readonly ok: false;
  readonly reason: OmsPaperPovStopRefuseReason;
  readonly detail: string;
};

export type OmsPaperPovStopOk = {
  readonly ok: true;
  readonly stopped: true;
  readonly paper: true;
  readonly parent: {
    readonly parentClientOrderId: string;
    readonly kind: 'pov';
  };
  readonly childrenTakeNew: false;
  readonly residual: { readonly remaining: string | null };
};

export type OmsPaperPovStopResult = OmsPaperPovStopOk | OmsPaperPovStopRefusal;

function refuse(reason: OmsPaperPovStopRefuseReason, detail: string): OmsPaperPovStopRefusal {
  return { ok: false, reason, detail };
}

function echoRemaining(raw: string | null | undefined): string | null {
  const remaining = raw?.trim() ?? '';
  return remaining || null;
}

/**
 * Stop a running paper POV parent. Existing children stay as recorded.
 * Residual is not released or consumed. Paper off refuses a live venue.
 */
export function stopPaperPovParent(input: {
  parentClientOrderId?: string;
  kind?: string;
  status?: string;
  remaining?: string | null;
  paper?: PaperGate;
}): OmsPaperPovStopResult {
  const parentClientOrderId = input.parentClientOrderId?.trim() ?? '';
  if (!parentClientOrderId) {
    return refuse('missing_parent', 'parentClientOrderId is required');
  }
  if (!input.paper) {
    return refuse('paper_gate_unwired', 'paper gate is required for paper stop');
  }
  if (input.paper.enabled === false) {
    return refuse('paper_off', 'paper is off — refusing to invent a live venue or a live child');
  }
  if (input.kind !== undefined && input.kind !== 'pov') {
    return refuse('not_live', `kind ${String(input.kind)} is not pov`);
  }
  const status = input.status?.trim() ?? '';
  if (status === 'stopped') {
    return refuse('already_stopped', `parent ${parentClientOrderId} is already stopped`);
  }
  if (status === 'running') {
    return refuse('not_running', `parent ${parentClientOrderId} is running live — refusing to invent a paper stop over live`);
  }
  if (status !== 'paper') {
    return refuse('not_running', `parent ${parentClientOrderId} is not a running paper parent`);
  }

  return {
    ok: true,
    stopped: true,
    paper: true,
    parent: { parentClientOrderId, kind: 'pov' },
    childrenTakeNew: false,
    residual: { remaining: echoRemaining(input.remaining) },
  };
}
