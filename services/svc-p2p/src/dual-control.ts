/**
 * Operator dual-control (merchants.decide, payment-method schema mutates).
 * Missing/same confirm refuses. Matching halt, ledger freeze, and edge
 * kill-switch already require two distinct operators; one-operator rewrite
 * of rails a stranger pays against is the same lie as one-operator halt.
 * No invented second caller.
 */
export const MISSING_OPERATOR = 'missing_operator' as const;

export class DualControlError extends Error {
  readonly code = MISSING_OPERATOR;
  constructor(message: string) {
    super(message);
    this.name = 'DualControlError';
  }
}

export function readConfirmOperatorId(cmd: { readonly confirmOperatorId?: string | null }): string | null {
  const raw = cmd.confirmOperatorId;
  if (raw === undefined || raw === null) return null;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export function dualControlRefuse(
  operatorId: string | null,
  confirmOperatorId: string | null,
): { readonly code: typeof MISSING_OPERATOR; readonly message: string } | null {
  const actor = operatorId?.trim() ? operatorId.trim() : null;
  if (actor === null) {
    return {
      code: MISSING_OPERATOR,
      message: 'operator identity is required; the p2p merchant door does not invent a caller',
    };
  }
  const confirm = confirmOperatorId?.trim() ? confirmOperatorId.trim() : null;
  if (confirm === null) {
    return {
      code: MISSING_OPERATOR,
      message: 'confirming operator identity is required; the p2p merchant door does not invent a second caller',
    };
  }
  if (confirm.toLowerCase() === actor.toLowerCase()) {
    return {
      code: MISSING_OPERATOR,
      message: 'confirming operator must be a distinct identity; the p2p merchant door does not invent a second caller',
    };
  }
  return null;
}

export function requireDualControl(operatorId: string | null, confirmOperatorId: string | null): string {
  const refuse = dualControlRefuse(operatorId, confirmOperatorId);
  if (refuse) throw new DualControlError(refuse.message);
  return (confirmOperatorId as string).trim();
}
