/**
 * svc-pay's in-process chain watcher starts only on a live EVM chain with `PAY_CRYPTO_WATCHER_ENABLED` exactly `true`:
 * a watcher on the in-memory TEST chain or on the refusing unconfigured chain would invent deposits, and one the owner
 * switched off must stay off. `index.ts` is booted four times against one migrated database, each time with the chain
 * `defaultChainFor` really builds for that posture (the sandbox chain, the unconfigured chain an enforced env gets) or
 * a live `EvmLiveChain`, with the flag off and on. Only the last builds a CryptoChainWatcher, and it is built on the
 * durable cursor. The watcher's own polling is the one thing not run: its `start` is recorded instead.
 */
import { createServer } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { bootDatabase, bootEnv, type BootDatabase } from './boot.testkit.js';

const boot = vi.hoisted(() => ({
  chain: null as unknown,
  watchers: [] as Array<{ options: Record<string, unknown>; started: boolean }>,
  cursors: [] as unknown[],
}));

vi.mock('./rails/posture.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./rails/posture.js')>();
  return {
    ...real,
    // The boot's chain is the one this case names; the real function is what built it (see `chains` below).
    defaultChainFor: (...args: Parameters<typeof real.defaultChainFor>) =>
      boot.chain === null ? real.defaultChainFor(...args) : boot.chain,
  };
});
vi.mock('./rails/chain-watcher.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./rails/chain-watcher.js')>();
  class RecordedWatcher extends real.CryptoChainWatcher {
    private readonly seen: { options: Record<string, unknown>; started: boolean };
    constructor(options: ConstructorParameters<typeof real.CryptoChainWatcher>[0]) {
      super(options);
      this.seen = { options: { ...options }, started: false };
      boot.watchers.push(this.seen);
    }
    override start(): void {
      this.seen.started = true;
    }
    override stop(): void {}
  }
  class RecordedCursorStore extends real.PostgresChainWatcherCursorStore {
    constructor(...args: ConstructorParameters<typeof real.PostgresChainWatcherCursorStore>) {
      super(...args);
      boot.cursors.push(this);
    }
  }
  Object.defineProperty(RecordedCursorStore, 'name', { value: 'PostgresChainWatcherCursorStore' });
  return { ...real, CryptoChainWatcher: RecordedWatcher, PostgresChainWatcherCursorStore: RecordedCursorStore };
});

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

type Posture = 'sandbox' | 'absent' | 'live';

/**
 * The chain for one posture, built from the same module instances the boot is about to load (so index.ts's
 * `instanceof EvmLiveChain` sees it as what it is): defaultChainFor's own answer for the sandbox and an enforced env, a
 * live EVM chain on a dead TEST address for live. The mocked posture module outlives a module reset, so its chains are
 * checked by class name.
 */
async function chainFor(posture: Posture) {
  const { MemoryBroadcastStore } = await import('./rails/broadcast-store.js');
  const { MemoryChain, UnconfiguredChain } = await import('./rails/chain-port.js');
  const { defaultChainFor } = await import('./rails/posture.js');
  if (posture === 'sandbox') {
    const chain = defaultChainFor({ APP_ENV: 'test' }, new MemoryBroadcastStore());
    expect(chain.constructor.name).toBe(MemoryChain.name);
    return chain;
  }
  if (posture === 'absent') {
    const chain = defaultChainFor({ APP_ENV: 'prod' }, new MemoryBroadcastStore());
    expect(chain.constructor.name).toBe(UnconfiguredChain.name);
    return chain;
  }
  const { TestnetDepositAddresses } = await import('./rails/deposit-source.js');
  const { EvmLiveChain } = await import('./rails/evm-chain.js');
  const { TestnetSigner } = await import('./rails/evm-signer.js');
  return new EvmLiveChain({
    rpcUrl: 'http://127.0.0.1:1',
    chainId: 31337,
    deposits: TestnetDepositAddresses.default(),
    signer: TestnetSigner.fromFixtureKey('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'),
    assets: new Map(),
    broadcasts: new MemoryBroadcastStore(),
    minConfirmations: 6,
  });
}

let database: BootDatabase;
const envBefore = { ...process.env };

/** Boots index.ts once on `chain` with the watcher flag `flag`, then shuts it down; returns the watchers it built. */
async function bootWith(posture: Posture, flag: 'true' | 'false') {
  vi.resetModules();
  boot.chain = null;
  const chain = await chainFor(posture);
  boot.chain = chain;
  boot.watchers.length = 0;
  const env = bootEnv(database.db.url, await freePort(), { PATH: undefined, LOG_LEVEL: 'fatal', PAY_CRYPTO_WATCHER_ENABLED: flag });
  for (const [key, value] of Object.entries(env)) process.env[key] = value;
  const intervals: unknown[] = [];
  const setInterval = globalThis.setInterval;
  const spy = vi.spyOn(globalThis, 'setInterval').mockImplementation(((run: () => void, ms?: number) => {
    const handle = setInterval(run, ms);
    intervals.push(handle);
    return handle;
  }) as typeof globalThis.setInterval);
  const before = new Set(process.listeners('SIGTERM'));
  await import('./index.js');
  const shutdown = process.listeners('SIGTERM').find((listener) => !before.has(listener));
  const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  try {
    if (shutdown) {
      process.removeListener('SIGTERM', shutdown);
      shutdown('SIGTERM');
      await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0), { timeout: 20_000 });
    }
  } finally {
    exit.mockRestore();
    spy.mockRestore();
    for (const handle of intervals) clearInterval(handle as NodeJS.Timeout);
  }
  return { chain, watchers: boot.watchers.map((w) => ({ ...w })) };
}

describe('the chain watcher starts only on a live chain with the flag on', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    database = await bootDatabase();
  }, 240_000);
  afterAll(async () => {
    for (const key of Object.keys(process.env)) if (!(key in envBefore)) delete process.env[key];
    Object.assign(process.env, envBefore);
    await database?.stop();
  }, 60_000);

  it('the sandbox and the unconfigured chain build no watcher even with the flag on; a live chain only with it on', async () => {
    expect((await bootWith('sandbox', 'true')).watchers).toEqual([]);
    expect((await bootWith('absent', 'true')).watchers).toEqual([]);
    expect((await bootWith('live', 'false')).watchers).toEqual([]);

    const { chain, watchers } = await bootWith('live', 'true');
    expect(watchers).toHaveLength(1);
    expect(watchers[0]!.started).toBe(true);
    expect(watchers[0]!.options.chain).toBe(chain);
    expect(watchers[0]!.options.cursorStore?.constructor.name).toBe('PostgresChainWatcherCursorStore');
    // It is the one durable cursor store the boot built (index.db.test.ts: on the service database, and no memory one).
    expect(boot.cursors.length).toBeGreaterThan(0);
    expect(watchers[0]!.options.cursorStore).toBe(boot.cursors.at(-1));
  });
});
