import Fastify, { type FastifyRequest } from 'fastify';
import { fastifyTRPCPlugin } from '@trpc/server/adapters/fastify';
import type { AnyProcedure, AnyRouter } from '@trpc/server';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import { describe, expect, it, vi } from 'vitest';
import type { Principal, Scope } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, procedureCallers, signPrincipalHeader } from '@intafaced/contracts';
import { createAgentsRouter, type AgentsRouterDeps } from './router.js';
import { NO_TIER_LAWS } from './tier-laws.js';

/**
 * The wire replay. `wire-replay.golden/` holds what svc-agents' hand-written router answered (main 2026-11-19,
 * before any of its calls is mounted from a record) to a matrix of requests: every tRPC call the router serves, five
 * inputs, five callers, sent through the production Fastify adapter. Today's router must answer each one byte for byte
 * the same, bugs included. A wrong scope, a widened enum, a renamed path, a dropped field or a changed refusal code
 * shows here as a difference.
 *
 * The router is built with every optional dependency left out (each owner value blank) and a runtime, gateway and meter
 * that hold nothing, so the recording is what the doors answer before any store or engine is reached: guards, input
 * parsing, blank-value refusals and the envelope. The `valid` input is made from each call's own input schema (the
 * required fields only, the first enum member, fixed ids and times), so a call added or changed gets its row without a
 * hand-kept list.
 *
 * The recording is split by the call's first path segment (its first two when one segment's file would pass FILE_CAP)
 * into `services/svc-agents/wire-replay.golden/<area>.json`, data kept out of `src`. Fastify numbers each request
 * (`req-1`, `req-2`, ...), which is the adapter's count and not the router's answer, so it is recorded as `<request>`:
 * a call added later shifts no other answer.
 *
 * `WIRE_REPLAY_WRITE=1` rewrites the golden files (then `prettier --write` them). Only for a change that is meant to
 * change the wire, named in its PR.
 */

// The blank sanctions list: a test process with no env list would otherwise screen with the owner's unsigned rows.
process.env.INTAFACED_UNSIGNED_SANCTIONS_ROWS = 'off';

const GOLDEN = new URL('../wire-replay.golden/', import.meta.url);
/** One golden file stays under the CI review's 400 KB diff part, so a change to it can be read. */
const FILE_CAP = 350_000;
const SECRET = 'an-agents-wire-replay-edge-secret-long-enough';
const USER = '11111111-1111-4111-8111-111111111111';
const ID = '33333333-3333-4333-8333-333333333333';
const NOW = '2026-11-19T00:00:00.000Z';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-agents' });

interface Caller {
  readonly scopes: Scope[];
  readonly tier: string;
  readonly kid?: string;
}

const CALLERS: Array<[string, Caller | null]> = [
  ['anon', null],
  ['read', { scopes: ['agents:read'], tier: 'basic' }],
  ['execute', { scopes: ['agents:read', 'agents:execute', 'identity:write'], tier: 'full' }],
  ['admin', { scopes: ['agents:read', 'admin:read'], tier: 'basic' }],
  ['key', { scopes: ['agents:read', 'agents:execute', 'identity:write'], tier: 'full', kid: 'key-1' }],
];

function headers(caller: Caller | null): Record<string, string> {
  if (caller === null) return {};
  const raw = encodePrincipal({
    sub: USER,
    userId: USER,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes: caller.scopes,
    tier: caller.tier,
    mfa: false,
    expiresAt: new Date('2099-01-01T00:00:00Z'),
    ...(caller.kid ? { kid: caller.kid } : {}),
  } as Principal);
  return {
    'x-intafaced-principal': raw,
    'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
    'x-intafaced-region': 'DE',
  };
}

function deps(): AgentsRouterDeps {
  return {
    runtime: {} as AgentsRouterDeps['runtime'],
    gateway: { routingTable: { routes: [] } } as Partial<AgentsRouterDeps['gateway']> as AgentsRouterDeps['gateway'],
    meter: {} as AgentsRouterDeps['meter'],
    feeAssetId: 'fixture-asset',
    tierLaws: NO_TIER_LAWS,
    loadCoachGrounding: async () => {
      throw new Error('coach grounding is unset in the wire replay');
    },
  };
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
      if (schema.format === 'email') return 'replay@example.test';
      if (schema.format === 'uri') return 'https://example.test/';
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
    case 'null':
      return null;
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

const INPUTS = (valid: Json | undefined): Array<[string, unknown]> => [
  ['valid', valid],
  ['absent', undefined],
  ['wrong-type', 7],
  ['empty', {}],
  ['extra-key', valid !== null && typeof valid === 'object' && !Array.isArray(valid) ? { ...valid, extra: 1 } : { extra: 1 }],
];

async function serve() {
  const app = Fastify();
  await app.register(fastifyTRPCPlugin, {
    prefix: '/trpc',
    trpcOptions: {
      router: createAgentsRouter(deps()),
      createContext: ({ req }: { req: FastifyRequest }) => edgeContext(req),
    },
  });
  return app;
}

async function hit(app: Awaited<ReturnType<typeof serve>>, path: string, kind: string, input: unknown, h: Record<string, string>) {
  const url = `/trpc/${path}${kind === 'query' && input !== undefined ? `?input=${encodeURIComponent(JSON.stringify(input))}` : ''}`;
  const res =
    kind === 'query'
      ? await app.inject({ method: 'GET', url, headers: h })
      : await app.inject({
          method: 'POST',
          url,
          headers: { ...h, 'content-type': 'application/json' },
          payload: input === undefined ? '' : JSON.stringify(input),
        });
  // tRPC's dev stack trace carries file paths and line numbers, which move with any edit.
  const body = res.body
    .replace(/"stack":"(?:[^"\\]|\\.)*"/g, '"stack":"<stack>"')
    .replace(/"requestId":"req-\d+"/g, '"requestId":"<request>"');
  return { status: res.statusCode, body };
}

interface Golden {
  readonly callers: ReadonlyArray<{ path: string }>;
  readonly inputs: Record<string, unknown>;
  readonly answers: Record<string, { status: number; body: string }>;
}

async function replay(): Promise<Golden> {
  const built = createAgentsRouter(deps());
  const r: AnyRouter = built;
  const procedures: Record<string, AnyProcedure> = r._def.procedures;
  // Subscriptions are streams, not calls: none is served today, and the matrix would not record one.
  const calls = Object.entries(procedures)
    .filter(([, p]) => p._def.type !== 'subscription')
    .sort(([a], [b]) => a.localeCompare(b));
  const inputs: Golden['inputs'] = {};
  const answers: Golden['answers'] = {};
  const app = await serve();
  try {
    for (const [path, proc] of calls) {
      const valid = validInput(proc._def.inputs);
      inputs[path] = valid ?? null;
      for (const [inputName, input] of INPUTS(valid))
        for (const [callerName, caller] of CALLERS)
          answers[`${path} ${inputName} ${callerName}`] = await hit(app, path, proc._def.type, input, headers(caller));
    }
  } finally {
    await app.close();
  }
  return { callers: procedureCallers(r), inputs, answers };
}

/** The recording in files of at most FILE_CAP bytes each, by area. */
function split(golden: Golden): Map<string, string> {
  const by = (depth: number, path: string) => path.split('.').slice(0, depth).join('.');
  const write = (paths: readonly string[]) => {
    const keep = new Set(paths);
    const part: Golden = {
      callers: golden.callers.filter((c) => keep.has(c.path)),
      inputs: Object.fromEntries(Object.entries(golden.inputs).filter(([path]) => keep.has(path))),
      answers: Object.fromEntries(Object.entries(golden.answers).filter(([key]) => keep.has(key.split(' ')[0] ?? ''))),
    };
    return `${JSON.stringify(part, null, 2)}\n`;
  };
  const group = (paths: readonly string[], depth: number) => {
    const areas = new Map<string, string[]>();
    for (const path of paths) areas.set(by(depth, path), [...(areas.get(by(depth, path)) ?? []), path]);
    return areas;
  };
  const files = new Map<string, string>();
  for (const [area, paths] of group(Object.keys(golden.inputs), 1)) {
    const whole = write(paths);
    if (whole.length <= FILE_CAP) files.set(area, whole);
    else for (const [sub, subPaths] of group(paths, 2)) files.set(sub, write(subPaths));
  }
  for (const [area, text] of files) if (text.length > FILE_CAP) throw new Error(`${area}: ${text.length} bytes, over FILE_CAP`);
  return files;
}

function readGolden(): Golden {
  const parts = readdirSync(GOLDEN)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => JSON.parse(readFileSync(new URL(name, GOLDEN), 'utf8')) as Golden);
  return {
    callers: parts.flatMap((p) => p.callers).sort((a, b) => a.path.localeCompare(b.path)),
    inputs: Object.assign({}, ...parts.map((p) => p.inputs)),
    answers: Object.assign({}, ...parts.map((p) => p.answers)),
  };
}

describe('the wire replay: svc-agents answers as main did before its calls are mounted from records', () => {
  it('every request in the matrix gets the recorded status and body, byte for byte', async () => {
    vi.setSystemTime(new Date(NOW));
    try {
      const now = await replay();
      if (process.env.WIRE_REPLAY_WRITE === '1') {
        rmSync(GOLDEN, { recursive: true, force: true });
        mkdirSync(GOLDEN);
        for (const [area, text] of split(now)) writeFileSync(new URL(`${area}.json`, GOLDEN), text);
      }
      const golden = readGolden();
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
  }, 120_000);
});
