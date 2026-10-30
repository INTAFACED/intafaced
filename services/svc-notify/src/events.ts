import {
  agentActionCompleted,
  agentActionRejected,
  bankMarginCalled,
  personalRequestCreated,
  personalRequestSettled,
  personalTransferPosted,
  payDepositCreditPosted,
  bankScheduledReminder,
  bankScheduledFailed,
  copySkipped,
  copyStopped,
  agentUsageAlertCrossed,
  supportTicketResolved,
  fillSettled,
  kycApproved,
  ledgerFreezeUpdated,
  orderUpdated,
  p2pEscrowLocked,
  p2pEscrowRefunded,
  p2pEscrowReleased,
  p2pOfferPaused,
  p2pRemarkCaseOpened,
  p2pTradeDisputed,
  p2pTradeFiatSent,
  positionUpdated,
  rankUpdated,
  securityFactorChanged,
  stakeCreated,
  wiringSocketReason,
  type EventBus,
  type EventName,
  type Handler,
  type PayloadOf,
  type Subscription,
} from '@intafaced/events';
import type { MessageKey } from '@intafaced/i18n';
import { noticeFreezeChange } from './freeze-notice.js';
import { DEPOSIT_CREDITED_BODY_KEY, DEPOSIT_CREDITED_KIND, DEPOSIT_CREDITED_TITLE_KEY } from './deposit-credit-notice.js';
import type { CreateResult, NotifyService } from './notify-service.js';
import type { Severity } from './store.js';
import {
  NOTIFY_EVENT_CONSUMERS,
  SKIPPED_NOTIFY_SUBJECTS,
  notifyEventConsumerCount,
  notifyEventDurableNames,
} from './event-wiring-matrix.js';

/** Class B matrix — re-exported so production graph reaches the pin (reachability gate). */
export { NOTIFY_EVENT_CONSUMERS, SKIPPED_NOTIFY_SUBJECTS, notifyEventConsumerCount, notifyEventDurableNames };

/**
 * EVENT WIRING — fan-out.
 *
 * Durable consumers survive restarts. Inserts are ON CONFLICT DO NOTHING at the
 * store layer and each out-of-app send is claimed on `(notification, channel)`,
 * so at-least-once redelivery writes one row and sends one message. When fan-out
 * is killed (`NOTIFY_FANOUT_ENABLED` / `notify.fanout`), handlers still ack
 * without writing or sending.
 *
 * BACKPRESSURE, AND WHAT IT MEANS TO NAK
 *
 * A handler throws only when a channel wants another attempt — a gateway that
 * timed out, a 503. JetStream redelivers, the inbox insert dedupes, and only the
 * channel that failed is retried. A handler that threw on a permanently broken
 * address would burn the redelivery budget for the whole message and eventually
 * park a notification that three other channels delivered perfectly.
 *
 * Nothing is lost by falling behind: the stream retains 90 days and durable
 * consumers resume where they stopped. A consumer that cannot be created at all
 * — its producer has never published, so the stream does not exist yet — is
 * reported as PENDING rather than silently skipped. See `SubscriptionReport`.
 *
 * A subject is safe to add here only when it is already published, maps to a
 * userId principal, and has clear user-facing meaning. No invented publishers.
 * Skipped (no user ids on payload): p2pDisputeResolved, p2pTradeExpired.
 * p2pTradeDisputed notifies openedBy only — the counterparty is not on the payload.
 * p2pTradeFiatSent notifies the seller only — the buyer is the one who marked it.
 * orderUpdated notifies cancelled/rejected/expired only — fills already have fillSettled.
 * agentActionCompleted notifies completion/session_close only — never tool_call/embedding noise.
 */

/**
 * A consumer that could not be created, and the honest reason.
 *
 * DECLARED SOCKET, OR DEFECT — NEVER BOTH
 *
 * This used to be one flat list that produced one WARN per entry on every boot.
 * `bankMarginCalled` lived in that WARN forever while its publisher was missing,
 * so the warning fired at every start and trained operators to skim past it.
 *
 * A warning that is always there is not a warning. It is a permanent feature of
 * the log that teaches whoever reads it to skim past warnings — including the
 * next one, which will be about something that just broke.
 *
 * So a pending consumer is now one of exactly two things:
 *
 *   `socket` non-null   Somebody wrote down that this subject has no publisher
 *                       yet, in `WIRING_SOCKETS`, with a reason. Known, reviewed
 *                       and enforced by `pnpm scan:events`. Logged at INFO with
 *                       the recorded reason. Quiet, because it is accounted for.
 *
 *   `socket` null       Nothing in the repo admits this consumer cannot attach.
 *                       That is a defect. Logged at ERROR, counted on /ready, and
 *                       CI is already red on it — `scan:events` fails on an
 *                       undeclared orphan, so this state cannot reach `main`.
 *
 * Boot does not refuse either way, and that is deliberate: svc-notify's inbox is
 * healthy without any one consumer, and taking the whole inbox down over a single
 * dark subject would turn a wiring gap into an outage. The loudness lives where
 * it costs nothing — the gate, at the commit.
 *
 * Note: `bankMarginCalled` used to be the permanent pending example. svc-bank
 * now publishes it; the attach path and pending report remain for any future
 * subject whose stream is not yet created.
 */
export interface PendingConsumer {
  readonly event: EventName;
  readonly subject: string;
  readonly durable: string;
  readonly reason: string;
  /**
   * The reason recorded in `WIRING_SOCKETS` for this subject having no
   * publisher, or null when nothing has been written down. Null is the defect.
   */
  readonly socket: string | null;
}

export interface SubscriptionReport {
  readonly subscriptions: readonly Subscription[];
  /**
   * Consumers that do not exist yet, with the reason.
   *
   * Reported rather than thrown, because svc-notify's inbox API is perfectly
   * healthy without them; reported rather than swallowed, because "margin-call
   * notifications are not running" has to be visible from outside the process.
   * Surfaced on `/ready`, split by `socket` into declared and undeclared.
   */
  readonly pending: readonly PendingConsumer[];
}

/** The lifecycle states `intafaced.trade.position.updated` can carry. */
type PositionStatus = PayloadOf<'positionUpdated'>['status'];

/**
 * WHICH POSITION TRANSITIONS ARE WORTH A NOTIFICATION — AND WHY THIS IS A
 * POLICY OBJECT RATHER THAN AN `if`.
 *
 * `trade.position.updated` is a high-frequency stream: svc-trade's position
 * service publishes on every transition and `tick-stores` publishes again when
 * the mark price moves a position through liquidation. Notifying on all of them
 * would put an inbox row — and, for anyone with a confirmed address, an email —
 * behind every open and every close a trader makes. That is how an inbox stops
 * being read, and an inbox nobody reads is the same outage as an inbox nothing
 * writes to.
 *
 * So the default is the single transition the user did not ask for and cannot
 * infer from their own action: `liquidated`. Opening a position, closing one,
 * and starting to close one are all things the trader just did; being
 * liquidated is something that happened to them while they were not looking.
 *
 * WHICH OTHER STATES DESERVE A MESSAGE IS PRODUCT LAW, AND IT HAS NOT BEEN
 * DECIDED. This object is where that decision lands when it is made, and the
 * default here is the conservative one — the fewest messages that still covers
 * the case where silence costs the user money. Widening it is a one-line change
 * to `statuses` and two i18n keys per new state; it is deliberately NOT an env
 * variable, because "which notifications exist" is a product fact that should
 * be the same in every deployment rather than a per-environment surprise.
 */
export interface PositionNotifyPolicy {
  /** Transitions that produce an inbox row. Everything else is acked and not written. */
  readonly statuses: readonly PositionStatus[];
  /**
   * Severity for those rows.
   *
   * `critical` is not decoration here either: it is what makes the dispatcher
   * record a refusal on every out-of-app channel even when the trader
   * registered none, so "we had no way to reach you about your liquidation" is
   * a row written at the time rather than an inference from an empty table
   * afterwards. It is also what makes the message ignore a channel mute — the
   * same rule margin calls already run under, for the same reason.
   */
  readonly severity: Severity;
}

export const DEFAULT_POSITION_NOTIFY_POLICY: PositionNotifyPolicy = {
  statuses: ['liquidated'],
  severity: 'critical',
};

/** The lifecycle states `intafaced.trade.order.updated` can carry. */
type OrderStatus = PayloadOf<'orderUpdated'>['status'];

/**
 * WHICH ORDER TRANSITIONS ARE WORTH A NOTIFICATION.
 *
 * `trade.order.updated` is high-frequency: every pending/open/fill change.
 * Fills already produce `trade.fill` via `fillSettled`. Pending and open are
 * the trader's own click (and private WS already fans the live row).
 *
 * The inbox default is the three terminal states that can complete while the
 * app is closed: cancelled, rejected, expired. Widening is a one-line change
 * to `statuses` plus copy — not an env variable.
 */
export interface OrderTerminalNotifyPolicy {
  readonly statuses: readonly OrderStatus[];
  readonly severity: Severity;
}

export const DEFAULT_ORDER_TERMINAL_NOTIFY_POLICY: OrderTerminalNotifyPolicy = {
  statuses: ['cancelled', 'rejected', 'expired'],
  severity: 'info',
};

/** The inbox title for each sign-in factor change (I-signin-sessions-08); a new change will not compile without one. */
const FACTOR_CHANGED_TITLE_KEYS: Record<PayloadOf<'securityFactorChanged'>['change'], MessageKey> = {
  totp_added: 'notify.identity.security.totp_added.title',
  totp_removed: 'notify.identity.security.totp_removed.title',
  totp_replaced: 'notify.identity.security.totp_replaced.title',
  passkey_added: 'notify.identity.security.passkey_added.title',
  passkey_removed: 'notify.identity.security.passkey_removed.title',
};

/** The action kinds `intafaced.agents.action.completed` can carry. */
type AgentActionKind = PayloadOf<'agentActionCompleted'>['kind'];

/**
 * WHICH AGENT COMPLETIONS ARE WORTH A NOTIFICATION.
 *
 * `agents.action.completed` is high-frequency: every tool_call, embedding, and
 * usage_settlement publishes. The user-facing log is already `agent_actions`
 * under the caller's authorisation. Inbox fan-out is only the two kinds a
 * person would miss with the app closed: a finished reply, and a session close.
 *
 * Everything else is ACKED AND NOT WRITTEN — same posture as position/order.
 */
export interface AgentActionCompletedNotifyPolicy {
  readonly kinds: readonly AgentActionKind[];
  readonly severity: Severity;
}

export const DEFAULT_AGENT_ACTION_COMPLETED_NOTIFY_POLICY: AgentActionCompletedNotifyPolicy = {
  kinds: ['completion', 'session_close'],
  severity: 'info',
};

export interface SubscribeOptions {
  /** Override the conservative default above. Production boots without one. */
  readonly positionNotify?: PositionNotifyPolicy;
  readonly orderNotify?: OrderTerminalNotifyPolicy;
  readonly agentActionCompletedNotify?: AgentActionCompletedNotifyPolicy;
}

/**
 * Throw when — and only when — a channel wants another attempt.
 *
 * The message names the channel on purpose. An operator reading a nak needs to
 * know which transport is unhappy, not that "dispatch failed".
 */
function nakIfRetryable(...results: readonly CreateResult[]): void {
  const wants = results.filter((r) => r.dispatch?.retry);
  if (wants.length === 0) return;
  const detail = wants
    .flatMap((r) => r.dispatch!.outcomes.filter((o) => o.retryable).map((o) => `${o.channel}: ${o.detail ?? 'unknown'}`))
    .join('; ');
  throw new Error(`notify fan-out wants a retry for ${wants[0]!.dispatch!.notificationId} — ${detail}`);
}

interface Attachment {
  subscription: Subscription | null;
  pending: PendingConsumer | null;
}

/**
 * Subscribe, or report why not.
 *
 * The failure this tolerates is real and specific: a durable consumer cannot be
 * created against a stream that does not exist, and a stream does not exist
 * until its owning service has connected a bus. Refusing to boot over it
 * would take the whole inbox down for every other subject; skipping it in
 * silence would leave nobody able to tell that notifications for that subject
 * are dark. So: attach what attaches, and report the rest by name.
 */
async function attach<K extends EventName>(
  bus: EventBus,
  event: K,
  subject: string,
  durable: string,
  handler: Handler<K>,
): Promise<Attachment> {
  try {
    return { subscription: await bus.subscribe(event, handler, { durable }), pending: null };
  } catch (err) {
    return {
      subscription: null,
      pending: {
        event,
        subject,
        durable,
        reason: err instanceof Error ? err.message : String(err),
        // The catalog is the single place a missing publisher is recorded, so
        // the boot log and `pnpm scan:events` cannot disagree about which
        // subjects are known-dark. One list, two readers.
        socket: wiringSocketReason(event, 'publisher'),
      },
    };
  }
}

export async function subscribeNotificationEvents(
  bus: EventBus,
  notify: NotifyService,
  options: SubscribeOptions = {},
): Promise<SubscriptionReport> {
  const attachments: Attachment[] = [];
  const positionPolicy = options.positionNotify ?? DEFAULT_POSITION_NOTIFY_POLICY;
  const agentCompletedPolicy = options.agentActionCompletedNotify ?? DEFAULT_AGENT_ACTION_COMPLETED_NOTIFY_POLICY;
  const orderPolicy = options.orderNotify ?? DEFAULT_ORDER_TERMINAL_NOTIFY_POLICY;

  attachments.push(
    await attach(bus, 'fillSettled', fillSettled.subject, 'notify-fill-settled', async (payload) => {
      nakIfRetryable(
        await notify.create({
          userId: payload.userId,
          kind: 'trade.fill',
          titleKey: 'notify.trade.fill.title',
          bodyKey: 'notify.trade.fill.body',
          params: {
            fillId: payload.fillId,
            orderId: payload.orderId,
            marketId: payload.marketId,
            side: payload.side,
            price: payload.price,
            qty: payload.qty,
          },
          href: `/trade/orders/${payload.orderId}`,
          severity: 'info',
          sourceSubject: fillSettled.subject,
          sourceIdempotencyKey: payload.fillId,
        }),
      );
    }),
  );

  attachments.push(
    await attach(bus, 'orderUpdated', orderUpdated.subject, 'notify-order-updated', async (payload) => {
      if (!orderPolicy.statuses.includes(payload.status)) return;

      nakIfRetryable(
        await notify.create({
          userId: payload.userId,
          kind: 'trade.order.terminal',
          titleKey: 'notify.trade.order.terminal.title',
          bodyKey: 'notify.trade.order.terminal.body',
          params: {
            orderId: payload.orderId,
            marketId: payload.marketId,
            status: payload.status,
            side: payload.side,
            type: payload.type,
            qty: payload.qty,
            filledQty: payload.filledQty,
            price: payload.price,
            clientOrderId: payload.clientOrderId,
            ts: payload.ts,
          },
          href: `/trade/orders/${payload.orderId}`,
          severity: orderPolicy.severity,
          sourceSubject: orderUpdated.subject,
          sourceIdempotencyKey: `${payload.orderId}:${payload.status}`,
        }),
      );
    }),
  );

  attachments.push(
    await attach(bus, 'positionUpdated', positionUpdated.subject, 'notify-position-updated', async (payload) => {
      /**
       * THE OTHER MONEY-ADJACENT ONE.
       *
       * A liquidation is the futures twin of a margin call: collateral was
       * consumed and the trader was not the one who decided it. svc-ws already
       * fans this subject to the owning principal, but a private WebSocket
       * reaches exactly the people who happen to have the app open — which is
       * the opposite of the population that needs to hear about a liquidation.
       * This consumer is the durable half of that same fact.
       *
       * Everything not on the policy is ACKED AND NOT WRITTEN. That is a real
       * decision, not a shortcut: see `PositionNotifyPolicy` for why the default
       * is `liquidated` alone. It is also why this returns before `notify.create`
       * rather than filtering afterwards — a suppressed row must never reach the
       * dispatcher, or a muted-but-critical rule would send a message for a
       * notification the inbox does not contain.
       *
       * The business key is `<positionId>:<status>`, not the position id: the
       * policy may later cover more than one transition of the same position,
       * and keying on the id alone would silently swallow every state after the
       * first. `ts` is deliberately NOT in the key — a redelivery carries the
       * same timestamp, but a producer that re-publishes with a fresh one would
       * turn a duplicate into a second liquidation notice.
       *
       * Every amount below crosses as the decimal string it arrived as. None of
       * these is parsed, summed or compared here, and nothing in this service
       * holds a position — svc-trade owns the position and the ledger owns the
       * value (§0.6).
       */
      if (!positionPolicy.statuses.includes(payload.status)) return;

      nakIfRetryable(
        await notify.create({
          userId: payload.userId,
          kind: 'trade.position.liquidated',
          titleKey: 'notify.trade.position.liquidated.title',
          bodyKey: 'notify.trade.position.liquidated.body',
          params: {
            positionId: payload.positionId,
            marketId: payload.marketId,
            symbol: payload.symbol,
            side: payload.side,
            status: payload.status,
            contracts: payload.contracts,
            entryPrice: payload.entryPrice,
            notional: payload.notional,
            ts: payload.ts,
          },
          href: '/trade/futures',
          severity: positionPolicy.severity,
          sourceSubject: positionUpdated.subject,
          sourceIdempotencyKey: `${payload.positionId}:${payload.status}`,
        }),
      );
    }),
  );

  attachments.push(
    await attach(bus, 'p2pEscrowLocked', p2pEscrowLocked.subject, 'notify-p2p-escrow-locked', async (payload) => {
      const base = {
        kind: 'p2p.escrow.locked',
        titleKey: 'notify.p2p.escrow.locked.title',
        bodyKey: 'notify.p2p.escrow.locked.body',
        params: {
          tradeId: payload.tradeId,
          asset: payload.asset,
          amount: payload.amount,
          fiatCurrency: payload.fiatCurrency,
          fiatAmount: payload.fiatAmount,
        },
        href: `/p2p/orders/${payload.tradeId}`,
        severity: 'action' as const,
        sourceSubject: p2pEscrowLocked.subject,
      };

      // Both sides of the escrow need the signal; the unique key includes user_id.
      const seller = await notify.create({ ...base, userId: payload.sellerId, sourceIdempotencyKey: `${payload.tradeId}:seller` });
      const buyer = await notify.create({ ...base, userId: payload.buyerId, sourceIdempotencyKey: `${payload.tradeId}:buyer` });
      nakIfRetryable(seller, buyer);
    }),
  );

  attachments.push(
    await attach(bus, 'p2pEscrowReleased', p2pEscrowReleased.subject, 'notify-p2p-escrow-released', async (payload) => {
      const base = {
        kind: 'p2p.escrow.released',
        titleKey: 'notify.p2p.escrow.released.title',
        bodyKey: 'notify.p2p.escrow.released.body',
        params: {
          tradeId: payload.tradeId,
          asset: payload.asset,
          amount: payload.amount,
          fee: payload.fee,
          resolvedBy: payload.resolvedBy,
        },
        href: `/p2p/orders/${payload.tradeId}`,
        severity: 'info' as const,
        sourceSubject: p2pEscrowReleased.subject,
      };

      const seller = await notify.create({ ...base, userId: payload.sellerId, sourceIdempotencyKey: `${payload.tradeId}:seller` });
      const buyer = await notify.create({ ...base, userId: payload.buyerId, sourceIdempotencyKey: `${payload.tradeId}:buyer` });
      nakIfRetryable(seller, buyer);
    }),
  );

  attachments.push(
    await attach(bus, 'p2pEscrowRefunded', p2pEscrowRefunded.subject, 'notify-p2p-escrow-refunded', async (payload) => {
      const base = {
        kind: 'p2p.escrow.refunded',
        titleKey: 'notify.p2p.escrow.refunded.title',
        bodyKey: 'notify.p2p.escrow.refunded.body',
        params: {
          tradeId: payload.tradeId,
          asset: payload.asset,
          amount: payload.amount,
          resolvedBy: payload.resolvedBy,
          reason: payload.reason,
        },
        href: `/p2p/orders/${payload.tradeId}`,
        severity: 'action' as const,
        sourceSubject: p2pEscrowRefunded.subject,
      };

      const seller = await notify.create({ ...base, userId: payload.sellerId, sourceIdempotencyKey: `${payload.tradeId}:seller` });
      const buyer = await notify.create({ ...base, userId: payload.buyerId, sourceIdempotencyKey: `${payload.tradeId}:buyer` });
      nakIfRetryable(seller, buyer);
    }),
  );

  attachments.push(
    await attach(bus, 'p2pTradeDisputed', p2pTradeDisputed.subject, 'notify-p2p-trade-disputed', async (payload) => {
      // Payload only carries openedBy — no counterparty id. Honest single-recipient fan-out.
      nakIfRetryable(
        await notify.create({
          userId: payload.openedBy,
          kind: 'p2p.trade.disputed',
          titleKey: 'notify.p2p.trade.disputed.title',
          bodyKey: 'notify.p2p.trade.disputed.body',
          params: {
            tradeId: payload.tradeId,
            disputeId: payload.disputeId,
            reason: payload.reason,
            moderatorDeadline: payload.moderatorDeadline,
          },
          href: `/p2p/orders/${payload.tradeId}`,
          severity: 'action',
          sourceSubject: p2pTradeDisputed.subject,
          sourceIdempotencyKey: payload.disputeId,
        }),
      );
    }),
  );

  attachments.push(
    await attach(bus, 'p2pTradeFiatSent', p2pTradeFiatSent.subject, 'notify-p2p-trade-fiat-sent', async (payload) => {
      // P-trade-orders-23: the buyer says the money is on its way; the seller is the one who must check and release.
      // One notice per trade: a trade is marked paid once, so the trade id is the business key.
      nakIfRetryable(
        await notify.create({
          userId: payload.sellerId,
          kind: 'p2p.trade.fiat_sent',
          titleKey: 'notify.p2p.trade.fiat_sent.title',
          bodyKey: 'notify.p2p.trade.fiat_sent.body',
          params: { tradeId: payload.tradeId },
          href: `/p2p/orders/${payload.tradeId}`,
          severity: 'action',
          sourceSubject: p2pTradeFiatSent.subject,
          sourceIdempotencyKey: `${payload.tradeId}:seller`,
        }),
      );
    }),
  );

  attachments.push(
    await attach(bus, 'p2pOfferPaused', p2pOfferPaused.subject, 'notify-p2p-offer-paused', async (payload) => {
      // P-ads-merchant-18: the maker removed the only payment method some of their ads could be paid with, so svc-p2p
      // paused them. One notice per removal: an instrument is removed once, so the instrument id is the business key.
      nakIfRetryable(
        await notify.create({
          userId: payload.makerId,
          kind: 'p2p.offer.paused',
          titleKey: 'notify.p2p.offer.paused.title',
          bodyKey: 'notify.p2p.offer.paused.body',
          params: { instrumentId: payload.instrumentId, methodId: payload.methodId, count: String(payload.offerIds.length) },
          href: '/uc/ad',
          severity: 'action',
          sourceSubject: p2pOfferPaused.subject,
          sourceIdempotencyKey: `${payload.instrumentId}:maker`,
        }),
      );
    }),
  );

  attachments.push(
    await attach(bus, 'p2pRemarkCaseOpened', p2pRemarkCaseOpened.subject, 'notify-p2p-remark-case-opened', async (payload) => {
      // P-ads-merchant-19: the seller reported a remark in the buyer's payment note (svc-p2p lets only the seller report)
      // and a case opened for staff. The reported party is told once per case, for information: staff decide, and the order shows the case. The remark itself
      // stays with svc-p2p and never travels on the bus.
      nakIfRetryable(
        await notify.create({
          userId: payload.reportedId,
          kind: 'p2p.remark_case.opened',
          titleKey: 'notify.p2p.remark_case.opened.title',
          bodyKey: 'notify.p2p.remark_case.opened.body',
          params: { caseId: payload.caseId, tradeId: payload.tradeId },
          href: `/p2p/orders/${payload.tradeId}`,
          severity: 'info',
          sourceSubject: p2pRemarkCaseOpened.subject,
          sourceIdempotencyKey: `${payload.caseId}:reported`,
        }),
      );
    }),
  );

  attachments.push(
    await attach(bus, 'kycApproved', kycApproved.subject, 'notify-kyc-approved', async (payload) => {
      nakIfRetryable(
        await notify.create({
          userId: payload.userId,
          kind: 'identity.kyc.approved',
          titleKey: 'notify.identity.kyc.approved.title',
          bodyKey: 'notify.identity.kyc.approved.body',
          params: { tier: payload.tier, jurisdiction: payload.jurisdiction },
          href: '/verification',
          severity: 'action',
          sourceSubject: kycApproved.subject,
          sourceIdempotencyKey: `${payload.userId}:${payload.tier}`,
        }),
      );
    }),
  );

  attachments.push(
    await attach(bus, 'securityFactorChanged', securityFactorChanged.subject, 'notify-security-factor-changed', async (payload) => {
      // I-signin-sessions-08: a sign-in factor of the account changed. The security category cannot be turned off, and the
      // notice points to Security, where the owner can sign out everywhere if it was not them. One row per change: the
      // business key from svc-identity is the dedupe key. Inbox only: svc-identity already mails the proved address in the
      // change's own transaction, and that mail is never muted or held for a digest.
      nakIfRetryable(
        await notify.create({
          userId: payload.userId,
          kind: `identity.security.${payload.change}`,
          titleKey: FACTOR_CHANGED_TITLE_KEYS[payload.change],
          bodyKey: 'notify.identity.security.factor_changed.body',
          params: {},
          href: '/uc/safe',
          severity: 'action',
          sourceSubject: securityFactorChanged.subject,
          sourceIdempotencyKey: payload.noticeKey,
          outOfApp: false,
        }),
      );
    }),
  );

  attachments.push(
    await attach(bus, 'rankUpdated', rankUpdated.subject, 'notify-rank-updated', async (payload) => {
      nakIfRetryable(
        await notify.create({
          userId: payload.userId,
          kind: 'identity.rank.updated',
          titleKey: 'notify.identity.rank.updated.title',
          bodyKey: 'notify.identity.rank.updated.body',
          params: { rank: payload.rank, previousRank: payload.previousRank, xp: payload.xp },
          href: '/uc/account',
          severity: 'action',
          sourceSubject: rankUpdated.subject,
          sourceIdempotencyKey: `${payload.userId}:${payload.previousRank}:${payload.rank}`,
        }),
      );
    }),
  );

  attachments.push(
    await attach(bus, 'stakeCreated', stakeCreated.subject, 'notify-stake-created', async (payload) => {
      nakIfRetryable(
        await notify.create({
          userId: payload.userId,
          kind: 'token.stake.created',
          titleKey: 'notify.token.stake.created.title',
          bodyKey: 'notify.token.stake.created.body',
          params: { stakeId: payload.stakeId, amount: payload.amount, tier: payload.tier, unlocksAt: payload.unlocksAt },
          href: '/token',
          severity: 'info',
          sourceSubject: stakeCreated.subject,
          sourceIdempotencyKey: payload.stakeId,
        }),
      );
    }),
  );

  attachments.push(
    await attach(bus, 'bankMarginCalled', bankMarginCalled.subject, 'notify-bank-margin-called', async (payload) => {
      /**
       * THE MONEY-ADJACENT ONE.
       *
       * `critical` is not decoration. Severity `critical` is what makes the
       * dispatcher record a refusal on every out-of-app channel even when the
       * borrower registered none — so if this loan is liquidated and the
       * borrower asks whether they were warned, the answer is a row rather than
       * an inference from an empty table.
       *
       * The business key is `<loanId>:<sequence>`, not the loan id: a loan can
       * be called, cured and called again, and the second call is a different
       * fact that must produce a second notification. Keying on loan id alone
       * would silently swallow every call after the first.
       */
      nakIfRetryable(
        await notify.create({
          userId: payload.userId,
          kind: 'bank.margin_call',
          titleKey: 'notify.bank.margin_call.title',
          bodyKey: 'notify.bank.margin_call.body',
          params: {
            loanId: payload.loanId,
            ltvBps: payload.ltvBps,
            cureCollateralAmount: payload.cureCollateralAmount,
            collateralAssetId: payload.collateralAssetId,
            graceExpiresAt: payload.graceExpiresAt,
            calledAt: payload.calledAt,
            sequence: payload.sequence,
          },
          href: `/bank/loans/${payload.loanId}`,
          severity: 'critical',
          sourceSubject: bankMarginCalled.subject,
          sourceIdempotencyKey: `${payload.loanId}:${payload.sequence}`,
        }),
      );
    }),
  );

  attachments.push(
    await attach(bus, 'agentActionRejected', agentActionRejected.subject, 'notify-agent-action-rejected', async (payload) => {
      nakIfRetryable(
        await notify.create({
          userId: payload.userId,
          kind: 'agents.action.rejected',
          titleKey: 'notify.agents.action.rejected.title',
          bodyKey: 'notify.agents.action.rejected.body',
          params: {
            refusalCode: payload.refusalCode,
            tool: payload.tool ?? '—',
            task: payload.task ?? '—',
            sessionId: payload.sessionId,
            agentId: payload.agentId,
          },
          href: `/agents/sessions/${payload.sessionId}`,
          severity: 'action',
          sourceSubject: agentActionRejected.subject,
          sourceIdempotencyKey: `${payload.sessionId}:${payload.sequence}`,
        }),
      );
    }),
  );

  attachments.push(
    await attach(bus, 'agentActionCompleted', agentActionCompleted.subject, 'notify-agent-action-completed', async (payload) => {
      /**
       * High-frequency stream. tool_call / embedding / session_open /
       * usage_settlement are already on agent_actions; writing them here would
       * turn the inbox into a telemetry dump. Return before notify.create so a
       * suppressed kind never reaches the dispatcher.
       *
       * Business key is `<sessionId>:<sequence>` — the same grain the publisher
       * uses. Kind is not in the key: a given sequence has one kind.
       */
      if (!agentCompletedPolicy.kinds.includes(payload.kind)) return;

      nakIfRetryable(
        await notify.create({
          userId: payload.userId,
          kind: 'agents.action.completed',
          titleKey: 'notify.agents.action.completed.title',
          bodyKey: 'notify.agents.action.completed.body',
          params: {
            kind: payload.kind,
            task: payload.task ?? '—',
            tool: payload.tool ?? '—',
            sessionId: payload.sessionId,
            agentId: payload.agentId,
            sequence: payload.sequence,
          },
          href: `/agents/sessions/${payload.sessionId}`,
          severity: agentCompletedPolicy.severity,
          sourceSubject: agentActionCompleted.subject,
          sourceIdempotencyKey: `${payload.sessionId}:${payload.sequence}`,
          // Inbox only — email/SMS/push stay refuse-until-credentials (#1991).
          outOfApp: false,
        }),
      );
    }),
  );

  attachments.push(
    await attach(bus, 'personalRequestCreated', personalRequestCreated.subject, 'notify-personal-request-created', async (payload) => {
      nakIfRetryable(
        await notify.create({
          userId: payload.payerUserId,
          kind: 'pay.request_created',
          titleKey: 'notify.pay.request_created.title',
          bodyKey: 'notify.pay.request_created.body',
          params: {
            payeeHandle: payload.payeeHandle,
            amount: payload.amount,
            assetId: payload.assetId,
            note: payload.note ?? '',
            expiresAt: payload.expiresAt,
            requestId: payload.requestId,
            sequence: payload.sequence,
          },
          href: `/pay/request/${payload.requestId}`,
          severity: 'action',
          sourceSubject: personalRequestCreated.subject,
          sourceIdempotencyKey: `${payload.requestId}:${payload.sequence}`,
        }),
      );
    }),
  );

  attachments.push(
    await attach(bus, 'personalRequestSettled', personalRequestSettled.subject, 'notify-personal-request-settled', async (payload) => {
      nakIfRetryable(
        await notify.create({
          userId: payload.payeeUserId,
          kind: 'pay.request_paid',
          titleKey: 'notify.pay.request_paid.title',
          bodyKey: 'notify.pay.request_paid.body',
          params: {
            payerHandle: payload.payerHandle,
            amount: payload.amount,
            assetId: payload.assetId,
            requestId: payload.requestId,
            ledgerTxId: payload.ledgerTxId,
          },
          href: `/pay/request/${payload.requestId}`,
          severity: 'info',
          sourceSubject: personalRequestSettled.subject,
          sourceIdempotencyKey: payload.requestId,
        }),
      );
    }),
  );

  attachments.push(
    await attach(bus, 'personalTransferPosted', personalTransferPosted.subject, 'notify-personal-transfer-posted', async (payload) => {
      // One posted transfer, one notice each: the recipient learns money arrived, the sender keeps the receipt.
      // Deduped per person on the transfer id, so a redelivered event writes nothing new. Both rows are written
      // before a retry is asked for, so one person's channel outage never holds back the other's notice. A send
      // to oneself is only a receipt: the money never left the person.
      const common = {
        params: { amount: payload.amount, assetId: payload.assetId, transferId: payload.transferId, ledgerTxId: payload.ledgerTxId },
        href: '/money/activity?tab=transfers',
        severity: 'info' as const,
        sourceSubject: personalTransferPosted.subject,
        sourceIdempotencyKey: payload.transferId,
      };
      const received =
        payload.recipientUserId === payload.senderUserId
          ? null
          : await notify.create({
              ...common,
              userId: payload.recipientUserId,
              kind: 'pay.transfer_received',
              titleKey: 'notify.pay.transfer_received.title',
              bodyKey: 'notify.pay.transfer_received.body',
            });
      const sent = await notify.create({
        ...common,
        userId: payload.senderUserId,
        kind: 'pay.transfer_sent',
        titleKey: 'notify.pay.transfer_sent.title',
        bodyKey: 'notify.pay.transfer_sent.body',
      });
      nakIfRetryable(...(received ? [received, sent] : [sent]));
    }),
  );

  // Copy trading (J-copy-bots-otc-03 #6): svc-trade publishes after the skip row or the stop is saved. The notice says
  // why, in words keyed by the reason id, and what the person can do; it never shows a raw code. Inbox only.
  attachments.push(
    await attach(bus, 'copySkipped', copySkipped.subject, 'notify-copy-skipped', async (payload) => {
      // A skip the follower chose (a pause or a stop) is theirs already; svc-trade does not send it, and none is written.
      if (payload.reason === 'paused' || payload.reason === 'stopped') return;
      nakIfRetryable(
        await notify.create({
          userId: payload.followerId,
          kind: 'trade.copy.skipped',
          titleKey: 'notify.trade.copy_skipped.title',
          bodyKey: `notify.trade.copy_skipped.body.${payload.reason}`,
          params: { followId: payload.followId, leaderFillId: payload.leaderFillId },
          href: '/trade/copy?tab=follows',
          severity: 'action',
          sourceSubject: copySkipped.subject,
          // One notice per follow and leader fill, however often svc-trade sends it.
          sourceIdempotencyKey: `${payload.followId}:${payload.leaderFillId}`,
          outOfApp: false,
        }),
      );
    }),
  );

  attachments.push(
    await attach(bus, 'copyStopped', copyStopped.subject, 'notify-copy-stopped', async (payload) => {
      const variant = payload.reason === 'follower' && payload.closeOnly ? 'follower_close_only' : payload.reason;
      nakIfRetryable(
        await notify.create({
          userId: payload.followerId,
          kind: 'trade.copy.stopped',
          titleKey: 'notify.trade.copy_stopped.title',
          bodyKey: `notify.trade.copy_stopped.body.${variant}`,
          params: { followId: payload.followId },
          href: '/trade/copy?tab=follows',
          severity: payload.reason === 'follower' ? 'info' : 'action',
          sourceSubject: copyStopped.subject,
          // A stop is one-way, so one notice per follow and close-only.
          sourceIdempotencyKey: `${payload.followId}:${payload.closeOnly}`,
          outOfApp: false,
        }),
      );
    }),
  );

  // An own agent's monthly spend alert (J-agents-02 #6): svc-agents records it once per agent and UTC month and
  // publishes it on that business key, so the owner gets one inbox row for it however often it is sent. Email is the
  // person's choice on the Limits page, which shows that channel's real state; this row is the in-app notice.
  attachments.push(
    await attach(bus, 'agentUsageAlertCrossed', agentUsageAlertCrossed.subject, 'notify-agent-usage-alert', async (payload) => {
      nakIfRetryable(
        await notify.create({
          userId: payload.userId,
          kind: 'agents.usage_alert.crossed',
          titleKey: 'notify.agents.usage_alert.crossed.title',
          bodyKey: 'notify.agents.usage_alert.crossed.body',
          params: { spent: payload.spent, alertAt: payload.alertAt, asset: payload.assetId, month: payload.month },
          href: `/agents/${payload.agentId}`,
          severity: 'action',
          sourceSubject: agentUsageAlertCrossed.subject,
          sourceIdempotencyKey: payload.alertKey,
          outOfApp: false,
        }),
      );
    }),
  );

  attachments.push(
    await attach(bus, 'payDepositCreditPosted', payDepositCreditPosted.subject, 'notify-pay-deposit-credit-posted', async (payload) => {
      // svc-pay publishes after the ledger post that credited the deposit, so the notice says what already happened.
      // Deduped on the deposit: svc-pay announces again after a crash, and a redelivery writes nothing new.
      nakIfRetryable(
        await notify.create({
          userId: payload.userId,
          kind: DEPOSIT_CREDITED_KIND,
          titleKey: DEPOSIT_CREDITED_TITLE_KEY,
          bodyKey: DEPOSIT_CREDITED_BODY_KEY,
          params: {
            amount: payload.amount,
            asset: payload.assetId,
            networkId: payload.networkId,
            depositId: payload.depositId,
            txHash: payload.txHash,
            ledgerTxId: payload.ledgerTxId,
          },
          // The deposit room on the asset and network that were credited, where its record is.
          href: `/uc/recharge?asset=${encodeURIComponent(payload.assetId)}&network=${encodeURIComponent(payload.networkId)}`,
          severity: 'info',
          sourceSubject: payDepositCreditPosted.subject,
          sourceIdempotencyKey: payload.depositId,
          // Inbox only, as the deposit notice has always been: a credit is not worth an email, SMS or push each time.
          outOfApp: false,
        }),
      );
    }),
  );

  // One notice per standing-order run and kind, deduped on schedule and run, so a redelivered event writes nothing new.
  const standingOrder = (payload: { userId: string; scheduleId: string; occurrence: number; amount: string; assetId: string }) => ({
    userId: payload.userId,
    href: '/bank/transfers',
    sourceIdempotencyKey: `${payload.scheduleId}:${payload.occurrence}`,
    params: { scheduleId: payload.scheduleId, occurrence: String(payload.occurrence), amount: payload.amount, assetId: payload.assetId },
  });

  attachments.push(
    await attach(bus, 'bankScheduledReminder', bankScheduledReminder.subject, 'notify-bank-scheduled-reminder', async (payload) => {
      // svc-bank drops a reminder whose run is due before it publishes; a reminder read late (this service was down or
      // behind) is dropped here too, so nobody is told to top up for a run that has already happened.
      if (Date.parse(payload.dueAt) <= Date.now()) return;
      const base = standingOrder(payload);
      nakIfRetryable(
        await notify.create({
          ...base,
          kind: 'bank.scheduled_reminder',
          titleKey: 'notify.bank.scheduled_reminder.title',
          bodyKey: 'notify.bank.scheduled_reminder.body',
          params: { ...base.params, dueAt: payload.dueAt, dueDate: payload.dueAt.slice(0, 10), leadHours: String(payload.leadHours) },
          severity: 'info',
          sourceSubject: bankScheduledReminder.subject,
        }),
      );
    }),
  );

  attachments.push(
    await attach(bus, 'bankScheduledFailed', bankScheduledFailed.subject, 'notify-bank-scheduled-failed', async (payload) => {
      // A run the bank refused took nothing; the person hears once, with the bank's reason as a reference.
      const base = standingOrder(payload);
      nakIfRetryable(
        await notify.create({
          ...base,
          kind: 'bank.scheduled_failed',
          titleKey: 'notify.bank.scheduled_failed.title',
          bodyKey: 'notify.bank.scheduled_failed.body',
          params: { ...base.params, reasonCode: payload.reasonCode, failedAt: payload.failedAt },
          severity: 'action',
          sourceSubject: bankScheduledFailed.subject,
        }),
      );
    }),
  );

  attachments.push(
    await attach(bus, 'ledgerFreezeUpdated', ledgerFreezeUpdated.subject, 'notify-ledger-freeze-updated', async (payload) => {
      // Reason and actor stay behind: a customer notice says only that postings paused or resumed.
      await noticeFreezeChange(notify, { frozen: payload.frozen, changedAt: payload.changedAt });
    }),
  );

  attachments.push(
    await attach(bus, 'supportTicketResolved', supportTicketResolved.subject, 'notify-support-ticket-resolved', async (payload) => {
      nakIfRetryable(
        await notify.create({
          userId: payload.userId,
          kind: 'support.rate_request',
          titleKey: 'notify.support.rate_request.title',
          bodyKey: 'notify.support.rate_request.body',
          params: { ticketId: payload.ticketId },
          href: '/support',
          severity: 'info',
          sourceSubject: supportTicketResolved.subject,
          // One ask per request: svc-support publishes it once, on the first resolve.
          sourceIdempotencyKey: payload.ticketId,
        }),
      );
    }),
  );

  // Class B growth pin: attach count must match the deliberate matrix.
  // A casual second attach without a matrix row fails here at boot, not in CI only.
  if (attachments.length !== notifyEventConsumerCount()) {
    throw new Error(`notify event-wiring drift: attached ${attachments.length} consumers, matrix has ${notifyEventConsumerCount()}`);
  }

  return {
    subscriptions: attachments.map((a) => a.subscription).filter((s): s is Subscription => s !== null),
    pending: attachments.map((a) => a.pending).filter((p): p is PendingConsumer => p !== null),
  };
}
