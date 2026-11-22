import Fastify from 'fastify';
import type { AnyRouter } from '@trpc/server';
import { fastifyTRPCPlugin } from '@trpc/server/adapters/fastify';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SCOPES, type Principal, type Scope } from '@intafaced/auth';
import { z } from 'zod';
import {
  createEdgeContext,
  encodePrincipal,
  procedureCallers,
  retainRawBody,
  serviceAuthHeadersForBody,
  signPrincipalHeader,
  verifyServiceRequest,
} from '@intafaced/contracts';
import { createBankServices, unconfiguredRecipientState } from './bank-service.js';
import { createBankRouter } from './router.js';
import { createStepUpGate } from './step-up/step-up-gate.js';
import { unwiredApprovalConsumer } from './action-approval-consume.js';
import { unconfiguredExtraControls } from './safety/extra-controls.js';
import { unconfiguredBusinessDirectory } from './business/business-directory.js';
import { unconfiguredSecurityLock } from './security-lock.js';
import { unconfiguredApprovalMail } from './ramps/address-approval.js';
import { unconfiguredTrustedDevices } from './ramps/trusted-devices.js';
import { unconfiguredIdentityRecovery } from './recovery/identity-recovery.js';
import { cardIssuerFor } from './cards/issuer.js';
import { rampProgrammeFor } from './ramps/rails.js';
import { destinationSanctions } from './ramps/sanctions-list.js';
import { registerClosureCheck } from './closure/closure-check.js';
import { registerAgentsTeamMembership } from './agents/team-membership.js';
import { registerAgentsUsagePayment } from './agents/usage-payment.js';

/**
 * The wire replay for svc-bank: every bank call's current answer, recorded before anyone moves its callers.
 *
 * `wire-replay.golden/` holds what svc-bank's tRPC surface answered (main 2026-11-19, as it is, bugs included) to a
 * matrix of requests: every procedure of the router `index.ts` mounts, six inputs, four people and four signed services,
 * sent through the production Fastify adapter with `index.ts`'s context. A later move of these calls must answer each one
 * byte for byte the same; a wrong scope, a changed refusal code, a widened input or a reshaped envelope shows here as a
 * difference. The REST doors `index.ts` mounts through an exported register function are recorded the same way.
 *
 * No database, ledger, bus or partner: every dependency `index.ts` builds before it composes the services is a recording
 * stub that refuses any call with its own name (`replay stub: <name>`), every identity port is its unconfigured refusal
 * (no IDENTITY_URL), and the services are svc-bank's own classes over those. Owner settings are blank, as on a stack
 * nobody configured; the job switches take their env defaults. So the recording pins the boundary (who may call, what
 * input is accepted, how each refusal is shaped) and which dependency each accepted call reaches first.
 *
 * `WIRE_REPLAY_WRITE=1` rewrites the golden files. Only for a change that is meant to change the wire, named in its PR.
 */

const GOLDEN = new URL('./wire-replay.golden/', import.meta.url);
/** One recorded JSON file in the recording folder. */
const goldenJson = (name: string) => new URL(`./wire-replay.golden/${name}.json`, import.meta.url);
/** One review part holds 400 KB and a new file is one hunk, so each recorded file stays under this. */
const SHARD_BYTES = 350_000;
const SECRET = 'a-bank-wire-replay-edge-secret-long-enough';
const INTERNAL = 'a-bank-wire-replay-internal-secret-long-enough';
const USER = '11111111-1111-4111-8111-111111111111';
const ID = '22222222-2222-4222-8222-222222222222';

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

/** The services as `index.ts` composes them, over stubs and blank owner settings. */
function replayBank() {
  const sql = stub('sql');
  return createBankServices(sql, stub('ledger'), stub('history'), {
    testPartner: null,
    bankApi: { allowLocalHttp: false },
    postingFreeze: stub('postingFreeze'),
    identityRecovery: unconfiguredIdentityRecovery(),
    receiptSecret: INTERNAL,
    deposits: { custody: stub('payCustodyDeposits'), addressCap: () => undefined, addressExpiryDays: () => undefined },
    assetRegistry: stub('assetRegistry'),
    recipients: unconfiguredRecipientState(),
    requestNotices: stub('requestNotices'),
    transferNotices: stub('transferNotices'),
    scheduledNotices: stub('scheduledNotices'),
    directory: unconfiguredBusinessDirectory(),
    activity: { pages: stub('historyPages'), cursorSecret: INTERNAL, payWithdrawals: stub('payWithdrawals') },
    statementJobs: { leaseMs: null, testRenderHoldMs: null },
    loans: { priceSource: stub('tradePrices'), marginCalls: stub('marginCalls'), moduleEnabled: true },
    cardProgramme: { sanctions: () => undefined, simulatorAllowed: false },
    cards: {
      issuer: cardIssuerFor('none', { APP_ENV: 'test' }),
      cashbackEarned: stub('cashbackEarned'),
      rates: stub('cardRates'),
      moduleEnabled: true,
    },
    portfolio: { tickers: stub('tickers'), pages: stub('portfolioPages'), history: stub('holdingsHistory'), closes: stub('closes') },
    autoInvest: { enabled: true },
    ramps: {
      programme: rampProgrammeFor('none'),
      sanctions: destinationSanctions(() => undefined),
      securityLock: unconfiguredSecurityLock(),
      approvalMail: unconfiguredApprovalMail(),
      trustedDevices: unconfiguredTrustedDevices(),
    },
  } as never);
}

export function createReplayBankRouter() {
  const approvals = unwiredApprovalConsumer();
  return createBankRouter(replayBank(), {
    extraControls: unconfiguredExtraControls(),
    scheduledTransfersEnabled: true,
    interestAccrualEnabled: true,
    loanAccrualEnabled: true,
    loanRiskSweepEnabled: false,
    autoInvestEnabled: true,
    autoInvestConvertWired: false,
    approvals,
    stepUp: createStepUpGate({ mode: 'off', approvals, store: stub('stepUpUses') }),
    statementStepUp: createStepUpGate({ mode: 'required', approvals, store: stub('stepUpUses') }),
    ownMoveStepUp: createStepUpGate({ mode: 'required', approvals, store: stub('stepUpUses') }),
  });
}

/** The context exactly as `index.ts` builds it: the edge's signed principal, and the signing service if any. */
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-bank', internalSecret: INTERNAL });

/** Every REST door `index.ts` mounts through an exported register function, in its order, with its options. */
function registerRest(app: ReturnType<typeof Fastify>) {
  const sql = stub('sql');
  registerClosureCheck(app, { sql, ledger: stub('ledger'), secret: INTERNAL });
  registerAgentsTeamMembership(app, { secret: INTERNAL, read: stub('teamMembershipFor') });
  registerAgentsUsagePayment(app, {
    secret: INTERNAL,
    freeze: stub('postingFreeze'),
    businessPayer: stub('firstAdministrator'),
    heldBy: stub('usagePaymentHeldBy'),
  });
}

/** One app as `index.ts` builds it: the raw-body parser, the REST doors, then the tRPC mount. */
async function serve(routes: Array<{ method: string; url: string; body: unknown }>) {
  // One fixed request id keeps an added call from shifting every later answer.
  const app = Fastify({ maxParamLength: 5_000, genReqId: () => 'replay-request' });
  app.addHook('onRoute', (route) => {
    for (const method of [route.method].flat()) {
      if (method === 'HEAD' || route.url.startsWith('/trpc')) continue;
      routes.push({ method, url: route.url, body: (route.schema as { body?: unknown } | undefined)?.body });
    }
  });
  retainRawBody(app);
  registerRest(app);
  await app.register(fastifyTRPCPlugin, {
    prefix: '/trpc',
    trpcOptions: {
      router: createReplayBankRouter(),
      createContext: ({ req }: { req: unknown }) => {
        const ctx = edgeContext(req as never);
        const { service } = verifyServiceRequest(req as never, { legacySecret: INTERNAL, bodyBindMode: 'accept-both' });
        return { ...ctx, service };
      },
    },
  });
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

/**
 * Nobody; a signed-in person holding no scope; a verified customer holding the bank's own scopes (staff are refused the
 * customer's doors); a fully verified holder of every scope, in a served and an unserved region.
 */
const CALLERS: ReadonlyArray<[string, Caller]> = [
  ['anon', { scopes: null, tier: 'none', mfa: false, region: 'DE' }],
  ['no-scope', { scopes: [], tier: 'basic', mfa: false, region: 'DE' }],
  ['customer', { scopes: ['bank:read', 'bank:write'], tier: 'full', mfa: true, region: 'DE' }],
  ['all', { scopes: [...SCOPES], tier: 'full', mfa: true, region: 'DE' }],
  ['all-US', { scopes: [...SCOPES], tier: 'full', mfa: true, region: 'US' }],
];

/** The signed services svc-bank's doors name (its own job twins and every service a door admits), each with a body-bound signature. */
const SERVICES = ['svc-bank', 'svc-ops', 'svc-identity', 'svc-agents', 'svc-pay', 'svc-support', 'svc-tax'] as const;

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
  // tRPC's dev stack trace carries file paths and line numbers, which move with any edit; an unexpected failure's
  // reference is a fresh random id each time (`Bank operation failed (ref <uuid>)`).
  return {
    status: res.statusCode,
    body: res.body
      .replace(/"stack":"(?:[^"\\]|\\.)*"/g, '"stack":"<stack>"')
      .replace(/\(ref [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\)/g, '(ref <ref>)'),
  };
}

async function replay(recorded: Golden['inputs'] | null): Promise<Golden> {
  const r = createReplayBankRouter();
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
            query ? undefined : input === undefined ? '' : JSON.stringify(input),
            headers(caller),
          );
        }
      // The ops job twins answer only a signed svc-bank; every call is also sent signed by each service, with no person.
      for (const [inputName, input] of inputs(samples[path]))
        for (const service of SERVICES) {
          const query = proc._def.type === 'query';
          const url = `/trpc/${path}${query && input !== undefined ? `?input=${encodeURIComponent(JSON.stringify(input))}` : ''}`;
          const payload = query ? undefined : input === undefined ? '' : JSON.stringify(input);
          (answers[path] ??= {})[`${inputName} ${service}`] = await send(
            app,
            query ? 'GET' : 'POST',
            url,
            payload,
            serviceAuthHeadersForBody(service, INTERNAL, payload ?? ''),
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

describe('the wire replay: svc-bank answers every bank call as recorded', () => {
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
