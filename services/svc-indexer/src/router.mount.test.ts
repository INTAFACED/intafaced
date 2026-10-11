import { describe, expect, it, vi } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { MemoryProjectionStore } from './projection/memory-store.js';
import { MemoryChainSource, NullChainSource } from './chain/memory-source.js';
import { ChainUnavailableError } from './chain/evm/availability.js';
import type { ChainBlock, ChainHead, ChainSource } from './chain/source.js';
import { Indexer } from './indexer.js';
import { createIndexerRouter, type ChainProbe } from './router.js';
import { CHAIN_ID } from './testing/conformance.js';

/**
 * THE MOUNT BOUNDARY, for svc-indexer (docs/decisions/mount-boundary.md).
 *
 * The context comes from `createEdgeContext` over real headers, exactly as
 * `index.ts` builds it, rather than from a `Context` literal — a literal would
 * keep passing on a service that trusted an unsigned header, which is the bug
 * that decision exists to prevent.
 *
 * Be precise about what is defended here, because it is unusual: NOTHING in
 * this router is gated on a principal, and that is correct. Every fact served
 * is a copy of public chain state. What these tests assert is therefore the
 * §22 property itself — that an anonymous caller gets a real answer — plus the
 * two things that must hold anyway: a forged principal confers nothing (there
 * is nothing to confer), and a signed one is read without changing the answer.
 *
 * If a future edit adds a `scopedProcedure` to this router, the first test here
 * still passes and the reviewer should ask why the procedure exists. A read
 * model of public data that requires a login is a read model that has quietly
 * stopped being §22 infrastructure.
 */

const SECRET = 'an-indexer-mount-test-edge-secret-length';
const USER = '11111111-1111-4111-8111-111111111111';

const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-indexer' });

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    sub: USER,
    userId: USER,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes: [],
    tier: 'none',
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
    ...overrides,
  } as Principal;
}

/** No credentials of any kind — a caller who simply found the port. */
const anonymous = (region = 'DE') => edgeContext({ headers: { 'x-intafaced-region': region }, id: 'req-anon' });

function signed(p: Principal = principal(), region = 'DE') {
  const raw = encodePrincipal(p);
  return edgeContext({
    headers: {
      'x-intafaced-principal': raw,
      'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
      'x-intafaced-region': region,
    },
    id: 'req-signed',
  });
}

function forged(p: Principal = principal()) {
  return edgeContext({
    headers: { 'x-intafaced-principal': encodePrincipal(p), 'x-intafaced-region': 'DE' },
    id: 'req-forged',
  });
}

async function seeded() {
  const store = new MemoryProjectionStore(CHAIN_ID);
  const source = new MemoryChainSource(CHAIN_ID);
  source.append([
    { kind: 'book_level', logIndex: 0, market: 'IFC-USD', side: 'bid', price: '100', quantity: '5' },
    { kind: 'book_level', logIndex: 1, market: 'IFC-USD', side: 'ask', price: '101', quantity: '2' },
    {
      kind: 'fill',
      logIndex: 2,
      market: 'IFC-USD',
      price: '100.5',
      quantity: '1.5',
      takerSide: 'buy',
      maker: '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      taker: '0xBBbBbBBbbBbBbbBbbbbbBBbBbbbbBbBbBbbBBbB0',
    },
    {
      kind: 'position',
      logIndex: 3,
      market: 'IFC-USD',
      account: '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      size: '-1.5',
      entryPrice: '100.5',
    },
  ]);

  const indexer = new Indexer({ source, store, finalityDepth: 64, ingestEnabled: () => true, startHeight: 0 });
  await indexer.sync();

  return createIndexerRouter({
    store,
    indexer,
    chainId: CHAIN_ID,
    finalityDepth: 64,
    ingestEnabled: () => true,
    chainSource: 'memory',
  });
}

describe('svc-indexer mount — §22 permissionless reads', () => {
  it('refuses a signed request with unconfigured screening before reading the projection', async () => {
    const store = new MemoryProjectionStore(CHAIN_ID);
    const read = vi.spyOn(store, 'book');
    const indexer = new Indexer({ source: new NullChainSource(CHAIN_ID), store, finalityDepth: 64, ingestEnabled: () => false });
    const router = createIndexerRouter({
      store,
      indexer,
      chainId: CHAIN_ID,
      finalityDepth: 64,
      ingestEnabled: () => false,
      chainSource: 'memory',
    });
    vi.stubEnv('INTAFACED_SCREENING_FAIL_CLOSED', undefined);
    vi.stubEnv('INTAFACED_REGION_FAIL_CLOSED', undefined);
    try {
      await expect(router.createCaller(signed()).book({ market: 'IFC-USD', depth: 10 })).rejects.toMatchObject({
        code: 'FORBIDDEN',
        cause: { decision: { code: 'denied.screening_unconfigured' } },
      });
      expect(read).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('serves the book to a caller with no credentials at all', async () => {
    const router = await seeded();
    const view = await router.createCaller(anonymous()).book({ market: 'IFC-USD', depth: 10 });

    expect(view.bids).toEqual([['100', '5']]);
    expect(view.asks).toEqual([['101', '2']]);
    expect(view.asOfHeight).toBe(0);
  });

  it('serves fills and positions anonymously, with money as decimal strings', async () => {
    const caller = (await seeded()).createCaller(anonymous());

    const fills = await caller.fills({ market: 'IFC-USD', limit: 10 });
    expect(fills).toHaveLength(1);
    expect(fills[0]).toMatchObject({ price: '100.5', quantity: '1.5', takerSide: 'buy' });
    // Strings, not numbers — a client that wants arithmetic parses them.
    expect(typeof fills[0]!.price).toBe('string');
    expect(typeof fills[0]!.quantity).toBe('string');

    const positions = await caller.positions({
      account: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      limit: 10,
    });
    expect(positions[0]).toMatchObject({ size: '-1.5', entryPrice: '100.5' });
    expect(typeof positions[0]!.size).toBe('string');
    expect(typeof positions[0]!.entryPrice).toBe('string');
  });

  /**
   * README API table residual: `markets`, `accountFills`, singular `position`.
   * Seed already carries a fill + position for 0xAA…; prove an anonymous
   * caller gets them with money still as decimal strings, and that the
   * account key is case-insensitive (checksummed vs lower hex).
   */
  it('serves markets, accountFills and singular position with no credentials', async () => {
    const caller = (await seeded()).createCaller(anonymous());
    // Seed applies uppercase 0xAA…; store normalises to lower (#1228).
    const lowerAccount = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const emptyAccount = '0x0000000000000000000000000000000000000001';

    const markets = await caller.markets({ limit: 10 });
    expect(markets).toContain('IFC-USD');

    // Mixed-case address must hit the same tape as the seed (case-insensitive).
    // Stored addresses are lowercased (#1228) — assert the canonical form.
    const accountFills = await caller.accountFills({ account: lowerAccount, limit: 10 });
    expect(accountFills).toHaveLength(1);
    expect(accountFills[0]).toMatchObject({
      market: 'IFC-USD',
      price: '100.5',
      quantity: '1.5',
      takerSide: 'buy',
      // Wire normalises EVM addresses to lower hex (same case-insensitivity as the account key).
      maker: lowerAccount,
    });
    expect(typeof accountFills[0]!.price).toBe('string');
    expect(typeof accountFills[0]!.quantity).toBe('string');

    const position = await caller.position({ market: 'IFC-USD', account: lowerAccount });
    expect(position).toMatchObject({
      market: 'IFC-USD',
      size: '-1.5',
      entryPrice: '100.5',
    });
    expect(typeof position!.size).toBe('string');
    expect(typeof position!.entryPrice).toBe('string');

    // No row for this address → null, not an empty object or a throw.
    await expect(caller.position({ market: 'IFC-USD', account: emptyAccount })).resolves.toBeNull();
  });

  it('book level quantities are decimal strings, not numbers', async () => {
    const view = await (await seeded()).createCaller(anonymous()).book({ market: 'IFC-USD', depth: 10 });
    expect(view.bids[0]).toEqual(['100', '5']);
    expect(view.asks[0]).toEqual(['101', '2']);
    for (const [price, qty] of [...view.bids, ...view.asks]) {
      expect(typeof price).toBe('string');
      expect(typeof qty).toBe('string');
    }
  });

  it('answers identically for every region, because there is nothing to gate', async () => {
    const router = await seeded();
    for (const region of ['DE', 'US', 'GB', 'XX', 'IR']) {
      const view = await router.createCaller(anonymous(region)).book({ market: 'IFC-USD', depth: 10 });
      expect(view.bids).toEqual([['100', '5']]);
    }
  });

  it('a forged principal changes nothing, because it confers nothing', async () => {
    const ctx = forged(principal({ scopes: ['admin:treasury'], tier: 'full', mfa: true }));
    // The edge did not sign it, so it is anonymous — and the answer is the same
    // either way, because no procedure here reads a principal.
    expect(ctx.principal).toBeNull();

    const view = await (await seeded()).createCaller(ctx).book({ market: 'IFC-USD', depth: 10 });
    expect(view.bids).toEqual([['100', '5']]);
  });

  it('a signed principal is accepted and does not change the answer either', async () => {
    const ctx = signed();
    expect(ctx.principal).not.toBeNull();

    const view = await (await seeded()).createCaller(ctx).book({ market: 'IFC-USD', depth: 10 });
    expect(view.bids).toEqual([['100', '5']]);
  });
});

/**
 * Production's no-RPC probe shape (`src/index.ts` when INDEXER_RPC_URL is empty).
 * Mounted hermetically so status honesty does not need a live node.
 */
function productionNullProbe(): () => Promise<ChainProbe> {
  return async () => ({
    kind: 'null',
    rpcUrl: null,
    venue: null,
    reachable: false,
    observedChainId: null,
    chainHeight: null,
    venueDeployed: false,
    refusalCode: 'indexer.chain_not_configured',
    reason:
      'INDEXER_RPC_URL is not set, so this service is following no chain. Everything it serves is whatever ' +
      'was projected before, and nothing is advancing it. (SOCKET §13 socket.evm-rpc)',
  });
}

/** A source that throws a typed chain refusal — real Indexer path records lastError. */
class UnreachableChainSource implements ChainSource {
  constructor(readonly chainId: number) {}
  async head(): Promise<ChainHead | null> {
    throw new ChainUnavailableError('indexer.chain_unreachable', 'endpoint refused at hermetic mount test');
  }
  async blockAt(_height: number): Promise<ChainBlock | null> {
    throw new ChainUnavailableError('indexer.chain_unreachable', 'endpoint refused at hermetic mount test');
  }
}

describe('svc-indexer mount — status is honest', () => {
  it('behindBy is null (not zero) when no probe is wired and heights are unknown', async () => {
    const store = new MemoryProjectionStore(CHAIN_ID);
    const indexer = new Indexer({
      source: new NullChainSource(CHAIN_ID),
      store,
      finalityDepth: 64,
      ingestEnabled: () => true,
    });
    const router = createIndexerRouter({
      store,
      indexer,
      chainId: CHAIN_ID,
      finalityDepth: 64,
      ingestEnabled: () => true,
      chainSource: 'null',
      // no chainProbe — "nobody asked", never a quiet zero
    });

    const status = await router.createCaller(anonymous()).status();
    expect(status.chainSource).toBe('null');
    expect(status.indexedHeight).toBeNull();
    expect(status.finalizedHeight).toBeNull();
    expect(status.halted).toBeNull();
    expect(status.chain).toBeNull();
    // Zero would read as "current". Unknown heights → null, never a default.
    expect(status.behindBy).toBeNull();
    expect(status.lastError).toBeNull();
  });

  it('behindBy is tip minus cursor when a probe reports both heights', async () => {
    const store = new MemoryProjectionStore(CHAIN_ID);
    // Cursor at 97 without walking 97 empty blocks.
    await store.applyBlock({
      chainId: CHAIN_ID,
      height: 97,
      hash: `0x${'a'.repeat(64)}`,
      parentHash: `0x${'0'.repeat(64)}`,
      timestamp: 1_700_000_000,
      events: [],
    });
    const indexer = new Indexer({
      source: new NullChainSource(CHAIN_ID),
      store,
      finalityDepth: 64,
      ingestEnabled: () => true,
    });
    const router = createIndexerRouter({
      store,
      indexer,
      chainId: CHAIN_ID,
      finalityDepth: 64,
      ingestEnabled: () => true,
      chainSource: 'evm',
      chainProbe: async () => ({
        kind: 'evm',
        rpcUrl: 'http://probe.test',
        venue: `0x${'1'.repeat(40)}`,
        reachable: true,
        observedChainId: CHAIN_ID,
        chainHeight: 100,
        venueDeployed: true,
        refusalCode: null,
        reason: null,
      }),
    });

    const status = await router.createCaller(anonymous()).status();
    expect(status.indexedHeight).toBe(97);
    expect(status.chain).toMatchObject({ kind: 'evm', chainHeight: 100, reachable: true });
    expect(status.behindBy).toBe(3);
  });

  /**
   * Tip can be below the cursor after a shortening reorg race (or a lagging
   * probe). Zero-clamping would lie as "current". Pin the signed subtraction.
   */
  it('behindBy is negative when the probe tip is below the cursor', async () => {
    const store = new MemoryProjectionStore(CHAIN_ID);
    await store.applyBlock({
      chainId: CHAIN_ID,
      height: 97,
      hash: `0x${'a'.repeat(64)}`,
      parentHash: `0x${'0'.repeat(64)}`,
      timestamp: 1_700_000_000,
      events: [],
    });
    const indexer = new Indexer({
      source: new NullChainSource(CHAIN_ID),
      store,
      finalityDepth: 64,
      ingestEnabled: () => true,
    });
    const router = createIndexerRouter({
      store,
      indexer,
      chainId: CHAIN_ID,
      finalityDepth: 64,
      ingestEnabled: () => true,
      chainSource: 'evm',
      chainProbe: async () => ({
        kind: 'evm',
        rpcUrl: 'http://probe.test',
        venue: `0x${'1'.repeat(40)}`,
        reachable: true,
        observedChainId: CHAIN_ID,
        chainHeight: 90,
        venueDeployed: true,
        refusalCode: null,
        reason: null,
      }),
    });

    const status = await router.createCaller(anonymous()).status();
    expect(status.indexedHeight).toBe(97);
    expect(status.behindBy).toBe(-7);
  });

  it('dark chain: production-shaped null probe surfaces refusal, never a quiet zero lag', async () => {
    const store = new MemoryProjectionStore(CHAIN_ID);
    const indexer = new Indexer({
      source: new NullChainSource(CHAIN_ID),
      store,
      finalityDepth: 64,
      ingestEnabled: () => true,
    });
    const router = createIndexerRouter({
      store,
      indexer,
      chainId: CHAIN_ID,
      finalityDepth: 64,
      ingestEnabled: () => true,
      chainSource: 'null',
      chainProbe: productionNullProbe(),
    });

    const status = await router.createCaller(anonymous()).status();
    expect(status.chain).toMatchObject({
      kind: 'null',
      reachable: false,
      chainHeight: null,
      venueDeployed: false,
      refusalCode: 'indexer.chain_not_configured',
    });
    expect(status.behindBy).toBeNull();
    expect(status.indexedHeight).toBeNull();
    expect(status.lastError).toBeNull();
  });

  it('puts lastError on the wire when a sync pass fails with a typed code', async () => {
    const store = new MemoryProjectionStore(CHAIN_ID);
    const indexer = new Indexer({
      source: new UnreachableChainSource(CHAIN_ID),
      store,
      finalityDepth: 64,
      ingestEnabled: () => true,
    });
    await expect(indexer.sync()).rejects.toMatchObject({ code: 'indexer.chain_unreachable' });
    expect(indexer.lastError).toMatchObject({
      code: 'indexer.chain_unreachable',
      message: expect.stringContaining('hermetic mount test'),
    });

    const router = createIndexerRouter({
      store,
      indexer,
      chainId: CHAIN_ID,
      finalityDepth: 64,
      ingestEnabled: () => true,
      chainSource: 'evm',
      chainProbe: productionNullProbe(),
    });

    const caller = router.createCaller(anonymous());
    const status = await caller.status();
    expect(status.lastError).not.toBeNull();
    expect(status.lastError).toMatchObject({
      code: 'indexer.chain_unreachable',
      message: expect.stringContaining('hermetic mount test'),
    });
    expect(typeof status.lastError!.at).toBe('string');
    // ISO timestamp, not a Date object on the wire.
    expect(Number.isNaN(Date.parse(status.lastError!.at))).toBe(false);
    // D26-P1-I3: chain-door lastError refuses data paths (no fake live book).
    await expect(caller.book({ market: 'IFC-USD', depth: 50 })).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
  });

  it('surfaces a halt, so a caller is told before it renders a price', async () => {
    const store = new MemoryProjectionStore(CHAIN_ID);
    const source = new MemoryChainSource(CHAIN_ID);
    for (let i = 0; i < 6; i++) source.append([]);

    const indexer = new Indexer({ source, store, finalityDepth: 1, ingestEnabled: () => true, startHeight: 0 });
    await indexer.sync();
    source.reorg(0, [[], [], []]);
    await expect(indexer.sync()).rejects.toThrow(/deeper than retained history/);

    const router = createIndexerRouter({
      store,
      indexer,
      chainId: CHAIN_ID,
      finalityDepth: 1,
      ingestEnabled: () => true,
      chainSource: 'memory',
    });

    const status = await router.createCaller(anonymous()).status();
    expect(status.halted).not.toBeNull();
    expect(status.halted!.reason).toMatch(/re-index/);
  });

  it('refuses book/fills/positions when halted — status still answers', async () => {
    const store = new MemoryProjectionStore(CHAIN_ID);
    const source = new MemoryChainSource(CHAIN_ID);
    source.append([{ kind: 'book_level', logIndex: 0, market: 'IFC-USD', side: 'bid', price: '100', quantity: '5' }]);
    for (let i = 0; i < 5; i++) source.append([]);

    const indexer = new Indexer({ source, store, finalityDepth: 1, ingestEnabled: () => true, startHeight: 0 });
    await indexer.sync();
    // Book is still in the store after a deep halt — that is the trap: the
    // projection was never unwound. Refusing the data path is what stops a
    // client rendering a price from a branch that no longer exists.
    expect((await store.book('IFC-USD', 10)).bids).toHaveLength(1);

    source.reorg(0, [[], [], []]);
    await expect(indexer.sync()).rejects.toThrow(/deeper than retained history/);

    const caller = createIndexerRouter({
      store,
      indexer,
      chainId: CHAIN_ID,
      finalityDepth: 1,
      ingestEnabled: () => true,
      chainSource: 'memory',
    }).createCaller(anonymous());

    // status is the diagnostic surface — always answers.
    await expect(caller.status()).resolves.toMatchObject({
      halted: expect.objectContaining({ reason: expect.stringMatching(/re-index/) }),
    });
    // health is liveness — the process is up.
    await expect(caller.health()).resolves.toMatchObject({ ok: true, service: 'svc-indexer' });

    // Every data procedure refuses. SERVICE_UNAVAILABLE, not a silent book.
    await expect(caller.book({ market: 'IFC-USD', depth: 50 })).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
    });
    await expect(caller.fills({ market: 'IFC-USD', limit: 100 })).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
    });
    await expect(caller.markets({ limit: 2 })).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    await expect(caller.positions({ account: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', limit: 2 })).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
    });
    // accountFills + singular position share assertServing — pin the matrix.
    await expect(caller.accountFills({ account: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', limit: 100 })).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
    });
    await expect(caller.position({ market: 'IFC-USD', account: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' })).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
    });
  });

  it('refuses stream when halted even if venue/RPC look wired — not status ok', async () => {
    const store = new MemoryProjectionStore(CHAIN_ID);
    const source = new MemoryChainSource(CHAIN_ID);
    source.append([{ kind: 'book_level', logIndex: 0, market: 'IFC-USD', side: 'bid', price: '100', quantity: '5' }]);
    for (let i = 0; i < 5; i++) source.append([]);

    const indexer = new Indexer({ source, store, finalityDepth: 1, ingestEnabled: () => true, startHeight: 0 });
    await indexer.sync();
    source.reorg(0, [[], [], []]);
    await expect(indexer.sync()).rejects.toThrow(/deeper than retained history/);

    const caller = createIndexerRouter({
      store,
      indexer,
      chainId: CHAIN_ID,
      finalityDepth: 1,
      ingestEnabled: () => true,
      chainSource: 'memory',
      venue: '0x78fbe21605d9424efdd6b2fddc4e846e8c746a4b',
      rpcUrl: 'http://127.0.0.1:8545',
    }).createCaller(anonymous());

    await expect(caller.stream({ market: 'IFC-USD', depth: 50 })).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
    });
  });
});

describe('svc-indexer health — liveness is not a custodial stamp', () => {
  it('answers ok + service and does not stamp custodial:false', async () => {
    const health = await (await seeded()).createCaller(anonymous()).health();
    expect(health).toEqual({
      ok: true,
      service: 'svc-indexer',
      ingestEnabled: true,
      clob: { live: false, kind: 'unset', reserves: false },
      chain: { status: 'unprobed', code: 'indexer.chain_unprobed', observedChainId: null },
    });
    expect(health).not.toHaveProperty('custodial');
  });
});

describe('svc-indexer mount — kill-switch is visible on the API', () => {
  it('reports ingestEnabled false on health and status when the switch is off', async () => {
    const store = new MemoryProjectionStore(CHAIN_ID);
    const indexer = new Indexer({
      source: new NullChainSource(CHAIN_ID),
      store,
      finalityDepth: 64,
      ingestEnabled: () => false,
    });
    const router = createIndexerRouter({
      store,
      indexer,
      chainId: CHAIN_ID,
      finalityDepth: 64,
      ingestEnabled: () => false,
      chainSource: 'null',
    });
    const caller = router.createCaller(anonymous());
    await expect(caller.health()).resolves.toMatchObject({ ingestEnabled: false });
    await expect(caller.status()).resolves.toMatchObject({ ingestEnabled: false });
  });

  it('stream refuses indexer.stream_unwired when venue/RPC are blank', async () => {
    const caller = (await seeded()).createCaller(anonymous());
    await expect(caller.stream({ market: 'IFC-USD', depth: 50 })).rejects.toMatchObject({
      message: 'indexer.stream_unwired',
    });
  });

  it('stream returns empty deltas when wired and the book is empty — not a $0 book', async () => {
    const store = new MemoryProjectionStore(CHAIN_ID);
    const source = new MemoryChainSource(CHAIN_ID);
    const indexer = new Indexer({ source, store, finalityDepth: 64, ingestEnabled: () => true, startHeight: 0 });
    const caller = createIndexerRouter({
      store,
      indexer,
      chainId: CHAIN_ID,
      finalityDepth: 64,
      ingestEnabled: () => true,
      chainSource: 'memory',
      venue: '0x78fbe21605d9424efdd6b2fddc4e846e8c746a4b',
      rpcUrl: 'http://127.0.0.1:8545',
    }).createCaller(anonymous());
    const out = await caller.stream({ depth: 50, marketsLimit: 2 });
    expect(out).toEqual({
      status: 'ok',
      code: null,
      deltas: [],
      clob: { live: true, kind: 'sovereign-venue', reserves: false },
    });
  });
});
