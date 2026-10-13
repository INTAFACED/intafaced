/**
 * Release leftover residual already on an expired implementation-shortfall parent.
 * Hands the retained leftover through ledger-client. This door never invents an
 * amount from duration, arrival, or the clock, and does not touch matching.
 */
import { formatAmount, parseAmount } from '@intafaced/ledger-client';

export type OmsIsReleaseResidualRefuseReason = 'missing_parent' | 'not_live' | 'not_expired' | 'already_released' | 'missing_residual';

export type OmsIsReleaseResidualRefusal = {
  readonly ok: false;
  readonly reason: OmsIsReleaseResidualRefuseReason;
  readonly detail: string;
};

export type OmsIsReleaseResidualOk = {
  readonly ok: true;
  readonly released: true;
  readonly parent: {
    readonly parentClientOrderId: string;
    readonly kind: 'implementation_shortfall';
  };
  readonly status: 'expired';
  readonly residual: { readonly remaining: string; readonly released: true };
};

export type OmsIsReleaseResidualResult = OmsIsReleaseResidualOk | OmsIsReleaseResidualRefusal;

function refuse(reason: OmsIsReleaseResidualRefuseReason, detail: string): OmsIsReleaseResidualRefusal {
  return { ok: false, reason, detail };
}

function parseRetainedRemaining(raw: string | null | undefined): { ok: true; text: string } | OmsIsReleaseResidualRefusal {
  if (raw === null || raw === undefined) {
    return refuse('missing_residual', 'residual.remaining is missing — refusing to invent leftover from duration or the clock');
  }
  const text = raw.trim();
  if (text.length === 0) {
    return refuse('missing_residual', 'residual.remaining is missing — refusing to invent leftover from duration or the clock');
  }
  try {
    return { ok: true, text: formatAmount(parseAmount(text)) };
  } catch {
    return refuse('missing_residual', 'residual.remaining is not a ledger amount — refusing to invent leftover');
  }
}

/**
 * Release leftover already retained on an expired IS parent through ledger-client.
 */
export function releaseExpiredImplementationShortfallResidual(input: {
  parentClientOrderId?: string;
  kind?: string;
  status?: string;
  /** Retained leftover. Blank refuses — never invent an amount. */
  remaining?: string | null;
  residualReleased?: boolean;
}): OmsIsReleaseResidualResult {
  const parentClientOrderId = input.parentClientOrderId?.trim() ?? '';
  if (!parentClientOrderId) {
    return refuse('missing_parent', 'parentClientOrderId is required');
  }
  if (input.kind !== undefined && input.kind !== 'implementation_shortfall') {
    return refuse('not_live', `kind ${String(input.kind)} is not implementation_shortfall`);
  }
  const status = input.status?.trim() ?? '';
  if (status !== 'expired') {
    return refuse(
      'not_expired',
      `parent ${parentClientOrderId} is ${status || 'not expired'} — releaseResidual needs an already expired parent`,
    );
  }
  if (input.residualReleased === true) {
    return refuse('already_released', `parent ${parentClientOrderId} residual is already released`);
  }

  const leftover = parseRetainedRemaining(input.remaining);
  if (!leftover.ok) return leftover;

  return {
    ok: true,
    released: true,
    parent: { parentClientOrderId, kind: 'implementation_shortfall' },
    status: 'expired',
    residual: { remaining: leftover.text, released: true },
  };
}
