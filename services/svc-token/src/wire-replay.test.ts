import Fastify, { type FastifyRequest } from 'fastify';
import type { AnyProcedure, AnyRouter } from '@trpc/server';
import { fastifyTRPCPlugin } from '@trpc/server/adapters/fastify';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { Principal, Scope } from '@intafaced/auth';
import { encodePrincipal, procedureCallers, retainRawBody, serviceAuthHeadersForBody, signPrincipalHeader } from '@intafaced/contracts';
import { unwiredApprovalConsumer } from './action-approval-consume.js';
import { buildEdgeContext } from './edge-context.js';
import type { Env } from './env.js';
import { registerInternalBuyback } from './internal-buyback.js';
import { registerInternalEmissions } from './internal-emissions.js';
import { registerInternalStake } from './internal-stake.js';
import { registerInternalYield } from './internal-yield.js';
import { unwiredParticipants } from './launch/eligibility.js';
import { LaunchService } from './launch/launch-service.js';
import { tokenReadyHonesty } from './ready-honesty.js';
import { createTokenRouter } from './router.js';
import { TokenService } from './token-service.js';

/**
 * The wire replay for svc-token: every served call's current answers, recorded before anyone moves them.
 *
 * `wire-replay.golden/` holds what svc-token answered (main 2026-11-19, as it is, bugs included) to a matrix of
 * requests: every tRPC call `createTokenRouter` serves (launch calls included), and every route `index.ts` registers
 * itself (`/health`, `/ready`, and the four `/internal/*` doors), sent to a Fastify app built as `index.ts` builds it
 * (raw body kept once, the internal doors, then tRPC under `/trpc`). A later move of these calls must answer each one
 * byte for byte the same; a changed scope, refusal code, status, widened input or reshaped body shows as a difference.
 *
 * Two settings: blank (every owner value unset, every job off, as on a stack nobody configured) and set (emissions,
 * yield and buyback jobs on, governance quorum, threshold, vote rule, proposer rule, proposal limit, staking asset
 * and launch eligibility set). Callers: nobody, `token:read`, `token:read` with `token:stake`, a founder with
 * `admin:read`, `admin:write` and `admin:treasury` and a second factor, and svc-token and svc-edge each signed with the
 * shared secret. The `valid` tRPC input is made from each call's own input schema, so a call added or changed gets
 * its row without a hand-kept list.
 *
 * No database, event bus or ledger: each is a stub that refuses any call with its own name (`replay stub: sql`), under
 * the real `TokenService` and `LaunchService`; the approvals are the unwired consumer and the launch participants the
 * unwired source `index.ts` uses without `IDENTITY_URL`; the yield and buyback windows are stubs too. So the recording
 * pins the boundary (who may call, what input is accepted, how each refusal is shaped) and which dependency each
 * accepted call reaches first.
 *
 * Not in this recording: the emissions auto-tick timer and the boot checks in `index.ts` (schema present, bus up).
 *
 * `WIRE_REPLAY_WRITE=1` rewrites the golden files. Only for a change that is meant to change the wire, named in its PR.
 */

const GOLDEN = new URL('./wire-replay.golden/', import.meta.url);
/** One recorded file, by name (`doors`, `set-trpc`). */
const goldenJson = (name: string) => new URL(`./wire-replay.golden/${name}.json`, import.meta.url);
/** One golden file stays under the CI review's 400 KB diff part, so a change to it can be read. */
const FILE_CAP = 350_000;
const EDGE_SECRET = 'a-token-wire-replay-edge-secret-long-enough';
const SHARED = 'a-token-wire-replay-internal-secret-long-enough';
const USER = '11111111-1111-4111-8111-111111111111';
const ID = '33333333-3333-4333-8333-333333333333';
const NOW = '2026-11-19T00:00:00.000Z';

/** The process env the token code reads outside its options; each setting pins every one of them. */
const ENV_KEYS = ['TOKEN_ASSET_ID', 'TOKEN_VOTE_RULE', 'TOKEN_PROPOSER_RULE', 'TOKEN_PROPOSAL_LIMIT'] as const;

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

interface Settings {
  readonly env: Readonly<Record<(typeof ENV_KEYS)[number], string | undefined>>;
  readonly on: boolean;
}

const SETTINGS: ReadonlyArray<[string, Settings]> = [
  [
    'blank',
    {
      on: false,
      env: { TOKEN_ASSET_ID: undefined, TOKEN_VOTE_RULE: undefined, TOKEN_PROPOSER_RULE: undefined, TOKEN_PROPOSAL_LIMIT: undefined },
    },
  ],
  [
    'set',
    {
      on: true,
      env: { TOKEN_ASSET_ID: 'IFC', TOKEN_VOTE_RULE: 'power:1', TOKEN_PROPOSER_RULE: 'stake:100', TOKEN_PROPOSAL_LIMIT: '3:86400000' },
    },
  ],
];

interface Caller {
  readonly scopes: Scope[];
  readonly mfa: boolean;
}

/** The callers: a principal signed by the edge, or a service signing the exact body with the shared secret. */
const CALLERS: Array<[string, Caller | string | null]> = [
  ['anon', null],
  ['read', { scopes: ['token:read'], mfa: false }],
  ['stake', { scopes: ['token:read', 'token:stake'], mfa: false }],
  ['founder', { scopes: ['admin:read', 'admin:write', 'admin:treasury'], mfa: true }],
  ['svc-token', 'svc-token'],
  ['svc-edge', 'svc-edge'],
];

function headers(caller: Caller | string | null, payload: string): Record<string, string> {
  if (caller === null) return {};
  if (typeof caller === 'string') return serviceAuthHeadersForBody(caller, SHARED, payload);
  const raw = encodePrincipal({
    sub: USER,
    userId: USER,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes: caller.scopes,
    tier: 'full',
    mfa: caller.mfa,
    expiresAt: new Date('2099-01-01T00:00:00Z'),
  } as Principal);
  return {
    'x-intafaced-principal': raw,
    'x-intafaced-principal-sig': signPrincipalHeader(raw, EDGE_SECRET, 'DE'),
    'x-intafaced-region': 'DE',
  };
}

function build(s: Settings) {
  const token = new TokenService(stub('sql'), stub('ledger'), stub('bus'), {
    assetId: 'IFC',
    loadParamsFromDb: true,
    ...(s.on ? { governanceQuorumBps: 2_000, governanceThresholdBps: 5_000, voteRule: 'power:1' } : {}),
    emissionEpochMs: 86_400_000,
  });
  const router = createTokenRouter(token, {
    emissionsEnabled: s.on,
    ...(s.on ? { runYieldWindow: stub('runYieldWindow'), runBuybackWindow: stub('runBuybackWindow') } : {}),
    buybackJobSet: s.on,
    approvals: unwiredApprovalConsumer(),
    stepUp: null,
    launch: {
      service: new LaunchService(stub('sql')),
      participants: unwiredParticipants(),
      eligibilityEnv: () => (s.on ? { TOKEN_LAUNCH_MIN_KYC_TIER: 'basic', TOKEN_LAUNCH_RESTRICTED_REGIONS: 'none' } : {}),
    },
  });
  return { token, router };
}

type Route = { method: string; url: string };

/** One app as `index.ts` builds it: raw body kept once, health and ready, the four internal doors, then tRPC. */
async function serve(s: Settings, routes: Route[]) {
  // A fixed request id keeps an added call from shifting every later answer.
  const app = Fastify({ maxParamLength: 5_000, genReqId: () => 'replay-request' });
  app.addHook('onRoute', (route) => {
    for (const method of [route.method].flat()) if (method !== 'HEAD') routes.push({ method, url: route.url });
  });
  const { token, router } = build(s);
  retainRawBody(app);
  app.get('/health', async () => ({ ok: true, service: 'svc-token' }));
  app.get('/ready', async () =>
    tokenReadyHonesty({
      ledgerUrl: s.on ? 'http://svc-ledger.internal:4000' : undefined,
      emissionsEnabled: s.on,
      emissionsAutoTick: false,
      yieldJobEnabled: s.on,
      buybackJobEnabled: s.on,
    }),
  );
  const internal = { internalSecret: SHARED, installRawBody: false } as const;
  registerInternalStake(app, { ...internal, accessOf: (userId) => token.accessOf(userId), bodyBind: 'accept-both' });
  registerInternalEmissions(app, { ...internal, emissionsEnabled: s.on, mintNextEpoch: () => token.mintNextEpoch(), bodyBind: 'require' });
  registerInternalYield(app, { ...internal, yieldJobEnabled: s.on, runWindow: stub('runYieldWindow'), bodyBind: 'require' });
  registerInternalBuyback(app, { ...internal, buybackJobEnabled: s.on, runWindow: stub('runBuybackWindow'), bodyBind: 'require' });
  const edgeContext = buildEdgeContext({
    EDGE_PRINCIPAL_SECRET: EDGE_SECRET,
    INTERNAL_SERVICE_SECRET: SHARED,
    SERVICE_NAME: 'svc-token',
  } as Env);
  await app.register(fastifyTRPCPlugin, {
    prefix: '/trpc',
    trpcOptions: { router, createContext: ({ req }: { req: FastifyRequest }) => edgeContext(req) },
  });
  await app.ready();
  return { app, router };
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Schema = Record<string, unknown>;

/** The smallest input a JSON Schema accepts by its shape: required fields only, the first member of each choice. */
function sample(schema: Schema | undefined, defs: Record<string, Schema>, depth = 0): Json {
  if (!schema || depth > 12) return null;
  if (typeof schema.$ref === 'string') return sample(defs[schema.$ref.split('/').pop() ?? ''], defs, depth + 1);
  if ('const' in schema) return schema.const as Json;
  if (Array.isArray(schema.enum)) return schema.enum[0] as Json;
  if ('default' in schema) return schema.default as Json;
  for (const key of ['anyOf', 'oneOf'] as const) {
    const options = schema[key];
    if (Array.isArray(options)) {
      const first = (options as Schema[]).find((o) => o.type !== 'null') ?? (options as Schema[])[0];
      return sample(first, defs, depth + 1);
    }
  }
  if (Array.isArray(schema.allOf)) return sample((schema.allOf as Schema[])[0], defs, depth + 1);
  const type = Array.isArray(schema.type) ? (schema.type as string[]).find((t) => t !== 'null') : schema.type;
  switch (type) {
    case 'object': {
      const properties = (schema.properties ?? {}) as Record<string, Schema>;
      const required = (schema.required ?? []) as string[];
      return Object.fromEntries(required.map((k) => [k, sample(properties[k], defs, depth + 1)]));
    }
    case 'array': {
      const min = typeof schema.minItems === 'number' ? schema.minItems : 0;
      const items = Array.isArray(schema.prefixItems) ? (schema.prefixItems as Schema[]) : null;
      if (items) return items.map((item) => sample(item, defs, depth + 1));
      return Array.from({ length: min }, () => sample(schema.items as Schema, defs, depth + 1));
    }
    case 'string': {
      if (schema.format === 'uuid') return ID;
      if (schema.format === 'date-time') return NOW;
      if (schema.format === 'date') return '2026-11-19';
      if (typeof schema.pattern === 'string') {
        const re = new RegExp(schema.pattern, 'u');
        return ['1', '1.5', 'IFC', 'DE', ID, 'x'].find((t) => re.test(t)) ?? 'x';
      }
      const min = typeof schema.minLength === 'number' ? schema.minLength : 1;
      return 'x'.repeat(Math.max(1, min));
    }
    case 'integer':
    case 'number':
      return typeof schema.minimum === 'number'
        ? schema.minimum
        : typeof schema.exclusiveMinimum === 'number'
          ? schema.exclusiveMinimum + 1
          : 1;
    case 'boolean':
      return true;
    default:
      return null;
  }
}

/** The `valid` input of a procedure, made from its own input parsers; `undefined` when it takes none. */
function validInput(inputs: readonly unknown[]): Json | undefined {
  if (inputs.length === 0) return undefined;
  const merged = inputs.map((parser) => {
    try {
      const json = z.toJSONSchema(parser as z.ZodType, { io: 'input', unrepresentable: 'any' }) as Schema;
      return sample(json, (json.$defs ?? {}) as Record<string, Schema>);
    } catch {
      return null;
    }
  });
  if (merged.every((m) => m !== null && typeof m === 'object' && !Array.isArray(m))) return Object.assign({}, ...merged);
  return merged[0] ?? null;
}

const TRPC_INPUTS = (valid: Json | undefined): Array<[string, unknown]> => [
  ['valid', valid],
  ['absent', undefined],
  ['wrong-type', 7],
  ['empty', {}],
  ['extra-key', valid !== null && typeof valid === 'object' && !Array.isArray(valid) ? { ...valid, extra: 1 } : { extra: 1 }],
];

/** The bodies each internal POST door gets: its own fields and the refusals it names by hand. */
const REST_BODIES: Readonly<Record<string, Array<[string, string]>>> = {
  'POST /internal/emissions/mint-next': [
    ['absent', ''],
    ['empty', '{}'],
  ],
  'POST /internal/yield/run-window': [
    ['absent', ''],
    ['null', 'null'],
    ['wrong-type', '7'],
    ['empty', '{}'],
    ['valid', JSON.stringify({ windowId: 'w-2026-47' })],
    ['blank-id', JSON.stringify({ windowId: '  ' })],
    ['typed-sources', JSON.stringify({ windowId: 'w-2026-47', sources: [] })],
  ],
  'POST /internal/buyback/run-window': [
    ['absent', ''],
    ['null', 'null'],
    ['wrong-type', '7'],
    ['empty', '{}'],
    ['valid', JSON.stringify({ runId: 'r1', revenueWindow: { from: '2026-11-01T00:00:00Z', to: '2026-11-08T00:00:00Z' } })],
    ['reversed', JSON.stringify({ runId: 'r1', revenueWindow: { from: '2026-11-08T00:00:00Z', to: '2026-11-01T00:00:00Z' } })],
    ['typed-bought', JSON.stringify({ runId: 'r1', tokensBought: '1' })],
  ],
};

type Answer = { status: number; body: string };

function clean(body: string): string {
  // tRPC's dev stack trace carries file paths and line numbers, which move with any edit.
  return body.replace(/"stack":"(?:[^"\\]|\\.)*"/g, '"stack":"<stack>"');
}

interface Golden {
  readonly routes: readonly string[];
  readonly callers: ReadonlyArray<{ path: string }>;
  readonly inputs: Record<string, unknown>;
  /** `<settings> <door> <input> <caller>`: the answer. */
  readonly answers: Record<string, Answer>;
}

async function replay(): Promise<Golden> {
  const answers: Golden['answers'] = {};
  const inputs: Golden['inputs'] = {};
  let names: string[] = [];
  let callers: Golden['callers'] = [];
  for (const [settingsName, s] of SETTINGS) {
    for (const key of ENV_KEYS) vi.stubEnv(key, s.env[key]);
    const routes: Route[] = [];
    const { app, router } = await serve(s, routes);
    try {
      names = routes
        .map((r) => `${r.method} ${r.url}`)
        .filter((n) => !n.includes('/trpc'))
        .sort();
      for (const name of names) {
        const [method, path] = name.split(' ') as [string, string];
        const url = path.replace(/:[A-Za-z]+/g, USER);
        const sent: Array<[string, string | undefined]> =
          method === 'GET' ? [['absent', undefined]] : (REST_BODIES[name] ?? [['absent', '']]);
        for (const [bodyName, payload] of sent)
          for (const [callerName, caller] of CALLERS) {
            const h = headers(caller, payload ?? '');
            const res = await app.inject({
              method: method as 'GET',
              url,
              headers: payload === undefined ? h : { ...h, 'content-type': 'application/json' },
              ...(payload === undefined ? {} : { payload }),
            });
            answers[`${settingsName} ${name} ${bodyName} ${callerName}`] = { status: res.statusCode, body: clean(res.body) };
          }
      }
      const r: AnyRouter = router;
      const procedures: Record<string, AnyProcedure> = r._def.procedures;
      // Subscriptions are streams, not calls: none is served today, and the matrix would not record one.
      const calls = Object.entries(procedures)
        .filter(([, p]) => p._def.type !== 'subscription')
        .sort(([a], [b]) => a.localeCompare(b));
      for (const [path, proc] of calls) {
        const valid = validInput(proc._def.inputs);
        inputs[path] = valid ?? null;
        for (const [inputName, input] of TRPC_INPUTS(valid))
          for (const [callerName, caller] of CALLERS) {
            const query = proc._def.type === 'query';
            const url = `/trpc/${path}${query && input !== undefined ? `?input=${encodeURIComponent(JSON.stringify(input))}` : ''}`;
            const payload = query || input === undefined ? '' : JSON.stringify(input);
            const h = headers(caller, payload);
            const res = query
              ? await app.inject({ method: 'GET', url, headers: h })
              : await app.inject({ method: 'POST', url, headers: { ...h, 'content-type': 'application/json' }, payload });
            answers[`${settingsName} trpc ${path} ${inputName} ${callerName}`] = { status: res.statusCode, body: clean(res.body) };
          }
      }
      callers = procedureCallers(r) as Golden['callers'];
    } finally {
      await app.close();
      vi.unstubAllEnvs();
    }
  }
  return { routes: names, callers, inputs, answers };
}

/** The file an answer goes in: its settings and door kind (`set-trpc`, `blank-http`). */
function fileOf(key: string): string {
  const [settings, kind] = key.split(' ') as [string, string];
  return `${settings}-${kind === 'trpc' ? 'trpc' : 'http'}`;
}

/** One file: each distinct body once, then one line per answer, so a diff names the answer that moved. */
function fileText(keys: string[], g: Golden): string {
  const list: string[] = [];
  const index = new Map<string, number>();
  const rows = keys.map((key) => {
    const a = g.answers[key]!;
    if (!index.has(a.body)) index.set(a.body, list.push(a.body) - 1);
    return `    ${JSON.stringify(key)}: [${a.status}, ${index.get(a.body)}]`;
  });
  return [
    '{',
    `  "bodies": [\n${list.map((b) => `    ${JSON.stringify(b)}`).join(',\n')}\n  ],`,
    `  "answers": {\n${rows.join(',\n')}\n  }`,
    '}',
    '',
  ].join('\n');
}

async function writeGolden(g: Golden) {
  const prettier = await import('prettier');
  const format = async (name: string, text: string) => {
    const file = goldenJson(name).pathname;
    return prettier.format(text, { ...(await prettier.resolveConfig(file)), filepath: file });
  };
  const groups = new Map<string, string[]>();
  for (const key of Object.keys(g.answers)) groups.set(fileOf(key), [...(groups.get(fileOf(key)) ?? []), key]);
  const files = new Map<string, string>();
  for (const [name, keys] of groups) {
    const text = await format(name, fileText(keys, g));
    if (Buffer.byteLength(text) > FILE_CAP) throw new Error(`${name}: ${Buffer.byteLength(text)} bytes, over FILE_CAP`);
    files.set(name, text);
  }
  rmSync(GOLDEN, { recursive: true, force: true });
  mkdirSync(GOLDEN);
  writeFileSync(goldenJson('doors'), await format('doors', JSON.stringify({ routes: g.routes, callers: g.callers, inputs: g.inputs })));
  for (const [name, text] of files) writeFileSync(goldenJson(name), text);
}

function readGolden(): Golden {
  const doors = JSON.parse(readFileSync(new URL('./wire-replay.golden/doors.json', import.meta.url), 'utf8')) as Omit<Golden, 'answers'>;
  const answers: Golden['answers'] = {};
  for (const file of readdirSync(GOLDEN).filter((f) => f.endsWith('.json') && f !== 'doors.json')) {
    const part = JSON.parse(readFileSync(goldenJson(file.replace(/\.json$/, '')), 'utf8')) as {
      bodies: string[];
      answers: Record<string, [number, number]>;
    };
    for (const [key, [status, i]] of Object.entries(part.answers)) answers[key] = { status, body: part.bodies[i]! };
  }
  return { ...doors, answers };
}

describe('the wire replay: svc-token answers every served call as recorded', () => {
  it('every request in the matrix gets the recorded status and body, byte for byte', async () => {
    vi.setSystemTime(new Date(NOW));
    try {
      const now = await replay();
      if (process.env.WIRE_REPLAY_WRITE === '1') await writeGolden(now);
      const golden = readGolden();
      expect(Object.keys(golden.answers)).toHaveLength(ANSWERS);
      expect(now.routes).toEqual(golden.routes);
      expect(now.callers).toEqual(golden.callers);
      expect(now.inputs).toEqual(golden.inputs);
      expect(Object.keys(now.answers).sort()).toEqual(Object.keys(golden.answers).sort());
      const diffs = Object.entries(golden.answers)
        .filter(([key, was]) => now.answers[key]?.status !== was.status || now.answers[key]?.body !== was.body)
        .map(
          ([key, was]) =>
            `${key}: ${was.status} ${was.body.slice(0, 160)} != ${now.answers[key]?.status} ${now.answers[key]?.body.slice(0, 160)}`,
        );
      expect(diffs).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  }, 300_000);
});

/** How many answers the recording holds: a matrix that shrinks fails here before it can pass on less. */
const ANSWERS = 3_528;
