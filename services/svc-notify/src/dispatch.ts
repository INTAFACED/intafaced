import type { ChannelRegistry } from './channels/registry.js';
import {
  ChannelDeliveryError,
  ChannelRefusal,
  OUT_OF_APP_CHANNELS,
  type ChannelId,
  type OutOfAppChannel,
  type RefusalCode,
} from './channels/channel.js';
import { normaliseLocale, renderNotification } from './channels/render.js';
import type { ChannelTarget, DeliveryRecord, DeliveryStore, TargetStore } from './channel-store.js';
import type { Notification } from './store.js';
import { withNotifySpan } from './tracing.js';
import { EMPTY_MUTE_PREFS, isChannelMuted, type ChannelMutePrefs, type MuteableChannel, type NotifySeverity } from './preferences/mute.js';
import type { OutOfAppPlan } from './preferences/gate.js';

/**
 * FAN-OUT.
 *
 * One notification, several channels, at-least-once bus delivery underneath.
 * Three properties have to hold at once and each one is load-bearing:
 *
 * 1. A REDELIVERED EVENT MUST NOT DOUBLE-NOTIFY. Every send is guarded by a
 *    claim on `(notification_id, channel)`. The guard is the database, not a
 *    process-local set, because two replicas consuming the same durable
 *    consumer would each hold their own set and each send.
 *
 * 2. A CHANNEL THAT DID NOT DELIVER MUST NOT READ AS DELIVERED. Every outcome
 *    is written back: accepted, refused with a code, failed with the detail.
 *    There is no path through this file where a message is dropped and nothing
 *    is written.
 *
 * 3. A TRANSIENT FAILURE MUST BE RETRIED, AND A PERMANENT ONE MUST NOT. The
 *    report says whether the caller should let the bus redeliver. Nak'ing a
 *    permanently broken address would burn the redelivery budget of every other
 *    channel on the same message and eventually park a notification that three
 *    other channels handled perfectly.
 *
 * WHICH CHANNELS ARE TRIED
 *
 *   in-app        always. It needs no credentials and no address, so it is the
 *                 honest fallback (§13) when the owner has obtained nothing.
 *   out-of-app    when the user has a CONFIRMED address for it. An address the
 *                 user never confirmed is not an address we may use.
 *
 * When the user has no confirmed address and the notification is `critical`, the
 * refusal is still recorded, and it says WHICH kind of nothing it was:
 * `channel.no_target` when the user gave us no address at all,
 * `channel.target_unverified` when they gave us one and never confirmed it. A
 * margin call that reached nobody but the inbox is exactly the fact a borrower
 * disputing a liquidation needs, and "we have no way to contact you" has to be
 * on the record at the moment it mattered — not inferred later from an empty
 * table, and not collapsed into a sentence that hides a fix the user could have
 * made in one click.
 *
 * That holds whether or not `NOTIFY_OUT_OF_APP_ENABLED` is on. The operator
 * switch changes the REASON on the row, never whether a critical message gets
 * one — a kill-switch that also switched off the record would make the state
 * with the highest liability the state with the least evidence.
 */

/**
 * Kinds whose mailed copy is owed, not only offered where an address is confirmed. With no email sender set, such a
 * message's email row waits `pending` with `vendor.email` instead of being skipped, so the record shows the mail is owed
 * and nothing claims it went. The rating ask (SP-csat-01) is one.
 */
export const MAILED_KINDS: ReadonlySet<string> = new Set(['support.rate_request']);

export interface DispatchOptions {
  /** Attempts per channel before the row is abandoned. Pair with the bus `maxDeliver`. */
  readonly maxAttempts: number;
  /** Operator switch for everything that leaves the platform. The inbox is unaffected. */
  readonly outOfAppEnabled: boolean;
  /** Channels the owner switched off (`notify.setChannelSettings`). Read once per dispatch. Absent = none. */
  readonly disabledChannels?: () => Promise<ReadonlySet<ChannelId>>;
  /**
   * Optional mute prefs. When absent, nothing is muted (legacy behaviour).
   * Critical severity never mutes — see preferences/mute.ts.
   */
  readonly mutePrefsOf?: (userId: string) => Promise<ChannelMutePrefs> | ChannelMutePrefs;
  /**
   * Topic mute and quiet-hours / digest hold. Critical never calls this.
   * `hold` records the notice for the next summary and does not drop it.
   */
  readonly planOutOfApp?: (input: {
    userId: string;
    kind: string;
    notificationId: string;
    channel: MuteableChannel;
    severity: NotifySeverity;
  }) => Promise<OutOfAppPlan>;
  /** Loads the held notice for `releaseHeld`. The inbox id is the caller's own. */
  readonly loadNotification?: (userId: string, notificationId: string) => Promise<Notification | null>;
  /**
   * Recipient health (quarantine). Absent = nothing is ever quarantined. A
   * quarantined address is refused non-critical sends; critical is still tried.
   */
  readonly recipientHealth?: RecipientHealthPort;
}

export interface RecipientHealthPort {
  readonly quarantineOf: (userId: string, channel: OutOfAppChannel, address: string) => Promise<{ reason: string } | null>;
  /** `ok: false` only for a terminal (abandoned) send. Failures here never change the delivery outcome. */
  readonly record: (input: {
    userId: string;
    channel: OutOfAppChannel;
    address: string;
    ok: boolean;
    code: string | null;
  }) => Promise<void>;
}

export interface ChannelOutcome {
  readonly channel: ChannelId;
  /** `waiting`: owed on this channel with no sender set; the row stays `pending`, never attempted. */
  readonly status: 'accepted' | 'refused' | 'failed' | 'abandoned' | 'already_accepted' | 'held' | 'waiting';
  readonly code: RefusalCode | null;
  readonly detail: string | null;
  /** True when the bus should redeliver so this channel gets another go. */
  readonly retryable: boolean;
}

export interface DispatchReport {
  readonly notificationId: string;
  readonly outcomes: readonly ChannelOutcome[];
  /** True when at least one channel wants another attempt. */
  readonly retry: boolean;
}

/**
 * Gateway receipts that are not on the row yet, one map per delivery store.
 *
 * `noteReceipt` and `settle(accepted)` can both throw before they change the
 * pending row. The receipt cannot sit on one `NotificationDispatcher`: the
 * lease expires and the next claim may run on a second dispatcher that shares
 * this store. That claim must finish the receipt and must not call `deliver`
 * again. A null reference is a real receipt: the transport accepted the send
 * and gave no handle.
 */
const receiptsByStore = new WeakMap<DeliveryStore, Map<string, { reference: string | null; attempt: number }>>();

function receiptInHand(store: DeliveryStore): Map<string, { reference: string | null; attempt: number }> {
  let held = receiptsByStore.get(store);
  if (held == null) {
    held = new Map();
    receiptsByStore.set(store, held);
  }
  return held;
}

export class NotificationDispatcher {
  constructor(
    private readonly channels: ChannelRegistry,
    private readonly targets: TargetStore,
    private readonly deliveries: DeliveryStore,
    private readonly options: DispatchOptions,
  ) {}

  async dispatch(notification: Notification, opts: { outOfApp?: boolean } = {}): Promise<DispatchReport> {
    return withNotifySpan(
      'notify.dispatch',
      { op: 'dispatch', kind: notification.kind, sourceSubject: notification.sourceSubject },
      async (span) => {
        const outOfApp = opts.outOfApp !== false;
        const verified = await this.targets.verified(notification.userId);
        const byChannel = new Map<ChannelId, ChannelTarget>(verified.map((t) => [t.channel, t]));
        const outcomes: ChannelOutcome[] = [];
        const ownerDisabled = outOfApp && this.options.disabledChannels ? await this.options.disabledChannels() : new Set<ChannelId>();

        // Only a critical message writes a row for a channel it could not use, so
        // only a critical message needs to know WHY there was nothing to use. A
        // fill notification does not pay for this read.
        const unverified =
          notification.severity === 'critical' ? new Set(await this.targets.unverifiedChannels(notification.userId)) : new Set<ChannelId>();

        // The inbox row already exists — the notification IS the in-app delivery.
        // Recording it as a delivery keeps one shape for "what happened to this
        // message across every channel", which is what the API answers.
        outcomes.push(await this.attempt(notification, 'inapp', notification.id, normaliseLocale(null)));

        if (!outOfApp) {
          const retry = outcomes.some((o) => o.retryable);
          span.setAttribute('intafaced.notify.channels_attempted', outcomes.length);
          span.setAttribute('intafaced.notify.channels_accepted', outcomes.filter((o) => o.status === 'accepted').length);
          span.setAttribute('intafaced.notify.dispatch_retry', retry);
          span.setAttribute('intafaced.notify.out_of_app', false);
          return { notificationId: notification.id, outcomes, retry };
        }

        for (const channel of OUT_OF_APP_CHANNELS) {
          const target = byChannel.get(channel);

          if (!this.options.outOfAppEnabled || ownerDisabled.has(channel)) {
            // The switch is the binding cause: a confirmed address would not have
            // been tried either, so `channel.disabled` is the honest code even
            // when the user registered nothing. A critical message still gets a
            // row in that case, because "nobody was reached" is the fact a
            // disputed liquidation turns on — and the one operator state where
            // sending is off must not also be the one state where that goes
            // unwritten. `detail` keeps the second fact from being collapsed
            // into the first.
            if (target || notification.severity === 'critical') {
              outcomes.push(
                await this.refuse(
                  notification,
                  channel,
                  'channel.disabled',
                  target
                    ? null
                    : unverified.has(channel)
                      ? 'address registered but never confirmed'
                      : 'no confirmed address on this channel',
                ),
              );
            }
            continue;
          }

          // The mailed copy is owed and no sender is set: it waits instead of being skipped or refused. See MAILED_KINDS.
          const owed =
            channel === 'email' &&
            MAILED_KINDS.has(notification.kind) &&
            this.channels.get(channel).unavailableReason === 'channel.not_configured';

          if (!target) {
            if (owed) {
              // No sender is the binding cause: no address would be mailed either. `detail` keeps the second fact.
              const unconfirmed = (await this.targets.unverifiedChannels(notification.userId)).includes(channel);
              outcomes.push(
                await this.waitUnsent(
                  notification,
                  channel,
                  unconfirmed ? 'address registered but never confirmed' : 'no confirmed address on this channel',
                ),
              );
              continue;
            }
            // Nothing was promised on a channel the user never gave us — except
            // when the message is critical, where silence is the thing worth
            // recording. See the header.
            //
            // Which silence it was, matters. "You gave us nothing" and "you gave
            // us an address and never clicked the code" are different facts about
            // the same user, and only the second is one the user can fix — the
            // same argument `channel.ts` makes for keeping `target_unroutable`
            // separate. Recording both as `no_target` told somebody who was one
            // click from a margin-call SMS that they had no phone number.
            if (notification.severity === 'critical') {
              const code = unverified.has(channel) ? 'channel.target_unverified' : 'channel.no_target';
              outcomes.push(await this.refuse(notification, channel, code));
            }
            continue;
          }

          // Quarantine (info/action only): this address kept failing terminally and an
          // operator has not released it. Critical is still attempted.
          if (this.options.recipientHealth && notification.severity !== 'critical') {
            // Fail open: if the health store cannot answer, the address is treated as not quarantined.
            const q = await this.options.recipientHealth.quarantineOf(notification.userId, channel, target.address).catch(() => null);
            if (q) {
              outcomes.push(await this.refuse(notification, channel, 'channel.recipient_quarantined', q.reason));
              continue;
            }
          }

          // Preference mute (info/action only). Critical always attempts.
          if (this.options.mutePrefsOf) {
            const prefs = await this.options.mutePrefsOf(notification.userId);
            if (isChannelMuted(prefs ?? EMPTY_MUTE_PREFS, channel as MuteableChannel, notification.severity)) {
              outcomes.push(await this.refuse(notification, channel, 'channel.muted'));
              continue;
            }
          }

          // Topic mute and quiet hours. Critical ignores both: it never reaches the gate.
          if (this.options.planOutOfApp && notification.severity !== 'critical') {
            const plan = await this.options.planOutOfApp({
              userId: notification.userId,
              kind: notification.kind,
              notificationId: notification.id,
              channel: channel as MuteableChannel,
              severity: notification.severity,
            });
            if (plan === 'muted') {
              outcomes.push(await this.refuse(notification, channel, 'channel.muted'));
              continue;
            }
            if (plan === 'hold') {
              outcomes.push({ channel, status: 'held', code: null, detail: null, retryable: false });
              continue;
            }
          }

          if (owed) {
            outcomes.push(await this.waitUnsent(notification, channel, null));
            continue;
          }

          outcomes.push(await this.attempt(notification, channel, target.address, target.locale));
        }

        const retry = outcomes.some((o) => o.retryable);
        span.setAttribute('intafaced.notify.channels_attempted', outcomes.length);
        span.setAttribute('intafaced.notify.channels_accepted', outcomes.filter((o) => o.status === 'accepted').length);
        span.setAttribute('intafaced.notify.dispatch_retry', retry);

        return { notificationId: notification.id, outcomes, retry };
      },
    );
  }

  /**
   * Send one notice that was held for a summary or a quiet window.
   *
   * The hold already passed topic choice and the quiet-hour gate. This does not
   * call `planOutOfApp` again — a second pass would see the open hold and wait
   * forever. Channel mute and the out-of-app switch are checked again, then the
   * same claim, send and settle as `attempt` runs. The delivery claim is unique
   * per notification and channel, so a crash after send and before the hold is
   * marked comes back as `already_accepted` and does not send twice.
   */
  async releaseHeld(userId: string, notificationId: string, channel: MuteableChannel): Promise<ChannelOutcome> {
    const load = this.options.loadNotification;
    if (!load) throw new Error('notify.release_held_loader_unset');
    const notification = await load(userId, notificationId);
    if (!notification) throw new Error('notify.release_held_notification_missing');

    const verified = await this.targets.verified(notification.userId);
    const target = verified.find((row) => row.channel === channel);

    if (!this.options.outOfAppEnabled || (this.options.disabledChannels && (await this.options.disabledChannels()).has(channel))) {
      return this.refuse(notification, channel, 'channel.disabled', target ? null : 'no confirmed address on this channel');
    }

    if (!target) {
      const unverified = new Set(await this.targets.unverifiedChannels(notification.userId));
      const code = unverified.has(channel) ? 'channel.target_unverified' : 'channel.no_target';
      return this.refuse(notification, channel, code);
    }

    if (this.options.mutePrefsOf) {
      const prefs = await this.options.mutePrefsOf(notification.userId);
      if (isChannelMuted(prefs ?? EMPTY_MUTE_PREFS, channel, notification.severity)) {
        return this.refuse(notification, channel, 'channel.muted');
      }
    }

    return this.attempt(notification, channel, target.address, target.locale);
  }

  /**
   * The mailed copy is owed and no sender is set. With no address on file the channel mute is checked here, since the
   * address gates never ran; topic mute and quiet hours are not, because asking them holds the notice for a summary. An
   * existing row is reported as it stands: a claim in progress asks for a redelivery, as `in_flight` does.
   */
  private async waitUnsent(notification: Notification, channel: ChannelId, detail: string | null): Promise<ChannelOutcome> {
    if (detail !== null && this.options.mutePrefsOf && notification.severity !== 'critical') {
      const prefs = await this.options.mutePrefsOf(notification.userId);
      if (isChannelMuted(prefs ?? EMPTY_MUTE_PREFS, channel as MuteableChannel, notification.severity)) {
        return this.refuse(notification, channel, 'channel.muted');
      }
    }
    const row = await this.deliveries.wait(notification.id, channel, 'vendor.email', detail);
    if (row.status === 'pending' && row.attempts === 0) {
      return { channel, status: 'waiting', code: row.refusalCode, detail: row.detail, retryable: false };
    }
    if (row.status === 'accepted') return fromExistingClaim(channel, 'already_accepted', row);
    if (row.status === 'pending') return fromExistingClaim(channel, 'in_flight', row);
    return fromExistingClaim(channel, 'terminal', row);
  }

  /** Record a refusal that the adapter never got a chance to make. */
  private async refuse(
    notification: Notification,
    channel: ChannelId,
    code: RefusalCode,
    detail: string | null = null,
  ): Promise<ChannelOutcome> {
    const recovered = await this.reconcileInHand(notification.id, channel);
    if (recovered) return recovered;
    const claim = await this.deliveries.claim(notification.id, channel, this.options.maxAttempts);
    if (!claim.claimed) {
      // A receipt is already on the row. A later kill-switch must not overwrite
      // it with a refusal, and must not send again.
      if (claim.reason === 'receipt_pending') {
        const recovered = await this.reconcileInHand(notification.id, channel);
        if (recovered) return recovered;
        return this.settleAccepted(notification.id, channel, claim.record.id, claim.record.attempts, claim.record.reference);
      }
      return fromExistingClaim(channel, claim.reason, claim.record);
    }

    // `attempted: false` — nothing was tried, so `attempted_at` stays NULL. That
    // column is the difference between "the provider was down" and "we never
    // had anywhere to send it", and collapsing the two loses the answer a
    // borrower is owed.
    await this.deliveries.settle({
      id: claim.id,
      attempt: claim.attempt,
      status: 'refused',
      refusalCode: code,
      detail,
      attempted: false,
    });
    return { channel, status: 'refused', code, detail, retryable: false };
  }

  /**
   * Tell recipient health how THIS pass ended a send. Called only where the pass
   * itself settled the row (abandoned) or finished a fresh receipt (accepted), never
   * for an outcome read back from an existing row: a redelivery of the same
   * notification must not count the same failure twice. A health write that throws
   * is dropped; it must not turn a delivered message into a retry.
   */
  private async noteHealth(
    notification: Notification,
    channel: ChannelId,
    address: string,
    ok: boolean,
    code: string | null,
  ): Promise<void> {
    const health = this.options.recipientHealth;
    if (!health || channel === 'inapp') return;
    try {
      await health.record({ userId: notification.userId, channel, address, ok, code });
    } catch {
      // Bookkeeping about the address; the delivery row already holds the outcome.
    }
  }

  private async attempt(notification: Notification, channel: ChannelId, address: string, locale: string): Promise<ChannelOutcome> {
    const handKey = receiptKey(notification.id, channel);
    const recovered = await this.reconcileInHand(notification.id, channel);
    if (recovered) return recovered;
    const claim = await this.deliveries.claim(notification.id, channel, this.options.maxAttempts);
    if (!claim.claimed) {
      // The gateway already returned a receipt. This pass only finishes the
      // accepted write. Delivering again would send the same message twice.
      if (claim.reason === 'receipt_pending') {
        const recovered = await this.reconcileInHand(notification.id, channel);
        if (recovered) return recovered;
        return this.settleAccepted(notification.id, channel, claim.record.id, claim.record.attempts, claim.record.reference);
      }
      return fromExistingClaim(channel, claim.reason, claim.record);
    }

    // The row never received the handle, so claim was willing to send again.
    // The receipt is already in hand. Finish it. Do not call the gateway.
    const held = receiptInHand(this.deliveries).get(handKey);
    if (held) {
      const recovered = await this.reconcileInHand(notification.id, channel);
      if (recovered) return recovered;
    }

    const adapter = this.channels.get(channel);
    const copy = renderNotification(notification, locale);

    let receipt: { reference: string | null };
    try {
      receipt = await adapter.deliver({
        notificationId: notification.id,
        userId: notification.userId,
        channel,
        kind: notification.kind,
        severity: notification.severity,
        titleKey: notification.titleKey,
        bodyKey: notification.bodyKey,
        title: copy.title,
        body: copy.body,
        href: notification.href,
        locale: normaliseLocale(locale),
        address,
        idempotencyKey: `${notification.id}:${channel}`,
      });
    } catch (err) {
      if (err instanceof ChannelRefusal) {
        // The adapter declined before doing anything — no credentials, typically.
        await this.deliveries.settle({
          id: claim.id,
          attempt: claim.attempt,
          status: 'refused',
          refusalCode: err.code,
          detail: err.message,
          attempted: false,
        });
        return { channel, status: 'refused', code: err.code, detail: err.message, retryable: false };
      }

      const retryable = err instanceof ChannelDeliveryError ? err.retryable : true;
      const detail = err instanceof Error ? err.message : String(err);
      // Out of attempts on this pass? Say so now rather than leaving a 'failed'
      // row that reads as "still being retried" when nothing will retry it.
      const exhausted = claim.attempt >= this.options.maxAttempts;
      const status = retryable && !exhausted ? 'failed' : 'abandoned';
      // Permanent gateway rejects (e.g. 422) abandon without burning more bus
      // attempts — but the row must still name *why*, not leave refusal_code null.
      const refusalCode = exhausted ? 'channel.attempts_exhausted' : status === 'abandoned' ? 'channel.transport_rejected' : null;

      await this.deliveries.settle({
        id: claim.id,
        attempt: claim.attempt,
        status,
        refusalCode,
        detail,
        attempted: true,
      });
      // Only a terminal outcome is evidence about the address; a retryable `failed` is not.
      if (status === 'abandoned') await this.noteHealth(notification, channel, address, false, refusalCode);
      return { channel, status, code: refusalCode, detail, retryable: status === 'failed' };
    }

    // The receipt exists. Persist that fact before settle(accepted). A throw
    // here is bookkeeping, not a transport failure: settling `failed` would
    // release the claim and the next pass would deliver again. reference is
    // stored as the gateway returned it, including null. Nothing is filled in.
    receiptInHand(this.deliveries).set(handKey, { reference: receipt.reference, attempt: claim.attempt });
    const finished = await this.finishReceipt(handKey, notification.id, channel, claim.id, claim.attempt, receipt.reference);
    if (finished.status === 'accepted') await this.noteHealth(notification, channel, address, true, null);
    return finished;
  }

  /** Known acceptance is bookkeeping, not another transport attempt or refusal. */
  private async reconcileInHand(notificationId: string, channel: ChannelId): Promise<ChannelOutcome | null> {
    const handKey = receiptKey(notificationId, channel);
    const held = receiptInHand(this.deliveries).get(handKey);
    if (!held) return null;
    const row = (await this.deliveries.listForNotification(notificationId)).find((record) => record.channel === channel);
    // A non-null gateway handle proves receipt identity across bookkeeping
    // attempts. Null supplies no identity, so its original attempt must match.
    if (row?.status === 'accepted' && row.reference === held.reference && (held.reference !== null || row.attempts === held.attempt)) {
      receiptInHand(this.deliveries).delete(handKey);
      return { channel, status: 'already_accepted', code: null, detail: null, retryable: false };
    }
    if (row?.status === 'pending' && row.attempts === held.attempt) {
      return this.finishReceipt(handKey, notificationId, channel, row.id, row.attempts, held.reference);
    }
    // Never invent a refusal or a successful write when a known receipt cannot
    // yet be recorded. Keep it available to the same store's recovery path.
    return { channel, status: 'failed', code: null, detail: 'gateway receipt is not recorded on a pending delivery', retryable: true };
  }

  /**
   * Put a receipt we already hold onto the row, then accept it when we can.
   *
   * A note that lands and then throws leaves the handle on the pending row.
   * Acceptance waits for the next claim, which sees `receipt_pending` and
   * does not deliver. A note that throws before the row changes is retried
   * here. If the pending row is still unchanged, `settle(accepted)` is the
   * write that stores the handle. When that also throws, the receipt stays
   * in the map for that store. The next claim, including one on another
   * dispatcher, finishes it and does not deliver.
   */
  private async finishReceipt(
    handKey: string,
    notificationId: string,
    channel: ChannelId,
    id: string,
    attempt: number,
    reference: string | null,
  ): Promise<ChannelOutcome> {
    const noted = { id, attempt, reference };
    let noteDetail: string | null = null;
    for (let pass = 0; pass < 3; pass++) {
      try {
        await this.deliveries.noteReceipt(noted);
        if (noteDetail != null && (await this.receiptLanded(notificationId, channel, attempt, reference))) {
          receiptInHand(this.deliveries).delete(handKey);
          return { channel, status: 'failed', code: null, detail: noteDetail, retryable: true };
        }
        break;
      } catch (err) {
        noteDetail = err instanceof Error ? err.message : String(err);
        if (await this.pendingReceiptStored(notificationId, channel, attempt, reference)) {
          receiptInHand(this.deliveries).delete(handKey);
          return { channel, status: 'failed', code: null, detail: noteDetail, retryable: true };
        }
      }
    }

    // Still no handle on the pending row. Accepting on this claim stores it.
    // If acceptance throws, the map for this store still holds the receipt.
    const settled = await this.settleAccepted(notificationId, channel, id, attempt, reference);
    const landed = await this.receiptLanded(notificationId, channel, attempt, reference);
    if (landed) receiptInHand(this.deliveries).delete(handKey);
    // A late ownership CAS can be a successful SQL call that writes nothing.
    // Keep the receipt and ask for recovery rather than assert row acceptance.
    if (settled.status === 'accepted' && !landed) {
      return { channel, status: 'failed', code: null, detail: 'gateway receipt acceptance is not recorded', retryable: true };
    }
    return settled;
  }

  /**
   * True when this attempt's receipt is on the row, pending or accepted.
   *
   * `reference` is compared as the gateway returned it, so a null handle
   * stays null. An accepted row has already finished; a pending row with
   * `attemptedAt` set is what the next claim treats as `receipt_pending`.
   */
  private async receiptLanded(notificationId: string, channel: ChannelId, attempt: number, reference: string | null): Promise<boolean> {
    const row = (await this.deliveries.listForNotification(notificationId)).find((r) => r.channel === channel);
    if (row == null || row.attempts !== attempt || row.reference !== reference) return false;
    if (row.status === 'accepted') return true;
    return row.status === 'pending' && row.attemptedAt != null;
  }

  /**
   * True when this attempt's receipt is already on the pending row.
   *
   * `attemptedAt` is the mark `claim` trusts. `reference` is compared as the
   * gateway returned it, so a null handle stays null.
   */
  private async pendingReceiptStored(
    notificationId: string,
    channel: ChannelId,
    attempt: number,
    reference: string | null,
  ): Promise<boolean> {
    const row = (await this.deliveries.listForNotification(notificationId)).find((r) => r.channel === channel);
    return row != null && row.status === 'pending' && row.attempts === attempt && row.attemptedAt != null && row.reference === reference;
  }

  /**
   * Write `accepted` for a receipt we already hold.
   *
   * On failure the row stays pending with that receipt. The outcome asks the
   * bus to come back. The next claim sees `receipt_pending` and does not deliver.
   */
  private async settleAccepted(
    notificationId: string,
    channel: ChannelId,
    id: string,
    attempt: number,
    reference: string | null,
  ): Promise<ChannelOutcome> {
    try {
      await this.deliveries.settle({
        id,
        attempt,
        status: 'accepted',
        reference,
        attempted: true,
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return { channel, status: 'failed', code: null, detail, retryable: true };
    }
    const row = (await this.deliveries.listForNotification(notificationId)).find((record) => record.id === id);
    if (row?.status !== 'accepted' || row.attempts !== attempt || row.reference !== reference) {
      return { channel, status: 'failed', code: null, detail: 'gateway receipt acceptance is not recorded', retryable: true };
    }
    return { channel, status: 'accepted', code: null, detail: null, retryable: false };
  }
}

/**
 * A claim we did not get. Never an error: the common case is a redelivery of
 * something already accepted, which is the guard doing its job.
 *
 * The outcome reports the row's OWN status rather than a status inferred from
 * why the claim was refused. A row that was abandoned must not come back as
 * "refused" — those words mean different things on this record, and a reader
 * settling a dispute reads them literally.
 */
function receiptKey(notificationId: string, channel: ChannelId): string {
  return `${notificationId}\0${channel}`;
}

function fromExistingClaim(
  channel: ChannelId,
  reason: 'already_accepted' | 'terminal' | 'exhausted' | 'in_flight',
  record: DeliveryRecord,
): ChannelOutcome {
  if (reason === 'already_accepted') {
    return { channel, status: 'already_accepted', code: null, detail: null, retryable: false };
  }
  if (reason === 'in_flight') {
    // Another replica holds the lease, so this pass must not stack a second
    // send. It must still ask the bus to redeliver.
    //
    // Not retrying looks safer and is not. `events.ts` naks only when some
    // outcome is retryable, so an unretryable in-flight outcome ACKS the
    // message — and an ack is the end of it: there is no sweeper over
    // `notify.deliveries` and no other path that re-drives a dispatch. If the
    // lease holder crashed mid-send, its own copy of the message is gone too
    // (this ack retired it), the lease expires with nobody left to reclaim the
    // row, and a margin call is neither sent nor recorded as abandoned — it
    // sits `pending` forever. That is the one failure this service exists to
    // make impossible, and it would be traded for a duplicate email.
    //
    // Retrying costs a redelivery. On the next pass the row is either
    // `accepted` — `already_accepted`, nothing sent twice — or the lease has
    // expired and this pass sends the message that would otherwise have been
    // lost. Worst case the bus parks the message after `max_deliver`, which an
    // operator can see and redrive. Visible beats silent.
    return {
      channel,
      status: 'failed',
      code: null,
      detail: 'delivery claim held by another worker',
      retryable: true,
    };
  }
  return {
    channel,
    // Active pending with live lease is handled as in_flight above. Other
    // pending rows map to failed so a reader never sees "accepted" for silence.
    status: record.status === 'pending' ? 'failed' : record.status === 'accepted' ? 'already_accepted' : record.status,
    code: record.refusalCode,
    detail: record.detail,
    retryable: false,
  };
}
