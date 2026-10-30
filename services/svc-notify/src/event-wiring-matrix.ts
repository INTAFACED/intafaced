/**
 * CLASS B EVENT-WIRING MATRIX — the growth pin.
 *
 * `subscribeNotificationEvents` attaches durable consumers one by one. A casual
 * add is how a dark subject (no publisher, no user id, no product meaning)
 * enters production and either parks forever or fans noise into every inbox.
 *
 * This list is the deliberate surface. Adding a consumer requires changing this
 * matrix AND the attach block in `events.ts`. The pin test fails if they drift.
 *
 * Skipped subjects (documented, not attached) live in SKIPPED_NOTIFY_SUBJECTS.
 * No invented publishers.
 */

export type NotifyConsumerRow = {
  /** Catalog event name on `@intafaced/events`. */
  readonly event: string;
  /** JetStream durable consumer name. */
  readonly durable: string;
  /** Bus subject string (must match the catalog). */
  readonly subject: string;
  /** One-line product effect for the README matrix. */
  readonly effect: string;
};

/**
 * Every durable consumer svc-notify attaches today.
 *
 * Order matches `subscribeNotificationEvents` for greppability.
 */
export const NOTIFY_EVENT_CONSUMERS: readonly NotifyConsumerRow[] = [
  {
    event: 'fillSettled',
    durable: 'notify-fill-settled',
    subject: 'intafaced.trade.fill.settled',
    effect: 'Inbox row for the fill owner',
  },
  {
    event: 'orderUpdated',
    durable: 'notify-order-updated',
    subject: 'intafaced.trade.order.updated',
    effect: 'Inbox row on cancelled / rejected / expired only',
  },
  {
    event: 'positionUpdated',
    durable: 'notify-position-updated',
    subject: 'intafaced.trade.position.updated',
    effect: 'Critical inbox row + fan-out on liquidation only',
  },
  {
    event: 'p2pEscrowLocked',
    durable: 'notify-p2p-escrow-locked',
    subject: 'intafaced.p2p.escrow.locked',
    effect: 'Inbox rows for seller and buyer',
  },
  {
    event: 'p2pEscrowReleased',
    durable: 'notify-p2p-escrow-released',
    subject: 'intafaced.p2p.escrow.released',
    effect: 'Inbox rows when escrow releases to buyer',
  },
  {
    event: 'p2pEscrowRefunded',
    durable: 'notify-p2p-escrow-refunded',
    subject: 'intafaced.p2p.escrow.refunded',
    effect: 'Inbox rows when escrow returns to seller',
  },
  {
    event: 'p2pTradeDisputed',
    durable: 'notify-p2p-trade-disputed',
    subject: 'intafaced.p2p.trade.disputed',
    effect: 'Inbox row for the opener only (no counterparty on payload)',
  },
  {
    event: 'p2pTradeFiatSent',
    durable: 'notify-p2p-trade-fiat-sent',
    subject: 'intafaced.p2p.trade_fiat.sent',
    effect: 'Inbox row for the seller when the buyer marks paid',
  },
  {
    event: 'p2pOfferPaused',
    durable: 'notify-p2p-offer-paused',
    subject: 'intafaced.p2p.offer.paused',
    effect: 'Inbox row for the maker when removing a payment method paused their ads',
  },
  {
    event: 'p2pRemarkCaseOpened',
    durable: 'notify-p2p-remark-case-opened',
    subject: 'intafaced.p2p.remark_case.opened',
    effect: 'Inbox row for the reported party when a payment-note remark is reported',
  },
  {
    event: 'kycApproved',
    durable: 'notify-kyc-approved',
    subject: 'intafaced.identity.kyc.approved',
    effect: 'Inbox row when verification tier is granted',
  },
  {
    event: 'securityFactorChanged',
    durable: 'notify-security-factor-changed',
    subject: 'intafaced.identity.security_factor.updated',
    effect: 'Inbox row when a sign-in factor is turned on, off, replaced, added or removed',
  },
  {
    event: 'rankUpdated',
    durable: 'notify-rank-updated',
    subject: 'intafaced.identity.rank.updated',
    effect: 'Inbox row when rank changes',
  },
  {
    event: 'stakeCreated',
    durable: 'notify-stake-created',
    subject: 'intafaced.token.stake.created',
    effect: 'Inbox row when a stake is locked',
  },
  {
    event: 'bankMarginCalled',
    durable: 'notify-bank-margin-called',
    subject: 'intafaced.bank.margin_call.created',
    effect: 'Critical inbox row + fan-out when a loan is called',
  },
  {
    event: 'personalRequestCreated',
    durable: 'notify-personal-request-created',
    subject: 'intafaced.bank.personal_request.created',
    effect: 'Inbox row pay.request_created for the person asked to pay',
  },
  {
    event: 'personalRequestSettled',
    durable: 'notify-personal-request-settled',
    subject: 'intafaced.bank.personal_request.settled',
    effect: 'Inbox row pay.request_paid for the person who was paid',
  },
  {
    event: 'personalTransferPosted',
    durable: 'notify-personal-transfer-posted',
    subject: 'intafaced.bank.personal_transfer.posted',
    effect: 'Inbox rows pay.transfer_received for the recipient and pay.transfer_sent for the sender of one posted personal send',
  },
  {
    event: 'payDepositCreditPosted',
    durable: 'notify-pay-deposit-credit-posted',
    subject: 'intafaced.pay.deposit_credit.posted',
    effect: 'Inbox row bank.deposit.credited for the customer whose crypto deposit the ledger credited, once per deposit',
  },
  {
    event: 'copySkipped',
    durable: 'notify-copy-skipped',
    subject: 'intafaced.trade.copy.skipped',
    effect: 'Inbox row trade.copy.skipped for the follower, the reason in words, once per follow and leader fill',
  },
  {
    event: 'copyStopped',
    durable: 'notify-copy-stopped',
    subject: 'intafaced.trade.copy.stopped',
    effect: 'Inbox row trade.copy.stopped for the follower, the reason in words, once per follow and close-only',
  },
  {
    event: 'bankScheduledReminder',
    durable: 'notify-bank-scheduled-reminder',
    subject: 'intafaced.bank.scheduled_reminder.triggered',
    effect: 'Inbox row bank.scheduled_reminder for the owner of a standing order due within their reminder lead time',
  },
  {
    event: 'bankScheduledFailed',
    durable: 'notify-bank-scheduled-failed',
    subject: 'intafaced.bank.scheduled_run.failed',
    effect: 'Inbox row bank.scheduled_failed for the owner of a standing order run the bank refused, with its reason',
  },
  {
    event: 'supportTicketResolved',
    durable: 'notify-support-ticket-resolved',
    subject: 'intafaced.support.ticket.resolved',
    effect: 'Inbox row support.rate_request asking the owner to rate a resolved request; email where an address is confirmed',
  },
  {
    event: 'agentActionRejected',
    durable: 'notify-agent-action-rejected',
    subject: 'intafaced.agents.action.rejected',
    effect: 'Inbox row when a guardrail refuses an agent action',
  },
  {
    event: 'agentActionCompleted',
    durable: 'notify-agent-action-completed',
    subject: 'intafaced.agents.action.completed',
    effect: 'Inbox row on completion / session_close only (not tool_call noise)',
  },
  {
    event: 'ledgerFreezeUpdated',
    durable: 'notify-ledger-freeze-updated',
    subject: 'intafaced.ledger.freeze.updated',
    effect: 'One audience-all inbox notice when the posting freeze is set or cleared (reason and actor never shown)',
  },
] as const;

/** Catalog subjects we deliberately do not fan out (and why). */
export const SKIPPED_NOTIFY_SUBJECTS: readonly { readonly event: string; readonly why: string }[] = [
  { event: 'p2pDisputeResolved', why: 'no user ids on payload' },
  { event: 'p2pTradeExpired', why: 'no user ids on payload' },
] as const;

export function notifyEventConsumerCount(): number {
  return NOTIFY_EVENT_CONSUMERS.length;
}

export function notifyEventDurableNames(): readonly string[] {
  return NOTIFY_EVENT_CONSUMERS.map((r) => r.durable);
}
