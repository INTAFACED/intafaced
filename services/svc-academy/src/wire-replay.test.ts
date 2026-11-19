import Fastify from 'fastify';
import type { AnyProcedure, AnyRouter } from '@trpc/server';
import { fastifyTRPCPlugin } from '@trpc/server/adapters/fastify';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { Principal, Scope } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, procedureCallers, signPrincipalHeader } from '@intafaced/contracts';
import { parseAmount } from '@intafaced/ledger-client';
import type { Sql } from 'postgres';
import { AcademyService } from './academy-service.js';
import { stubApprovalConsumer, ActionApprovalConsumeError } from './action-approval-consume.js';
import { OwnerDecisionError } from './curriculum/lessons.js';
import { DualControlError } from './dual-control.js';
import { ACADEMY_ERROR_CODES, AcademyError } from './errors.js';
import { BaseHostRights } from './host-rights.js';
import { createAcademyRouter } from './router.js';
import { FixedStake } from './stake-source.js';
import { NullStreamProvider } from './stream/provider.js';

/**
 * The wire replay. `wire-replay.golden.json` holds what svc-academy's hand-written router answered on main
 * (2026-11-19, before any of its calls is mounted from a record), bugs included: every call, four inputs, four
 * callers, sent through the production Fastify adapter to two services:
 *
 * - `store-down`: the real AcademyService over a database that refuses every query. Everything main decides before
 *   storage (path, query or mutation, who may call, input checks, owner values, pure catalogue answers) shows as it is.
 * - `refuses`: a service whose every method throws one academy refusal. Every call's way of turning a refusal into
 *   an answer shows; and every code in the catalogue, plus each other refusal type, goes once through a query and a
 *   mutation, so each code's status and envelope are recorded.
 *
 * The requests themselves are in the golden file, so a later router answers the same inputs, not inputs made from its
 * own schemas. A wrong scope, a widened input, a renamed path or a changed refusal code shows as a difference.
 *
 * `WIRE_REPLAY_WRITE=1` rewrites the golden file from the router in this checkout. Only for a change that is meant to
 * change the wire, named in its PR.
 */

const GOLDEN = new URL('./wire-replay.golden.json', import.meta.url);
const SECRET = 'an-academy-wire-replay-edge-secret-long';
const USER = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-11-19T00:00:00Z');
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-academy' });

process.env.INTAFACED_UNSIGNED_SANCTIONS_ROWS = 'off';

const CALLERS: Array<[string, Scope[] | null]> = [
  ['anon', null],
  ['read', ['academy:read']],
  ['write', ['academy:read', 'academy:write']],
  ['operator', ['academy:read', 'academy:write', 'admin:read', 'admin:write']],
];

function headers(scopes: Scope[] | null): Record<string, string> {
  if (scopes === null) return { 'x-intafaced-region': 'DE' };
  const principal = {
    sub: USER,
    userId: USER,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes,
    tier: 'none',
    mfa: scopes.includes('admin:write'),
    expiresAt: new Date('2099-01-01T00:00:00Z'),
  } as Principal;
  const raw = encodePrincipal(principal);
  return {
    'x-intafaced-principal': raw,
    'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
    'x-intafaced-region': 'DE',
  };
}

/** A database that is down: every query, however it is built, rejects when awaited. Building a query never throws. */
function storeDown(): Sql {
  const down = () => Promise.reject(new Error('wire replay: the database is down'));
  // oxlint-disable-next-line unicorn/no-thenable -- a query is awaited, so the stand-in must be thenable to reject there
  const query: object = { then: (ok: unknown, fail: (e: unknown) => unknown) => down().then(ok as never, fail) };
  const handler: ProxyHandler<() => unknown> = {
    apply: () => new Proxy(() => query, handler),
    get: (_t, key) => {
      if (key === 'then') return (query as { then: unknown }).then;
      if (key === 'begin' || key === 'reserve') return () => down();
      return new Proxy(() => query, handler);
    },
  };
  // oxlint-disable-next-line garden/no-double-cast -- a stand-in database that only rejects: no real handle exists in this test
  return new Proxy(() => query, handler) as unknown as Sql;
}

/** A service whose every method, at any depth, throws `err`. */
function refusing(err: () => Error): AcademyService {
  const handler: ProxyHandler<() => unknown> = {
    apply: () => {
      throw err();
    },
    get: (_t, key) => (key === 'then' ? undefined : new Proxy(() => undefined, handler)),
  };
  // oxlint-disable-next-line garden/no-double-cast -- a stand-in service that only refuses: every method, at any depth
  return new Proxy(() => undefined, handler) as unknown as AcademyService;
}

function realAcademy(): AcademyService {
  return new AcademyService(storeDown(), new FixedStake(parseAmount('0')), new BaseHostRights(), new NullStreamProvider(), {});
}

async function serve(academy: AcademyService) {
  const app = Fastify();
  await app.register(fastifyTRPCPlugin, {
    prefix: '/trpc',
    trpcOptions: {
      router: createAcademyRouter(academy, {}, undefined, stubApprovalConsumer('replay-operator')),
      createContext: ({ req }: { req: unknown }) =>
        Object.assign(edgeContext(req as never), { clientAddress: '203.0.113.7', quizClientAddress: '203.0.113.7' }),
    },
  });
  return app;
}

type App = Awaited<ReturnType<typeof serve>>;
interface Call {
  readonly path: string;
  readonly kind: 'query' | 'mutation';
  readonly valid: unknown;
}

async function hit(app: App, call: Call, input: unknown, h: Record<string, string>): Promise<string> {
  const url = `/trpc/${call.path}${call.kind === 'query' && input !== undefined ? `?input=${encodeURIComponent(JSON.stringify(input))}` : ''}`;
  const res =
    call.kind === 'query'
      ? await app.inject({ method: 'GET', url, headers: h })
      : await app.inject({
          method: 'POST',
          url,
          headers: { ...h, 'content-type': 'application/json' },
          payload: input === undefined ? '' : JSON.stringify(input),
        });
  // tRPC's dev stack trace carries file paths and line numbers, which move with any edit; the request id is Fastify's
  // counter, not the router's answer; the call's own path is in its key, so the body names it `<path>`.
  const body = res.body
    .replace(/"stack":"(?:[^"\\]|\\.)*"/g, '"stack":"<stack>"')
    .replace(/"requestId":"req-[0-9a-z]+"/g, '"requestId":"<id>"')
    .replaceAll(`"path":${JSON.stringify(call.path)}`, '"path":"<path>"');
  return `${res.statusCode} ${body}`;
}

// ── Making the requests (only when the golden file is written) ─────────────────────────────────────────────────────

type Json = { [k: string]: unknown };

/** A smallest input that main's schema for the call admits where it can: required fields only, the first choice. */
function sampleOf(s: Json | boolean | undefined, depth = 0): unknown {
  if (s === undefined || typeof s === 'boolean' || depth > 8) return null;
  if ('const' in s) return s.const;
  if (Array.isArray(s.enum)) return s.enum[0];
  const branches = (s.anyOf ?? s.oneOf) as Json[] | undefined;
  if (branches) return sampleOf(branches.find((b) => b.type !== 'null') ?? branches[0], depth + 1);
  if (Array.isArray(s.allOf)) return sampleOf(s.allOf[0] as Json, depth + 1);
  const type = Array.isArray(s.type) ? (s.type as string[]).find((t) => t !== 'null') : (s.type as string | undefined);
  switch (type) {
    case 'object': {
      const props = (s.properties ?? {}) as Record<string, Json>;
      const out: Record<string, unknown> = {};
      for (const key of (s.required ?? []) as string[]) out[key] = sampleOf(props[key], depth + 1);
      return out;
    }
    case 'array':
      return Array.from({ length: Number(s.minItems ?? 0) }, () => sampleOf(s.items as Json, depth + 1));
    case 'string': {
      const byFormat: Record<string, string> = {
        uuid: '33333333-3333-4333-8333-333333333333',
        'date-time': '2026-01-01T00:00:00.000Z',
        date: '2026-01-01',
        email: 'learner@example.com',
        uri: 'https://example.com/a',
        url: 'https://example.com/a',
      };
      const f = typeof s.format === 'string' ? byFormat[s.format] : undefined;
      if (f) return f;
      // A plain string says it is a placeholder where its length allows, so a sample named `key` reads as no credential.
      const min = Number(s.minLength ?? 1);
      return typeof s.maxLength === 'number' && s.maxLength < 11 ? 'a'.repeat(Math.max(1, min)) : 'placeholder'.padEnd(min, 'x');
    }
    case 'integer':
    case 'number':
      return typeof s.minimum === 'number' ? s.minimum : typeof s.exclusiveMinimum === 'number' ? s.exclusiveMinimum + 1 : 1;
    case 'boolean':
      return true;
    case 'null':
      return null;
    default:
      return {};
  }
}

function makeCalls(): Call[] {
  const academyRouter: AnyRouter = createAcademyRouter(realAcademy());
  const procedures: Record<string, AnyProcedure> = academyRouter._def.procedures;
  return Object.entries(procedures)
    .filter(([, p]) => p._def.type !== 'subscription')
    .map(([path, p]) => {
      const input = p._def.inputs[0] as z.ZodType | undefined;
      let valid: unknown;
      if (input) {
        try {
          valid = sampleOf(z.toJSONSchema(input, { io: 'input', unrepresentable: 'any' }) as Json);
        } catch {
          valid = {};
        }
      }
      return { path, kind: p._def.type as 'query' | 'mutation', valid };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
}

const INPUTS = (valid: unknown): Array<[string, unknown]> => [
  ['valid', valid],
  ['absent', undefined],
  ['wrong-type', 7],
  ['extra-key', valid !== null && typeof valid === 'object' && !Array.isArray(valid) ? { ...valid, extra: 1 } : { extra: 1 }],
];

/** The other refusal types the router turns into answers, each once. */
const OTHER_REFUSALS: Array<[string, () => Error]> = [
  ['owner-decision', () => new OwnerDecisionError('replay: waits for the owner')],
  ['dual-control', () => new DualControlError('replay: a second operator is missing')],
  ['approval', () => new ActionApprovalConsumeError('replay: approval missing', 'action_approval.consume_failed')],
  ['plain-error', () => new Error('replay: an unexpected failure')],
];

// ── The replay ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** Each answer is `<status> <body>`, keyed by `<group> | <request> <caller>`: the group is a call's path or `refusal <name>`. */
interface Replay {
  readonly callers: unknown;
  readonly calls: Call[];
  readonly answers: Record<string, string>;
}

/**
 * The file keeps each distinct answer once (`bodies`) and, per group and request, which answer each of the four
 * callers got, in `CALLERS`' order: thousands of answers are a few hundred distinct ones, and the file stays readable.
 */
interface Golden {
  readonly callers: unknown;
  readonly calls: Call[];
  readonly bodies: string[];
  readonly answers: Record<string, Record<string, number[]>>;
}

function pack(r: Replay): Golden {
  const bodies: string[] = [];
  const answers: Golden['answers'] = {};
  for (const [key, answer] of Object.entries(r.answers)) {
    const [group, rest] = key.split(' | ') as [string, string];
    const request = rest.slice(0, rest.lastIndexOf(' '));
    const caller = CALLERS.findIndex(([name]) => rest.endsWith(` ${name}`));
    let at = bodies.indexOf(answer);
    if (at < 0) at = bodies.push(answer) - 1;
    ((answers[group] ??= {})[request] ??= [])[caller] = at;
  }
  return { callers: r.callers, calls: r.calls, bodies, answers };
}

function unpack(g: Golden): Replay {
  const answers: Replay['answers'] = {};
  for (const [group, requests] of Object.entries(g.answers))
    for (const [request, ats] of Object.entries(requests))
      ats.forEach((at, caller) => (answers[`${group} | ${request} ${CALLERS[caller]![0]}`] = g.bodies[at]!));
  return { callers: g.callers, calls: g.calls, answers };
}

async function replay(calls: Call[]): Promise<Replay> {
  const answers: Replay['answers'] = {};
  const store = await serve(realAcademy());
  try {
    for (const call of calls)
      for (const [inputName, input] of INPUTS(call.valid))
        for (const [callerName, scopes] of CALLERS)
          answers[`${call.path} | store-down ${inputName} ${callerName}`] = await hit(store, call, input, headers(scopes));
  } finally {
    await store.close();
  }

  const notFound = await serve(refusing(() => new AcademyError('replay: refused', 'academy.room_not_found')));
  try {
    for (const call of calls)
      for (const [callerName, scopes] of CALLERS)
        answers[`${call.path} | refuses valid ${callerName}`] = await hit(notFound, call, call.valid, headers(scopes));
  } finally {
    await notFound.close();
  }

  // Each refusal once through a query and a mutation that reach the service with the operator's valid input, by every caller.
  const reach = (kind: Call['kind']) =>
    calls.find((c) => c.kind === kind && answers[`${c.path} | refuses valid operator`]?.includes('academy.room_not_found'));
  const through = [reach('query'), reach('mutation')].filter((c): c is Call => c !== undefined);
  const refusals: Array<[string, () => Error]> = [
    ...ACADEMY_ERROR_CODES.map((code): [string, () => Error] => [code, () => new AcademyError(`replay: ${code}`, code)]),
    ...OTHER_REFUSALS,
  ];
  for (const [name, err] of refusals) {
    const app = await serve(refusing(err));
    try {
      for (const call of through)
        for (const [callerName, scopes] of CALLERS)
          answers[`refusal ${name} | via ${call.path} ${callerName}`] = await hit(app, call, call.valid, headers(scopes));
    } finally {
      await app.close();
    }
  }
  return { callers: procedureCallers(createAcademyRouter(realAcademy()) as never), calls, answers };
}

function golden(): Replay {
  return unpack(JSON.parse(readFileSync(GOLDEN, 'utf8')) as Golden);
}

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: NOW });
});
afterAll(() => {
  vi.useRealTimers();
});

describe('the wire replay: svc-academy answers as main did before its calls were mounted from records', () => {
  it('every request in the recording gets the recorded status and body, byte for byte', async () => {
    if (process.env.WIRE_REPLAY_WRITE === '1') {
      writeFileSync(GOLDEN, `${JSON.stringify(pack(await replay(makeCalls())), null, 2)}\n`);
      // The repo's format check covers JSON: the written file leaves in the shape it checks.
      execFileSync(fileURLToPath(new URL('../../../node_modules/.bin/prettier', import.meta.url)), ['--write', fileURLToPath(GOLDEN)]);
    }
    const recorded = golden();
    const now = await replay(recorded.calls);
    expect(Object.keys(recorded.answers)).toHaveLength(7_588);
    expect(now.callers).toEqual(recorded.callers);
    const diffs = Object.entries(recorded.answers)
      .filter(([key, was]) => now.answers[key] !== was)
      .map(([key, was]) => `${key}: ${was.slice(0, 200)} != ${now.answers[key]?.slice(0, 200)}`);
    expect(diffs).toEqual([]);
    expect(Object.keys(now.answers).filter((key) => !(key in recorded.answers))).toEqual([]);
  });
});
