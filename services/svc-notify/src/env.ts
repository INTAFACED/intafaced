import { z } from 'zod';
import { edgeEnvSchema, loadEnv, serviceEnvSchema } from '@intafaced/config';
import { DEFAULT_SMS_MAX_CHARS, GATEWAY_ENV, parseRequiredChannels } from './channels/registry.js';
import { OUT_OF_APP_CHANNELS } from './channels/channel.js';

/**
 * svc-notify environment.
 *
 * Self-mounts /trpc, so it must authenticate the edge principal. No ledger
 * client. Guest outreach ingress uses a dedicated ops producer secret; it never
 * makes service-credential calls or moves value.
 *
 * THE CHANNEL CREDENTIALS (§0.4)
 *
 * Email, push and SMS each reach the world through a gateway URL the owner
 * configures. Whoever answers that URL is the owner's choice and is named
 * nowhere in this repository: §0.7 keeps partner names out of shipped code, and
 * keeping the name out of the code is also what makes changing provider an env
 * change rather than a release.
 *
 * A channel with no URL is not "off". It is UNCONFIGURED, and it refuses every
 * message by name so the refusal is on the record — see `channels/gateway.ts`.
 *
 * WHY THAT IS NOT ENOUGH ON ITS OWN, AND WHAT `NOTIFY_REQUIRED_CHANNELS` DOES
 *
 * An honest refusal is the right behaviour in dev and in test. In a deployment
 * that is supposed to be sending margin calls it is a silent outage with a good
 * paper trail — nobody reads a delivery table until somebody complains.
 *
 * So the operator states which channels this deployment depends on, and a
 * required channel with no credentials is FATAL AT BOOT. Same posture as
 * `EDGE_PRINCIPAL_SECRET` in `@intafaced/config`: no default, no fallback, the
 * process refuses to start. A notifier that cannot notify should page somebody
 * at deploy time, not at 3am through a borrower.
 *
 *   dev / test    unset means "nothing required". Frictionless: no gateway is
 *                 needed to run the suite or the local stack.
 *   staging/prod  unset is itself FATAL. The operator must write `none` to say
 *                 "in-app only, on purpose" — because "decided" and "never
 *                 thought about it" must not look the same in a config file.
 *
 * This variable does NOT decide which channels a product should use. That is the
 * owner's call, and inventing it here would be inventing product law. It only
 * makes the decision explicit and its absence loud.
 */

const bool = (defaultOn: boolean) =>
  z
    .union([z.boolean(), z.string()])
    .default(defaultOn)
    .transform((v) => (typeof v === 'boolean' ? v : !['0', 'false', 'off', 'no'].includes(String(v).toLowerCase())));

/**
 * An unset variable arrives as an empty string, not as nothing.
 *
 * `docker compose` interpolates `${NOTIFY_SMS_GATEWAY_URL:-}` to `""`, and every
 * other deployment system does something similar. Without this, an unset gateway
 * would fail `z.string().url()` and take the whole service down — turning "this
 * channel is not wired", which is a supported state, into a boot failure.
 *
 * Worse, it would let `NOTIFY_REQUIRED_CHANNELS=""` satisfy the staging/prod
 * requirement to STATE something while stating nothing. Blank is absent.
 */
const blankAsAbsent = <T extends z.ZodTypeAny>(inner: T) =>
  z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), inner);

/** Environments where an unwired-but-required channel must stop the boot. */
const ENFORCED_APP_ENVS = ['staging', 'prod'] as const;

const schema = serviceEnvSchema
  .merge(edgeEnvSchema)
  .merge(
    z.object({
      SERVICE_NAME: z.string().default('svc-notify'),
      HTTP_PORT: z.coerce.number().int().default(4015),
      /** Exact-body authenticated ops ingress; absent leaves it closed. */
      NOTIFY_OPS_SERVICE_SECRET: blankAsAbsent(z.string().min(32).optional()),
      /** Per-recipient fixed-window budget, separate from platform verification. */
      NOTIFY_GUEST_ADDRESS_MAX_PER_WINDOW: z.coerce.number().int().min(1).max(100).default(3),
      NOTIFY_GUEST_ADDRESS_WINDOW_MS: z.coerce.number().int().min(1000).max(86400000).default(900000),

      /**
       * Fan-out kill-switch. When false, event consumers still ack but do not
       * insert inbox rows — and therefore send nothing anywhere. Pairs with the
       * `notify.fanout` feature flag. The operator stop for notification spam.
       */
      NOTIFY_FANOUT_ENABLED: bool(true),

      /**
       * The narrower stop: keep filling the inbox, send nothing out of the
       * platform. This is the switch for an incident — silencing customers'
       * phones without also blinding them.
       */
      NOTIFY_OUT_OF_APP_ENABLED: bool(true),

      /**
       * Incident-silence latch (M18). When on, customer-facing venue truth
       * cannot flip back to allFine unless NOTIFY_INCIDENT_ALL_CLEAR is also
       * on AND matching is actually open. Matching resume is not auto-unmute.
       */
      NOTIFY_INCIDENT_SILENCE: bool(false),

      /**
       * Explicit all-clear for the incident-silence latch. Never invents
       * recovered: halt-all / one-market halt / missing matching source still
       * refuse allFine.
       */
      NOTIFY_INCIDENT_ALL_CLEAR: bool(false),

      /** Email gateway. URL and token are all-or-nothing; see the refine below. */
      NOTIFY_EMAIL_GATEWAY_URL: blankAsAbsent(z.string().url().optional()),
      NOTIFY_EMAIL_GATEWAY_TOKEN: blankAsAbsent(z.string().min(16).optional()),

      /** Push gateway. */
      NOTIFY_PUSH_GATEWAY_URL: blankAsAbsent(z.string().url().optional()),
      NOTIFY_PUSH_GATEWAY_TOKEN: blankAsAbsent(z.string().min(16).optional()),

      /** SMS gateway. */
      NOTIFY_SMS_GATEWAY_URL: blankAsAbsent(z.string().url().optional()),
      NOTIFY_SMS_GATEWAY_TOKEN: blankAsAbsent(z.string().min(16).optional()),

      /**
       * Which out-of-app channels this deployment DEPENDS ON: a comma-separated
       * subset of email, push, sms — or the literal `none`.
       *
       * No default. In `staging` and `prod` its absence stops the boot; see the
       * header. Anything listed here must have both of its gateway variables set
       * or the process refuses to start naming exactly which one is missing.
       */
      NOTIFY_REQUIRED_CHANNELS: blankAsAbsent(z.string().optional()),

      /**
       * Budget for one gateway call. A slow gateway must not stall the consumer.
       *
       * Cap is `MAX_GATEWAY_TIMEOUT_MS` (ack_wait − lease slack = 25s), not 30s:
       * above that the claim lease cannot both outlast the attempt and stay
       * under bus redelivery, which reopens multi-replica double-send.
       */
      NOTIFY_GATEWAY_TIMEOUT_MS: z.coerce.number().int().min(250).max(25_000).default(5_000),

      /**
       * Characters before an SMS body is cut. Three GSM segments by default.
       *
       * A cap rather than a refusal: refusing to send a margin call because its
       * translation ran long is worse than sending a cut one with a link. See
       * `SmsChannel`.
       */
      NOTIFY_SMS_MAX_CHARS: z.coerce.number().int().min(64).max(1_600).default(DEFAULT_SMS_MAX_CHARS),

      /**
       * Attempts per channel before a delivery row is abandoned. Kept at or below
       * the bus `maxDeliver` (5) so the row retires before JetStream parks the
       * message — otherwise the record would read "still retrying" about a
       * message nothing is retrying.
       * Blank / unset is unpublished — never 3. Owner may set 3 explicitly.
       */
      NOTIFY_MAX_DELIVERY_ATTEMPTS: blankAsAbsent(z.coerce.number().int().min(1).max(5).optional()),

      /**
       * How long an address-confirmation code stays valid.
       * Blank / unset is unpublished — never 15. Owner may set 15 explicitly.
       */
      NOTIFY_VERIFY_TTL_MINUTES: blankAsAbsent(z.coerce.number().int().min(1).max(120).optional()),

      /**
       * Public trade base URL for v22.alerts marks (`GET /api/v1/markets?limit=` +
       * `GET /api/v1/ticker/:symbol`). Same surface svc-bank already uses for
       * loan marks — no invent, no shared table. Need NOTIFY_MARKETS_LIST_LIMIT.
       *
       * Unset / blank → production keeps the dark MarkSource (canFire false).
       * Set → live wiring; individual quotes may still refuse when the book is
       * empty or trade is down.
       */
      TRADE_URL: blankAsAbsent(z.string().url().optional()),

      /**
       * Owner-published page size for live mark `GET /api/v1/markets?limit=`.
       * Blank / unset is unpublished — never 50. Trade cap is 500. Owner may
       * set 500 explicitly. Omit with TRADE_URL set refuses
       * `notify.markets_list_limit_unset` rather than dumping the listing.
       */
      NOTIFY_MARKETS_LIST_LIMIT: blankAsAbsent(z.coerce.number().int().min(1).max(500).optional()),

      /**
       * Matching public board for venue halt-all / one-market halt (GET /markets).
       * Unset / blank → unwired: do not invent live, halt, or all-clear.
       * Never POST /halt-all — matching halt is consume-only here.
       */
      MATCHING_URL: blankAsAbsent(z.string().url().optional()),

      /**
       * Whale-flow allow-list: comma-separated market ids that may quote a
       * sourced ticker volume. Blank / unset → dark whale mark
       * (`alerts.whale_mark_dark`). Membership is not a flow number — TRADE_URL
       * must also be set, and the ticker must publish quoteVolume/baseVolume.
       */
      NOTIFY_WHALE_FLOW_ALLOWLIST: blankAsAbsent(z.string().optional()),
    }),
  )
  .superRefine((parsed, ctx) => {
    // A gateway URL with no credential is an open relay for anything that can
    // reach it. Refusing to boot is the correct response: the alternative is a
    // service that looks configured and posts unauthenticated notifications at
    // somebody's endpoint.
    for (const channel of OUT_OF_APP_CHANNELS) {
      const names = GATEWAY_ENV[channel];
      const url = parsed[names.url];
      const token = parsed[names.token];
      if (url && !token) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [names.token],
          message: `${channel} gateway URL is set without ${names.token}. An unauthenticated notification gateway is an open relay — set the token, or unset the URL and let the channel refuse honestly.`,
        });
      }
    }

    const enforced = (ENFORCED_APP_ENVS as readonly string[]).includes(parsed.APP_ENV);

    if (enforced && parsed.NOTIFY_REQUIRED_CHANNELS === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['NOTIFY_REQUIRED_CHANNELS'],
        message:
          `APP_ENV=${parsed.APP_ENV} must state which out-of-app channels this deployment depends on. ` +
          'Set NOTIFY_REQUIRED_CHANNELS to a comma-separated subset of email,push,sms — or to `none` if in-app delivery ' +
          'alone is the intended posture. There is no default because "decided" and "never considered" must not look alike.',
      });
      return;
    }

    const required = parseRequiredChannels(parsed.NOTIFY_REQUIRED_CHANNELS);
    if (!required.ok) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['NOTIFY_REQUIRED_CHANNELS'],
        message: `unknown channel(s): ${required.invalid.join(', ')}. Allowed: ${OUT_OF_APP_CHANNELS.join(', ')} — or \`none\`.`,
      });
      return;
    }

    for (const channel of required.channels) {
      const names = GATEWAY_ENV[channel];
      const missing = [names.url, names.token].filter((name) => !parsed[name]);
      if (missing.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['NOTIFY_REQUIRED_CHANNELS'],
          message:
            `${channel} is listed in NOTIFY_REQUIRED_CHANNELS but ${missing.join(' and ')} ${missing.length > 1 ? 'are' : 'is'} not set. ` +
            'A deployment that depends on this channel must not start without it — every message would be refused and the outage would ' +
            'be visible only to whoever reads notify.deliveries.',
        });
      }
    }

    // Requiring a channel and switching all out-of-app sending off is a
    // contradiction, and it is the shape a bad rollback takes: the kill-switch
    // is flipped during an incident and never flipped back. Refuse it rather
    // than run a deployment whose two settings disagree about whether the
    // margin calls go out.
    if (required.channels.length > 0 && !parsed.NOTIFY_OUT_OF_APP_ENABLED) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['NOTIFY_OUT_OF_APP_ENABLED'],
        message:
          `NOTIFY_REQUIRED_CHANNELS lists ${required.channels.join(', ')} while NOTIFY_OUT_OF_APP_ENABLED is off, so every ` +
          'required channel would refuse. Turn sending on, or stop requiring the channels.',
      });
    }
  });

export const envSchema = schema;
export const env = loadEnv(schema);
export type Env = typeof env;
