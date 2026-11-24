import {
  connect,
  type NatsConnection,
  type JetStreamClient,
  type JetStreamManager,
  type ConsumerInfo,
  RetentionPolicy,
  AckPolicy,
  DeliverPolicy,
} from 'nats';
import type { ModuleId } from '@intafaced/config';
import { EVENT_CATALOG, type EventDef, type EventName } from './catalog.js';
import { streamName, wildcard } from './subject.js';
import { decodeEnvelope, encodeEnvelope, type Envelope } from './envelope.js';
import {
  acceptEnvelope,
  buildEnvelope,
  type EventBus,
  type Handler,
  type Payload,
  type PublishOptions,
  type SubscribeOptions,
  type Subscription,
} from './bus.js';

/**
 * NATS JetStream implementation of the bus.
 *
 * Streams are per-service (`INTAFACED_LEDGER` carries `intafaced.ledger.>`),
 * so a service's event history can be replayed, retained, or purged on its own
 * terms — §10: "event sourcing where money moves ... replayable by design".
 *
 * Publishes use JetStream's `msgID` for server-side dedupe inside the dedupe
 * window; the consumer-side `idempotent()` wrapper covers everything beyond it.
 */

export interface JetStreamBusOptions {
  servers: string;
  /** The service publishing — becomes envelope.producer. */
  producer: string;
  streamPrefix?: string;
  /** Services whose streams this process is responsible for creating. */
  ownedStreams?: readonly ModuleId[];
  name?: string;
}

export class JetStreamEventBus implements EventBus {
  private constructor(
    private readonly nc: NatsConnection,
    private readonly js: JetStreamClient,
    private readonly jsm: JetStreamManager,
    private readonly opts: Required<Pick<JetStreamBusOptions, 'producer' | 'streamPrefix'>>,
    private readonly subs: Subscription[] = [],
  ) {}

  static async connect(opts: JetStreamBusOptions): Promise<JetStreamEventBus> {
    const nc = await connect({ servers: opts.servers, name: opts.name ?? opts.producer });
    const jsm = await nc.jetstreamManager();
    const js = nc.jetstream();
    const prefix = opts.streamPrefix ?? 'INTAFACED';

    for (const service of opts.ownedStreams ?? []) {
      await ensureStream(jsm, service, prefix);
    }

    return new JetStreamEventBus(nc, js, jsm, { producer: opts.producer, streamPrefix: prefix });
  }

  async publish<K extends EventName>(name: K, payload: Payload<K>, opts: PublishOptions = {}): Promise<Envelope<Payload<K>>> {
    const def = EVENT_CATALOG[name] as EventDef;
    const env = buildEnvelope(name, payload, this.opts.producer, opts);
    await this.js.publish(def.subject, encodeEnvelope(env as Envelope), { msgID: env.idempotencyKey });
    return env;
  }

  async subscribe<K extends EventName>(name: K, handler: Handler<K>, opts: SubscribeOptions): Promise<Subscription> {
    const def = EVENT_CATALOG[name] as EventDef;
    const stream = streamName(def.service, this.opts.streamPrefix);

    const maxDeliver = opts.maxDeliver ?? DEFAULT_MAX_DELIVER;

    await ensureConsumer(this.jsm, stream, {
      durable_name: opts.durable,
      ack_policy: AckPolicy.Explicit,
      deliver_policy: DeliverPolicy.All,
      filter_subject: def.subject,
      max_deliver: maxDeliver,
      ack_wait: ACK_WAIT_NS,
    });

    const consumer = await this.js.consumers.get(stream, opts.durable);
    const messages = await consumer.consume();

    let stopped = false;
    const pump = (async () => {
      for await (const msg of messages) {
        if (stopped) break;
        announceDelivered(def.subject, opts.durable, () => msg.info.redeliveryCount);
        try {
          const env = decodeEnvelope(msg.data);
          // Version, schema, and drift. A message carrying a field this build
          // cannot name is NAK'd rather than delivered with the field removed —
          // see `EventSchemaDriftError`. The stream retains it for 90 days, so
          // a rebuild is all that stands between the refusal and delivery.
          const validated = acceptEnvelope(name, env);
          await handler(validated, env as Envelope<Payload<K>>);
          msg.ack();
        } catch (err) {
          // Redelivery is JetStream's job. Never ack a message we failed to
          // process.
          //
          // The delay is the difference between retrying and only appearing to.
          // A bare `nak()` redelivers immediately, so the default budget of five
          // attempts against a gateway returning 503 was spent inside a few
          // milliseconds and the message parked before the blip it was meant to
          // ride out had finished. svc-notify says a transient failure MUST be
          // retried; three attempts in five milliseconds is not a retry.
          const attempt = msg.info.redeliveryCount;
          if (attempt >= maxDeliver) announceAbandoned(def.subject, opts.durable, attempt, msg.data, err);
          msg.nak(nakBackoffMs(attempt));
          if (!(err instanceof Error)) throw err;
        }
      }
    })();

    const sub: Subscription = {
      unsubscribe: async () => {
        stopped = true;
        messages.stop();
        await pump.catch(() => undefined);
      },
    };

    if (opts.signal) opts.signal.addEventListener('abort', () => void sub.unsubscribe(), { once: true });
    this.subs.push(sub);
    return sub;
  }

  async close(): Promise<void> {
    await Promise.all(this.subs.map((s) => s.unsubscribe()));
    await this.nc.drain();
  }

  /**
   * Resolves when this NATS connection is gone for good (drain, close, or
   * server drop). Used by svc-ws to drop `/ready` bus flags and re-attach
   * without a process restart. Not a liveness probe while TCP reconnects.
   */
  whenClosed(): Promise<void> {
    return this.nc.closed().then(() => undefined);
  }
}

/** The `event` of the line the bus writes for each message it delivers (announceDelivered). */
export const BUS_DELIVERED = 'bus.delivered';

/**
 * One line, in the consuming service's own output, for each message the bus
 * hands to a handler: its time, subject, durable and attempt. A handler that
 * logs nothing and serves no request otherwise leaves no trace that it ran, so
 * the journey recorder (tooling/scripts/journey-reach.mjs) could not tie the
 * service to the journey running at that moment, and every change to a
 * subscribing service had to run the whole journey suite (intafaced #8657).
 * The line holds no payload. Pino's shape (`level` 30 is info, `time` in ms),
 * on stdout, because this package depends on no logger. Never throws.
 */
function announceDelivered(subject: string, durable: string, attempt: () => number): void {
  try {
    console.log(
      JSON.stringify({ level: 30, time: Date.now(), event: BUS_DELIVERED, subject, durable, attempt: attempt(), msg: 'bus delivered' }),
    );
  } catch {
    // A delivery is never held up by its own log line.
  }
}

/**
 * The last attempt has just failed — say so, once, before the bus goes quiet.
 *
 * WHAT "PARKED FOR THE OPERATOR" USED TO MEAN
 *
 * Nothing. `SubscribeOptions.maxDeliver` said "before the message goes to the
 * dead-letter subject", and there is no dead-letter subject — the phrase
 * appeared exactly once in this repo, in that sentence. JetStream simply stops
 * redelivering: no subject, no row, no log, no advisory consumer. A margin call
 * that failed its whole budget left the same trace as one that was never
 * published, and the only "operator" who could have been reading was a NATS
 * advisory nobody subscribes to.
 *
 * So this is not a dead-letter queue and does not pretend to be one. Publishing
 * to a new subject would mean inventing one in the catalog, which is a decision
 * and not a bug fix. This is the smallest true thing: the moment the bus gives
 * up is the moment somebody is told, with enough to find the message — subject,
 * durable, attempt count, and the envelope's own idempotency key, which is what
 * a replay would be keyed on.
 *
 * `console.error` because this package deliberately depends on no logger and
 * chooses none for its consumers. A structured line on a path that should never
 * run beats a silence that always looks healthy.
 *
 * Fail-safe: this must never be why a message is not nak'd, so every part of it
 * that could throw — decoding a payload that already failed to parse — is
 * caught and dropped in favour of reporting less.
 */
function announceAbandoned(subject: string, durable: string, attempt: number, data: Uint8Array, err: unknown): void {
  let idempotencyKey = 'unknown';
  let producer = 'unknown';
  try {
    const env = decodeEnvelope(data);
    idempotencyKey = env.idempotencyKey;
    producer = env.producer;
  } catch {
    // The message could not be decoded — which may well be why it failed. The
    // announcement is worth more than the fields it is missing.
  }

  console.error(
    JSON.stringify({
      level: 'error',
      event: 'bus.message_abandoned',
      subject,
      durable,
      producer,
      idempotencyKey,
      attempts: attempt,
      reason: err instanceof Error ? err.message : String(err),
      msg:
        'event bus gave up on this message — max_deliver is spent, JetStream will not redeliver it, ' +
        'and nothing downstream will retry it. The stream retains it for 90 days: it can be replayed ' +
        'by resetting this durable consumer once the cause is fixed.',
    }),
  );
}

/**
 * How long to wait before a nak'd message comes back.
 *
 * Doubling from one second, capped at eight, so a default budget of five
 * attempts spans roughly half a minute instead of a few milliseconds. The cap
 * matters as much as the growth: a message must still reach `max_deliver` and
 * park while an operator is awake to see it, rather than drifting into a
 * retry schedule nobody is watching.
 *
 * `redeliveryCount` is 1 on the first delivery, so the first retry waits 1s.
 */
export function nakBackoffMs(redeliveryCount: number): number {
  const attempt = Number.isFinite(redeliveryCount) && redeliveryCount > 0 ? Math.floor(redeliveryCount) : 1;
  return Math.min(1_000 * 2 ** (attempt - 1), 8_000);
}

/**
 * Default redelivery budget for a durable consumer.
 *
 * Named (not a bare `5`) because other packages reason against it — svc-notify
 * pins `NOTIFY_MAX_DELIVERY_ATTEMPTS` at or below this, and stuck-pending grace
 * is `DEFAULT_MAX_DELIVER × ACK_WAIT_MS`. A bound computed against a number
 * nobody exports is a bound that drifts in silence.
 */
export const DEFAULT_MAX_DELIVER = 5;

/**
 * The bus `ack_wait`, in milliseconds. 30s.
 *
 * Same law as `ACK_WAIT_NS` — milliseconds for callers that compute leases
 * without inventing a second copy of "30 seconds".
 */
export const ACK_WAIT_MS = 30_000;

/**
 * The bus `ack_wait`, in nanoseconds. 30s.
 *
 * Named because other packages reason against it: `svc-notify`'s claim lease
 * must outlast one gateway attempt and stay UNDER this, and its docstring cites
 * the number. A bound computed against a constant that has drifted is not a
 * bound. Derived from `ACK_WAIT_MS` so the two cannot disagree.
 */
export const ACK_WAIT_NS = ACK_WAIT_MS * 1_000_000;

/**
 * Idempotent consumer creation — and, unlike before, idempotent RECONCILIATION.
 *
 * THE DRIFT THIS CLOSES
 *
 * `subscribe()` called `consumers.add()` and stopped there. A durable consumer
 * is created once and then lives in the server; `add` on one that already
 * exists does not apply the config it was handed — it either refuses or returns
 * the config the server already had. So `max_deliver` and `ack_wait` were
 * whatever the FIRST boot of that durable asked for, permanently, and changing
 * either in this file had no effect on any deployment past its first.
 *
 * `ensureStream` below has always done the other thing — catch "already exists"
 * and call `streams.update`, "in case the registry grew". Streams reconciled on
 * every boot; consumers never did. That asymmetry was the bug.
 *
 * It matters beyond tidiness because other services compute bounds against
 * these numbers. `svc-notify`'s README requires `NOTIFY_MAX_DELIVERY_ATTEMPTS`
 * to sit "at or below the bus maxDeliver", and the delivery row that retires a
 * spent margin call depends on that relationship holding. A live consumer with
 * a stale `max_deliver` makes that bound a statement about a number nobody is
 * using.
 *
 * Reconciled by COMPARISON rather than by catching an error, because the two
 * possible behaviours of `add` on an existing durable — refuse, or hand back
 * the stale config — need the same correction and only one of them throws.
 * `filter_subject` is deliberately not reconciled: JetStream does not accept it
 * in an update, and it is derived from the event name, so it cannot drift
 * without the durable name drifting too.
 */
async function ensureConsumer(jsm: JetStreamManager, stream: string, cfg: ConsumerConfigInput): Promise<void> {
  let live: ConsumerInfo;
  try {
    live = await jsm.consumers.add(stream, cfg);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!/already exists|already in use/i.test(message)) throw err;
    live = await jsm.consumers.info(stream, cfg.durable_name);
  }

  if (live.config.max_deliver === cfg.max_deliver && live.config.ack_wait === cfg.ack_wait) return;

  await jsm.consumers.update(stream, cfg.durable_name, {
    max_deliver: cfg.max_deliver,
    ack_wait: cfg.ack_wait,
  });
}

interface ConsumerConfigInput {
  durable_name: string;
  ack_policy: AckPolicy;
  deliver_policy: DeliverPolicy;
  filter_subject: string;
  max_deliver: number;
  ack_wait: number;
}

/** Idempotent stream creation — safe to call on every boot. */
export async function ensureStream(jsm: JetStreamManager, service: ModuleId, prefix = 'INTAFACED'): Promise<void> {
  const name = streamName(service, prefix);
  const config = {
    name,
    subjects: [wildcard(service)],
    retention: RetentionPolicy.Limits,
    max_age: 90 * 24 * 60 * 60 * 1_000_000_000, // 90d in ns
    duplicate_window: 2 * 60 * 1_000_000_000, // 2m dedupe window
  };

  try {
    await jsm.streams.add(config);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Already exists — reconcile subjects in case the registry grew.
    if (/already in use|stream name already/i.test(message)) {
      await jsm.streams.update(name, config);
      return;
    }
    throw err;
  }
}
