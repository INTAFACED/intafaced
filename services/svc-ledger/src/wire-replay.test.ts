import Fastify from 'fastify';
import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { issueAccessToken } from '@intafaced/auth';
import {
  createServiceSigner,
  createServiceVerifier,
  serviceAuthHeadersForBody,
  type Keyring,
  type ServiceAuthMode,
  type ServiceName,
} from '@intafaced/contracts';
import {
  defineReconciliationControlInputSchema,
  listReconciliationControlRunsInputSchema,
  runReconciliationControlInputSchema,
  updateReconciliationControlInputSchema,
} from '@intafaced/contracts/ledger-reconciliation';
import { accountRefSchema, postRequestSchema } from '@intafaced/ledger-client';
import { LEDGER_DOOR_CALLERS } from './door-callers.js';
import { unwiredApprovalConsumer } from './ledger/action-approval-consume.js';
import { custodyInputSchema } from './ledger/custody-adapters.js';
import { financeCloseInputSchema } from './ledger/finance-close.js';
import { historyInputSchema } from './ledger/history.js';
import { accountMetadataDeleteInputSchema, accountMetadataSetInputSchema } from './ledger/operator-account-metadata.js';
import { reportExportInputSchema } from './ledger/report-export.js';
import { resilienceInputSchema } from './ledger/resilience-gate.js';
import { statementPnlReproduceInputSchema } from './ledger/statement-pnl-reproduce.js';
import { registerOperatorHttp } from './operator-http.js';
import { registerS2sHttp } from './s2s-http.js';
import { LedgerService } from './service.js';
import { registerLedgerStatusHttp } from './status-http.js';

/**
 * The wire replay for svc-ledger: every served call's current answers, recorded before anyone moves them.
 *
 * `wire-replay.golden/` holds what svc-ledger's served doors answered (main 2026-11-19, as it is, bugs included)
 * to a matrix of requests: every route `index.ts` registers through `registerLedgerStatusHttp`, `registerS2sHttp` and
 * `registerOperatorHttp`, six bodies, every caller kind, under three settings, sent to a Fastify app built as
 * `index.ts` builds it. A later move of these calls must answer each one byte for byte the same; a changed caller
 * list, refusal code, status, widened input or reshaped body shows here as a difference.
 *
 * Callers: on the service doors, nobody, every service the doors name plus one they never name (svc-edge), each signed
 * with the shared secret, and in the key-signed settings each signed with its own key. On the operator doors, nobody,
 * a token that does not verify, and access tokens with no scope, a founder's `admin:read` with a second factor,
 * `admin:compliance`, and `admin:treasury` without and with a second factor.
 *
 * No database or event bus: each is a stub that refuses any call with its own name (`replay stub: sql`), under the
 * real `LedgerService`; the action approvals are the unwired consumer `index.ts` uses without `IDENTITY_URL`, and the
 * reconciliation sources are unset. So the recording pins the boundary (who may call, what input is accepted, how each
 * refusal is shaped) and which dependency each accepted call reaches first.
 *
 * Not in this recording: `/metrics` (its body counts this run's own requests and their timings), the reconcile and
 * outbox timers, and the boot policy in `index.ts`. The tRPC `appRouter` `index.ts` builds is exported for its type
 * and served on no port, so it answers nothing on the wire.
 *
 * `WIRE_REPLAY_WRITE=1` rewrites the golden file. Only for a change that is meant to change the wire, named in its PR.
 */

const GOLDEN = new URL('./wire-replay.golden/', import.meta.url);
const SHARED = 'a-ledger-wire-replay-internal-secret-long-enough';
const ID = '22222222-2222-4222-8222-222222222222';
const OPERATOR = '11111111-1111-4111-8111-111111111111';
const TOKENS = {
  secret: 'a-ledger-wire-replay-operator-secret-long-enough',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
};

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

/** Every service a door names, sorted, then one no door names. */
const NAMED = [...new Set(Object.values(LEDGER_DOOR_CALLERS).flat() as ServiceName[])].sort();
const SERVICES: readonly ServiceName[] = [...NAMED, 'svc-edge'];

function pair() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKey: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url'),
    x: publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url'),
  };
}

/** Generated keys for every caller; the ledger verifies from the public keyring alone. */
function keys() {
  const made = SERVICES.map((svc) => ({ svc, ...pair() }));
  const keyring: Keyring = made.map((k) => ({ kid: `${k.svc}.a`, svc: k.svc, use: 's2s' as const, x: k.x }));
  const signer = (svc: ServiceName) =>
    createServiceSigner({ service: svc, kid: `${svc}.a`, privateKey: made.find((k) => k.svc === svc)!.privateKey, keyring });
  return { signer, verifier: () => createServiceVerifier({ self: 'svc-ledger', keyring, bootSecond: 0 }) };
}

interface Settings {
  /** Unset: the shared secret alone, as with `S2S_AUTH_MODE` unset. */
  readonly s2s: ServiceAuthMode | null;
  readonly ledger: ConstructorParameters<typeof LedgerService>[2];
}

/** Blank: nothing set, as on a stack nobody configured. Set: the owner values and the custody layer on, under dual and keypair keys. */
const SETTINGS: ReadonlyArray<[string, Settings]> = [
  ['blank', { s2s: null, ledger: {} }],
  ['set-dual', { s2s: 'dual', ledger: { postingEnabled: true, custodyLayer: 'on', clockSkewBoundMs: 5_000 } }],
  ['set-keypair', { s2s: 'keypair', ledger: { postingEnabled: true, custodyLayer: 'on', clockSkewBoundMs: 5_000 } }],
];

type Route = { method: string; url: string };

/** One app as `index.ts` builds it (without `/metrics`): status, the service doors with body binding required, the operator doors. */
async function serve(settings: Settings, k: ReturnType<typeof keys>, routes: Route[]) {
  // A fixed request id keeps an added call from shifting every later answer.
  const app = Fastify({ maxParamLength: 5_000, genReqId: () => 'replay-request' });
  app.addHook('onRoute', (route) => {
    for (const method of [route.method].flat()) if (method !== 'HEAD') routes.push({ method, url: route.url });
  });
  const ledger = new LedgerService(stub('sql'), stub('bus'), settings.ledger);
  registerLedgerStatusHttp(app, ledger, 'svc-ledger');
  registerS2sHttp(app, ledger, SHARED, {
    bodyBind: 'require',
    ...(settings.s2s ? { s2s: { verifier: k.verifier(), mode: settings.s2s } } : {}),
  });
  registerOperatorHttp(app, ledger, TOKENS, unwiredApprovalConsumer());
  await app.ready();
  return app;
}

/** The inputs a door parses, where its schema is exported: the sample request is made from it. Every other door gets `{}`. */
const INPUT_SCHEMAS: Readonly<Record<string, z.ZodType>> = {
  'POST /trpc/post': postRequestSchema,
  'POST /trpc/balance': accountRefSchema,
  'POST /trpc/history': historyInputSchema,
  'POST /trpc/statementPnl': statementPnlReproduceInputSchema,
  'POST /trpc/reportExport': reportExportInputSchema,
  'POST /trpc/custody': custodyInputSchema,
  'POST /trpc/financeClose': financeCloseInputSchema,
  'POST /trpc/resilience': resilienceInputSchema,
  'POST /operator/accounts/:accountId/metadata/set': accountMetadataSetInputSchema,
  'POST /operator/accounts/:accountId/metadata/delete': accountMetadataDeleteInputSchema,
  'POST /operator/reconciliation/controls': defineReconciliationControlInputSchema,
  'POST /operator/reconciliation/controls/runs': listReconciliationControlRunsInputSchema,
  'POST /operator/reconciliation/controls/update': updateReconciliationControlInputSchema,
  'POST /operator/reconciliation/controls/run': runReconciliationControlInputSchema,
};

type Json = { [k: string]: unknown };

/** Strings tried against a schema's pattern, in order: the first that matches is the sample. */
const PATTERN_TRIES = ['1.50', '1', 'USDC', 'DE', 'placeholder', ID, '2026-01-01', '2026-01-01T00:00:00Z', 'a-b', 'A'];

/** A plain sample of what an input's own JSON schema asks for. Not always accepted: that answer is recorded too. */
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
      if (typeof s.pattern === 'string') {
        const re = new RegExp(s.pattern, 'u');
        return PATTERN_TRIES.find((t) => re.test(t)) ?? 'x';
      }
      const min = typeof s.minLength === 'number' ? s.minLength : 1;
      const max = typeof s.maxLength === 'number' ? s.maxLength : Infinity;
      return 'placeholder'.length <= max ? 'placeholder'.padEnd(min, 'x') : 'x'.repeat(Math.max(1, min));
    }
    default:
      return null;
  }
}

function sampleOf(name: string): unknown {
  const schema = INPUT_SCHEMAS[name];
  if (!schema) return {};
  try {
    return sample(z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }));
  } catch {
    return {};
  }
}

/** The two bodies made from a door's own schema, recorded so a changed schema cannot change its own requests. */
type Samples = { readonly sample: string; readonly 'sample-nulls': string };

function samplesOf(valid: unknown): Samples {
  const nulls =
    valid !== null && typeof valid === 'object' && !Array.isArray(valid)
      ? Object.fromEntries(Object.keys(valid).map((k) => [k, null]))
      : null;
  return { sample: JSON.stringify(valid ?? null), 'sample-nulls': JSON.stringify(nulls) };
}

/** Each body-taking door gets: nothing; null; a wrong type; an object missing every field; a sample; the sample with every field null. */
function bodies(samples: Samples): Array<[string, string]> {
  return [
    ['absent', ''],
    ['null', 'null'],
    ['wrong-type', '7'],
    ['empty', '{}'],
    ['sample', samples.sample],
    ['sample-nulls', samples['sample-nulls']],
  ];
}

async function bearer(scopes: string[], mfa: boolean): Promise<string> {
  const { token } = await issueAccessToken(
    { userId: OPERATOR, sessionId: '33333333-3333-4333-8333-333333333333', scopes, tier: 'basic', mfa },
    TOKENS,
  );
  return `Bearer ${token}`;
}

/** The operator callers: name and `authorization` header (none for nobody). */
async function operators(): Promise<Array<[string, string | null]>> {
  return [
    ['anon', null],
    ['bad-token', 'Bearer not-a-token'],
    ['no-scope', await bearer([], true)],
    ['read-mfa', await bearer(['admin:read'], true)],
    ['compliance', await bearer(['admin:compliance'], true)],
    ['treasury-no-mfa', await bearer(['admin:treasury'], false)],
    ['treasury-mfa', await bearer(['admin:treasury'], true)],
  ];
}

type Answer = { status: number; body: string };

interface Golden {
  readonly routes: readonly string[];
  readonly inputs: Record<string, Samples>;
  /** `<settings> <route> <body> <caller>`: the answer. */
  readonly answers: Record<string, Answer>;
}

async function replay(recorded: Golden['inputs'] | null): Promise<Golden> {
  const samples: Golden['inputs'] = {};
  const answers: Golden['answers'] = {};
  let names: string[] = [];
  const ops = await operators();
  for (const [settingsName, settings] of SETTINGS) {
    const k = keys();
    const routes: Route[] = [];
    const app = await serve(settings, k, routes);
    try {
      names = routes.map((r) => `${r.method} ${r.url}`).sort();
      for (const name of names) {
        const [method, path] = name.split(' ') as [string, string];
        // `/metrics` is not registered here; a door that would be is named in the golden routes and fails if missing.
        const url = path.replace(/:[A-Za-z]+/g, ID);
        const takesBody = method !== 'GET' && method !== 'DELETE';
        if (takesBody) samples[name] = recorded?.[name] ?? samplesOf(sampleOf(name));
        const sent: Array<[string, string | undefined]> = takesBody ? bodies(samples[name]!) : [['absent', undefined]];
        const callers: Array<[string, (payload: string) => Record<string, string>]> = path.startsWith('/trpc/')
          ? [
              ['anon', () => ({})],
              ...SERVICES.map((svc): [string, (payload: string) => Record<string, string>] => [
                `shared ${svc}`,
                (payload) => serviceAuthHeadersForBody(svc, SHARED, payload),
              ]),
              ...(settings.s2s
                ? SERVICES.map((svc): [string, (payload: string) => Record<string, string>] => [
                    `key ${svc}`,
                    (payload) =>
                      k.signer(svc).headers({
                        audience: 'svc-ledger',
                        method,
                        url: new URL(`http://svc-ledger.internal${url}`),
                        body: payload,
                        context: { contentType: 'application/json' },
                      }),
                  ])
                : []),
            ]
          : path.startsWith('/operator/')
            ? ops.map(([n, auth]): [string, () => Record<string, string>] => [
                n,
                (): Record<string, string> => (auth ? { authorization: auth } : {}),
              ])
            : [['anon', () => ({})]];
        for (const [bodyName, payload] of sent)
          for (const [callerName, headersFor] of callers) {
            const h = headersFor(payload ?? '');
            const res = await app.inject({
              method: method as 'GET',
              url,
              headers: payload === undefined ? h : { ...h, 'content-type': 'application/json' },
              ...(payload === undefined ? {} : { payload }),
            });
            answers[`${settingsName} ${name} ${bodyName} ${callerName}`] = { status: res.statusCode, body: res.body };
          }
      }
    } finally {
      await app.close();
    }
  }
  return { routes: names, inputs: samples, answers };
}

/** One review part holds 400 KB and a new file is one hunk, so each recorded file stays under this. */
const SHARD_BYTES = 350_000;

/** A recorded file's name: its settings and door kind (`set-keypair-trpc`), and its part when that kind is split. */
const goldenJson = (name: string) => new URL(`./wire-replay.golden/${name}.json`, import.meta.url);

/** One shard: each distinct body once, then one line per answer, so a diff names the answer that moved. */
function shardText(keys: string[], g: Golden): string {
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

/** Writes the recording in the repo's own format: `routes.json` (routes and samples), then the answers by settings and door kind. */
async function writeGolden(g: Golden) {
  const prettier = await import('prettier');
  const format = async (name: string, text: string) => {
    const file = goldenJson(name).pathname;
    return prettier.format(text, { ...(await prettier.resolveConfig(file)), filepath: file });
  };
  const groups = new Map<string, Map<string, string[]>>();
  for (const key of Object.keys(g.answers)) {
    const [settings, method, path] = key.split(' ') as [string, string, string];
    const group = `${settings}-${path.split('/')[1]}`;
    const routes = groups.get(group) ?? new Map<string, string[]>();
    routes.set(`${method} ${path}`, [...(routes.get(`${method} ${path}`) ?? []), key]);
    groups.set(group, routes);
  }
  const files = new Map<string, string>();
  for (const [group, routes] of groups) {
    // Whole routes, in order, into as few parts as stay under the bound.
    const parts: string[][] = [[]];
    for (const keys of routes.values()) {
      const grown = [...parts.at(-1)!, ...keys];
      if (parts.at(-1)!.length > 0 && Buffer.byteLength(await format(group, shardText(grown, g))) > SHARD_BYTES) parts.push([...keys]);
      else parts[parts.length - 1] = grown;
    }
    for (const [i, keys] of parts.entries()) {
      const name = parts.length === 1 ? group : `${group}-${i + 1}`;
      const text = await format(name, shardText(keys, g));
      if (Buffer.byteLength(text) > SHARD_BYTES) throw new Error(`shard ${name} is ${Buffer.byteLength(text)} bytes, over ${SHARD_BYTES}`);
      files.set(name, text);
    }
  }
  rmSync(GOLDEN, { recursive: true, force: true });
  mkdirSync(GOLDEN);
  writeFileSync(goldenJson('routes'), await format('routes', JSON.stringify({ routes: g.routes, inputs: g.inputs })));
  for (const [name, text] of files) writeFileSync(goldenJson(name), text);
}

function readGolden(): Golden {
  const index = JSON.parse(readFileSync(new URL('./wire-replay.golden/routes.json', import.meta.url), 'utf8')) as {
    routes: string[];
    inputs: Record<string, Samples>;
  };
  const answers: Golden['answers'] = {};
  for (const file of readdirSync(GOLDEN).filter((f) => f !== 'routes.json')) {
    const shard = JSON.parse(readFileSync(goldenJson(file.replace(/\.json$/, '')), 'utf8')) as {
      bodies: string[];
      answers: Record<string, [number, number]>;
    };
    for (const [key, [status, i]] of Object.entries(shard.answers)) answers[key] = { status, body: shard.bodies[i]! };
  }
  return { routes: index.routes, inputs: index.inputs, answers };
}

describe('the wire replay: svc-ledger answers every served call as recorded', () => {
  it('every request in the matrix gets the recorded status and body, byte for byte', async () => {
    const write = process.env.WIRE_REPLAY_WRITE === '1';
    const now = await replay(write ? null : readGolden().inputs);
    if (write) await writeGolden(now);
    const golden = readGolden();
    expect(Object.keys(golden.answers)).toHaveLength(ANSWERS);
    expect(now.routes).toEqual(golden.routes);
    expect(now.inputs).toEqual(golden.inputs);
    expect(Object.keys(now.answers).sort()).toEqual(Object.keys(golden.answers).sort());
    const diffs = Object.entries(golden.answers)
      .filter(([key, was]) => now.answers[key]?.status !== was.status || now.answers[key]?.body !== was.body)
      .map(
        ([key, was]) =>
          `${key}: ${was.status} ${was.body.slice(0, 160)} != ${now.answers[key]?.status} ${now.answers[key]?.body.slice(0, 160)}`,
      );
    expect(diffs).toEqual([]);
  }, 300_000);
});

/** How many answers the recording holds: a matrix that shrinks fails here before it can pass on less. */
const ANSWERS = 11_304;
