/**
 * Plain words for a withdrawal's failure code (W-withdraw-06). `customer` is what the person reads; `support` is what
 * an agent does. A code this map does not know is shown as the raw code with no invented reason, so a new rail code
 * is never dressed up as something it is not.
 */
export interface FailureReason {
  readonly code: string;
  readonly known: boolean;
  readonly customer: string;
  readonly support: string;
}

const KNOWN: Record<string, { customer: string; support: string }> = {
  'rail.failed': {
    customer: 'The payout could not be completed. Your funds were returned to your balance.',
    support: 'The rail reported a failure. Read the attempt journal for the rail answer before retrying with the same reference.',
  },
  'rail.refused': {
    customer: 'The payout was refused by the payment network. Your funds were returned to your balance.',
    support: 'The rail refused the first dispatch. The hold was reversed once; check the destination details with the customer.',
  },
  'rail.unhealthy': {
    customer: 'This payout route is not available right now. Your funds were returned to your balance.',
    support: 'The rail was not healthy when the withdrawal was claimed. Check the rail health read before asking the customer to retry.',
  },
  'rail.marked_down': {
    customer: 'This payout route is paused. Your funds were returned to your balance.',
    support: 'An operator marked the rail down. Retry only after the rail is marked up again.',
  },
  'rail.health_stale': {
    customer: 'This payout route could not be confirmed as available. Your funds were returned to your balance.',
    support: 'The rail health reading was stale. Wait for a fresh probe, then retry.',
  },
  'rail.probe_failed': {
    customer: 'This payout route could not be reached. Your funds were returned to your balance.',
    support: 'The rail probe failed. Check the rail credentials and network path.',
  },
  'rail.rpc_unset': {
    customer: 'Withdrawals on this network are not switched on yet.',
    support: 'The node address for this network is not set. Nothing was sent; the owner sets it before the rail can be used.',
  },
  'rail.sandbox_only': {
    customer: 'This route only works in test mode.',
    support: 'The rail is a sandbox rail. It cannot carry a live withdrawal.',
  },
  'rail.not_sent': {
    customer: 'The payout was not sent. Your funds were returned to your balance.',
    support: 'The rail status query says the requested attempt was never sent. The hold was reversed.',
  },
  'rail.unknown_reference': {
    customer: 'The payout could not be matched at the payment network. We are checking it.',
    support: 'The rail does not know the reference. Keep the hold and query the rail by the original key before any retry.',
  },
};

export function failureReason(code: string | null): FailureReason | null {
  if (code === null) return null;
  const known = KNOWN[code];
  if (known) return { code, known: true, ...known };
  return { code, known: false, customer: code, support: code };
}
