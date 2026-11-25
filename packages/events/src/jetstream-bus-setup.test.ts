import { afterEach, describe, expect, it, vi } from 'vitest';
import { JS_API_TIMEOUT_MS, TRANSIENT_JS_CODES, retryTransientJetStream, type JetStreamRetryOptions } from './jetstream-bus.js';

const natsError = (code: string, message = code) => Object.assign(new Error(message), { name: 'NatsError', code });

const fakeClock = (): Required<Pick<JetStreamRetryOptions, 'now' | 'pause'>> & { elapsed: () => number; sleeps: number[] } => {
  let t = 0;
  const sleeps: number[] = [];
  return {
    now: () => t,
    pause: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    elapsed: () => t,
    sleeps,
  };
};

const emptyMessages = () =>
  Object.assign(
    (async function* () {
      // no messages needed for setup tests
    })(),
    { stop: vi.fn() },
  );

describe('JetStreamEventBus setup — transient JetStream timeouts during boot and restart (#10801)', () => {
  afterEach(() => {
    vi.doUnmock('nats');
    vi.resetModules();
  });

  it('gives JetStream API calls 15 s and retries a transient TIMEOUT from consumers.add on subscribe (trade-fills on svc-trade restart)', async () => {
    let addCalls = 0;
    const jsmOpts: unknown[] = [];
    const jsOpts: unknown[] = [];
    const consumer = { consume: async () => emptyMessages() };
    const connection = {
      jetstreamManager: vi.fn(async (opts?: unknown) => {
        jsmOpts.push(opts);
        return {
          consumers: {
            add: vi.fn(async (_stream: string, cfg: unknown) => {
              addCalls += 1;
              if (addCalls === 1) throw natsError('TIMEOUT');
              return { config: cfg };
            }),
          },
        };
      }),
      jetstream: vi.fn((opts?: unknown) => {
        jsOpts.push(opts);
        return { consumers: { get: vi.fn(async () => consumer) } };
      }),
      drain: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    };

    vi.resetModules();
    vi.doMock('nats', async () => ({ ...(await vi.importActual<typeof import('nats')>('nats')), connect: async () => connection }));

    const clock = fakeClock();
    const { JetStreamEventBus } = await import('./jetstream-bus.js');
    const bus = await JetStreamEventBus.connect({
      servers: 'nats://unused',
      producer: 'svc-trade',
      streamPrefix: 'LOCAL_TEST',
      setupRetry: clock,
    });
    try {
      const sub = await bus.subscribe('orderFilled', async () => undefined, { durable: 'trade-fills' });
      expect(addCalls).toBe(2);
      expect(clock.sleeps).toEqual([1_000]);
      expect(jsmOpts[0]).toMatchObject({ timeout: JS_API_TIMEOUT_MS });
      expect(jsOpts[0]).toMatchObject({ timeout: JS_API_TIMEOUT_MS });
      expect(JS_API_TIMEOUT_MS).toBeGreaterThanOrEqual(15_000);
      await sub.unsubscribe();
    } finally {
      await bus.close();
    }
  });

  it('retries transient misses on jetstreamManager, ownedStreams, consumers.info, consumers.update and consumers.get', async () => {
    let jsmCalls = 0;
    let streamAddCalls = 0;
    let streamUpdateCalls = 0;
    let infoCalls = 0;
    let updateCalls = 0;
    let getCalls = 0;
    const consumer = { consume: async () => emptyMessages() };
    const jsm = {
      streams: {
        add: vi.fn(async () => {
          streamAddCalls += 1;
          if (streamAddCalls === 1) throw natsError('TIMEOUT');
          throw natsError('400', 'stream name already in use');
        }),
        update: vi.fn(async () => {
          streamUpdateCalls += 1;
          if (streamUpdateCalls === 1) throw natsError('DISCONNECT');
          return {};
        }),
      },
      consumers: {
        add: vi.fn(async () => {
          throw natsError('400', 'consumer already exists');
        }),
        info: vi.fn(async () => {
          infoCalls += 1;
          if (infoCalls === 1) throw natsError('TIMEOUT');
          return { config: { max_deliver: 2, ack_wait: 1_000 } };
        }),
        update: vi.fn(async () => {
          updateCalls += 1;
          if (updateCalls === 1) throw natsError('408');
          return {};
        }),
      },
    };
    const connection = {
      jetstreamManager: vi.fn(async () => {
        jsmCalls += 1;
        if (jsmCalls === 1) throw natsError('503');
        return jsm;
      }),
      jetstream: vi.fn(() => ({
        consumers: {
          get: vi.fn(async () => {
            getCalls += 1;
            if (getCalls === 1) throw natsError('CONNECTION_CLOSED');
            return consumer;
          }),
        },
      })),
      drain: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    };

    vi.resetModules();
    vi.doMock('nats', async () => ({ ...(await vi.importActual<typeof import('nats')>('nats')), connect: async () => connection }));

    const clock = fakeClock();
    const { JetStreamEventBus } = await import('./jetstream-bus.js');
    const bus = await JetStreamEventBus.connect({
      servers: 'nats://unused',
      producer: 'svc-trade',
      streamPrefix: 'LOCAL_TEST',
      ownedStreams: ['trade'],
      setupRetry: clock,
    });
    try {
      const sub = await bus.subscribe('orderFilled', async () => undefined, { durable: 'trade-fills' });
      expect(jsmCalls).toBe(2);
      expect(streamAddCalls).toBe(3);
      expect(streamUpdateCalls).toBe(2);
      expect(infoCalls).toBe(3);
      expect(updateCalls).toBe(2);
      expect(getCalls).toBe(2);
      await sub.unsubscribe();
    } finally {
      await bus.close();
    }
  });

  it('retries every transient NATS code and stops at once on a server refusal or after the deadline', async () => {
    for (const code of TRANSIENT_JS_CODES) {
      let calls = 0;
      const clock = fakeClock();
      const value = await retryTransientJetStream(async () => {
        calls += 1;
        if (calls === 1) throw natsError(code);
        return 'ok';
      }, clock);
      expect(value, code).toBe('ok');
      expect(calls, code).toBe(2);
    }

    let refusalCalls = 0;
    const refusalClock = fakeClock();
    await expect(
      retryTransientJetStream(async () => {
        refusalCalls += 1;
        throw natsError('404', 'stream not found');
      }, refusalClock),
    ).rejects.toThrow('stream not found');
    expect(refusalCalls).toBe(1);
    expect(refusalClock.sleeps).toEqual([]);

    let expiredCalls = 0;
    const expiredClock = fakeClock();
    await expect(
      retryTransientJetStream(
        async () => {
          expiredCalls += 1;
          throw natsError('TIMEOUT');
        },
        { ...expiredClock, retryForMs: 5_000, pauseMs: 1_000 },
      ),
    ).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(expiredCalls).toBe(6);
    expect(expiredClock.elapsed()).toBe(5_000);
  });

  it('closes the NATS connection if connect fails on a non-transient error', async () => {
    const close = vi.fn(async () => undefined);
    const connection = {
      jetstreamManager: vi.fn(async () => ({
        streams: {
          add: vi.fn(async () => {
            throw natsError('BAD API', 'insufficient resources');
          }),
        },
      })),
      jetstream: vi.fn(() => ({})),
      drain: vi.fn(async () => undefined),
      close,
    };

    vi.resetModules();
    vi.doMock('nats', async () => ({ ...(await vi.importActual<typeof import('nats')>('nats')), connect: async () => connection }));

    const clock = fakeClock();
    const { JetStreamEventBus } = await import('./jetstream-bus.js');
    await expect(
      JetStreamEventBus.connect({
        servers: 'nats://unused',
        producer: 'svc-trade',
        ownedStreams: ['trade'],
        setupRetry: clock,
      }),
    ).rejects.toThrow('insufficient resources');
    expect(close).toHaveBeenCalledOnce();
    expect(clock.sleeps).toEqual([]);
  });
});
