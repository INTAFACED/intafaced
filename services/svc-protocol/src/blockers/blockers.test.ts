import { describe, expect, it } from 'vitest';
import { toFunctionSelector } from 'viem';
import { createEdgeContext, protocolBlockersOutputSchema } from '@intafaced/contracts';
import { createProtocolRouter, type ProtocolRouterDeps } from '../router.js';
import { createPeers, noPeers, type Peers } from './peers.js';

const SECRET = 'a-protocol-blockers-test-edge-secret-length';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-protocol' });
const anonymous = (region = 'DE') => edgeContext({ headers: { 'x-intafaced-region': region }, id: 'req-blockers' });

const ZERO = '0x0000000000000000000000000000000000000000';
const FACTORY = '0x2222222222222222222222222222222222222222';
const status = {
  reachable: true,
  configuredChainId: 84532,
  observedChainId: 84532,
  blockNumber: '100',
  suiteConfigured: true,
  suiteDeployed: true,
  tokenFactoryConfigured: true,
  tokenFactoryDeployed: true,
  refusalCode: null,
  reason: null,
  expectedChainId: null,
  actualChainId: null,
};
const indexer = {
  chainId: 84532,
  chainSource: 'evm',
  indexedHeight: 90,
  finalityDepth: 12,
  finalizedHeight: 78,
  ingestEnabled: true,
  halted: null,
  behindBy: 10,
  lastError: null,
  chain: null,
  clob: { live: true, kind: 'sovereign-venue' },
};
const dex = { ammVenueWired: true, externalVenueWired: false, internalBook: { enabled: true } };

function deps(overrides: Partial<Record<string, unknown>> = {}): ProtocolRouterDeps {
  return {
    chain: { config: { chainId: 84532, factory: FACTORY, implementation: FACTORY }, status: async () => status },
    registry: {},
    relay: {},
    relayEnabled: () => true,
    ammFactoryAddress: () => ZERO,
    swapSlippageBps: () => null,
    ...overrides,
  } as unknown as ProtocolRouterDeps;
}
const wired = (region: string[] = []): Peers => ({
  indexer: async (r) => (region.push(`indexer:${r}`), { status: 'ok', data: indexer as never }),
  dex: async (r) => (region.push(`dex:${r}`), { status: 'ok', data: dex as never }),
});
const call = (d: ProtocolRouterDeps, input: { plannedSelector?: string } = {}, region?: string) =>
  createProtocolRouter(d).createCaller(anonymous(region)).blockers(input);
const codes = (out: Awaited<ReturnType<typeof call>>, action: keyof Awaited<ReturnType<typeof call>>['actions']) =>
  (out.actions[action] ?? []).map((b) => b.code);

describe('protocol.blockers', () => {
  it('answers every action from live sources, never audited and always with a network label', async () => {
    const out = await call(deps({ peers: wired() }));
    expect(protocolBlockersOutputSchema.parse(out)).toEqual(out);
    expect(out.sources).toEqual({ chain: 'ok', audit: 'ok', indexer: 'ok', dex: 'ok', health: 'ok' });
    for (const blockers of Object.values(out.actions)) {
      expect(blockers.map((b) => b.code)).toContain('not_audited');
      expect(blockers.at(-1)?.code).toBe('network_label');
    }
  });

  it('with no peers wired, the indexer and the DEX read as not connected and block their actions', async () => {
    const out = await call(deps());
    expect(out.sources).toMatchObject({ indexer: 'not_connected', dex: 'not_connected', chain: 'ok' });
    expect(codes(out, 'swap')).toContain('source_not_connected');
    expect(codes(out, 'createPool')).toContain('source_not_connected');
  });

  it('reports a chain that throws as unreachable instead of failing the whole read', async () => {
    const chain = {
      config: { chainId: 84532, factory: FACTORY, implementation: FACTORY },
      status: async () => {
        throw new Error('rpc exploded at http://secret-rpc.internal');
      },
    };
    const out = await call(deps({ chain, peers: wired() }));
    expect(out.sources.chain).toBe('no_reply');
    expect(codes(out, 'swap')[0]).toBe('source_no_reply');
    expect(JSON.stringify(out)).not.toContain('secret-rpc');
  });

  it('reads the relay switch live', async () => {
    const out = await call(deps({ relayEnabled: () => false, peers: wired() }));
    expect(codes(out, 'smartAccount')).toContain('relay_disabled');
  });

  it('adds policy_gap to a session key only for a selector the session spec forbids', async () => {
    const approve = toFunctionSelector('approve(address,uint256)');
    const swap = toFunctionSelector('swapExactTokensForTokens(uint256,uint256,address[],address,uint256)');
    const refused = await call(deps({ peers: wired() }), { plannedSelector: approve.toUpperCase().replace('0X', '0x') });
    expect(refused.actions.sessionKey?.find((b) => b.code === 'policy_gap')?.params).toEqual({ rule: 'approve' });
    expect(codes(refused, 'swap')).not.toContain('policy_gap');
    expect(codes(await call(deps({ peers: wired() }), { plannedSelector: swap }), 'sessionKey')).not.toContain('policy_gap');
    expect(codes(await call(deps({ peers: wired() })), 'sessionKey')).not.toContain('policy_gap');
  });

  it('refuses a malformed planned selector', async () => {
    await expect(call(deps({ peers: wired() }), { plannedSelector: 'approve' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('forwards the caller region to both peers', async () => {
    const seen: string[] = [];
    await call(deps({ peers: wired(seen) }), {}, 'DE');
    expect(seen.sort()).toEqual(['dex:DE', 'indexer:DE']);
  });
});

describe('peers', () => {
  const envelope = (data: unknown) => new Response(JSON.stringify({ result: { data } }), { status: 200 });

  it('is not connected without a URL or without a timeout, and never calls out', async () => {
    let called = false;
    const fetch = (async () => ((called = true), envelope(indexer))) as typeof globalThis.fetch;
    for (const config of [
      { url: undefined, timeoutMs: 1000, fetch },
      { url: 'http://indexer.test', timeoutMs: undefined, fetch },
    ]) {
      const peers = createPeers({ indexer: config, dex: config });
      expect(await peers.indexer(undefined)).toMatchObject({ status: 'down', code: 'edge.upstream_unwired' });
      expect(await peers.dex(undefined)).toMatchObject({ status: 'down', code: 'edge.upstream_unwired' });
    }
    expect(called).toBe(false);
    expect(await noPeers.dex(undefined)).toMatchObject({ code: 'edge.upstream_unwired' });
  });

  it('reads the public procedure with the region header and no credential', async () => {
    let seen: { url: string; headers: Record<string, string> } | undefined;
    const fetch = (async (url: string, init: RequestInit) => {
      seen = { url, headers: init.headers as Record<string, string> };
      return envelope(indexer);
    }) as unknown as typeof globalThis.fetch;
    const peers = createPeers({ indexer: { url: 'http://indexer.test/', timeoutMs: 500, fetch }, dex: { url: undefined, timeoutMs: 500 } });
    expect(await peers.indexer('DE')).toMatchObject({ status: 'ok' });
    expect(seen?.url).toBe('http://indexer.test/trpc/status');
    expect(seen?.headers).toEqual({ accept: 'application/json', 'x-intafaced-region': 'DE' });
  });

  it('reports an unreachable, refusing or malformed peer as down, never as ok', async () => {
    const make = (fetch: typeof globalThis.fetch) =>
      createPeers({ indexer: { url: 'http://i.test', timeoutMs: 500, fetch }, dex: { url: 'http://d.test', timeoutMs: 500, fetch } });
    const boom = make((async () => {
      throw new Error('ECONNREFUSED');
    }) as typeof globalThis.fetch);
    expect(await boom.indexer(undefined)).toMatchObject({ status: 'down', reason: 'unreachable' });
    const refuses = make((async () => new Response('no', { status: 503 })) as typeof globalThis.fetch);
    expect(await refuses.dex(undefined)).toMatchObject({ status: 'down', reason: 'http_503' });
    const junk = make((async () => envelope({ ammVenueWired: 'yes' })) as typeof globalThis.fetch);
    expect(await junk.dex(undefined)).toMatchObject({ status: 'down', reason: 'malformed' });
    const notJson = make((async () => new Response('<html>', { status: 200 })) as typeof globalThis.fetch);
    expect(await notJson.indexer(undefined)).toMatchObject({ status: 'down', reason: 'malformed' });
  });
});
