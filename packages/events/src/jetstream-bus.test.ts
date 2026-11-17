import { randomUUID } from 'node:crypto';
import { connect } from 'nats';
import { recordInfraProbe } from '@intafaced/db';
import { afterAll, describe, expect, it } from 'vitest';
import { ACK_WAIT_NS, BUS_DELIVERED, JetStreamEventBus, nakBackoffMs } from './jetstream-bus.js';

/**
 * `JetStreamEventBus` against a real NATS server.
 *
 * Until this file existed, nothing executed it. CI has run a `nats:2.10-alpine`
 * service container for a long time and no test ever connected to it, so the
 * bus every service runs on in production was covered only by `MemoryEventBus`
 * — which shares none of the mechanism that matters here.
 *
 * What matters here is the at-least-once contract, because twelve services'
 * money-adjacent handlers are written against it: a handler that throws must be
 * redelivered, a handler that returns must not be, and redelivery must stop at
 * `max_deliver` rather than running forever. Every idempotency guard in the
 * fleet — svc-notify's delivery claim, svc-ledger's request ids — exists to
 * survive exactly this behaviour, and none of them was ever run against the
 * real thing.
 *
 * Skips without a reachable server, on the same posture as the Postgres suites.
 */

const URL = process.env.NATS_URL ?? 'nats://localhost:4222';

/**
 * Journalled, like the Postgres and dev-chain probes.
 *
 * A skip that writes nothing to the infra journal is a skip `pnpm verify` cannot
 * report, and a run that quietly did not test the bus reads exactly like a run
 * that did. `recordInfraProbe` is what makes the verdict able to say "nats
 * unreachable — 1 suite did not run".
 */
async function natsReachable(): Promise<boolean> {
  try {
    const nc = await connect({ servers: URL, timeout: 3_000, maxReconnectAttempts: 0 });
    await nc.close();
    recordInfraProbe({ dependency: 'nats', outcome: 'ran', target: URL });
    return true;
  } catch (err) {
    recordInfraProbe({
      dependency: 'nats',
      outcome: 'skipped',
      target: URL,
      reason: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

const available = await natsReachable();

/** A prefix per run, so a re-run never inherits a previous run's consumer state. */
const PREFIX = `TEST${randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase()}`;
const buses: JetStreamEventBus[] = [];

async function bus(): Promise<JetStreamEventBus> {
  const b = await JetStreamEventBus.connect({
    servers: URL,
    producer: 'svc-identity',
    streamPrefix: PREFIX,
    ownedStreams: ['identity'],
  });
  buses.push(b);
  return b;
}

function user() {
  return { userId: randomUUID(), handle: `h-${randomUUID().slice(0, 8)}` };
}

/** Poll rather than sleep a fixed amount — a fixed sleep is a flaky test. */
async function until(predicate: () => boolean, timeoutMs = 8_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return predicate();
}

afterAll(async () => {
  await Promise.all(buses.map((b) => b.close().catch(() => undefined)));
});

/** Pure — runs everywhere, including the machines with no NATS. */
describe('nak backoff', () => {
  it('doubles from one second and caps at eight', () => {
    expect([1, 2, 3, 4, 5, 6].map(nakBackoffMs)).toEqual([1_000, 2_000, 4_000, 8_000, 8_000, 8_000]);
  });

  it('treats a missing or nonsense redelivery count as the first attempt', () => {
    expect(nakBackoffMs(0)).toBe(1_000);
    expect(nakBackoffMs(-3)).toBe(1_000);
    expect(nakBackoffMs(Number.NaN)).toBe(1_000);
  });

  it('spans a useful window across a default budget rather than milliseconds', () => {
    // Five attempts: 1 + 2 + 4 + 8 = 15s of waiting before the message parks.
    const total = [1, 2, 3, 4].reduce((sum, n) => sum + nakBackoffMs(n), 0);
    expect(total).toBe(15_000);
  });
});

describe.skipIf(!available)('JetStreamEventBus — the at-least-once contract every handler is written against', () => {
  it('delivers a published event to a durable subscriber', async () => {
    const b = await bus();
    const seen: string[] = [];
    const payload = user();

    await b.subscribe(
      'userCreated',
      async (p) => {
        seen.push(p.userId);
      },
      { durable: `d-${randomUUID().slice(0, 8)}` },
    );

    await b.publish('userCreated', payload);

    expect(await until(() => seen.includes(payload.userId))).toBe(true);
  });

  it('redelivers when the handler throws, and stops when it returns', async () => {
    // This is the property svc-notify's delivery claim exists to survive: the
    // same business event arriving at a handler more than once.
    const b = await bus();
    const payload = user();
    let attempts = 0;

    await b.subscribe(
      'userCreated',
      async (p) => {
        if (p.userId !== payload.userId) return;
        attempts += 1;
        if (attempts < 2) throw new Error('transient — nak me');
      },
      { durable: `d-${randomUUID().slice(0, 8)}`, maxDeliver: 5 },
    );

    await b.publish('userCreated', payload);

    expect(await until(() => attempts >= 2)).toBe(true);
    // Settle: it must not keep coming back once the handler stopped throwing.
    await new Promise((r) => setTimeout(r, 500));
    expect(attempts).toBe(2);
  });

  it('spaces the retries instead of spending the whole budget at once', async () => {
    // A bare nak() redelivers immediately, so five attempts against a gateway
    // returning 503 were spent inside a few milliseconds and the message parked
    // before the blip had finished. The gaps are what make it a retry.
    const b = await bus();
    const payload = user();
    const at: number[] = [];

    await b.subscribe(
      'userCreated',
      async (p) => {
        if (p.userId !== payload.userId) return;
        at.push(Date.now());
        throw new Error('transient');
      },
      { durable: `d-${randomUUID().slice(0, 8)}`, maxDeliver: 3 },
    );

    await b.publish('userCreated', payload);

    expect(await until(() => at.length >= 2, 12_000)).toBe(true);
    // First retry waits ~1s. Allow generous slack for a loaded CI runner; the
    // assertion is "not immediate", not a precise schedule.
    expect(at[1]! - at[0]!).toBeGreaterThan(400);
  });

  it('stops redelivering at maxDeliver rather than retrying forever', async () => {
    const b = await bus();
    const payload = user();
    let attempts = 0;

    await b.subscribe(
      'userCreated',
      async (p) => {
        if (p.userId !== payload.userId) return;
        attempts += 1;
        throw new Error('permanently broken');
      },
      { durable: `d-${randomUUID().slice(0, 8)}`, maxDeliver: 3 },
    );

    await b.publish('userCreated', payload);

    expect(await until(() => attempts >= 3)).toBe(true);
    await new Promise((r) => setTimeout(r, 500));
    // Stopped, not spinning. A bus that retried forever would keep a broken
    // handler hot and hide the failure.
    expect(attempts).toBe(3);
  });

  it('writes one timed line per delivery, in the consuming process, holding no payload (#8657)', async () => {
    // The journey recorder ties a service to the journey running when its log
    // has a line with a `time`; a handler that logs nothing was recorded nowhere.
    const b = await bus();
    const payload = user();
    const durable = `d-${randomUUID().slice(0, 8)}`;
    const lines: string[] = [];
    const realLog = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(String(args[0]));
    };
    try {
      // A new durable starts from the stream's first message (DeliverPolicy.All),
      // so it also receives what earlier tests published: one line per call.
      let calls = 0;
      let handled = false;
      await b.subscribe(
        'userCreated',
        async (p) => {
          calls += 1;
          if (p.userId === payload.userId) handled = true;
        },
        { durable },
      );
      const before = Date.now();
      await b.publish('userCreated', payload);
      const delivered = () =>
        lines
          .map((line) => {
            try {
              return JSON.parse(line) as Record<string, unknown>;
            } catch {
              return null;
            }
          })
          .filter((entry) => entry?.event === BUS_DELIVERED && entry?.durable === durable);
      // The line is written before the handler runs: once ours is handled, every call has its line.
      expect(await until(() => handled)).toBe(true);
      const mine = delivered();
      expect(mine).toHaveLength(calls);
      for (const line of mine) {
        expect(line).toMatchObject({ level: 30, subject: 'intafaced.identity.user.created', attempt: 1, msg: 'bus delivered' });
        expect(Object.keys(line ?? {}).sort()).toEqual(['attempt', 'durable', 'event', 'level', 'msg', 'subject', 'time']);
      }
      expect(mine.at(-1)!.time as number).toBeGreaterThanOrEqual(before);
      expect(lines.join('\n')).not.toContain(payload.userId);
    } finally {
      console.log = realLog;
    }
  });

  it('says so, once, when it gives up — the message is otherwise abandoned in silence', async () => {
    // "Parked for the operator" was the claim, and no operator was ever told:
    // there is no dead-letter subject, no advisory consumer, and no row. A
    // margin call that spent its whole budget left the same trace as one that
    // was never published.
    const b = await bus();
    const payload = user();
    const key = `abandoned-${randomUUID()}`;
    const lines: string[] = [];
    const realError = console.error;
    console.error = (...args: unknown[]) => {
      lines.push(String(args[0]));
    };

    try {
      let attempts = 0;
      await b.subscribe(
        'userCreated',
        async (p) => {
          if (p.userId !== payload.userId) return;
          attempts += 1;
          throw new Error('permanently broken');
        },
        { durable: `d-${randomUUID().slice(0, 8)}`, maxDeliver: 2 },
      );

      await b.publish('userCreated', payload, { idempotencyKey: key });
      expect(await until(() => attempts >= 2)).toBe(true);
      // Long enough for a third delivery to arrive if the budget were not spent,
      // so a second announcement would be caught rather than raced past.
      await new Promise((r) => setTimeout(r, 1_500));

      const announced = lines
        .map((line) => {
          try {
            return JSON.parse(line) as Record<string, unknown>;
          } catch {
            return null;
          }
        })
        .filter((entry) => entry?.event === 'bus.message_abandoned' && entry?.idempotencyKey === key);

      // ONCE. On the last attempt, not on every failed one — an error line per
      // retry is how a real one gets skimmed past.
      expect(announced).toHaveLength(1);
      expect(announced[0]).toMatchObject({
        subject: 'intafaced.identity.user.created',
        attempts: 2,
        reason: 'permanently broken',
      });
      expect(announced[0]!.durable).toBeTruthy();
    } finally {
      console.error = realError;
    }
  });

  it('applies a changed maxDeliver to a durable that already exists', async () => {
    // A durable consumer is created once and then lives in the server. `add`
    // on one that already exists does NOT apply the config it is handed — it
    // either refuses or hands back the config the server already had. So
    // before this was reconciled, `max_deliver` and `ack_wait` were whatever
    // the FIRST boot of that durable asked for, permanently: changing either
    // in jetstream-bus.ts had no effect on any deployment past its first.
    //
    // Reached through the public `subscribe`, not by calling the helper, so it
    // is the boot path that is under test — that is where the drift lived.
    const b = await bus();
    const durable = `d-${randomUUID().slice(0, 8)}`;

    const first = await b.subscribe('userCreated', async () => {}, { durable, maxDeliver: 2 });
    await first.unsubscribe();

    const second = await b.subscribe('userCreated', async () => {}, { durable, maxDeliver: 4 });
    await second.unsubscribe();

    // Asked of the SERVER, not of our own config object — the whole failure was
    // that the two had stopped being the same thing.
    const nc = await connect({ servers: URL });
    try {
      const info = await (await nc.jetstreamManager()).consumers.info(`${PREFIX}_IDENTITY`, durable);
      expect(info.config.max_deliver).toBe(4);
      // The other value `subscribe` sets, and the one svc-notify's claim lease
      // is bounded against.
      expect(info.config.ack_wait).toBe(ACK_WAIT_NS);
    } finally {
      await nc.close();
    }
  });

  it('publishes the same idempotency key once — server-side dedupe inside the window', async () => {
    const b = await bus();
    const payload = user();
    const seen: string[] = [];
    const key = `dedupe-${randomUUID()}`;

    await b.subscribe(
      'userCreated',
      async (p, env) => {
        if (p.userId === payload.userId) seen.push(env.idempotencyKey);
      },
      { durable: `d-${randomUUID().slice(0, 8)}` },
    );

    await b.publish('userCreated', payload, { idempotencyKey: key });
    await b.publish('userCreated', payload, { idempotencyKey: key });

    expect(await until(() => seen.length >= 1)).toBe(true);
    await new Promise((r) => setTimeout(r, 500));
    // Two publishes, one message: `msgID` is what makes a retried producer safe.
    expect(seen).toHaveLength(1);
  });

  it('a second durable name gets its own copy — one stream, independent consumers', async () => {
    const b = await bus();
    const payload = user();
    const a: string[] = [];
    const c: string[] = [];

    await b.subscribe(
      'userCreated',
      async (p) => {
        if (p.userId === payload.userId) a.push(p.userId);
      },
      { durable: `d-${randomUUID().slice(0, 8)}` },
    );
    await b.subscribe(
      'userCreated',
      async (p) => {
        if (p.userId === payload.userId) c.push(p.userId);
      },
      { durable: `d-${randomUUID().slice(0, 8)}` },
    );

    await b.publish('userCreated', payload);

    expect(await until(() => a.length >= 1 && c.length >= 1)).toBe(true);
  });

  it('unsubscribe stops delivery without closing the connection', async () => {
    const b = await bus();
    const seen: string[] = [];

    const sub = await b.subscribe(
      'userCreated',
      async (p) => {
        seen.push(p.userId);
      },
      { durable: `d-${randomUUID().slice(0, 8)}` },
    );
    await sub.unsubscribe();

    const after = user();
    await b.publish('userCreated', after);
    await new Promise((r) => setTimeout(r, 500));

    expect(seen).not.toContain(after.userId);
  });
});
