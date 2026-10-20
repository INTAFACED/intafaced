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

/** Codes that are not a stored failure but the sub-status of a blocked or cancelled withdrawal (W-custody-ops-11). */
const SUB_STATUS: Record<string, { customer: string; support: string }> = {
  'withdrawal.canceled': {
    customer: 'You canceled this withdrawal. Nothing was sent.',
    support: 'The customer canceled before dispatch. A hold, if one was posted, was reversed once.',
  },
  'travel_rule.blocking_time_expired': {
    customer: 'This withdrawal is waiting on a compliance check that has not finished in time.',
    support: 'The travel-rule wait limit passed with no answer. It still blocks; an operator marks it canceled, rejected or repair.',
  },
  'travel_rule.rejected': {
    customer: 'This withdrawal could not be sent because the receiving institution declined the transfer details.',
    support: 'The counterparty rejected the travel-rule message. Read the transition reason; the customer may start a new withdrawal.',
  },
  'travel_rule.repair': {
    customer: 'We need a few more details about the recipient before this withdrawal can go.',
    support: 'A required travel-rule field is missing. The customer or an operator supplies it and the message is re-sent.',
  },
  'travel_rule.provider_unavailable': {
    customer: 'This withdrawal is waiting on a compliance check that is not available right now.',
    support: 'No travel-rule counterparty provider is connected for this destination. Nothing was sent.',
  },
};

/** Every code this catalog explains, in a stable order. A code not listed is shown raw by `failureReason`. */
export function listFailureReasons(): FailureReason[] {
  const all = { ...KNOWN, ...SUB_STATUS };
  return Object.keys(all)
    .sort()
    .map((code) => ({ code, known: true, ...all[code]! }));
}

export function failureReason(code: string | null): FailureReason | null {
  if (code === null) return null;
  const known = KNOWN[code] ?? SUB_STATUS[code];
  if (known) return { code, known: true, ...known };
  return { code, known: false, customer: code, support: code };
}
