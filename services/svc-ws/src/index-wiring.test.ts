/**
 * Boots svc-ws's start-up module (`index.ts`) with its network edges stubbed and checks what it builds and
 * hands over: the identity authority the private and drop-copy doors get, the multiplexed door's idle timeout,
 * and what the bus session's close tears down. These replace pins that read `index.ts` as text.
 */
import type { FastifyInstance, FastifyServerOptions } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BusLifecycleOptions } from './bus-lifecycle.js';

const calls = vi.hoisted(() => ({
  authority: [] as unknown[][],
  privateGateway: [] as Record<string, unknown>[],
  dropCopyGateway: [] as Record<string, unknown>[],
  publicGateway: [] as Record<string, unknown>[],
  mux: [] as Record<string, unknown>[],
  closeBusSession: [] as Record<string, unknown>[],
  busOptions: [] as unknown[],
  apps: [] as FastifyInstance[],
  shutdown: [] as { stopPoller: () => void; closeApp: () => Promise<unknown> }[],
  authorityClient: { kind: 'identity-authority-client' },
}));

vi.mock('fastify', async (importOriginal) => {
  const real = (await importOriginal<typeof import('fastify')>()).default;
  return {
    default: (opts?: FastifyServerOptions) => {
      const app = real(opts);
      const listen = app.listen.bind(app);
      // The boot listens on HTTP_PORT; the test binds a free loopback port instead.
      (app as { listen: unknown }).listen = () => listen({ host: '127.0.0.1', port: 0 });
      calls.apps.push(app);
      return app;
    },
  };
});

vi.mock('@intafaced/telemetry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@intafaced/telemetry')>()),
  registerProcessHooks: () => undefined,
}));

vi.mock('./private/authority.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./private/authority.js')>()),
  createIdentityAuthorityClient: (...args: unknown[]) => {
    calls.authority.push(args);
    return calls.authorityClient;
  },
}));

vi.mock('./private/gateway.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./private/gateway.js')>()),
  createPrivateWebSocketGateway: (input: Record<string, unknown>) => {
    calls.privateGateway.push(input);
    return { close: async () => undefined };
  },
}));

vi.mock('./drop-copy/gateway.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./drop-copy/gateway.js')>()),
  createDropCopyWebSocketGateway: (input: Record<string, unknown>) => {
    calls.dropCopyGateway.push(input);
    return { close: async () => undefined };
  },
}));

vi.mock('./ws/gateway.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./ws/gateway.js')>()),
  createWebSocketGateway: (input: Record<string, unknown>) => {
    calls.publicGateway.push(input);
    return { close: async () => undefined };
  },
}));

vi.mock('./mux/gateway.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./mux/gateway.js')>()),
  createMuxGateway: (input: Record<string, unknown>) => {
    calls.mux.push(input);
    return { close: async () => undefined, handleUpgrade: () => undefined };
  },
}));

vi.mock('./bus-lifecycle.js', () => ({
  createBusLifecycle: (options: unknown) => {
    calls.busOptions.push(options);
    return {
      start: () => undefined,
      stop: async () => undefined,
      tradesBus: () => false,
      privateBus: () => false,
      dropCopyBus: () => false,
    };
  },
}));

vi.mock('./bus-session-close.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./bus-session-close.js')>();
  return {
    ...real,
    closeBusSession: (input: Parameters<typeof real.closeBusSession>[0]) => {
      calls.closeBusSession.push({ ...input });
      return real.closeBusSession(input);
    },
  };
});

vi.mock('./signal-shutdown.js', () => ({
  registerSignalShutdown: (_target: unknown, steps: { stopPoller: () => void; closeApp: () => Promise<unknown> }) => {
    calls.shutdown.push(steps);
  },
}));

const INTERNAL_MARKER = 'internal-service-secret-must-not-flow-0001';
const OWNERSHIP_SECRET = 'ws-test-identity-ownership-secret-32';

const BASE_ENV: Record<string, string | undefined> = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'fatal',
  OTEL_ENABLED: 'false',
  MATCHING_URL: 'http://127.0.0.1:9',
  TRADE_URL: 'http://127.0.0.1:9',
  IDENTITY_URL: 'http://identity.test',
  IDENTITY_OWNERSHIP_SECRET: OWNERSHIP_SECRET,
  JWT_ACCESS_SECRET: 'ws-test-access-secret-at-least-32-chars',
  INTERNAL_SERVICE_SECRET: INTERNAL_MARKER,
  WS_MUX_IDLE_MS: undefined,
  WS_HEARTBEAT_MS: '30000',
};

async function boot(overrides: Record<string, string | undefined> = {}): Promise<void> {
  vi.resetModules();
  vi.unstubAllEnvs();
  for (const [key, value] of Object.entries({ ...BASE_ENV, ...overrides })) vi.stubEnv(key, value);
  await import('./index.js');
}

function reset(): void {
  for (const list of [
    calls.authority,
    calls.privateGateway,
    calls.dropCopyGateway,
    calls.publicGateway,
    calls.mux,
    calls.closeBusSession,
    calls.busOptions,
    calls.apps,
    calls.shutdown,
  ]) {
    list.length = 0;
  }
}

afterEach(async () => {
  for (const steps of calls.shutdown) {
    steps.stopPoller();
    await steps.closeApp();
  }
  reset();
  vi.unstubAllEnvs();
});

/** Every string reachable from a value, so a secret handed anywhere in a constructor's input is found. */
function strings(value: unknown, seen = new Set<unknown>()): string[] {
  if (typeof value === 'string') return [value];
  if (!value || typeof value !== 'object' || seen.has(value)) return [];
  seen.add(value);
  return Object.values(value as Record<string, unknown>).flatMap((v) => strings(v, seen));
}

describe('production index wires mandatory identity authority', () => {
  it('builds one identity authority from IDENTITY_URL + IDENTITY_OWNERSHIP_SECRET and hands it to both private doors', async () => {
    await boot();
    expect(calls.authority).toHaveLength(1);
    expect(calls.authority[0]?.[0]).toEqual({ baseUrl: 'http://identity.test', secret: OWNERSHIP_SECRET });
    expect(calls.privateGateway).toHaveLength(1);
    expect(calls.dropCopyGateway).toHaveLength(1);
    expect(calls.privateGateway[0]?.authority).toBe(calls.authorityClient);
    expect(calls.dropCopyGateway[0]?.authority).toBe(calls.authorityClient);
  });

  it('never passes a session-passkey adapter or INTERNAL_SERVICE_SECRET to any door', async () => {
    await boot();
    for (const input of [...calls.privateGateway, ...calls.dropCopyGateway]) {
      expect(input).not.toHaveProperty('sessionPasskey');
    }
    const handed = [...calls.authority, ...calls.privateGateway, ...calls.dropCopyGateway, ...calls.publicGateway, ...calls.busOptions];
    expect(strings(handed)).not.toContain(INTERNAL_MARKER);
    expect(strings(handed).some((s) => s.includes(INTERNAL_MARKER))).toBe(false);
  });

  it('without IDENTITY_URL or IDENTITY_OWNERSHIP_SECRET the private doors get no authority, and no client is built', async () => {
    await boot({ IDENTITY_URL: undefined });
    expect(calls.authority).toHaveLength(0);
    expect(calls.privateGateway[0]?.authority).toBeNull();
    expect(calls.dropCopyGateway[0]?.authority).toBeNull();
    await calls.shutdown[0]?.closeApp();
    calls.shutdown[0]?.stopPoller();
    reset();

    await boot({ IDENTITY_OWNERSHIP_SECRET: '  ' });
    expect(calls.authority).toHaveLength(0);
    expect(calls.privateGateway[0]?.authority).toBeNull();
    expect(calls.dropCopyGateway[0]?.authority).toBeNull();
  });
});

describe('mux idle at start-up', () => {
  it('a blank WS_MUX_IDLE_MS does not borrow the heartbeat: the multiplexed door stays down', async () => {
    await boot({ WS_MUX_IDLE_MS: undefined, WS_HEARTBEAT_MS: '30000' });
    expect(calls.mux).toHaveLength(0);
    expect(calls.publicGateway[0]).not.toHaveProperty('mux');
  });

  it('a published WS_MUX_IDLE_MS opens the multiplexed door with exactly that idle timeout', async () => {
    await boot({ WS_MUX_IDLE_MS: '5000', WS_HEARTBEAT_MS: '30000' });
    expect(calls.mux).toHaveLength(1);
    expect(calls.mux[0]?.session).toMatchObject({ idleMs: 5_000 });
    expect(calls.mux[0]?.heartbeatMs).toBe(30_000);
    expect(calls.publicGateway[0]?.mux).toBeDefined();
  });
});

describe('bus session close at start-up', () => {
  it('the session close runs closeBusSession on the private hub the private door serves, the drop-copy hub, every half and the bus', async () => {
    await boot();
    const options = calls.busOptions[0] as BusLifecycleOptions;
    expect(options).toBeDefined();

    const removed: string[] = [];
    const sub = (name: string) => ({
      unsubscribe: async () => {
        removed.push(name);
      },
    });
    const bus = {
      close: vi.fn(async () => undefined),
      whenClosed: () => new Promise<void>(() => undefined),
    };
    const events = await import('@intafaced/events');
    const connect = vi.spyOn(events.JetStreamEventBus, 'connect').mockResolvedValue(bus as never);
    const tradeSource = await import('./trade/source.js');
    const privateSource = await import('./private/source.js');
    const dropSource = await import('./drop-copy/source.js');
    vi.spyOn(tradeSource, 'subscribeTradeTape').mockResolvedValue(sub('trades') as never);
    vi.spyOn(privateSource, 'tryAttachPrivate').mockResolvedValue({
      orders: sub('orders'),
      fills: sub('fills'),
      positions: sub('positions'),
      balances: sub('balances'),
    } as never);
    vi.spyOn(dropSource, 'tryAttachDropCopy').mockResolvedValue({ fills: sub('drop-copy-fills') } as never);

    const session = await options.attempt();
    expect(connect).toHaveBeenCalledTimes(1);
    expect(session.privateUp).toBe(true);
    expect(session.dropCopyUp).toBe(true);

    await session.close();
    expect(calls.closeBusSession).toHaveLength(1);
    const input = calls.closeBusSession[0]!;
    expect(input.privateHub).toBe(calls.privateGateway[0]?.hub);
    expect(input.dropCopyHub).toBe(calls.dropCopyGateway[0]?.hub);
    expect(removed).toEqual(['trades', 'orders', 'fills', 'positions', 'balances', 'drop-copy-fills']);
    expect(bus.close).toHaveBeenCalledTimes(1);
  });
});
