/**
 * Operator treasury-value dual-control. Missing/same confirm refuses.
 * Job HMAC twins (mintEpoch / yield.runWindow / buyback.runWindow) stay
 * service doors — not this. No invented second caller.
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
  const confirm = confirmOperatorId?.trim() ? confirmOperatorId.trim() : null;
  if (actor === null) {
    return {
      code: MISSING_OPERATOR,
      message: 'operator identity is required; the token service does not invent a caller',
    };
  }
  if (confirm === null) {
    return {
      code: MISSING_OPERATOR,
      message: 'confirming operator identity is required; the token service does not invent a second caller',
    };
  }
  if (confirm === actor) {
    return {
      code: MISSING_OPERATOR,
      message: 'confirming operator must be a distinct identity; the token service does not invent a second caller',
    };
  }
  return null;
}

export function requireDualControl(operatorId: string | null, confirmOperatorId: string | null): string {
  const refuse = dualControlRefuse(operatorId, confirmOperatorId);
  if (refuse) throw new DualControlError(refuse.message);
  return (confirmOperatorId as string).trim();
}
