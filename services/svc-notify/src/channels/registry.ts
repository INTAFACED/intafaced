import {
  CHANNEL_IDS,
  OUT_OF_APP_CHANNELS,
  type ChannelId,
  type NotificationChannel,
  type OutOfAppChannel,
  type RefusalCode,
} from './channel.js';
import { InAppChannel, UnconfiguredChannel } from './gateway.js';
import { EmailChannel, PushChannel, SmsChannel } from './adapters.js';
import { TestMerchantEmlChannel } from '../merchant-email/merchant-email.js';
import { socketIdForChannel, type NotifyChannelSocketId } from './mountain-vs-sockets.js';

/**
 * WHICH CHANNELS EXIST, AND WHICH ONE CAN ACTUALLY REACH ANYONE.
 *
 * Every channel is always registered. A channel with no credentials is
 * registered as an `UnconfiguredChannel`, not left out — because a missing key
 * in a map is indistinguishable from a channel nobody has written yet, and this
 * service has to be able to say "email exists, it is not wired, here is the env
 * var you are missing" to an operator reading `/ready`.
 *
 * The in-app inbox is always available and is the honest fallback (§13): if the
 * owner has obtained no credentials at all, users still get every notification,
 * in the app, and every out-of-app channel says on the record why it did not
 * send. That is a working notification system with three refusals — not a
 * broken one pretending.
 *
 * REFUSING IS THE DEFAULT, NOT THE POLICY
 *
 * "The channel refuses honestly" is the right answer in dev, in test, and for a
 * channel the operator has decided not to wire. It is the WRONG answer for a
 * channel a production deployment depends on — an operator who believes SMS
 * margin calls are going out, and whose delivery table quietly disagrees, is in
 * the same position as the borrower.
 *
 * So the operator declares the channels that must work, in
 * `NOTIFY_REQUIRED_CHANNELS`, and a required channel with no credentials is
 * fatal — here at construction and, before that, in `env.ts` at boot. Same
 * posture as `EDGE_PRINCIPAL_SECRET`: no default, and a process that cannot do
 * the job it was deployed for does not start and pretend.
 */

export interface ChannelEnv {
  readonly NOTIFY_EMAIL_GATEWAY_URL?: string | undefined;
  readonly NOTIFY_EMAIL_GATEWAY_TOKEN?: string | undefined;
  readonly NOTIFY_PUSH_GATEWAY_URL?: string | undefined;
  readonly NOTIFY_PUSH_GATEWAY_TOKEN?: string | undefined;
  readonly NOTIFY_SMS_GATEWAY_URL?: string | undefined;
  readonly NOTIFY_SMS_GATEWAY_TOKEN?: string | undefined;
  readonly NOTIFY_GATEWAY_TIMEOUT_MS: number;
  /** Characters before an SMS is cut. See `SmsChannel`. */
  readonly NOTIFY_SMS_MAX_CHARS?: number | undefined;
  /** Comma-separated out-of-app channels that MUST be configured, or `none`. */
  readonly NOTIFY_REQUIRED_CHANNELS?: string | undefined;
  /**
   * The operator switch for everything that leaves the platform. The registry
   * needs it because `notify.channels` answers whether the switch would refuse
   * a send. Absent → treated as on, which is the behaviour of every caller that
   * predates the switch. URL+token still never means reachable.
   */
  readonly NOTIFY_OUT_OF_APP_ENABLED?: boolean | undefined;
  /**
   * TEST file transport for email. Used only when this is exactly `1`, a
   * directory is set, and the email gateway URL and token are both blank.
   * Off when either is absent. Never a stand-in for a live gateway.
   */
  readonly NOTIFY_MERCHANT_EMAIL_TEST?: string | undefined;
  readonly NOTIFY_MERCHANT_EMAIL_TEST_DIR?: string | undefined;
}

/** Env var names per channel. Reported to operators verbatim, so they are data. */
export const GATEWAY_ENV = {
  email: { url: 'NOTIFY_EMAIL_GATEWAY_URL', token: 'NOTIFY_EMAIL_GATEWAY_TOKEN' },
  push: { url: 'NOTIFY_PUSH_GATEWAY_URL', token: 'NOTIFY_PUSH_GATEWAY_TOKEN' },
  sms: { url: 'NOTIFY_SMS_GATEWAY_URL', token: 'NOTIFY_SMS_GATEWAY_TOKEN' },
} as const satisfies Record<OutOfAppChannel, { url: string; token: string }>;

/** Default SMS budget: three GSM segments. Long enough for a margin call, bounded. */
export const DEFAULT_SMS_MAX_CHARS = 480;

/**
 * Parse `NOTIFY_REQUIRED_CHANNELS`.
 *
 * `none` is spelled out rather than left as the empty string, because "the
 * operator has decided in-app is enough" and "the operator has not thought about
 * it" must not look identical in a config file. `env.ts` refuses to boot an
 * enforced environment where this is absent for exactly that reason.
 *
 * Returns `{ ok: false, invalid }` rather than throwing so `env.ts` can report
 * every environment problem in one run, which is how `loadEnv` behaves.
 *
 * THIS IS THE ONLY PARSE OF `NOTIFY_REQUIRED_CHANNELS` IN THE SERVICE, and
 * `env.ts` is its only caller on the boot path.
 *
 * There were briefly two. A `required-channels.ts` took an extra `appEnv` and
 * re-derived the staging/prod enforcement `env.ts` already performs, on an
 * `APP_ENV` vocabulary this repo does not use (`'production'`; the enum in
 * `@intafaced/config` is dev/test/staging/prod). Nothing imported it. Two
 * implementations of a boot gate is one implementation and one lie: only one
 * can be the thing that actually stops a process, and the other drifts
 * unwatched until somebody wires it up believing it is the gate. If this parse
 * ever needs to vary by environment, it varies here, by parameter — not beside
 * this one as a rival.
 */
export function parseRequiredChannels(
  raw: string | undefined,
): { ok: true; channels: readonly OutOfAppChannel[] } | { ok: false; invalid: readonly string[] } {
  if (raw === undefined) return { ok: true, channels: [] };

  const parts = raw
    .split(',')
    .map((p) => p.trim().toLowerCase())
    .filter((p) => p.length > 0);

  if (parts.length === 1 && parts[0] === 'none') return { ok: true, channels: [] };

  // Separators and nothing else: `","`, `" , "`. `blankAsAbsent` in `env.ts`
  // already turns the empty string into "absent", so a value arriving here is
  // one the operator typed — and an enforced environment reads "typed
  // something" as "stated a posture". Punctuation is not a posture. Without
  // this line `NOTIFY_REQUIRED_CHANNELS=","` satisfies the staging/prod
  // requirement to declare while declaring nothing, and the deployment boots
  // depending on no channel at all: the precise silent outage the variable
  // exists to prevent. `none` is how you say none.
  //
  // A stray comma inside a real list (`email,,sms`) is still fine — that is a
  // typo in a stated posture, not an absent one.
  if (parts.length === 0) return { ok: false, invalid: [raw] };

  const invalid = parts.filter((p) => !(OUT_OF_APP_CHANNELS as readonly string[]).includes(p));
  if (invalid.length > 0) return { ok: false, invalid };

  return { ok: true, channels: [...new Set(parts as OutOfAppChannel[])] };
}

export interface ChannelStatus {
  readonly channel: ChannelId;
  /**
   * URL+token present (out-of-app) or always (in-app). Not a live probe.
   * Configured ≠ available.
   */
  readonly configured: boolean;
  /**
   * True only when this process can prove a route without a gateway POST —
   * `inapp`. A gateway with URL+token is never this without a probe, and this
   * process does not probe at boot.
   */
  readonly available: boolean;
  /** Null when available. A code, never a sentence — clients render their own copy. */
  readonly reason: RefusalCode | null;
  /** Env vars an operator must set to make this channel work. Empty when credentials exist. */
  readonly requires: readonly string[];
  /** True when this deployment declared the channel must work. Never true for `inapp`. */
  readonly required: boolean;
  /**
   * Doctrine §13 tracker id for out-of-app channels (`socket.notify-*`).
   * Null for `inapp` — that surface is the fan-out mountain (`ops.notifications`),
   * not a credential socket (D26-P1-O5).
   */
  readonly socket: NotifyChannelSocketId | null;
}

export class ChannelRegistry {
  private readonly channels: Map<ChannelId, NotificationChannel>;
  private readonly required: ReadonlySet<ChannelId>;
  private readonly outOfAppEnabled: boolean;

  constructor(channels: readonly NotificationChannel[], required: readonly OutOfAppChannel[] = [], outOfAppEnabled = true) {
    this.channels = new Map(channels.map((c) => [c.channel, c]));
    this.required = new Set<ChannelId>(required);
    this.outOfAppEnabled = outOfAppEnabled;

    for (const id of CHANNEL_IDS) {
      if (!this.channels.has(id)) {
        throw new Error(
          `ChannelRegistry is missing "${id}". Every channel must be registered — an absent channel cannot refuse, ` +
            'and a channel that cannot refuse is a channel that drops messages silently.',
        );
      }
    }

    // The second half of "absence is fatal". `env.ts` catches this at boot with a
    // better message; this catches the caller that built a registry by hand — the
    // tests, and any future wiring that does not come through `channelsFromEnv`.
    for (const id of this.required) {
      if (this.get(id).unavailableReason !== null) {
        throw new Error(
          `ChannelRegistry: "${id}" is listed in NOTIFY_REQUIRED_CHANNELS but has no credentials. ` +
            'A deployment that depends on this channel must not start without it — either configure it, or stop requiring it.',
        );
      }
    }
  }

  get(channel: ChannelId): NotificationChannel {
    // The constructor proved every id is present.
    return this.channels.get(channel)!;
  }

  /**
   * Why `deliver()` will refuse without a POST, or null.
   *
   * Credentials are one reason and the operator switch is the other. Null here
   * is "we would attempt", not "a gateway answered 2xx". `/ready` must not sell
   * that null as `available`.
   *
   * The switch is out-of-app only. `inapp` needs no gateway and no address, so
   * it stays the honest fallback in every operator state (§13).
   */
  private blockedReason(channel: NotificationChannel): RefusalCode | null {
    if (channel.unavailableReason !== null) return channel.unavailableReason;
    if (!this.outOfAppEnabled && channel.channel !== 'inapp') return 'channel.disabled';
    return null;
  }

  /**
   * Door reason for `/ready` and `notify.channels`.
   *
   * A gateway with URL+token and the switch on is `channel.unprobed` — this
   * process never POSTs at boot. Same class as P2P `moderationConfigured` ≠
   * reachable.
   */
  private doorReason(channel: NotificationChannel): RefusalCode | null {
    const blocked = this.blockedReason(channel);
    if (blocked !== null) return blocked;
    if (channel.channel !== 'inapp') return 'channel.unprobed';
    return null;
  }

  /** Channels whose door status is available. `inapp` only — gateways are unprobed. */
  availableChannels(): readonly ChannelId[] {
    return CHANNEL_IDS.filter((id) => this.doorReason(this.get(id)) === null);
  }

  /** The operator's view: what is configured, what is unprobed, what to set. */
  status(): readonly ChannelStatus[] {
    return CHANNEL_IDS.map((id) => {
      const channel = this.get(id);
      const requires = channel instanceof UnconfiguredChannel ? channel.missingEnv : [];
      const reason = this.doorReason(channel);
      return {
        channel: id,
        configured: channel.unavailableReason !== 'channel.not_configured',
        available: reason === null,
        reason,
        requires,
        required: this.required.has(id),
        socket: socketIdForChannel(id),
      };
    });
  }
}

/**
 * Build the registry from environment.
 *
 * A URL without a token is a configuration error, not a half-configured channel:
 * an unauthenticated notification gateway is an open relay for anything that can
 * reach it. `env.ts` refuses to load in that state, and this function treats the
 * pair as all-or-nothing for the same reason.
 */
export function channelsFromEnv(env: ChannelEnv, fetchImpl: typeof fetch = fetch): ChannelRegistry {
  const channels: NotificationChannel[] = [new InAppChannel()];
  const timeoutMs = env.NOTIFY_GATEWAY_TIMEOUT_MS;

  for (const id of OUT_OF_APP_CHANNELS) {
    const names = GATEWAY_ENV[id];
    const url = env[names.url as keyof ChannelEnv] as string | undefined;
    const token = env[names.token as keyof ChannelEnv] as string | undefined;

    if (id === 'email' && !url && !token && env.NOTIFY_MERCHANT_EMAIL_TEST === '1') {
      const dir = env.NOTIFY_MERCHANT_EMAIL_TEST_DIR?.trim();
      if (dir) {
        channels.push(new TestMerchantEmlChannel(dir));
        continue;
      }
    }

    if (!url || !token) {
      channels.push(new UnconfiguredChannel(id, [names.url, names.token]));
      continue;
    }

    const config = { url, token, timeoutMs };
    channels.push(
      id === 'email'
        ? new EmailChannel(config, fetchImpl)
        : id === 'push'
          ? new PushChannel(config, fetchImpl)
          : new SmsChannel({ ...config, maxChars: env.NOTIFY_SMS_MAX_CHARS ?? DEFAULT_SMS_MAX_CHARS }, fetchImpl),
    );
  }

  const required = parseRequiredChannels(env.NOTIFY_REQUIRED_CHANNELS);
  if (!required.ok) {
    throw new Error(`NOTIFY_REQUIRED_CHANNELS names channels that do not exist: ${required.invalid.join(', ')}`);
  }

  return new ChannelRegistry(channels, required.channels, env.NOTIFY_OUT_OF_APP_ENABLED ?? true);
}
