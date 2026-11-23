import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync, writeFileSync } from 'node:fs';
import type { AnyRouter } from '@trpc/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SCOPES, type Principal, type Scope } from '@intafaced/auth';
import { z } from 'zod';
import {
  REGION_FAIL_CLOSED_ENV,
  SANCTIONS_REGIONS_ENV,
  SANCTIONS_SOURCE_ENV,
  SCREENING_FAIL_CLOSED_ENV,
  UNSIGNED_SANCTIONS_ROWS_ENV,
} from '@intafaced/config';
import { encodePrincipal, procedureCallers, serviceAuthHeadersForBody, signPrincipalHeader } from '@intafaced/contracts';
import { miningHealthHonesty } from './health-honesty.js';
import { createMiningRequestHandler } from './http.js';
import { MiningReadStore } from './reads.js';
import { createMiningRouter } from './router.js';

/**
 * The wire replay for svc-mining-pool: every call's current answers, recorded before anyone moves them.
 *
 * `wire-replay.golden.json` holds what svc-mining-pool answered (main 2026-11-19, as it is, bugs included) to a matrix
 * of requests: every tRPC procedure of its router, `/health`, `/ready`, `POST /submitShare` and an unknown path, with
 * six inputs, four people and two signed services, sent through the production request handler (`http.ts`) over a real
 * socket, the way `server.ts` serves it. A later move of these calls must answer each one byte for byte the same; a
 * wrong scope, a changed refusal code, a widened input or a reshaped envelope shows here as a difference.
 *
 * As a stack with no database and no ledger (`server.ts` with `DATABASE_URL` and `LEDGER_URL` unset), in three set-ups:
 * every owner setting blank; the owner settings set to labelled TEST values (the probe's limits left blank, so it never
 * dials); and the edge secret unset, where every tRPC call refuses. Every setting the service reads is blanked in the
 * process for the run, so a developer's shell can't change an answer; the sanctions list is fixed (KP screened out).
 *
 * `WIRE_REPLAY_WRITE=1` rewrites the recording. Only for a change that is meant to change the wire, named in its PR.
 */

const GOLDEN = new URL('./wire-replay.golden.json', import.meta.url);
const SECRET = 'a-mining-pool-wire-replay-edge-secret-long-enough';
const INTERNAL = 'a-mining-pool-wire-replay-internal-secret-long-enough';
const USER = '11111111-1111-4111-8111-111111111111';
const ID = '22222222-2222-4222-8222-222222222222';

/** Every setting svc-mining-pool reads from the process: blank for the run, whatever the machine running the test holds. */
const PROCESS_SETTINGS = [
  'DATABASE_URL',
  'EDGE_PRINCIPAL_CLOCK_SKEW_SECONDS',
  'EDGE_PRINCIPAL_MAX_LIFETIME_SECONDS',
  'EDGE_PRINCIPAL_PUBLIC_KEY',
  'EDGE_PRINCIPAL_SECRET',
  'INTERNAL_SERVICE_SECRET',
  'LEDGER_URL',
  'MINING_DEFAULT_DIFFICULTY',
  'MINING_OVERVIEW_COIN',
  'MINING_OVERVIEW_HARDWARE',
  'MINING_OVERVIEW_NOT_SUPPORTED',
  'MINING_OVERVIEW_REVENUE_SPLIT',
  'MINING_OVERVIEW_VERSION',
  'MINING_OVERVIEW_WHAT',
  'MINING_PAYOUT_INTERVAL_MS',
  'MINING_POOL_FEE_BPS',
  'MINING_POOL_HOST',
  'MINING_POOL_PORT',
  'MINING_POOL_SECURE_URL',
  'MINING_POOL_WINDOW_SIZE',
  'MINING_POW_DIMENSION',
  'MINING_POW_TARGET_BITS',
  'MINING_POW_TESTNET',
  'MINING_PROBE_LIMIT',
  'MINING_PROBE_TIMEOUT_MS',
  'MINING_PROBE_WINDOW_MS',
  'MINING_STRATUM_ASSET_ID',
  'MINING_STRATUM_LISTEN_PORT',
  'MINING_STRATUM_WINDOW_SECONDS',
  'MINING_WORKER_NAME_PATTERN',
  'S2S_AUTH_MODE',
] as const;

/** The screening list and its fail-closed switches, fixed for the run as svc-dex's replay has them: KP is screened out, every other region is not. */
const SCREENING_ENV: Record<string, string | undefined> = {
  APP_ENV: 'test',
  [SANCTIONS_REGIONS_ENV]: 'KP',
  [SANCTIONS_SOURCE_ENV]: 'wire-replay-fixture',
  [UNSIGNED_SANCTIONS_ROWS_ENV]: undefined,
  [SCREENING_FAIL_CLOSED_ENV]: undefined,
  [REGION_FAIL_CLOSED_ENV]: undefined,
};

/** Owner settings at labelled TEST values. The probe's limit and timeout stay blank: it refuses before it dials. */
const TEST_SETTINGS: Record<string, string> = {
  MINING_DEFAULT_DIFFICULTY: '1.5',
  MINING_OVERVIEW_VERSION: 'TEST-1',
  MINING_OVERVIEW_WHAT: 'TEST what the pool is',
  MINING_OVERVIEW_COIN: 'TEST coin',
  MINING_OVERVIEW_HARDWARE: 'TEST hardware',
  MINING_OVERVIEW_REVENUE_SPLIT: 'TEST split',
  MINING_POOL_FEE_BPS: '100',
  MINING_POOL_WINDOW_SIZE: '1000',
  MINING_POOL_HOST: 'pool.test.invalid',
  MINING_POOL_PORT: '3333',
  MINING_POOL_SECURE_URL: 'stratum+ssl://pool.test.invalid:3334',
  MINING_WORKER_NAME_PATTERN: '<account>.<rig>',
  MINING_POW_DIMENSION: '8',
  MINING_POW_TARGET_BITS: '4',
  MINING_POW_TESTNET: 'true',
};

type Setup = 'blank' | 'test-settings' | 'edge-unset';
const SETUPS: readonly Setup[] = ['blank', 'test-settings', 'edge-unset'];

/** The handler `server.ts` builds with no database, no ledger, no payout jobs and no per-service keys. */
function handlerFor(setup: Setup) {
  return createMiningRequestHandler({
    health: () => miningHealthHonesty({ ledgerConfigured: false, pgConfigured: false, jobs: [] }),
    sql: null,
    internalSecret: INTERNAL,
    edgeSecret: setup === 'edge-unset' ? undefined : SECRET,
    edgeTrust: {},
    ledger: null,
  });
}

async function listen(setup: Setup): Promise<{ server: Server; base: string }> {
  const handler = handlerFor(setup);
  const server = createServer((request, response) => {
    void handler(request, response);
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
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

/** Signed service calls, body-bound: svc-mining-pool itself, and svc-trade. */
const SERVICES = ['svc-mining-pool', 'svc-trade'] as const;

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

type Json = { [k: string]: unknown };

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
      return typeof s.minimum === 'number' ? s.minimum : 1;
    case 'boolean':
      return true;
    case 'string':
      if (s.format === 'uuid') return ID;
      if (s.format === 'date-time') return '2026-01-01T00:00:00Z';
      return 'placeholder';
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

/** The two inputs made from a call's own schema, kept in the recording as the JSON text sent, so a changed schema cannot change its own requests. */
type Samples = { readonly sample: string; readonly 'sample-nulls': string };

function samplesOf(valid: unknown): Samples {
  const nulls =
    valid !== null && typeof valid === 'object' && !Array.isArray(valid)
      ? Object.fromEntries(Object.keys(valid).map((k) => [k, null]))
      : null;
  return { sample: JSON.stringify(valid ?? null), 'sample-nulls': JSON.stringify(nulls) };
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

/** A share batch for `POST /submitShare`, in the shape its callers send. */
const SHARE_SAMPLE: Samples = samplesOf({
  windowId: ID,
  shares: [{ minerId: ID, workerId: ID, difficulty: '1', submittedAt: '2026-01-01T00:00:00Z' }],
});

type Answer = { status: number; body: string };

interface Golden {
  readonly callers: unknown;
  readonly inputs: Record<string, Samples>;
  /** Each distinct body once; an answer is its status and its body's index. */
  readonly bodies?: string[];
  /** Per `<setup> <call>`, per `<input> <caller>`: the answer. */
  readonly answers: Record<string, Record<string, Answer>>;
}

async function send(base: string, method: string, path: string, payload: string | undefined, h: Record<string, string>): Promise<Answer> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: payload === undefined ? h : { ...h, 'content-type': 'application/json' },
    ...(payload === undefined ? {} : { body: payload }),
  });
  // tRPC's dev stack trace carries file paths and line numbers, which move with any edit.
  return { status: res.status, body: (await res.text()).replace(/"stack":"(?:[^"\\]|\\.)*"/g, '"stack":"<stack>"') };
}

function payload(query: boolean, input: unknown): string | undefined {
  return query ? undefined : input === undefined ? '' : JSON.stringify(input);
}

async function replay(recorded: Golden['inputs'] | null): Promise<Golden> {
  const r = createMiningRouter(new MiningReadStore(null, null));
  const anyRouter: AnyRouter = r;
  const procedures: Record<string, Proc> = anyRouter._def.procedures;
  const answers: Golden['answers'] = {};
  const samples: Golden['inputs'] = {};
  for (const setup of SETUPS) {
    for (const name of PROCESS_SETTINGS) vi.stubEnv(name, setup === 'test-settings' ? TEST_SETTINGS[name] : undefined);
    const { server, base } = await listen(setup);
    try {
      for (const path of Object.keys(procedures).sort()) {
        const proc = procedures[path]!;
        if (proc._def.type === 'subscription') continue;
        samples[path] = recorded?.[path] ?? samplesOf(sampleInput(proc));
        const query = proc._def.type === 'query';
        const call = (answers[`${setup} ${path}`] ??= {});
        for (const [inputName, input] of inputs(samples[path])) {
          const url = `/trpc/${path}${query && input !== undefined ? `?input=${encodeURIComponent(JSON.stringify(input))}` : ''}`;
          const body = payload(query, input);
          for (const [callerName, caller] of CALLERS)
            call[`${inputName} ${callerName}`] = await send(base, query ? 'GET' : 'POST', url, body, headers(caller));
          for (const service of SERVICES)
            call[`${inputName} ${service}`] = await send(
              base,
              query ? 'GET' : 'POST',
              url,
              body,
              serviceAuthHeadersForBody(service, INTERNAL, body ?? ''),
            );
        }
      }
      // The doors outside tRPC: health, readiness, the share ingest, and a path nobody serves.
      for (const [method, path] of [
        ['GET', '/health'],
        ['GET', '/ready'],
        ['GET', '/nowhere'],
      ] as const) {
        const call = (answers[`${setup} ${method} ${path}`] ??= {});
        for (const [callerName, caller] of CALLERS)
          call[`absent ${callerName}`] = await send(base, method, path, undefined, headers(caller));
      }
      samples['POST /submitShare'] = recorded?.['POST /submitShare'] ?? SHARE_SAMPLE;
      const share = (answers[`${setup} POST /submitShare`] ??= {});
      for (const [inputName, input] of inputs(samples['POST /submitShare'])) {
        const body = input === undefined ? '' : JSON.stringify(input);
        for (const [callerName, caller] of CALLERS)
          share[`${inputName} ${callerName}`] = await send(base, 'POST', '/submitShare', body, headers(caller));
        for (const service of SERVICES)
          share[`${inputName} ${service}`] = await send(
            base,
            'POST',
            '/submitShare',
            body,
            serviceAuthHeadersForBody(service, INTERNAL, body),
          );
      }
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
    }
  }
  for (const name of PROCESS_SETTINGS) vi.stubEnv(name, undefined);
  return { callers: procedureCallers(r as never), inputs: samples, answers };
}

/** Writes the recording in the repo's own format (the format check reads JSON): one line per body and per call. */
async function writeGolden(g: Golden) {
  const bodies: string[] = [];
  const index = new Map<string, number>();
  const rows = Object.entries(g.answers).map(([call, answers]) => {
    const cells = Object.entries(answers).map(([k, a]) => {
      if (!index.has(a.body)) index.set(a.body, bodies.push(a.body) - 1);
      return `${JSON.stringify(k)}: [${a.status}, ${index.get(a.body)}]`;
    });
    return `    ${JSON.stringify(call)}: { ${cells.join(', ')} }`;
  });
  const recordedInputs = Object.entries(g.inputs).map(
    ([c, s]) =>
      `    ${JSON.stringify(c)}: {\n${Object.entries(s)
        .map(([k, v]) => `      ${JSON.stringify(k)}: ${JSON.stringify(v)}`)
        .join(',\n')}\n    }`,
  );
  const text = [
    '{',
    `  "callers": ${JSON.stringify(g.callers)},`,
    `  "inputs": {\n${recordedInputs.join(',\n')}\n  },`,
    `  "bodies": [\n${bodies.map((b) => `    ${JSON.stringify(b)}`).join(',\n')}\n  ],`,
    `  "answers": {\n${rows.join(',\n')}\n  }`,
    '}',
    '',
  ].join('\n');
  const prettier = await import('prettier');
  const file = GOLDEN.pathname;
  writeFileSync(GOLDEN, await prettier.format(text, { ...(await prettier.resolveConfig(file)), filepath: file }));
}

function readGolden(): Golden {
  const raw = JSON.parse(readFileSync(GOLDEN, 'utf8')) as {
    callers: unknown;
    inputs: Record<string, Samples>;
    bodies: string[];
    answers: Record<string, Record<string, [number, number]>>;
  };
  const answers: Golden['answers'] = {};
  for (const [call, a] of Object.entries(raw.answers))
    answers[call] = Object.fromEntries(Object.entries(a).map(([k, [status, i]]) => [k, { status, body: raw.bodies[i]! }]));
  return { callers: raw.callers, inputs: raw.inputs, answers };
}

describe('the wire replay: svc-mining-pool answers every call as recorded', () => {
  beforeAll(() => {
    for (const name of PROCESS_SETTINGS) vi.stubEnv(name, undefined);
    for (const [name, value] of Object.entries(SCREENING_ENV)) vi.stubEnv(name, value);
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
