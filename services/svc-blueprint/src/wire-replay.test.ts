import Fastify from 'fastify';
import type { AnyRouter } from '@trpc/server';
import { fastifyTRPCPlugin } from '@trpc/server/adapters/fastify';
import { readFileSync, writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SCOPES, type Principal, type Scope } from '@intafaced/auth';
import { z } from 'zod';
import { createEdgeContext, encodePrincipal, procedureCallers, signPrincipalHeader } from '@intafaced/contracts';
import { BlueprintService, type BlueprintServiceOptions } from './blueprint-service.js';
import { createBlueprintRouter } from './router.js';

/**
 * The wire replay for svc-blueprint: every call's current answers, recorded before anyone moves them.
 *
 * `wire-replay.golden.json` holds what svc-blueprint's tRPC surface answered (main 2026-11-19, as it is, bugs included)
 * to a matrix of requests: every procedure of the router `index.ts` mounts, six inputs, four callers, under blank and
 * set owner settings, sent through the production Fastify adapter with `index.ts`'s context. A later move of these calls
 * must answer each one byte for byte the same; a wrong scope, a changed refusal code, a widened input or a reshaped
 * envelope shows here as a difference.
 *
 * No database, event bus, Neural Engine or card renderer: each is a recording stub that refuses any call with its own
 * name (`replay stub: <name>`), and the service is the real `BlueprintService` over them. So the recording pins the
 * boundary (who may call, what input is accepted, how each refusal is shaped) and which dependency each accepted call
 * reaches first. The screening gate is set to the test posture `router.mount.test.ts` uses (its blank-list refusal is
 * proven there), so signed calls reach their own checks and the recording does not depend on the machine's env.
 * `/health` and `/ready` are written inline in `index.ts`, which connects to Postgres and NATS when
 * imported, so they are not in this recording.
 *
 * `WIRE_REPLAY_WRITE=1` rewrites the golden file. Only for a change that is meant to change the wire, named in its PR.
 */

const GOLDEN = new URL('./wire-replay.golden.json', import.meta.url);
/**
 * Error replies no longer carry tRPC's stack. Recordings made before that hold `"stack":"<stack>"` in their error bodies;
 * it is dropped on reading, while the live side still turns any stack into `<stack>`, so a stack that comes back fails.
 */
const RECORDED_STACK = '\\"stack\\":\\"<stack>\\",';
const SECRET = 'a-blueprint-wire-replay-edge-secret-long-enough';
const USER = '11111111-1111-4111-8111-111111111111';
const ID = '22222222-2222-4222-8222-222222222222';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-blueprint' });

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

/** Blank: nothing set, as on a stack nobody configured. Set: every owner value present, so calls reach their stores. */
const SETTINGS: ReadonlyArray<[string, BlueprintServiceOptions]> = [
  ['blank', {}],
  ['set', { crewCapacity: 6, mentorShortlistSize: 3, season: 1, sharesPerOwner: 5, opensListLimit: 50 }],
];

const routerFor = (options: BlueprintServiceOptions) =>
  createBlueprintRouter(new BlueprintService(stub('sql'), stub('engine'), stub('bus'), stub('cardRenderer'), options));

async function serve(options: BlueprintServiceOptions) {
  // A fixed request id keeps an added call from shifting every later answer.
  const app = Fastify({ maxParamLength: 5_000, genReqId: () => 'replay-request' });
  await app.register(fastifyTRPCPlugin, {
    prefix: '/trpc',
    trpcOptions: { router: routerFor(options), createContext: ({ req }: { req: unknown }) => edgeContext(req as never) },
  });
  await app.ready();
  return app;
}

interface Caller {
  readonly scopes: readonly Scope[] | null;
  readonly region: string;
}

/** Nobody; a signed-in person holding no scope; a holder of every scope, in a served and an unserved region. */
const CALLERS: ReadonlyArray<[string, Caller]> = [
  ['anon', { scopes: null, region: 'DE' }],
  ['no-scope', { scopes: [], region: 'DE' }],
  ['all', { scopes: [...SCOPES], region: 'DE' }],
  ['all-US', { scopes: [...SCOPES], region: 'US' }],
];

function headers(caller: Caller): Record<string, string> {
  if (caller.scopes === null) return {};
  const principal = {
    sub: USER,
    userId: USER,
    sid: '33333333-3333-4333-8333-333333333333',
    scopes: caller.scopes,
    tier: 'none',
    mfa: false,
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
      return typeof s.minimum === 'number' ? s.minimum : typeof s.exclusiveMinimum === 'number' ? s.exclusiveMinimum + 1 : 1;
    case 'boolean':
      return true;
    case 'string': {
      if (s.format === 'uuid') return ID;
      if (s.format === 'date-time') return '2026-01-01T00:00:00Z';
      if (s.format === 'date') return '2026-01-01';
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

/** The two inputs made from a call's own schema, recorded so a changed schema cannot change its own requests. */
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

type Answer = { status: number; body: string };

interface Golden {
  readonly callers: unknown;
  readonly inputs: Record<string, Samples>;
  /** `<settings> <call> <input> <caller>`: the answer. */
  readonly answers: Record<string, Answer>;
}

async function replay(recorded: Golden['inputs'] | null): Promise<Golden> {
  const anyRouter: AnyRouter = routerFor({});
  const procedures: Record<string, Proc> = anyRouter._def.procedures;
  const samples: Golden['inputs'] = {};
  const answers: Golden['answers'] = {};
  for (const [settingsName, options] of SETTINGS) {
    const app = await serve(options);
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
            const h = headers(caller);
            const res = query
              ? await app.inject({ method: 'GET', url, headers: h })
              : await app.inject({
                  method: 'POST',
                  url,
                  headers: { ...h, 'content-type': 'application/json' },
                  payload: input === undefined ? '' : JSON.stringify(input),
                });
            // tRPC's dev stack trace carries file paths and line numbers, which move with any edit.
            answers[`${settingsName} ${path} ${inputName} ${callerName}`] = {
              status: res.statusCode,
              body: res.body.replace(/"stack":"(?:[^"\\]|\\.)*"/g, '"stack":"<stack>"'),
            };
          }
      }
    } finally {
      await app.close();
    }
  }
  return { callers: procedureCallers(anyRouter as never), inputs: samples, answers };
}

describe('the wire replay: svc-blueprint answers every call as recorded', () => {
  beforeEach(() => {
    vi.stubEnv('APP_ENV', 'test');
    vi.stubEnv('INTAFACED_SCREENING_FAIL_CLOSED', 'off');
    vi.stubEnv('INTAFACED_UNSIGNED_SANCTIONS_ROWS', 'off');
    vi.stubEnv('INTAFACED_SANCTIONS_REGIONS', undefined);
    vi.stubEnv('INTAFACED_SANCTIONS_LIST_SOURCE', undefined);
  });
  afterEach(() => vi.unstubAllEnvs());

  it('every request in the matrix gets the recorded status and body, byte for byte', async () => {
    const write = process.env.WIRE_REPLAY_WRITE === '1';
    const now = await replay(write ? null : (JSON.parse(readFileSync(GOLDEN, 'utf8').replaceAll(RECORDED_STACK, '')) as Golden).inputs);
    if (write) writeFileSync(GOLDEN, `${JSON.stringify(now, null, 2)}\n`);
    const golden = JSON.parse(readFileSync(GOLDEN, 'utf8').replaceAll(RECORDED_STACK, '')) as Golden;
    expect(Object.keys(golden.answers)).toHaveLength(624);
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
  }, 120_000);
});
