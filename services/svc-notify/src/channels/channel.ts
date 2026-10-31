/**
 * THE CHANNEL INTERFACE — Doctrine §0.4, "adapters, not integrations".
 *
 * Every way of reaching a user is one of these. The in-app inbox is a channel
 * like any other; email, push and SMS are channels that need credentials the
 * owner may not have yet. That symmetry is the point: the dispatcher has one
 * code path, and "we cannot reach you by email" is a first-class recorded
 * outcome rather than a branch someone forgot.
 *
 * THE THREE OUTCOMES, AND WHY THEY ARE THREE
 *
 *   accepted   The adapter handed the message to its transport and the transport
 *              ACCEPTED IT FOR DELIVERY. That is the whole claim. It is not
 *              "received", it is not "read", and no channel in this service ever
 *              learns either of those — see WHAT "ACCEPTED" DOES NOT MEAN below.
 *   refused    The adapter declined BEFORE attempting anything: no credentials,
 *              no address on file, address never confirmed, address not routable
 *              on this channel. Terminal, and the reason is recorded. A refusal
 *              is never a silent drop — the code is on the delivery row and
 *              readable through the API.
 *   failed     It was attempted and it did not work. Retryable or not.
 *
 * A design where "refused" and "accepted" are both `void` is how an undelivered
 * margin call comes to look like a delivered one. svc-bank already keeps
 * `notifiedAt` separate from `calledAt` for exactly this reason; this is the
 * same discipline one layer out.
 *
 * WHAT "ACCEPTED" DOES NOT MEAN — READ THIS BEFORE BUILDING A CLOCK ON IT
 *
 * A gateway answering 2xx has taken custody of the message. It has not said the
 * mail server accepted it, that the handset was reachable, or that a human saw
 * it. We do not receive delivery receipts and we do not model them, so the
 * strongest true statement this service can make is "a transport accepted it",
 * and that is exactly what the status and the column are named.
 *
 * The reason this is spelled out rather than assumed: svc-bank stamps a margin
 * call `notified_at` and starts the liquidation grace clock from it. A clock
 * that gates somebody's collateral must never be started by a word that means
 * less than the reader thinks it means. `accepted` is the weakest true word
 * available, deliberately.
 *
 * PROVIDER NAMES LIVE IN CONFIGURATION, NOT HERE (§0.7). No adapter in this
 * directory names a vendor, and none ever should — the transport is a URL and a
 * credential the owner sets, and whoever is behind that URL is the owner's
 * business, not this codebase's.
 */

/** Every way of reaching a user. `inapp` is always available; the rest are adapters. */
export const CHANNEL_IDS = ['inapp', 'email', 'push', 'sms'] as const;
export type ChannelId = (typeof CHANNEL_IDS)[number];

/** Channels that leave the platform and therefore need an address and credentials. */
export const OUT_OF_APP_CHANNELS = ['email', 'push', 'sms'] as const satisfies readonly ChannelId[];
export type OutOfAppChannel = (typeof OUT_OF_APP_CHANNELS)[number];

export function isChannelId(value: string): value is ChannelId {
  return (CHANNEL_IDS as readonly string[]).includes(value);
}

/** L3 — full channel catalog count (always 4). */
export function channelCatalogSize(): number {
  return CHANNEL_IDS.length;
}

/** L3 — out-of-app channel count (always 3). */
export function outOfAppChannelCount(): number {
  return OUT_OF_APP_CHANNELS.length;
}

/** L3 — true when id is out-of-app. */
export function isOutOfAppChannel(value: string): value is OutOfAppChannel {
  return (OUT_OF_APP_CHANNELS as readonly string[]).includes(value);
}

/** L3 — channel catalog board card. */
export function channelCatalogBoardCard(): {
  readonly total: number;
  readonly outOfApp: number;
  readonly inappAlways: boolean;
  readonly ids: readonly ChannelId[];
} {
  return {
    total: channelCatalogSize(),
    outOfApp: outOfAppChannelCount(),
    inappAlways: CHANNEL_IDS.includes('inapp'),
    ids: CHANNEL_IDS,
  };
}

/** L3 — catalog status line. */
export function channelCatalogStatusLine(): string {
  const c = channelCatalogBoardCard();
  return `total=${c.total} outOfApp=${c.outOfApp} inapp=${c.inappAlways ? '1' : '0'}`;
}

/** L3 — parse catalog status. Invalid → null. */
export function parseChannelCatalogStatusLine(
  line: string,
): { readonly total: number; readonly outOfApp: number; readonly inapp: boolean } | null {
  const m = line.trim().match(/^total=(\d+) outOfApp=(\d+) inapp=([01])$/);
  if (!m) return null;
  return { total: Number(m[1]), outOfApp: Number(m[2]), inapp: m[3] === '1' };
}

/** L3 — true when status matches catalog. */
export function channelCatalogStatusLineMatches(): boolean {
  const p = parseChannelCatalogStatusLine(channelCatalogStatusLine());
  if (!p) return false;
  const c = channelCatalogBoardCard();
  return p.total === c.total && p.outOfApp === c.outOfApp && p.inapp === c.inappAlways;
}

/** L3 — export header. */
export function channelCatalogExportHeader(): string {
  return 'id,outOfApp';
}

/** L3 — export lines. */
export function channelCatalogExportLines(): readonly string[] {
  return CHANNEL_IDS.map((id) => `${id},${isOutOfAppChannel(id) ? '1' : '0'}`);
}

/** L3 — full export. */
export function channelCatalogExportText(): string {
  return [channelCatalogExportHeader(), ...channelCatalogExportLines()].join('\n');
}

/** L3 — true when catalog size is within [min,max]. Invalid → false. */
export function channelCatalogSizeInRange(min: number, max: number): boolean {
  if (!Number.isFinite(min) || !Number.isFinite(max) || min > max) return false;
  const n = channelCatalogSize();
  return n >= min && n <= max;
}

/** L3 — stable refusal code list for operator docs. */
export function allRefusalCodes(): readonly RefusalCode[] {
  return [
    'channel.not_configured',
    'channel.no_target',
    'channel.target_unverified',
    'channel.target_unroutable',
    'channel.disabled',
    'channel.muted',
    'channel.attempts_exhausted',
    'channel.transport_rejected',
    'channel.delivery_stuck',
    'channel.register_rate_limited',
    'channel.verify_rate_limited',
    'channel.unprobed',
    'channel.recipient_quarantined',
  ];
}

/** L3 — refusal code count. */
export function refusalCodeCount(): number {
  return allRefusalCodes().length;
}

/**
 * Why a channel declined without attempting anything.
 *
 * These are codes, not sentences: they cross the wire to a client that renders
 * its own copy from `@intafaced/i18n`, and a code cannot accidentally ship an
 * untranslated string or a vendor's name.
 */
export type RefusalCode =
  /**
   * No email sender is set, and this message's mailed copy is owed: the row waits `pending`, never attempted. Not a
   * refusal of the message, which still reached the inbox.
   */
  | 'vendor.email'
  /** No credentials configured for this channel. The owner has not obtained them. */
  | 'channel.not_configured'
  /** The user has no address registered for this channel. */
  | 'channel.no_target'
  /** An address is registered but was never confirmed. We do not send to unconfirmed addresses. */
  | 'channel.target_unverified'
  /**
   * An address is registered and confirmed, but this channel cannot route it —
   * a phone number that is not E.164, a mailbox with no domain, a device token
   * of an impossible length.
   *
   * Terminal, and separate from `no_target` on purpose: "we have nowhere to send
   * this" and "what we hold is unusable" are different facts about the same user,
   * and only the second one is something the user can fix.
   */
  | 'channel.target_unroutable'
  /** Out-of-app sending is switched off by the operator. The inbox still fills. */
  | 'channel.disabled'
  /** User muted this non-critical channel (preference law). Critical never mutes. */
  | 'channel.muted'
  /** Attempted the configured maximum times and never succeeded. Terminal by policy. */
  | 'channel.attempts_exhausted'
  /**
   * Gateway returned a permanent failure (non-retryable 4xx other than auth).
   * Distinct from attempts_exhausted (budget spent) and refused (never tried).
   * Detail still carries the gateway wording.
   */
  | 'channel.transport_rejected'
  /**
   * A pending row whose claim lease has been dead longer than the bus could still
   * redeliver, retired by the stuck-pending reaper arm. Distinct from
   * `attempts_exhausted`: attempts may still be below max (the in_flight path
   * burns bus deliveries without raising attempts). Status is still abandoned;
   * the code says *why* nobody is coming back.
   */
  | 'channel.delivery_stuck'
  /**
   * Too many `registerTarget` calls for this user+channel in the window.
   * Stops unlimited SMS/email verification traffic (billing + abuse).
   */
  | 'channel.register_rate_limited'
  /**
   * Too many `verifyTarget` guesses for this user+channel in the window.
   * A 6-digit code with a long TTL is brute-forceable without this.
   */
  | 'channel.verify_rate_limited'
  /**
   * Gateway URL+token are set; this process has not POSTed. Door status on
   * `/ready` and `notify.channels` — never a delivery row. `deliver()` still
   * POSTs. Configured is not reachable (same class as P2P moderation unprobed).
   */
  | 'channel.unprobed'
  /** The address failed terminally often enough to be quarantined; non-critical sends wait for an operator release. */
  | 'channel.recipient_quarantined';

/** A channel declining before it attempted anything. Terminal — never retried. */
export class ChannelRefusal extends Error {
  readonly code: RefusalCode;
  readonly channel: ChannelId;

  constructor(channel: ChannelId, code: RefusalCode, detail?: string) {
    super(detail ? `${channel}: ${code} (${detail})` : `${channel}: ${code}`);
    this.name = 'ChannelRefusal';
    this.channel = channel;
    this.code = code;
  }
}

/**
 * A channel that tried and failed.
 *
 * `retryable` decides whether the bus message is nak'd. A gateway that is down
 * is retryable; a gateway that says the address is malformed is not, and
 * retrying it forever would be a busy-loop against someone else's server whose
 * only effect is to hide the problem.
 */
export class ChannelDeliveryError extends Error {
  readonly channel: ChannelId;
  readonly retryable: boolean;
  readonly status: number | null;

  constructor(channel: ChannelId, message: string, opts: { retryable: boolean; status?: number }) {
    super(message);
    this.name = 'ChannelDeliveryError';
    this.channel = channel;
    this.retryable = opts.retryable;
    this.status = opts.status ?? null;
  }
}

/**
 * A message on its way out of the platform.
 *
 * `title` and `body` are RENDERED here, server-side, from `@intafaced/i18n` —
 * an email cannot carry copy a screen could not (§9), and cannot carry copy the
 * brand scan has not seen (§0.7). The i18n keys ride along so a gateway that
 * wants to re-render in its own template system can.
 */
export interface OutboundMessage {
  readonly notificationId: string;
  readonly userId: string;
  readonly channel: ChannelId;
  readonly kind: string;
  readonly severity: 'info' | 'action' | 'critical';
  readonly titleKey: string;
  readonly bodyKey: string;
  readonly title: string;
  readonly body: string;
  readonly href: string | null;
  readonly locale: string;
  /** Where it goes on this channel: an address, a number, a device token. */
  readonly address: string;
  /**
   * Business key for the transport's own dedupe. `<notificationId>:<channel>`.
   * At-least-once means this arrives twice; a gateway that honours it sends once.
   */
  readonly idempotencyKey: string;
}

export interface DeliveryReceipt {
  /** The transport's handle for the message, when it gives one. Null is allowed and honest. */
  readonly reference: string | null;
}

export interface NotificationChannel {
  readonly channel: ChannelId;
  /**
   * Non-null when `deliver()` will refuse without attempting a POST — no
   * credentials, typically. Null is not "reachable": a gateway with URL+token
   * still reports `channel.unprobed` on `/ready`. Required-channel boot uses
   * this field, not the door status.
   */
  readonly unavailableReason: RefusalCode | null;
  /** Throws `ChannelRefusal` (terminal) or `ChannelDeliveryError` (attempted). */
  deliver(message: OutboundMessage): Promise<DeliveryReceipt>;
}
