import Fastify from 'fastify';
import type { AnyRouter } from '@trpc/server';
import { fastifyTRPCPlugin } from '@trpc/server/adapters/fastify';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Address } from 'viem';
import { z } from 'zod';
import { SCOPES, type Principal, type Scope } from '@intafaced/auth';
import { edgeTrustFromEnv } from '@intafaced/config';
import { createEdgeContext, encodePrincipal, procedureCallers, signPrincipalHeader } from '@intafaced/contracts';
import type { Env } from './env.js';
import { ProtocolChain } from './chain/client.js';
import { chainIdentityReader } from './chain/identity.js';
import { isZeroAddress } from './chain/availability.js';
import { parseGasPercentileSetting } from './chain/gas-price.js';
import { SessionRelay } from './session/relay.js';
import { createPeers } from './blockers/peers.js';
import { createProtocolRouter } from './router.js';
import { representationFromSetting } from './representation/representation.js';
import { PostgresRepresentationStore } from './representation/representation.pg.js';
import { PostgresAddressRiskStore } from './address-risk/risk.pg.js';
import { PostgresComplianceStore } from './address-risk/compliance.pg.js';
import { PostgresTrustDeskStore } from './address-risk/trust-desk.pg.js';
import { walletSessionFromSetting } from './address-book/session.js';
import { PostgresAddressBookStore } from './address-book/book.pg.js';
import { venueConnectionTtlFromSetting, walletSanctionsFromSetting } from './venue-wallet/connection.js';
import { PostgresVenueConnectionStore } from './venue-wallet/connection.pg.js';
import { embeddedWalletFromSetting } from './embedded-wallet/provider.js';
import { PostgresEmbeddedWalletStore } from './embedded-wallet/embedded.pg.js';
import { challengeTtlFromSetting } from './listing/ownership.js';
import { PostgresListingStore } from './listing/ownership.pg.js';
import { chainIsMainnet, loadNetworkRegistry, networksRegistryPathFromSetting } from './networks/registry.js';

/**
 * The wire replay for svc-protocol: every protocol call's current answers, recorded before anyone moves them.
 *
 * `wire-replay.golden.json` and `wire-replay.golden/` hold what svc-protocol answered (main 2026-11-19, as it is, bugs
 * included) to a matrix of requests: every procedure of the router `index.ts` mounts, six inputs and four callers, sent
 * through the production Fastify adapter with the edge context `index.ts` builds. A later move of these calls must answer
 * each one byte for byte the same; a wrong scope, a changed refusal code, a widened input or a reshaped envelope shows here.
 *
 * No database, bus, chain node or peer: the database handle is a recording stub that refuses any call with its own name
 * (`replay stub: sql`), every Postgres store is the real class over it, and the chain is the real `ProtocolChain` whose
 * RPC client is such a stub. Settings are parsed by the real parsers from a blank environment (only what the schema
 * refuses to start without is set), so every owner value is the blank one. So the recording pins the boundary (who may
 * call, what input is accepted, how each refusal is shaped) and which dependency each accepted call reaches first.
 *
 * `WIRE_REPLAY_WRITE=1` rewrites the recording. Only for a change that is meant to change the wire, named in its PR.
 */

/** The recording's index: who may call each procedure, and the shard files below it. */
const INDEX = new URL('./wire-replay.golden.json', import.meta.url);
/**
 * Error replies no longer carry tRPC's stack. Recordings made before that hold `"stack":"<stack>"` in their error bodies;
 * it is dropped on reading, while the live side still turns any stack into `<stack>`, so a stack that comes back fails.
 */
const RECORDED_STACK = '\\"stack\\":\\"<stack>\\",';
const GOLDEN = new URL('./wire-replay.golden/', import.meta.url);
/** One recorded shard in the recording folder. */
const goldenJson = (name: string) => new URL(`./wire-replay.golden/${name}.json`, import.meta.url);
/** One review part holds 400 KB and a new file is one hunk, so each recorded file stays under this. */
const SHARD_BYTES = 350_000;
const SECRET = 'a-protocol-wire-replay-edge-secret-long-enough';
const USER = '11111111-1111-4111-8111-111111111111';
const ID = '22222222-2222-4222-8222-222222222222';
/**
 * Blank owner settings: nothing set but what the schema refuses to start without, as on a test stack nobody configured.
 * The chain id, RPC endpoint and EntryPoint have no default, so they hold the local test chain's values. `index.ts`
 * reads APP_ENV raw too, so it is `test` here, the stack the journeys run on.
 */
const ENV_SOURCE: NodeJS.ProcessEnv = {
  APP_ENV: 'test',
  SERVICE_NAME: 'svc-protocol',
  DATABASE_URL: 'postgres://replay:replay@localhost:5432/replay',
  DATABASE_POOL_MAX: '1',
  EDGE_PRINCIPAL_SECRET: SECRET,
  PROTOCOL_CHAIN_ID: '31337',
  PROTOCOL_RPC_URL: 'http://127.0.0.1:8545',
  PROTOCOL_ENTRYPOINT_ADDRESS: '0x0000000071727De22E5E9d8BAf0edAc6f37da032',
};

/** `env.ts` parses `process.env` when it is imported: it is imported once, over the blank source alone. */
async function loadBlankEnv(): Promise<Env> {
  const saved = process.env;
  process.env = { ...ENV_SOURCE };
  try {
    return (await import('./env.js')).env;
  } finally {
    process.env = saved;
  }
}
const env = await loadBlankEnv();
const APP_ENV = ENV_SOURCE.APP_ENV;

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

/** The composition `index.ts` makes, with the same factories in the same order, over the stubbed database and RPC client. */
export function createReplayProtocolRouter() {
  const sql = stub('sql');
  const chain = new ProtocolChain({
    chainId: env.PROTOCOL_CHAIN_ID,
    rpcUrl: env.PROTOCOL_RPC_URL,
    entryPoint: env.PROTOCOL_ENTRYPOINT_ADDRESS as Address,
    factory: env.PROTOCOL_FACTORY_ADDRESS as Address,
    implementation: env.PROTOCOL_IMPLEMENTATION_ADDRESS as Address,
    tokenFactory: env.PROTOCOL_TOKEN_FACTORY_ADDRESS as Address,
    ...(env.PROTOCOL_BUNDLER_URL ? { bundlerUrl: env.PROTOCOL_BUNDLER_URL } : {}),
  });
  // No node: every RPC call refuses with the method it reached.
  Object.defineProperty(chain, 'client', { value: stub('chain.client') });
  const chainIdentity = chainIdentityReader(chain);
  const relay = new SessionRelay();
  const relayEnabled = env.PROTOCOL_RELAY_ENABLED;
  const representationSetting = representationFromSetting(env.PROTOCOL_REPRESENTATION_VERSION, env.PROTOCOL_REPRESENTATION_TEXT, APP_ENV);
  const walletSessionSetting = walletSessionFromSetting(
    env.PROTOCOL_WALLET_SESSION_SECRET,
    env.PROTOCOL_WALLET_SESSION_TTL_SECONDS,
    env.PROTOCOL_WALLET_SESSION_ORIGINS,
    APP_ENV,
  );
  const venueConnectionTtl = venueConnectionTtlFromSetting(env.PROTOCOL_VENUE_CONNECTION_TTL_SECONDS, APP_ENV);
  const walletSanctions = walletSanctionsFromSetting(env.PROTOCOL_WALLET_SANCTIONS, APP_ENV);
  const embeddedWalletSetting = embeddedWalletFromSetting(
    env.PROTOCOL_EMBEDDED_WALLET_PROVIDER,
    env.PROTOCOL_EMBEDDED_WALLET_TEST_URL,
    APP_ENV,
  );
  const networksRegistryPath = networksRegistryPathFromSetting(env.PROTOCOL_TEST_NETWORKS_REGISTRY, APP_ENV);
  const loadNetworks = () => loadNetworkRegistry(networksRegistryPath);
  const listingChallengeTtl = challengeTtlFromSetting(env.PROTOCOL_LISTING_CHALLENGE_TTL_SECONDS, APP_ENV);
  return createProtocolRouter({
    chainIdentity,
    loadNetworks,
    gasPercentiles: () => parseGasPercentileSetting(env.PROTOCOL_GAS_PERCENTILES, env.PROTOCOL_GAS_HISTORY_BLOCKS),
    chain,
    relay,
    relayEnabled: () => relayEnabled,
    ammFactoryAddress: () => env.PROTOCOL_AMM_FACTORY_ADDRESS as `0x${string}`,
    liquidityRouter: () => env.PROTOCOL_LIQUIDITY_ROUTER_ADDRESS as `0x${string}`,
    feeTiers: () => env.PROTOCOL_AMM_FEE_TIERS_BPS,
    swapSlippageBps: () => env.PROTOCOL_SWAP_SLIPPAGE_BPS,
    swapQuoteTtlSeconds: () => env.PROTOCOL_SWAP_QUOTE_TTL_SECONDS,
    swapConfirmations: () => env.PROTOCOL_SWAP_CONFIRMATIONS,
    swapFeeCapWei: () => env.PROTOCOL_SWAP_MAX_FEE_PER_GAS_WEI,
    swapPaymasterAddress: () =>
      isZeroAddress(env.PROTOCOL_SWAP_PAYMASTER_ADDRESS) ? null : (env.PROTOCOL_SWAP_PAYMASTER_ADDRESS as `0x${string}`),
    feeRelay: () =>
      !isZeroAddress(env.PROTOCOL_FEE_RELAY_ADDRESS) && env.PROTOCOL_FEE_RELAY_URL && env.PROTOCOL_FEE_RELAY_GAS_LIMIT !== null
        ? {
            relay: env.PROTOCOL_FEE_RELAY_ADDRESS as `0x${string}`,
            url: env.PROTOCOL_FEE_RELAY_URL,
            gasLimit: env.PROTOCOL_FEE_RELAY_GAS_LIMIT,
          }
        : null,
    claimEscrow: () => env.PROTOCOL_CLAIM_ESCROW_ADDRESS as `0x${string}`,
    p2pEscrow: () => ({
      escrow: env.PROTOCOL_P2P_ESCROW_ADDRESS as `0x${string}`,
      mainnet: chainIsMainnet(env.PROTOCOL_CHAIN_ID, loadNetworks()),
    }),
    venue: () => env.PROTOCOL_VENUE_ADDRESS as `0x${string}`,
    lendingMarket: () => env.PROTOCOL_LENDING_MARKET_ADDRESS as `0x${string}`,
    swapV2: () =>
      isZeroAddress(env.PROTOCOL_ROUTER_V2_ADDRESS) ||
      isZeroAddress(env.PROTOCOL_SOVEREIGN_PERMIT_ADDRESS) ||
      isZeroAddress(env.PROTOCOL_WRAPPED_NATIVE_ADDRESS)
        ? null
        : {
            router: env.PROTOCOL_ROUTER_V2_ADDRESS as `0x${string}`,
            sovereignPermit: env.PROTOCOL_SOVEREIGN_PERMIT_ADDRESS as `0x${string}`,
            wrappedNative: env.PROTOCOL_WRAPPED_NATIVE_ADDRESS as `0x${string}`,
          },
    permitLifetimeCapSeconds: () => env.PROTOCOL_PERMIT_LIFETIME_CAP_SECONDS,
    replacement: () => ({ bumpBps: env.PROTOCOL_TX_FEE_BUMP_BPS, ceilingWei: env.PROTOCOL_TX_FEE_CEILING_WEI }),
    priceSetting: () =>
      env.PROTOCOL_PRICE_USD_TOKENS && env.PROTOCOL_PRICE_MIN_RESERVE_USD !== null
        ? { usdTokens: env.PROTOCOL_PRICE_USD_TOKENS, minReserveUsd: env.PROTOCOL_PRICE_MIN_RESERVE_USD }
        : null,
    tokensQuoteToken: () => env.PROTOCOL_TOKENS_QUOTE_TOKEN,
    probeTimeoutMs: () => env.PROTOCOL_PEER_TIMEOUT_MS,
    listing: { store: new PostgresListingStore(sql), ttlSeconds: () => listingChallengeTtl },
    representation: { store: new PostgresRepresentationStore(sql), setting: () => representationSetting },
    addressRisk: { store: new PostgresAddressRiskStore(sql), screeningLoaded: () => false },
    compliance: { store: new PostgresComplianceStore(sql), trustDesk: new PostgresTrustDeskStore(sql) },
    addressBook: {
      store: new PostgresAddressBookStore(sql),
      session: () => walletSessionSetting,
      maxContacts: () => env.PROTOCOL_ADDRESS_BOOK_MAX_CONTACTS,
      maxGroups: () => env.PROTOCOL_WALLET_GROUPS_MAX,
    },
    venueWallet: {
      store: new PostgresVenueConnectionStore(sql),
      session: () => walletSessionSetting,
      ttlSeconds: () => venueConnectionTtl,
      sanctions: () => walletSanctions,
    },
    embeddedWallet: { store: new PostgresEmbeddedWalletStore(sql), setting: () => embeddedWalletSetting },
    peers: createPeers({
      indexer: { url: env.INDEXER_URL, timeoutMs: env.PROTOCOL_PEER_TIMEOUT_MS },
      dex: { url: env.DEX_URL, timeoutMs: env.PROTOCOL_PEER_TIMEOUT_MS },
    }),
  });
}

/** The app `index.ts` serves, without its listener, its `/health` and `/ready` (which need the boot) or its observer. */
async function serve() {
  const edgeContext = createEdgeContext({ secret: env.EDGE_PRINCIPAL_SECRET, ...edgeTrustFromEnv(env), serviceName: env.SERVICE_NAME });
  // Fastify numbers requests per process (`req-1`, `req-2`, ...) and a refusal carries that id: one fixed id keeps an
  // added or reordered call from shifting every later answer. That the id is there is still recorded.
  const app = Fastify({ maxParamLength: 5_000, genReqId: () => 'req-replay' });
  await app.register(fastifyTRPCPlugin, {
    prefix: '/trpc',
    trpcOptions: { router: createReplayProtocolRouter(), createContext: ({ req }: { req: unknown }) => edgeContext(req as never) },
  });
  await app.ready();
  return app;
}

interface Caller {
  readonly scopes: readonly Scope[] | null;
  readonly tier: 'none' | 'basic' | 'full';
  readonly mfa: boolean;
  readonly region: string;
}

function headers(caller: Caller): Record<string, string> {
  if (caller.scopes === null) return { 'x-intafaced-region': caller.region };
  const principal = {
    sub: USER,
    userId: USER,
    sid: '33333333-3333-4333-8333-333333333333',
    scopes: caller.scopes,
    tier: caller.tier,
    mfa: caller.mfa,
    expiresAt: new Date('2099-01-01T00:00:00Z'),
  } as Principal;
  const raw = encodePrincipal(principal);
  return {
    'x-intafaced-principal': raw,
    'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, caller.region),
    'x-intafaced-region': caller.region,
  };
}

/** Nobody; a signed-in person holding no scope; a fully verified holder of every scope, in a served and an unserved region. */
const CALLERS: ReadonlyArray<[string, Caller]> = [
  ['anon', { scopes: null, tier: 'none', mfa: false, region: 'DE' }],
  ['no-scope', { scopes: [], tier: 'basic', mfa: false, region: 'DE' }],
  ['all', { scopes: [...SCOPES], tier: 'full', mfa: true, region: 'DE' }],
  ['all-US', { scopes: [...SCOPES], tier: 'full', mfa: true, region: 'US' }],
];

type Json = { [k: string]: unknown };

/** Strings tried against a schema's pattern, in order: the first that matches is the sample. */
const PATTERN_TRIES = [
  '0x' + 'a'.repeat(40),
  '0x' + 'a'.repeat(64),
  '0x' + 'a'.repeat(130),
  '0x',
  '1.50',
  '1',
  '1.5',
  'BTC',
  'USDC',
  'DE',
  'placeholder',
  ID,
  '2026-01-01',
  '2026-01-01T00:00:00Z',
  'a-b',
  'A',
];

/** A plain sample of what an input's own JSON schema asks for. Not always accepted (custom checks are not in the schema): that answer is recorded too. */
function sample(schema: unknown, depth = 0): unknown {
  if (typeof schema !== 'object' || schema === null || depth > 8) return null;
  const s = schema as Json;
  if ('const' in s) return s.const;
  if (Array.isArray(s.enum)) return s.enum[0];
  for (const k of ['anyOf', 'oneOf', 'allOf'] as const) {
    if (Array.isArray(s[k])) {
      const options = (s[k] as Json[]).filter((o) => o.type !== 'null');
      if (k === 'allOf') return Object.assign({}, ...options.map((o) => sample(o, depth + 1)));
      return sample(options[0] ?? s[k][0], depth + 1);
    }
  }
  const type = Array.isArray(s.type) ? (s.type as string[]).find((t) => t !== 'null') : s.type;
  switch (type) {
    case 'object': {
      const props = (s.properties ?? {}) as Record<string, unknown>;
      const out: Json = {};
      for (const key of (s.required ?? []) as string[]) out[key] = sample(props[key], depth + 1);
      return out;
    }
    case 'array':
      return typeof s.minItems === 'number' && s.minItems > 0 ? Array.from({ length: s.minItems }, () => sample(s.items, depth + 1)) : [];
    case 'integer':
    case 'number':
      return typeof s.minimum === 'number' ? s.minimum : typeof s.exclusiveMinimum === 'number' ? s.exclusiveMinimum + 1 : 1;
    case 'boolean':
      return true;
    case 'string': {
      if (s.format === 'uuid') return ID;
      if (s.format === 'date-time') return '2026-01-01T00:00:00Z';
      if (s.format === 'date') return '2026-01-01';
      if (s.format === 'email') return 'a@example.com';
      if (s.format === 'uri' || s.format === 'url') return 'https://example.com/';
      if (typeof s.pattern === 'string') {
        const re = new RegExp(s.pattern as string, 'u');
        return PATTERN_TRIES.find((t) => re.test(t)) ?? 'x';
      }
      // A sample says it is a placeholder, so the secret scan never reads a sample `key` as a committed credential.
      const min = typeof s.minLength === 'number' ? s.minLength : 1;
      const max = typeof s.maxLength === 'number' ? s.maxLength : Infinity;
      return 'placeholder'.length <= max ? 'placeholder'.padEnd(min, 'x') : 'x'.repeat(Math.max(1, min));
    }
    default:
      return null;
  }
}

type Proc = { _def: { type: 'query' | 'mutation' | 'subscription'; inputs: unknown[] } };

function sampleInput(proc: Proc): unknown {
  const input = proc._def.inputs[0];
  if (input === undefined) return undefined;
  try {
    return sample(z.toJSONSchema(input as z.ZodType, { io: 'input', unrepresentable: 'any' }));
  } catch {
    return {};
  }
}

/**
 * The two inputs made from a call's own schema, recorded in the golden file so a changed schema cannot change its own
 * requests. Kept as the JSON text that is sent, byte for byte.
 */
type Samples = { readonly sample: string; readonly 'sample-nulls': string };

function nulls(valid: unknown): unknown {
  return valid !== null && typeof valid === 'object' && !Array.isArray(valid)
    ? Object.fromEntries(Object.keys(valid).map((k) => [k, null]))
    : null;
}

function samplesOf(valid: unknown): Samples {
  return { sample: JSON.stringify(valid ?? null), 'sample-nulls': JSON.stringify(nulls(valid)) };
}

/** Each call gets: nothing; null; a wrong type; an object missing every field; a sample; the sample with every field null. */
function inputs(samples: Samples): Array<[string, unknown]> {
  return [
    ['absent', undefined],
    ['null', null],
    ['wrong-type', 7],
    ['empty', {}],
    ['sample', JSON.parse(samples.sample)],
    ['sample-nulls', JSON.parse(samples['sample-nulls'])],
  ];
}

type Answer = { status: number; body: string };

interface Golden {
  readonly callers: unknown;
  /** The requests made from each call's schema when the recording was written: replayed as they are. */
  readonly inputs: Record<string, Samples>;
  /** Per call, per `<input> <caller>`: the answer. */
  readonly answers: Record<string, Record<string, Answer>>;
}

/** The shard a call is kept in: its namespace (`amm`); `depth` adds one more part when a shard would pass SHARD_BYTES. */
function shardOf(call: string, depth: number): string {
  return call.split('.').slice(0, depth).join('.');
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
  const inputs = calls.filter((c) => g.inputs[c]).map((c) => `    ${JSON.stringify(c)}: ${JSON.stringify(g.inputs[c])}`);
  return [
    '{',
    `  "inputs": {\n${inputs.join(',\n')}\n  },`,
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
  const files = new Map<string, string>();
  const place = async (calls: string[], depth: number) => {
    const groups = new Map<string, string[]>();
    for (const c of calls) groups.set(shardOf(c, depth), [...(groups.get(shardOf(c, depth)) ?? []), c]);
    for (const [name, group] of groups) {
      const text = await format(name, shardText(group, g));
      if (Buffer.byteLength(text) <= SHARD_BYTES) files.set(name, text);
      else if (depth < 4 && new Set(group.map((c) => shardOf(c, depth + 1))).size > 1) await place(group, depth + 1);
      else throw new Error(`shard ${name} is ${Buffer.byteLength(text)} bytes, over ${SHARD_BYTES}`);
    }
  };
  await place(Object.keys(g.answers), 1);
  rmSync(GOLDEN, { recursive: true, force: true });
  mkdirSync(GOLDEN);
  for (const [name, text] of files) writeFileSync(goldenJson(name), text);
  const index = JSON.stringify({ callers: g.callers, shards: [...files.keys()].sort() });
  writeFileSync(INDEX, await prettier.format(index, { ...(await prettier.resolveConfig(INDEX.pathname)), filepath: INDEX.pathname }));
}

function readGolden(): Golden {
  const index = JSON.parse(readFileSync(INDEX, 'utf8').replaceAll(RECORDED_STACK, '')) as { callers: unknown; shards: string[] };
  const g: Golden = { callers: index.callers, inputs: {}, answers: {} };
  // A shard the index does not name is a leftover, and fails like a missing one.
  expect(readdirSync(GOLDEN).sort()).toEqual(index.shards.map((s) => `${s}.json`).sort());
  for (const shardName of index.shards) {
    const shard = JSON.parse(readFileSync(goldenJson(shardName), 'utf8').replaceAll(RECORDED_STACK, '')) as {
      inputs: Record<string, Samples>;
      bodies: string[];
      answers: Record<string, Record<string, [number, number]>>;
    };
    Object.assign(g.inputs, shard.inputs);
    for (const [call, answers] of Object.entries(shard.answers))
      g.answers[call] = Object.fromEntries(Object.entries(answers).map(([k, [status, i]]) => [k, { status, body: shard.bodies[i]! }]));
  }
  return g;
}

async function send(
  app: Awaited<ReturnType<typeof serve>>,
  method: string,
  url: string,
  payload: string | undefined,
  h: Record<string, string>,
) {
  const res = await app.inject({
    method: method as 'GET',
    url,
    headers: payload === undefined ? h : { ...h, 'content-type': 'application/json' },
    ...(payload === undefined ? {} : { payload }),
  });
  // tRPC's dev stack trace carries file paths and line numbers, which move with any edit.
  return { status: res.statusCode, body: res.body.replace(/"stack":"(?:[^"\\]|\\.)*"/g, '"stack":"<stack>"') };
}

async function replay(recorded: Golden['inputs'] | null): Promise<Golden> {
  const r = createReplayProtocolRouter();
  const anyRouter: AnyRouter = r;
  const procedures: Record<string, Proc> = anyRouter._def.procedures;
  const answers: Golden['answers'] = {};
  const samples: Golden['inputs'] = {};
  const app = await serve();
  try {
    for (const path of Object.keys(procedures).sort()) {
      const proc = procedures[path]!;
      if (proc._def.type === 'subscription') continue;
      // A call missing from the recording gets samples from its schema; its answers then match no recorded key and fail.
      samples[path] = recorded?.[path] ?? samplesOf(sampleInput(proc));
      const query = proc._def.type === 'query';
      for (const [inputName, input] of inputs(samples[path]))
        for (const [callerName, caller] of CALLERS) {
          const url = `/trpc/${path}${query && input !== undefined ? `?input=${encodeURIComponent(JSON.stringify(input))}` : ''}`;
          const payload = query ? undefined : input === undefined ? '' : JSON.stringify(input);
          (answers[path] ??= {})[`${inputName} ${callerName}`] = await send(app, query ? 'GET' : 'POST', url, payload, headers(caller));
        }
    }
  } finally {
    await app.close();
  }
  return { callers: procedureCallers(r as never), inputs: samples, answers };
}

describe('the wire replay: svc-protocol answers every protocol call as recorded', () => {
  // Some answers carry the time (a quote's expiry, a challenge's deadline): one fixed time keeps them the same on every run.
  // Shared packages read APP_ENV and a few settings per request: they read the same blank source, whatever runs the test.
  let saved: NodeJS.ProcessEnv;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-19T00:00:00.000Z') });
    saved = process.env;
    process.env = { ...ENV_SOURCE, ...(saved.WIRE_REPLAY_WRITE ? { WIRE_REPLAY_WRITE: saved.WIRE_REPLAY_WRITE } : {}) };
  });
  afterEach(() => {
    process.env = saved;
    vi.useRealTimers();
  });

  it('every request in the matrix gets the recorded status and body, byte for byte', async () => {
    const write = process.env.WIRE_REPLAY_WRITE === '1';
    const now = await replay(write ? null : readGolden().inputs);
    if (write) await writeGolden(now);
    const golden = readGolden();
    expect(now.callers).toEqual(golden.callers);
    expect(now.inputs).toEqual(golden.inputs);
    const flat = (g: Golden) =>
      Object.fromEntries(Object.entries(g.answers).flatMap(([call, a]) => Object.entries(a).map(([k, v]) => [`${call} ${k}`, v])));
    const was = flat(golden);
    const is = flat(now);
    expect(Object.keys(is).sort()).toEqual(Object.keys(was).sort());
    const diffs = Object.entries(was)
      .filter(([key, a]) => is[key]?.status !== a.status || is[key]?.body !== a.body)
      .map(([key, a]) => `${key}: ${a.status} ${a.body.slice(0, 160)} != ${is[key]?.status} ${is[key]?.body.slice(0, 160)}`);
    expect(diffs).toEqual([]);
  }, 300_000);
});
