import Fastify from 'fastify';
import type { AnyRouter } from '@trpc/server';
import { fastifyTRPCPlugin } from '@trpc/server/adapters/fastify';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SCOPES, type Principal, type Scope } from '@intafaced/auth';
import { z } from 'zod';
import { createEdgeContext, encodePrincipal, procedureCallers, serviceAuthHeadersForBody, signPrincipalHeader } from '@intafaced/contracts';
import { createVenueMarketDataAdapter } from '@intafaced/venue-adapter';
import { installOmsWriteRawBody } from './oms-write-hmac.js';
import { loadMatchingVenueHalt } from './oms-matching-venue-halt.js';
import { createExecutionRouter } from './router.js';
import { registerStartBasketDoor } from './oms-basket-http.js';
import { registerKillParentDoor } from './oms-kill-parent-http.js';
import { registerOmsDisplayQtyDoor } from './oms-iceberg-http.js';
import { registerOmsPegDoor } from './oms-peg-http.js';
import { registerOmsOcoDoor } from './oms-oco-http.js';
import { registerOmsBuyingPowerDoor } from './oms-buying-power-http.js';
import { registerOmsMmpDoor } from './oms-mmp-http.js';
import { registerOmsCareDoor } from './oms-care-http.js';
import { registerOmsKillDoor } from './oms-kill-http.js';
import { registerOmsTcaDoor } from './oms-tca-http.js';
import { registerOmsPaperDoor } from './oms-paper-http.js';
import { registerOmsMultivenueDoor } from './oms-multivenue-http.js';
import { buildExecutionVenueAccountMapsWithOperatorSupplement } from './venue-account-adapters.js';
import { buildExecutionVenueTradeMapsWithOperatorSupplement, parseExecutionVenueIds } from './venue-adapters.js';
import { buildExecutionVenueMarketMapsWithPublicMdSupplement } from './venue-market-adapters.js';
import { buildTradeBookSnapshotMap } from './trade-book-snapshot.js';
import { createCaptureLakeRuntime } from './capture-lake-runtime.js';

/**
 * The wire replay for svc-execution: every execution call's current answers, recorded before anyone moves them.
 *
 * `wire-replay.golden/` holds what svc-execution answered (main 2026-11-19, as it is, bugs included) to a matrix of
 * requests: every procedure of the router `index.ts` mounts and every door it registers, six inputs, four people and
 * two signed services, sent through the production Fastify adapter with `index.ts`'s context. A later move of these
 * calls must answer each one byte for byte the same; a wrong scope, a changed refusal code, a widened input or a
 * reshaped envelope shows here as a difference.
 *
 * No venue, matching engine or journal: every store and client `index.ts` builds before it composes the router is a
 * recording stub that refuses any call with its own name (`replay stub: <name>`). The venue maps are built by
 * `index.ts`'s own builders from a blank environment, so they hold the venues a blank stack holds, each adapter a stub
 * (`replay stub: venueMarket.<id>.<method>`). So the recording pins the boundary (who may call, what input is
 * accepted, how each refusal is shaped) and which dependency each accepted call reaches first. Every owner value is
 * the blank one.
 *
 * `WIRE_REPLAY_WRITE=1` rewrites the recording. Only for a change that is meant to change the wire, named in its PR.
 */

const GOLDEN = new URL('./wire-replay.golden/', import.meta.url);
/** One recorded JSON file in the recording folder. */
const goldenJson = (name: string) => new URL(`./wire-replay.golden/${name}.json`, import.meta.url);
/** One review part holds 400 KB and a new file is one hunk, so each recorded file stays under this. */
const SHARD_BYTES = 350_000;
const SECRET = 'an-execution-wire-replay-edge-secret-long-enough';
const INTERNAL = 'an-execution-wire-replay-internal-secret-long-enough';
const USER = '11111111-1111-4111-8111-111111111111';
const ID = '22222222-2222-4222-8222-222222222222';
/** Blank owner settings: nothing set, as on a stack nobody configured. */
const ENV: NodeJS.ProcessEnv = { APP_ENV: 'test' };

/** The one setting svc-execution reads from the process at call time: blank here, whatever the machine running the test holds. */
const PROCESS_SETTINGS = ['INTERNAL_SERVICE_SECRET'] as const;

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

/** The venue maps `index.ts` builds from a blank environment: the venues it wires, each adapter a stub. */
function venueMaps() {
  const ids = parseExecutionVenueIds(ENV.EXECUTION_VENUE_IDS ?? '');
  // No venue ids and no operator credentials: the trade and account maps hold what a blank stack holds.
  const trade = buildExecutionVenueTradeMapsWithOperatorSupplement(ids, { env: ENV });
  const account = buildExecutionVenueAccountMapsWithOperatorSupplement(ids, { env: ENV });
  const market = buildExecutionVenueMarketMapsWithPublicMdSupplement(ids, {
    createAdapter: ((id: string) => (createVenueMarketDataAdapter(id) === null ? null : stub(`venueMarket.${id}`))) as never,
  });
  return { trade, account, market };
}

const maps = venueMaps();
const captureLakeRuntime = createCaptureLakeRuntime(ENV);
const snapshotByVenue = captureLakeRuntime.wrapSnapshotMap({ ...maps.market.snapshotByVenue, ...buildTradeBookSnapshotMap(ENV.TRADE_URL) });
const emsStore = stub('emsStore');
const parentStore = stub('parentStore');
const pauseStore = stub('pauseStore');
const algoJobs = { enabled: false };
const matchingVenueHalt = () => loadMatchingVenueHalt({ matchingUrl: ENV.MATCHING_URL });

export function createReplayExecutionRouter() {
  return createExecutionRouter(
    stub('registry'),
    maps.trade.submitByVenue,
    maps.trade.cancelByVenue,
    maps.trade.fetchByVenue,
    maps.trade.openOrdersByVenue,
    maps.account.balancesByVenue,
    maps.account.positionsByVenue,
    maps.account.railsByVenue,
    maps.market.fundingByVenue,
    maps.market.borrowByVenue,
    maps.market.latencyByVenue,
    maps.market.marketsByVenue,
    snapshotByVenue,
    emsStore,
    captureLakeRuntime.lake,
    pauseStore,
    parentStore,
    algoJobs,
    undefined, // paper default off, as `index.ts` passes it
    stub('fillConfirmStore'),
    stub('manualFillStore'),
    stub('fillAssignStore'),
    matchingVenueHalt,
    ENV.MATCHING_URL,
    undefined,
    undefined, // no IDENTITY_URL: no approval client
    undefined, // no S2S_AUTH_MODE
  );
}

/** The context exactly as `index.ts` builds it with an internal secret set and no per-service keys. */
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-execution', internalSecret: INTERNAL });

/** Every door `index.ts` registers, in its order, with its options. */
function registerDoors(app: ReturnType<typeof Fastify>) {
  const door = { edgeContext, internalSecret: INTERNAL, s2s: undefined } as const;
  registerStartBasketDoor(app, { ...door, jobs: algoJobs, matchingVenueHalt, matchingUrl: ENV.MATCHING_URL, matchingS2s: undefined });
  registerOmsDisplayQtyDoor(app, door);
  registerOmsPegDoor(app, door);
  registerOmsOcoDoor(app, door);
  registerOmsBuyingPowerDoor(app, door);
  registerOmsMmpDoor(app, door);
  registerOmsCareDoor(app, door);
  registerOmsKillDoor(app, { ...door, emsStore, matchingVenueHalt });
  registerKillParentDoor(app, {
    ...door,
    parentStore,
    pauseStore,
    emsStore,
    cancelByVenue: maps.trade.cancelByVenue,
    matchingUrl: ENV.MATCHING_URL,
    matchingS2s: undefined,
  });
  registerOmsTcaDoor(app, { ...door, emsStore, captureLake: captureLakeRuntime.lake });
  registerOmsPaperDoor(app, door);
  registerOmsMultivenueDoor(app, { ...door, wiredVenueIds: maps.trade.wiredVenueIds });
}

/** One app as `index.ts` builds it: the raw-body parser, the tRPC mount, then the doors. */
async function serve(routes: Array<{ method: string; url: string; body: unknown }>) {
  // Fastify counts request ids; one fixed id keeps an added call from shifting every later answer.
  const app = Fastify({ maxParamLength: 5_000, genReqId: () => 'replay-request' });
  app.addHook('onRoute', (route) => {
    for (const method of [route.method].flat()) {
      if (method === 'HEAD' || route.url.startsWith('/trpc')) continue;
      routes.push({ method, url: route.url, body: (route.schema as { body?: unknown } | undefined)?.body });
    }
  });
  installOmsWriteRawBody(app);
  await app.register(fastifyTRPCPlugin, {
    prefix: '/trpc',
    trpcOptions: {
      router: createReplayExecutionRouter(),
      createContext: ({ req }: { req: unknown }) => edgeContext(req as never),
    },
  });
  registerDoors(app);
  await app.ready();
  return app;
}

function headers(caller: Caller): Record<string, string> {
  if (caller.scopes === null) return {};
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

interface Caller {
  readonly scopes: readonly Scope[] | null;
  readonly tier: 'none' | 'basic' | 'full';
  readonly mfa: boolean;
  readonly region: string;
}

/** Nobody; a signed-in person holding no scope; a fully verified holder of every scope, in a served and an unserved region. */
const CALLERS: ReadonlyArray<[string, Caller]> = [
  ['anon', { scopes: null, tier: 'none', mfa: false, region: 'DE' }],
  ['no-scope', { scopes: [], tier: 'basic', mfa: false, region: 'DE' }],
  ['all', { scopes: [...SCOPES], tier: 'full', mfa: true, region: 'DE' }],
  ['all-US', { scopes: [...SCOPES], tier: 'full', mfa: true, region: 'US' }],
];

/** Signed service calls, body-bound: svc-execution is the one caller its writes take, svc-trade one they refuse. */
const SERVICES = ['svc-execution', 'svc-trade'] as const;

type Json = { [k: string]: unknown };

/** Strings tried against a schema's pattern, in order: the first that matches is the sample. */
const PATTERN_TRIES = [
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
  '0x' + 'a'.repeat(40),
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

/**
 * The shard a call is kept in: its namespace (`merchantOps`), or for REST its first two fixed path parts
 * (`rest-v1-payments`); `depth` adds one more part when a shard would pass SHARD_BYTES.
 */
function shardOf(call: string, depth: number): string {
  const rest = /^[A-Z]+ (\/.*)$/.exec(call);
  if (rest)
    return [
      'rest',
      ...rest[1]!
        .split('/')
        .filter((x) => x && !x.startsWith(':'))
        .slice(0, depth + 1),
    ].join('-');
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
  // Each call's inputs open on a line of their own: the secret scan reads `"execution.oms.pass": <value>` as a password.
  const inputs = calls
    .filter((c) => g.inputs[c])
    .map(
      (c) =>
        `    ${JSON.stringify(c)}: {\n${Object.entries(g.inputs[c]!)
          .map(([k, v]) => `      ${JSON.stringify(k)}: ${JSON.stringify(v)}`)
          .join(',\n')}\n    }`,
    );
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
  writeFileSync(goldenJson('callers'), await format('callers', JSON.stringify(g.callers)));
  for (const [name, text] of files) writeFileSync(goldenJson(name), text);
}

function readGolden(): Golden {
  const g: Golden = {
    callers: JSON.parse(readFileSync(new URL('./wire-replay.golden/callers.json', import.meta.url), 'utf8')),
    inputs: {},
    answers: {},
  };
  for (const file of readdirSync(GOLDEN).filter((f) => f !== 'callers.json')) {
    const shard = JSON.parse(readFileSync(goldenJson(file.replace(/\.json$/, '')), 'utf8')) as {
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
  const r = createReplayExecutionRouter();
  const anyRouter: AnyRouter = r;
  const procedures: Record<string, Proc> = anyRouter._def.procedures;
  const answers: Golden['answers'] = {};
  const samples: Golden['inputs'] = {};
  const routes: Array<{ method: string; url: string; body: unknown }> = [];
  const app = await serve(routes);
  try {
    for (const path of Object.keys(procedures).sort()) {
      const proc = procedures[path]!;
      if (proc._def.type === 'subscription') continue;
      // A call missing from the recording gets samples from its schema; its answers then match no recorded key and fail.
      samples[path] = recorded?.[path] ?? samplesOf(sampleInput(proc));
      for (const [inputName, input] of inputs(samples[path]))
        for (const [callerName, caller] of CALLERS) {
          const query = proc._def.type === 'query';
          const url = `/trpc/${path}${query && input !== undefined ? `?input=${encodeURIComponent(JSON.stringify(input))}` : ''}`;
          (answers[path] ??= {})[`${inputName} ${callerName}`] = await send(
            app,
            query ? 'GET' : 'POST',
            url,
            payload(query, input),
            headers(caller),
          );
        }
      // OMS writes are service calls: each signed service sends the same six inputs.
      for (const [inputName, input] of inputs(samples[path]))
        for (const service of SERVICES) {
          const query = proc._def.type === 'query';
          const url = `/trpc/${path}${query && input !== undefined ? `?input=${encodeURIComponent(JSON.stringify(input))}` : ''}`;
          const body = payload(query, input);
          (answers[path] ??= {})[`${inputName} ${service}`] = await send(
            app,
            query ? 'GET' : 'POST',
            url,
            body,
            serviceAuthHeadersForBody(service, INTERNAL, body ?? ''),
          );
        }
    }
    // REST: every route, path parameters filled with one id; a body-taking route gets the same six bodies.
    for (const route of [...routes].sort((a, b) => `${a.url} ${a.method}`.localeCompare(`${b.url} ${b.method}`))) {
      const name = `${route.method} ${route.url}`;
      const url = route.url.replace(/:[A-Za-z]+/g, ID);
      const takesBody = route.method !== 'GET' && route.method !== 'DELETE';
      if (takesBody) {
        const valid = route.body === undefined ? {} : sample(route.body);
        samples[name] = recorded?.[name] ?? samplesOf(valid);
      }
      const bodies: Array<[string, unknown]> = takesBody ? inputs(samples[name]!) : [['absent', undefined]];
      for (const [inputName, input] of bodies) {
        const payload = takesBody ? (input === undefined ? '' : JSON.stringify(input)) : undefined;
        for (const [callerName, caller] of CALLERS)
          (answers[name] ??= {})[`${inputName} ${callerName}`] = await send(app, route.method, url, payload, headers(caller));
        for (const service of SERVICES)
          (answers[name] ??= {})[`${inputName} ${service}`] = await send(
            app,
            route.method,
            url,
            payload,
            serviceAuthHeadersForBody(service, INTERNAL, payload ?? ''),
          );
      }
    }
  } finally {
    await app.close();
  }
  return { callers: procedureCallers(r as never), inputs: samples, answers };
}

/** What a tRPC call sends as its body: nothing for a query, the input's JSON for a mutation. */
function payload(query: boolean, input: unknown): string | undefined {
  return query ? undefined : input === undefined ? '' : JSON.stringify(input);
}

describe('the wire replay: svc-execution answers every execution call as recorded', () => {
  beforeAll(() => {
    for (const name of PROCESS_SETTINGS) vi.stubEnv(name, undefined);
  });
  afterAll(() => {
    vi.unstubAllEnvs();
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
