import {
  ChannelDeliveryError,
  ChannelRefusal,
  type ChannelId,
  type DeliveryReceipt,
  type NotificationChannel,
  type OutboundMessage,
  type RefusalCode,
} from './channel.js';

/**
 * THE OUT-OF-APP TRANSPORT — the half that email, push and SMS share.
 *
 * Each of the three reaches the world the same way: one authenticated HTTP POST
 * to a URL the owner configures. Whoever answers that URL — a mail relay, a push
 * service, an SMS aggregator, or the owner's own forwarder — is configuration.
 * This file cannot name them and must not: §0.7 keeps partner names out of
 * shipped code, and a hard-coded vendor SDK would also make "swap the provider"
 * a code change instead of an env change (§0.4).
 *
 * What each channel does NOT share is the shape of an address and the shape of a
 * message. A mailbox is not a handset is not a device token, and a body that is
 * fine in an email is three billed segments over SMS. Those differences live in
 * `adapters.ts`, one subclass each, and this class holds nothing but the wire.
 *
 * WHY NOT A VENDOR SDK
 *
 * Three SDKs would be three dependency trees, three retry semantics, three
 * credential shapes and three names the brand scan would have to allow. One POST
 * with an idempotency key is a smaller, honest surface, and the owner can put
 * anything behind it. The cost is real and stated: the owner must run or buy
 * something that speaks it. That cost is named in the README and in
 * `docs/OWNER-ACTIONS-NOTIFY-GATEWAYS.md`, not hidden.
 *
 * WHAT IT SENDS
 *
 *   POST <gateway url>
 *   authorization: Bearer <token>
 *   idempotency-key: <notificationId>:<channel>
 *   content-type: application/json
 *   { channel, notificationId, to, locale, severity, kind, titleKey, bodyKey,
 *     …per-channel fields }
 *
 * Copy is rendered before it gets here, so a gateway needs no catalog. The keys
 * ride along for a gateway that has its own templates.
 *
 * WHAT IT NEVER DOES
 *
 * It never returns a receipt it did not earn. Every path out of `deliver()` is
 * either a receipt backed by a 2xx from the gateway, a `ChannelRefusal`, or a
 * `ChannelDeliveryError`. There is no catch that swallows, no default that
 * shrugs, and no timeout that resolves. If this service cannot prove a transport
 * took the message, it says so and the delivery row says so.
 */

export interface GatewayConfig {
  readonly url: string;
  readonly token: string;
  readonly timeoutMs: number;
}

/**
 * Statuses worth trying again.
 *
 * 401/403 are deliberately NOT here even though they are "our side is wrong":
 * a rejected credential rejects every message, so retrying turns one bad token
 * into three times the traffic against somebody else's authentication endpoint
 * and a plausible source-IP block. It fails once, terminally, and the detail
 * says why so an operator reading the delivery row fixes the token instead of
 * watching a counter climb.
 */
function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

/**
 * One POST, with the per-channel parts left to the subclass.
 *
 * Subclasses supply two things and nothing else:
 *   `routeAddress`  the address this channel can actually use, or null if what
 *                   we hold is not routable here. Null becomes a refusal, never
 *                   a send to a garbage destination.
 *   `payload`       the JSON body. Per-channel, because the fields a mail relay
 *                   needs are not the fields a push service needs.
 */
export abstract class GatewayChannel implements NotificationChannel {
  /**
   * Credentials exist. That is not a probe. `/ready` must not treat this null
   * as `available` — see `ChannelRegistry.status()`.
   */
  readonly unavailableReason: RefusalCode | null = null;

  constructor(
    readonly channel: ChannelId,
    protected readonly config: GatewayConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** The address in the form this channel sends to, or null if it is not routable here. */
  protected abstract routeAddress(address: string): string | null;

  /** The JSON body for this channel. `to` is the already-routed address. */
  protected abstract payload(message: OutboundMessage, to: string): Record<string, unknown>;

  async deliver(message: OutboundMessage): Promise<DeliveryReceipt> {
    const to = this.routeAddress(message.address);
    if (to === null) {
      // Refusal, not failure: nothing was attempted, and no number of retries
      // will make an unroutable address routable. `attempted_at` stays NULL and
      // the row says exactly which of the two problems the user has.
      throw new ChannelRefusal(this.channel, 'channel.target_unroutable', `address is not routable on ${this.channel}`);
    }

    let response: Response;
    try {
      response = await this.fetchImpl(this.config.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.config.token}`,
          // At-least-once is the only delivery. A gateway that honours this
          // header turns our retry into their no-op; one that ignores it is why
          // we ALSO guard on our own delivery row before ever calling.
          'idempotency-key': message.idempotencyKey,
        },
        body: JSON.stringify(this.payload(message, to)),
        // A configured gateway URL that answers with a redirect is a
        // misconfiguration, not a route. Following it would carry the bearer
        // token one hop further than the owner authorised, so we refuse to
        // follow and report it rather than quietly obeying.
        redirect: 'error',
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
    } catch (err) {
      // Network error, DNS failure, timeout, refused redirect. The gateway may
      // well be fine in a minute, so this is retryable and the message is nak'd
      // back to the bus — bounded by NOTIFY_MAX_DELIVERY_ATTEMPTS, which is what
      // stops "retryable" meaning "forever".
      throw new ChannelDeliveryError(this.channel, err instanceof Error ? err.message : String(err), { retryable: true });
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      // Email is the mailbox. A handset or device token is not folded by letter case.
      const detail = truncate(redact(body, to, this.channel === 'email'), 300);
      throw new ChannelDeliveryError(this.channel, `gateway responded ${response.status}: ${detail}`, {
        retryable: isRetryableStatus(response.status),
        status: response.status,
      });
    }

    return { reference: await readReference(response) };
  }
}

/**
 * A channel with no credentials.
 *
 * It refuses, loudly and by name, every single time. It does NOT accept the
 * message and drop it, and it does NOT pretend to send: an adapter that returns
 * success while doing nothing is the exact failure this whole file exists to
 * prevent — the user gets no email, the record says the message went out, and
 * nobody finds out until a borrower asks why their collateral was sold.
 *
 * Registered rather than omitted so `/ready` and `notify.channels` can say
 * "email exists and is not wired" instead of email simply not appearing.
 *
 * In an enforced environment this class is not reachable for a channel the
 * operator declared required — `NOTIFY_REQUIRED_CHANNELS` makes the missing
 * credential fatal at boot instead (see `env.ts`). It stays the honest default
 * for dev, for test, and for a channel the operator has consciously not wired.
 */
export class UnconfiguredChannel implements NotificationChannel {
  readonly unavailableReason: RefusalCode = 'channel.not_configured';

  constructor(
    readonly channel: ChannelId,
    /** The env vars the owner must set. Reported verbatim — this is an ops instruction. */
    readonly missingEnv: readonly string[],
  ) {}

  async deliver(): Promise<DeliveryReceipt> {
    throw new ChannelRefusal(this.channel, 'channel.not_configured', `set ${this.missingEnv.join(' and ')}`);
  }
}

/**
 * The in-app inbox as a channel.
 *
 * The row is already written by the time the dispatcher runs — the inbox insert
 * is what created the notification. So this reports accepted and references the
 * row, which is true: the message is in the user's inbox and retrievable.
 *
 * "Accepted" here does not mean "read". `notifications.read_at` is the read
 * signal and it is a different column for the same reason `notified_at` is a
 * different column from `called_at`.
 */
export class InAppChannel implements NotificationChannel {
  readonly channel = 'inapp' as const;
  readonly unavailableReason: RefusalCode | null = null;

  async deliver(message: OutboundMessage): Promise<DeliveryReceipt> {
    return { reference: message.notificationId };
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** `%HH` with either hex case. Every other character in the encoding stays exact. */
function percentHexPattern(encoded: string): string {
  return escapeRegExp(encoded).replace(/%[0-9A-Fa-f]{2}/g, (token) => {
    const fold = (ch: string) => {
      const upper = ch.toUpperCase();
      const lower = ch.toLowerCase();
      return upper === lower ? upper : `${upper}${lower}`;
    };
    return `%[${fold(token.charAt(1))}][${fold(token.charAt(2))}]`;
  });
}

/**
 * Take the recipient back out of whatever the gateway said about them.
 *
 * A gateway rejecting a destination almost always echoes it — `The 'To' number
 * +447700900000 is not valid`, `invalid recipient borrower@example.com`. That
 * string becomes the delivery row's `detail`, and `detail` is not a field the
 * read API returns, so this is not an exposure to another user. It is still a
 * SECOND COPY of a mailbox, a handset or a device token, written to a table
 * whose rows outlive `channel_targets` — and `removeTarget` deletes the address
 * of record, not every place a gateway happened to quote it back. A delete path
 * that misses a copy is not a delete path.
 *
 * So the address is removed on the way in and the diagnosis is kept: an
 * operator reading the row still sees the status, the gateway's own wording and
 * its error code, which is what tells them whether to fix the token, the URL or
 * the number. They do not need the number printed twice to know which row it is
 * — the row is already keyed to the user.
 *
 * Substring, not a parse: the address may be JSON-quoted, percent-encoded in a
 * URL the gateway echoes, or repeated. Every occurrence goes. Percent-encoding
 * hex is case-insensitive, so `%2B` and `%2b` are the same octet. A mailbox
 * echo that differs only by case is the same recipient, including one the
 * gateway lowercased before encoding. A device token is not folded: another
 * case can be a different token.
 */
function redact(body: string, address: string, mailbox: boolean): string {
  if (address.length === 0) return body;
  const gone = '[address redacted]';
  let out = body.split(address).join(gone);
  if (mailbox) out = out.replace(new RegExp(escapeRegExp(address), 'gi'), gone);
  const encoded = encodeURIComponent(address);
  if (encoded === address) return out;
  const pattern = mailbox ? escapeRegExp(encoded) : percentHexPattern(encoded);
  return out.replace(new RegExp(pattern, mailbox ? 'gi' : 'g'), gone);
}

/** Cut to `max` INCLUDING the ellipsis, so a budget is a budget. */
export function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return max <= 1 ? '…'.slice(0, max) : `${value.slice(0, max - 1)}…`;
}

/** A gateway may return an id. It may not. Neither is an error. */
async function readReference(response: Response): Promise<string | null> {
  const text = await response.text().catch(() => '');
  if (!text) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && 'id' in parsed) {
      const id = (parsed as { id: unknown }).id;
      if (typeof id === 'string') return id;
      if (typeof id === 'number') return String(id);
    }
  } catch {
    // Not JSON. The transport accepted it; that is what we needed to know.
  }
  return null;
}
