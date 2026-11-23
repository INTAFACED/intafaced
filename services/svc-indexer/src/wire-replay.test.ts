import Fastify from 'fastify';
import type { AnyRouter } from '@trpc/server';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, procedureCallers, signPrincipalHeader } from '@intafaced/contracts';
import { MemoryChainSource, NullChainSource } from './chain/memory-source.js';
import { memoryExplorerSource, parseExplorerListLimit, type ExplorerBlockFact } from './explorer/blocks.js';
import { parsePoolFactory } from './explorer/pools.js';
import { parseTxDropWindow } from './explorer/tx.js';
import { Indexer } from './indexer.js';
import { MemoryProjectionStore } from './projection/memory-store.js';
import { registerIndexerPublicHttp } from './public-http.js';
import { createIndexerRouter, type ChainProbe, type IndexerRouterDeps } from './router.js';
import { CHAIN_ID } from './testing/conformance.js';

/**
 * The wire replay for svc-indexer: every call's current answers, recorded before anyone moves them.
 *
 * `wire-replay.golden/` holds what svc-indexer's public door answered (main 2026-11-19, as it is, bugs included) to a
 * matrix of requests: every tRPC procedure, `/health` and `/ready`, through `registerIndexerPublicHttp` (the door
 * `index.ts` mounts) with the edge context `index.ts` builds. Each call gets nothing, null, a wrong type, an empty
 * object, a valid input and a second input that takes another branch (another network, a missing window, a bad
 * address), from four callers: nobody, and a signed-in person in DE, in US and in an unknown region. A later move of
 * these calls must answer each one byte for byte the same; a changed refusal code, a widened input, a new gate or a
 * reshaped envelope shows here as a difference.
 *
 * Two stacks, each composed the way `index.ts` composes it:
 * - `blank`: blank owner settings and no RPC, so `NullChainSource` and every unset window and limit.
 * - `wired`: a memory chain holding a small book, one fill and one position, synced; owner limits set; three
 *   explorer block facts. `wired-unset`: the same chain with the explorer's owner settings blank and no address page. Every other read `index.ts` takes from Postgres or a node is a stub that refuses with its own
 *   name (`replay stub: txs.indexed`), so the recording pins how each call answers when that read fails.
 * No database and no node. The clock is fixed: answers carry `asOf` times.
 *
 * Requests are written here, not made from the schemas, so a changed schema cannot change its own requests.
 * `WIRE_REPLAY_WRITE=1` rewrites the golden folder. Only for a change that is meant to change the wire, named in its PR.
 */

const GOLDEN = new URL('./wire-replay.golden/', import.meta.url);
const goldenJson = (name: string) => new URL(`./wire-replay.golden/${name}.json`, import.meta.url);
/** One review part holds 400 KB and a new file is one hunk, so each recorded file stays under this. */
const SHARD_BYTES = 350_000;
const NOW = new Date('2026-11-19T00:00:00Z');
const SECRET = 'an-indexer-wire-replay-edge-secret-long-enough';
const USER = '11111111-1111-4111-8111-111111111111';
const MARKET = 'IFC-USD';
const ACCOUNT = '0x' + 'a'.repeat(40);
const VENUE = '0x' + 'b'.repeat(40);
const FACTORY = '0x' + 'c'.repeat(40);
const HASH = '0x' + 'd'.repeat(64);
const OTHER_CHAIN = 1;

/** A dependency nobody wired: any property is another stub, any call refuses with the path it was reached by. */
function stub(name: string): never {
  const target = function () {};
  return new Proxy(target, {
    get(_t, prop) {
      if (prop === 'then' || typeof prop === 'symbol') return undefined;
      return stub(`${name}.${prop}`);
    },
    apply() {
      throw new Error(`replay stub: ${name}`);
    },
    construct() {
      throw new Error(`replay stub: new ${name}`);
    },
  }) as never;
}

/** `index.ts`'s probe with no RPC configured, word for word. */
const nullProbe = async (): Promise<ChainProbe> => ({
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

const FACTS: ExplorerBlockFact[] = [
  {
    chainId: CHAIN_ID,
    height: 3,
    hash: '0x' + '3'.repeat(64),
    gasUsed: 21_000n,
    gasLimit: 30_000_000n,
    baseFeePerGas: 7n,
    miner: ACCOUNT,
    txCount: 1,
    size: 600,
    timestamp: 1_700_000_036,
    orphaned: null,
  },
  {
    chainId: CHAIN_ID,
    height: 2,
    hash: '0x' + '2'.repeat(64),
    gasUsed: 0n,
    gasLimit: 30_000_000n,
    baseFeePerGas: null,
    miner: ACCOUNT,
    txCount: 0,
    size: 500,
    timestamp: 1_700_000_024,
    orphaned: null,
  },
  {
    chainId: CHAIN_ID,
    height: 2,
    hash: '0x' + 'e'.repeat(64),
    gasUsed: 0n,
    gasLimit: 0n,
    baseFeePerGas: null,
    miner: ACCOUNT,
    txCount: 0,
    size: 500,
    timestamp: 1_700_000_024,
    orphaned: { reason: 'reorged' },
  },
];

type Stack = { deps: IndexerRouterDeps; indexer: Indexer; venue: string | null };

/** Blank owner settings and no RPC, as `index.ts` composes it. */
function blankStack(): Stack {
  const store = new MemoryProjectionStore(CHAIN_ID);
  const indexer = new Indexer({
    source: new NullChainSource(CHAIN_ID),
    store,
    finalityDepth: 64,
    ingestEnabled: () => true,
    startHeight: 0,
  });
  const deps: IndexerRouterDeps = {
    store,
    indexer,
    chainId: CHAIN_ID,
    finalityDepth: 64,
    ingestEnabled: () => true,
    chainSource: 'null',
    chainProbe: nullProbe,
    venue: null,
    rpcUrl: null,
    claimLiveClob: false,
    explorer: {
      listLimit: parseExplorerListLimit(undefined),
      blocks: stub('explorer.blocks'),
      atHeight: stub('explorer.atHeight'),
      block: stub('explorer.block'),
    },
    txs: {
      dropWindow: parseTxDropWindow(undefined),
      indexed: stub('txs.indexed'),
      pendingSince: stub('txs.pendingSince'),
      notePending: stub('txs.notePending'),
      lookup: async () => null,
    },
    txList: stub('txList'),
    address: { txs: stub('address.txs'), tokensBySymbol: stub('address.tokensBySymbol') },
    searchNetworks: [],
    pools: { reads: stub('pools.reads'), factory: parsePoolFactory(undefined) },
  };
  return { deps, indexer, venue: null };
}

/**
 * A memory chain with a book, a fill and a position, synced; the rest refuses by name. `owner` sets the explorer's list
 * limit, drop window and pool factory and wires the address page; without it each is left as a blank setting leaves it.
 */
async function wiredStack(owner: boolean): Promise<Stack> {
  const store = new MemoryProjectionStore(CHAIN_ID);
  const source = new MemoryChainSource(CHAIN_ID);
  source.append([
    { kind: 'book_level', logIndex: 0, market: MARKET, side: 'bid', price: '100.5', quantity: '5' },
    { kind: 'book_level', logIndex: 1, market: MARKET, side: 'ask', price: '101', quantity: '2.25' },
  ]);
  source.append([
    { kind: 'fill', logIndex: 0, market: MARKET, price: '101', quantity: '1', takerSide: 'buy', maker: VENUE, taker: ACCOUNT },
    { kind: 'position', logIndex: 1, market: MARKET, account: ACCOUNT, size: '-1', entryPrice: '101' },
  ]);
  source.appendEmpty(3);
  const indexer = new Indexer({ source, store, finalityDepth: 2, ingestEnabled: () => true, startHeight: 0 });
  await indexer.sync();
  const deps: IndexerRouterDeps = {
    store,
    indexer,
    chainId: CHAIN_ID,
    finalityDepth: 2,
    ingestEnabled: () => true,
    chainSource: 'evm',
    chainProbe: stub('chainProbe'),
    venue: VENUE,
    rpcUrl: 'http://127.0.0.1:8545',
    claimLiveClob: false,
    explorer: memoryExplorerSource(parseExplorerListLimit(owner ? '2' : undefined), FACTS),
    txs: {
      dropWindow: parseTxDropWindow(owner ? '600' : undefined),
      indexed: stub('txs.indexed'),
      pendingSince: stub('txs.pendingSince'),
      notePending: stub('txs.notePending'),
      lookup: stub('txs.lookup'),
    },
    txList: stub('txList'),
    address: { txs: stub('address.txs'), tokensBySymbol: stub('address.tokensBySymbol') },
    ...(owner ? { addressPage: { reads: stub('addressPage.reads'), state: stub('addressPage.state') } } : {}),
    searchNetworks: [{ chainId: OTHER_CHAIN, find: stub('searchNetworks.find') }],
    pools: { reads: stub('pools.reads'), factory: parsePoolFactory(owner ? FACTORY : undefined) },
  };
  return { deps, indexer, venue: VENUE };
}

const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-indexer' });

async function serve(stack: Stack) {
  const app = Fastify({ maxParamLength: 5_000, genReqId: () => 'replay-request' });
  await registerIndexerPublicHttp(app, {
    indexer: stack.indexer,
    appRouter: createIndexerRouter(stack.deps),
    serviceName: 'svc-indexer',
    ingestEnabled: () => true,
    venue: stack.venue,
    claimLiveClob: false,
    dbPing: async () => {},
    createContext: ({ req }) => edgeContext(req),
  });
  await app.ready();
  return app;
}

/** Each call: a valid input and a second one that takes another branch. Both are sent as they are written here. */
const CALLS: Record<string, { valid: unknown; alt: unknown }> = {
  'explorer.blocks.list': { valid: { chainId: CHAIN_ID }, alt: { chainId: OTHER_CHAIN, cursor: 3, limit: 1 } },
  'explorer.blocks.get': { valid: { chainId: CHAIN_ID, height: 2 }, alt: { chainId: CHAIN_ID, hash: HASH } },
  'explorer.txs.list': {
    valid: { chainId: CHAIN_ID },
    alt: { chainId: OTHER_CHAIN, cursor: { height: 1, index: 0, hash: HASH }, limit: 1 },
  },
  'explorer.address.txs': { valid: { chainId: CHAIN_ID, address: ACCOUNT }, alt: { chainId: OTHER_CHAIN, address: ACCOUNT, limit: 1 } },
  'explorer.address.summary': { valid: { chainId: CHAIN_ID, address: ACCOUNT }, alt: { chainId: OTHER_CHAIN, address: ACCOUNT } },
  'explorer.address.holdings': { valid: { chainId: CHAIN_ID, address: ACCOUNT }, alt: { chainId: OTHER_CHAIN, address: ACCOUNT } },
  'explorer.address.internal': {
    valid: { chainId: CHAIN_ID, address: ACCOUNT },
    alt: { chainId: OTHER_CHAIN, address: ACCOUNT, limit: 1 },
  },
  'explorer.address.balanceAt': {
    valid: { chainId: CHAIN_ID, address: ACCOUNT, at: { height: 1 } },
    alt: { chainId: CHAIN_ID, address: ACCOUNT, at: { date: '2026-02-30' } },
  },
  'explorer.tokens.bySymbol': { valid: { chainId: CHAIN_ID, symbol: 'USDC' }, alt: { chainId: OTHER_CHAIN, symbol: ' ' } },
  'explorer.pools.list': { valid: { chainId: CHAIN_ID }, alt: { chainId: OTHER_CHAIN, cursor: { height: 1, index: 0, logIndex: 0 } } },
  'explorer.pools.get': { valid: { chainId: CHAIN_ID, address: FACTORY }, alt: { chainId: OTHER_CHAIN, address: FACTORY, interval: '5m' } },
  'explorer.pools.swaps': { valid: { chainId: CHAIN_ID, address: FACTORY }, alt: { chainId: OTHER_CHAIN, address: FACTORY } },
  'explorer.tx.get': { valid: { chainId: CHAIN_ID, hash: HASH }, alt: { chainId: OTHER_CHAIN, hash: HASH } },
  'explorer.tx.networks': { valid: { hash: HASH }, alt: { hash: '0x1' } },
  status: { valid: undefined, alt: { extra: 1 } },
  book: { valid: { market: MARKET, depth: 10 }, alt: { market: MARKET } },
  positions: { valid: { account: ACCOUNT, limit: 10 }, alt: { account: ACCOUNT } },
};

function inputs(call: { valid: unknown; alt: unknown }): Array<[string, unknown]> {
  return [
    ['absent', undefined],
    ['null', null],
    ['wrong-type', 7],
    ['empty', {}],
    ['valid', call.valid],
    ['alt', call.alt],
  ];
}

function headers(region: string | null): Record<string, string> {
  if (region === null) return {};
  const principal = {
    sub: USER,
    userId: USER,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes: [],
    tier: 'none',
    mfa: false,
    expiresAt: new Date('2099-01-01T00:00:00Z'),
  } as Principal;
  const raw = encodePrincipal(principal);
  return {
    'x-intafaced-principal': raw,
    'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, region),
    'x-intafaced-region': region,
  };
}

/** Nobody; a signed-in person in a served region, in the US, and in a region nobody named. */
const CALLERS: ReadonlyArray<[string, string | null]> = [
  ['anon', null],
  ['DE', 'DE'],
  ['US', 'US'],
  ['XX', 'XX'],
];

type Answer = { status: number; body: string };

interface Golden {
  readonly callers: unknown;
  /** Per `<stack> <call>`, per `<input> <caller>`: the answer. */
  readonly answers: Record<string, Record<string, Answer>>;
}

async function send(app: Awaited<ReturnType<typeof serve>>, url: string, h: Record<string, string>): Promise<Answer> {
  const res = await app.inject({ method: 'GET', url, headers: h });
  // tRPC's dev stack trace carries file paths and line numbers, which move with any edit.
  return { status: res.statusCode, body: res.body.replace(/"stack":"(?:[^"\\]|\\.)*"/g, '"stack":"<stack>"') };
}

async function replay(): Promise<Golden> {
  const answers: Golden['answers'] = {};
  for (const [name, make] of [
    ['blank', async () => blankStack()],
    ['wired', async () => wiredStack(true)],
    ['wired-unset', async () => wiredStack(false)],
  ] as const) {
    const app = await serve(await make());
    try {
      for (const door of ['/health', '/ready']) {
        const row: Record<string, Answer> = {};
        for (const [callerName, region] of CALLERS) row[`- ${callerName}`] = await send(app, door, headers(region));
        answers[`${name} GET ${door}`] = row;
      }
      for (const [path, call] of Object.entries(CALLS)) {
        const row: Record<string, Answer> = {};
        for (const [inputName, input] of inputs(call))
          for (const [callerName, region] of CALLERS) {
            const url = `/trpc/${path}${input === undefined ? '' : `?input=${encodeURIComponent(JSON.stringify(input))}`}`;
            row[`${inputName} ${callerName}`] = await send(app, url, headers(region));
          }
        answers[`${name} ${path}`] = row;
      }
    } finally {
      await app.close();
    }
  }
  return { callers: procedureCallers(createIndexerRouter(blankStack().deps) as never), answers };
}

/** The shard a call is kept in: its stack and first path part (`wired explorer`, `blank core`). */
function shardOf(call: string): string {
  const [stack, path] = call.split(' ') as [string, string];
  const head = path.split('.')[0]!;
  return `${stack}-${head === 'explorer' ? 'explorer' : 'core'}`;
}

/** One shard file: each distinct body once, every answer a status and that body's index. One line per body and per call. */
function shardText(calls: string[], g: Golden): string {
  const bodies: string[] = [];
  const index = new Map<string, number>();
  const rows = calls.map((call) => {
    const answers = Object.entries(g.answers[call]!).map(([k, a]) => {
      if (!index.has(a.body)) index.set(a.body, bodies.push(a.body) - 1);
      return `${JSON.stringify(k)}: [${a.status}, ${index.get(a.body)}]`;
    });
    return `    ${JSON.stringify(call)}: { ${answers.join(', ')} }`;
  });
  return [
    '{',
    `  "bodies": [\n${bodies.map((b) => `    ${JSON.stringify(b)}`).join(',\n')}\n  ],`,
    `  "answers": {\n${rows.join(',\n')}\n  }`,
    '}',
    '',
  ].join('\n');
}

/** Writes the recording in the repo's own format (the format check reads JSON), each shard under SHARD_BYTES. */
async function writeGolden(g: Golden) {
  const prettier = await import('prettier');
  const format = async (name: string, text: string) => {
    const file = goldenJson(name).pathname;
    return prettier.format(text, { ...(await prettier.resolveConfig(file)), filepath: file });
  };
  const groups = new Map<string, string[]>();
  for (const c of Object.keys(g.answers)) groups.set(shardOf(c), [...(groups.get(shardOf(c)) ?? []), c]);
  rmSync(GOLDEN, { recursive: true, force: true });
  mkdirSync(GOLDEN);
  writeFileSync(goldenJson('callers'), await format('callers', JSON.stringify(g.callers)));
  for (const [name, calls] of groups) {
    const text = await format(name, shardText(calls, g));
    if (Buffer.byteLength(text) > SHARD_BYTES) throw new Error(`shard ${name} is ${Buffer.byteLength(text)} bytes, over ${SHARD_BYTES}`);
    writeFileSync(goldenJson(name), text);
  }
}

function readGolden(): Golden {
  const g: Golden = {
    callers: JSON.parse(readFileSync(new URL('./wire-replay.golden/callers.json', import.meta.url), 'utf8')),
    answers: {},
  };
  for (const file of readdirSync(GOLDEN).filter((f) => f !== 'callers.json')) {
    const shard = JSON.parse(readFileSync(goldenJson(file.replace(/\.json$/, '')), 'utf8')) as {
      bodies: string[];
      answers: Record<string, Record<string, [number, number]>>;
    };
    for (const [call, answers] of Object.entries(shard.answers))
      g.answers[call] = Object.fromEntries(Object.entries(answers).map(([k, [status, i]]) => [k, { status, body: shard.bodies[i]! }]));
  }
  return g;
}

describe('the wire replay: svc-indexer answers as main did before its calls were moved', () => {
  beforeAll(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: NOW });
  });
  afterAll(() => {
    vi.useRealTimers();
  });

  it('every tRPC procedure is in the matrix', () => {
    const anyRouter: AnyRouter = createIndexerRouter(blankStack().deps);
    expect(Object.keys(anyRouter._def.procedures).sort()).toEqual(Object.keys(CALLS).sort());
  });

  it('every request in the matrix gets the recorded status and body, byte for byte', async () => {
    const now = await replay();
    if (process.env.WIRE_REPLAY_WRITE === '1') await writeGolden(now);
    const golden = readGolden();
    expect(Object.keys(golden.answers).sort()).toEqual(Object.keys(now.answers).sort());
    expect(Object.values(golden.answers).reduce((n, row) => n + Object.keys(row).length, 0)).toBe(1248);
    expect(now.callers).toEqual(golden.callers);
    const diffs = Object.entries(golden.answers).flatMap(([call, row]) =>
      Object.entries(row)
        .filter(([k, was]) => now.answers[call]?.[k]?.status !== was.status || now.answers[call]?.[k]?.body !== was.body)
        .map(
          ([k, was]) =>
            `${call} ${k}: ${was.status} ${was.body.slice(0, 160)} != ${now.answers[call]?.[k]?.status} ${now.answers[call]?.[k]?.body.slice(0, 160)}`,
        ),
    );
    expect(diffs).toEqual([]);
  });
});
