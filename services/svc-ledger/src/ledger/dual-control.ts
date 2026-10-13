/**
 * Operator freeze/unfreeze/reconcile dual-control. Missing/same confirm refuses.
 * Cron/boot freeze stay on LedgerService — those are not operator doors.
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

/** Trim and fold hex case. Blank, whitespace, or the same UUID in another case is not a second person. */
function canonicalOperatorId(raw: string | null): string | null {
  if (raw === null) return null;
  const folded = raw.trim().toLowerCase();
  return folded.length === 0 ? null : folded;
}

export function dualControlRefuse(
  operatorId: string | null,
  confirmOperatorId: string | null,
): { readonly code: typeof MISSING_OPERATOR; readonly message: string } | null {
  const actor = canonicalOperatorId(operatorId);
  const confirm = canonicalOperatorId(confirmOperatorId);
  if (actor === null) {
    return {
      code: MISSING_OPERATOR,
      message: 'operator identity is required; the ledger does not invent a caller',
    };
  }
  if (confirm === null) {
    return {
      code: MISSING_OPERATOR,
      message: 'confirming operator identity is required; the ledger does not invent a second caller',
    };
  }
  if (confirm === actor) {
    return {
      code: MISSING_OPERATOR,
      message: 'confirming operator must be a distinct identity; the ledger does not invent a second caller',
    };
  }
  return null;
}

export function requireDualControl(operatorId: string | null, confirmOperatorId: string | null): string {
  const refuse = dualControlRefuse(operatorId, confirmOperatorId);
  if (refuse) throw new DualControlError(refuse.message);
  return canonicalOperatorId(confirmOperatorId) as string;
}
