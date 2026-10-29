import { PayError } from '../../payment-service.js';

/**
 * svc-ledger refused a withdrawal post because its fee is not the one the posted hold carries (`ledger.withdraw_fee_unbound`,
 * services/svc-ledger/src/withdraw-fee-binding.ts). The door refuses BEFORE anything posts, so the outcome is known: nothing
 * moved under this post. A retry would send the same fee from the same row and be refused the same way, so it is not
 * `pay.ledger_outcome_unknown` (which invites a retry, and after the rail has sent would invite one forever): it is the
 * definite `pay.withdrawal_fee_unbound`, with an alert for the operator. The withdrawal stays as it was (a settle refused
 * after the rail sent leaves the hold for an operator to reconcile; nothing is reversed on a guess).
 */
export const LEDGER_WITHDRAW_FEE_UNBOUND = 'ledger.withdraw_fee_unbound';

export interface WithdrawFeeUnboundAlert {
  readonly withdrawalId: string;
  readonly step: 'hold' | 'settle' | 'reverse';
  readonly message: string;
}

let sink: (alert: WithdrawFeeUnboundAlert) => void = () => undefined;

/** `index.ts` wires the service log; the default is silent so tests and library callers need no logger. */
export function setWithdrawFeeUnboundSink(next: ((alert: WithdrawFeeUnboundAlert) => void) | null): void {
  sink = next ?? (() => undefined);
}

export function isWithdrawFeeUnbound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === LEDGER_WITHDRAW_FEE_UNBOUND;
}

/** Throws the definite refusal when `error` is svc-ledger's fee binding refusal; returns otherwise. Never throws from the sink. */
export function refuseIfFeeUnbound(error: unknown, withdrawalId: string, step: WithdrawFeeUnboundAlert['step']): void {
  if (!isWithdrawFeeUnbound(error)) return;
  const message = error instanceof Error ? error.message : LEDGER_WITHDRAW_FEE_UNBOUND;
  try {
    sink({ withdrawalId, step, message });
  } catch {
    // A broken logger must not change the money answer.
  }
  throw new PayError(
    `The ledger refused this withdrawal's ${step}: its fee is not the one its hold carries. Nothing was posted; an operator must look`,
    'pay.withdrawal_fee_unbound',
    { withdrawalId, step },
  );
}
