import { createPublicClient, custom, RpcRequestError } from 'viem';
import { describe, expect, it } from 'vitest';
import { ProtocolChain } from '../chain/client.js';
import { createEdgeContext } from '@intafaced/contracts';
import { createProtocolRouter, type ProtocolRouterDeps } from '../router.js';
import { deploymentsFor, loadNetworkRegistry, loadRouterVersions, parseNetworkRegistry, routerVersionIsSunset } from './registry.js';

const edgeContext = createEdgeContext({ secret: 'a-networks-test-edge-secret-of-enough-length', serviceName: 'svc-protocol' });
const bare = {
  chainId: 84532,
  name: 'Base Sepolia test network',
  kind: 'testnet',
  nativeCurrency: null,
  rpcUrls: null,
  blockTimeSeconds: null,
  explorerUrls: null,
  faucets: null,
  ecosystem: null,
};

function caller(overrides: Record<string, unknown> = {}) {
  const deps = {
    chain: {
      config: { chainId: 84532, factory: '0x0', implementation: '0x0' },
      probeCapabilities: async () => ({ pendingTag: true, bundlerReachable: null, paymasterFunded: null }),
    },
    registry: {},
    relay: {},
    relayEnabled: () => true,
    ammFactoryAddress: () => '0x0',
    swapSlippageBps: () => null,
    ...overrides,
  } as unknown as ProtocolRouterDeps;
  return createProtocolRouter(deps).createCaller(edgeContext({ headers: { 'x-intafaced-region': 'DE' }, id: 'req-networks' }));
}

describe('network registry', () => {
  it('ships Base Sepolia as a testnet and the local chain as local, with nothing invented', () => {
    const networks = loadNetworkRegistry();
    const base = networks.find((n) => n.chainId === 84532)!;
    expect(base).toMatchObject({
      kind: 'testnet',
      name: 'Base Sepolia test network',
      rpcUrls: null,
      nativeCurrency: null,
      faucets: null,
      ecosystem: null,
    });
    expect(networks.find((n) => n.chainId === 31337)).toMatchObject({ kind: 'local' });
    expect(JSON.stringify(networks)).not.toMatch(/mainnet|intachain|"audited"\s*:\s*true/i);
  });

  it('refuses a registry that names mainnet or intachain, for Base or any other chain', () => {
    for (const kind of ['mainnet', 'intachain']) {
      for (const chainId of [84532, 8453, 1, 999]) {
        expect(() => parseNetworkRegistry([{ ...bare, chainId, kind }])).toThrow(/protocol\.network_kind_forbidden/);
      }
    }
  });

  it('refuses a duplicate chain, a non-list, an http faucet and a non-https explorer', () => {
    expect(() => parseNetworkRegistry([bare, bare])).toThrow(/listed twice/);
    expect(() => parseNetworkRegistry({})).toThrow(/must be a list/);
    expect(() => parseNetworkRegistry([{ ...bare, faucets: [{ name: 'f', url: 'http://faucet.test' }] }])).toThrow();
    expect(() => parseNetworkRegistry([{ ...bare, explorerUrls: ['javascript:alert(1)'] }])).toThrow();
  });
});

describe('deployments', () => {
  it('serves the Base Sepolia record with the router row and no sunset', () => {
    const found = deploymentsFor(84532)!;
    expect(found.chainId).toBe(84532);
    expect(found.contracts.length).toBeGreaterThan(20);
    expect(found.contracts.every((c) => c.verified === false)).toBe(true);
    expect(found.routers).toEqual([expect.objectContaining({ name: 'SovereignRouter', version: 'v1', sunsetAt: null, verified: false })]);
    expect(JSON.stringify(found)).not.toMatch(/"audited"\s*:\s*true/i);
  });

  it('knows nothing about a chain it has no record for', () => {
    expect(deploymentsFor(1)).toBeNull();
    expect(deploymentsFor(8453)).toBeNull();
  });

  it('calls a router sunset only after the owner-published date', () => {
    const rows = [{ chainId: 84532, name: 'SovereignRouter', version: 'v1', sunsetAt: '2026-11-01T00:00:00.000Z' }];
    expect(routerVersionIsSunset(84532, 'SovereignRouter', new Date('2026-10-31T23:59:59.000Z'), rows)).toBe(false);
    expect(routerVersionIsSunset(84532, 'SovereignRouter', new Date('2026-11-01T00:00:00.000Z'), rows)).toBe(true);
    expect(routerVersionIsSunset(84532, 'SovereignRouter', new Date('2030-01-01T00:00:00.000Z'), loadRouterVersions())).toBe(false);
    expect(routerVersionIsSunset(84532, 'Unknown', new Date('2030-01-01T00:00:00.000Z'), rows)).toBe(false);
  });
});

describe('protocol.networks / deployments / capabilities', () => {
  it('lists the registry', async () => {
    const out = await caller().networks.list();
    expect(out.networks.map((n) => n.chainId)).toEqual([84532, 31337]);
  });

  it('serves deployments for a known chain and NOT_FOUND for an unknown one', async () => {
    expect((await caller().deployments.list({ chainId: 84532 })).routers).toHaveLength(1);
    await expect(caller().deployments.list({ chainId: 1 })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(caller().deployments.list({ chainId: 0 })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('probes only the configured chain and never claims preconfirmations it did not find', async () => {
    const own = await caller().capabilities({ chainId: 84532 });
    expect(own).toEqual({
      chainId: 84532,
      probed: true,
      pendingTag: true,
      bundlerReachable: null,
      paymasterFunded: null,
      preconfirmations: 'not_offered',
    });
    const other = await caller().capabilities({ chainId: 1 });
    expect(other).toMatchObject({ probed: false, pendingTag: null, bundlerReachable: null, preconfirmations: 'unknown' });
    const silent = caller({
      chain: {
        config: { chainId: 84532 },
        probeCapabilities: async () => ({ pendingTag: null, bundlerReachable: null, paymasterFunded: null }),
      },
    });
    expect((await silent.capabilities({ chainId: 84532 })).preconfirmations).toBe('unknown');
  });

  it('passes the published probe timeout to the probe and nothing when unset', async () => {
    const seen: Array<number | undefined> = [];
    const chain = {
      config: { chainId: 84532 },
      probeCapabilities: async (t: number | undefined) => (
        seen.push(t),
        { pendingTag: true, bundlerReachable: null, paymasterFunded: null }
      ),
    };
    await caller({ chain, probeTimeoutMs: () => 800 }).capabilities({ chainId: 84532 });
    await caller({ chain }).capabilities({ chainId: 84532 });
    expect(seen).toEqual([800, undefined]);
  });
});

describe('ProtocolChain.probeCapabilities', () => {
  const chainOver = (reply: () => unknown, bundlerUrl?: string) => {
    const chain = new ProtocolChain({
      chainId: 84532,
      rpcUrl: 'http://node.test',
      entryPoint: '0x4444444444444444444444444444444444444444',
      factory: '0x0000000000000000000000000000000000000000',
      implementation: '0x0000000000000000000000000000000000000000',
      ...(bundlerUrl ? { bundlerUrl } : {}),
    });
    (chain as { client: unknown }).client = createPublicClient({
      transport: custom(
        {
          async request() {
            return reply();
          },
        },
        { retryCount: 0 },
      ),
    });
    return chain;
  };
  const block = {
    number: '0x1',
    hash: '0x' + '11'.repeat(32),
    parentHash: '0x' + '22'.repeat(32),
    timestamp: '0x1',
    transactions: [],
    gasLimit: '0x1',
    gasUsed: '0x0',
    miner: '0x' + '00'.repeat(20),
    nonce: '0x0000000000000000',
    difficulty: '0x0',
    totalDifficulty: '0x0',
    size: '0x1',
    extraData: '0x',
    logsBloom: '0x' + '00'.repeat(256),
    receiptsRoot: '0x' + '33'.repeat(32),
    sha3Uncles: '0x' + '44'.repeat(32),
    stateRoot: '0x' + '55'.repeat(32),
    transactionsRoot: '0x' + '66'.repeat(32),
    uncles: [],
    mixHash: '0x' + '77'.repeat(32),
  };
  const rpc = (code: number) =>
    new RpcRequestError({ body: { method: 'eth_getBlockByNumber' }, error: { code, message: 'x' }, url: 'http://node.test' });

  it('answers yes when the node serves a pending block, no for an RPC error reply, and null when it does not answer', async () => {
    expect((await chainOver(() => block).probeCapabilities(undefined)).pendingTag).toBe(true);
    expect((await chainOver(() => Promise.reject(rpc(-32601))).probeCapabilities(undefined)).pendingTag).toBe(false);
    expect((await chainOver(() => Promise.reject(rpc(-32603))).probeCapabilities(undefined)).pendingTag).toBeNull();
    expect((await chainOver(() => Promise.reject(new Error('socket hang up'))).probeCapabilities(undefined)).pendingTag).toBeNull();
  });

  it('does not probe a bundler without a configured URL and a published timeout', async () => {
    let called = false;
    const real = globalThis.fetch;
    globalThis.fetch = (async () => ((called = true), new Response('{}', { status: 200 }))) as typeof fetch;
    try {
      expect((await chainOver(() => block).probeCapabilities(500)).bundlerReachable).toBeNull();
      expect((await chainOver(() => block, 'http://bundler.test').probeCapabilities(undefined)).bundlerReachable).toBeNull();
      expect(called).toBe(false);
      expect((await chainOver(() => block, 'http://bundler.test').probeCapabilities(500)).bundlerReachable).toBe(true);
      globalThis.fetch = (async () => {
        throw new Error('ECONNREFUSED');
      }) as typeof fetch;
      expect((await chainOver(() => block, 'http://bundler.test').probeCapabilities(500)).bundlerReachable).toBe(false);
    } finally {
      globalThis.fetch = real;
    }
  });
});
