import Fastify from 'fastify';
import { fastifyTRPCPlugin } from '@trpc/server/adapters/fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import type { ProcedureSample, RefusalStatus } from '@intafaced/contracts/procedure';
import { SUPPORT_DESK_PROCEDURES } from '@intafaced/contracts/support-desk-procedures';
import { buildCaseFile, citeAccountState, groundingFor } from './case-file.js';
import { MacroError, type DeskMacros } from './desk-macros.js';
import type { DeskRouting } from './desk-routing.js';
import { createSupportRouter } from './router.js';
import { SupportError, type SupportService } from './support-service.js';
import type { TicketLinks } from './ticket-links.js';

/**
 * The mounted side of each record of svc-support's operator desk, through svc-support's whole router. Its path is on the
 * router with the record's own input and output parsers; each sample, sent through the production adapter by an agent,
 * reaches its verdict (a refused sample is answered 400, an accepted one 200); and every refusal the record lists, thrown
 * as the typed error svc-support makes it from, leaves with the status it names, under the strict check that fails on a
 * refusal the record does not list. The record's zod schema and its JSON export run the same samples in
 * `@intafaced/contracts` (`procedure-registry.test.ts`).
 */

const SECRET = 'a-support-desk-samples-edge-secret-long-enough';
const OPERATOR = '11111111-1111-4111-8111-111111111111';
const ID = '22222222-2222-4222-8222-222222222222';
const NOW = '2026-11-20T00:00:00.000Z';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-support' });
type DeskRecord = (typeof SUPPORT_DESK_PROCEDURES)[number];

function agent(): Record<string, string> {
  const principal = {
    sub: OPERATOR,
    userId: OPERATOR,
    sid: '33333333-3333-4333-8333-333333333333',
    scopes: ['support:read', 'support:write', 'support:ops'],
    tier: 'basic',
    mfa: false,
    expiresAt: new Date('2099-01-01T00:00:00Z'),
  } as Principal;
  const raw = encodePrincipal(principal);
  return { 'x-intafaced-principal': raw, 'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'), 'x-intafaced-region': 'DE' };
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Schema = Record<string, unknown>;

/** The smallest value a JSON Schema accepts by its shape: required fields only, the first member of each choice. */
function smallest(schema: Schema | undefined, defs: Record<string, Schema>, depth = 0): Json {
  if (!schema || depth > 12) return null;
  if (typeof schema.$ref === 'string') return smallest(defs[schema.$ref.split('/').pop() ?? ''], defs, depth + 1);
  if ('const' in schema) return schema.const as Json;
  if (Array.isArray(schema.enum)) return schema.enum[0] as Json;
  for (const key of ['anyOf', 'oneOf'] as const) {
    const options = schema[key];
    if (Array.isArray(options))
      return smallest((options as Schema[]).find((o) => o.type !== 'null') ?? (options as Schema[])[0], defs, depth + 1);
  }
  const type = Array.isArray(schema.type) ? (schema.type as string[]).find((t) => t !== 'null') : schema.type;
  switch (type) {
    case 'object': {
      const properties = (schema.properties ?? {}) as Record<string, Schema>;
      return Object.fromEntries(((schema.required ?? []) as string[]).map((k) => [k, smallest(properties[k], defs, depth + 1)]));
    }
    case 'array':
      return [];
    case 'string':
      if (schema.format === 'uuid') return ID;
      if (schema.format === 'date-time') return NOW;
      return 'x'.repeat(Math.max(1, typeof schema.minLength === 'number' ? schema.minLength : 1));
    case 'integer':
    case 'number':
      return typeof schema.minimum === 'number' ? schema.minimum : 1;
    case 'boolean':
      return true;
    default:
      return null;
  }
}

/** A real case file, as an escalation builds it: one the smallest-shape reply cannot make (its citations must ground it). */
const state = { userId: ID, status: 'frozen', kycTier: 'basic' } as const;
const built = buildCaseFile({
  ticketId: ID,
  escalatedBy: OPERATOR,
  reason: 'account_state',
  summary: 'Account frozen; the customer cannot withdraw.',
  citations: [citeAccountState(state, NOW)],
  grounding: groundingFor(state, NOW),
  now: new Date(NOW),
});
if (built.status !== 'ok') throw new Error('the case file fixture is refused');
const CASE_FILE = built.caseFile;

/** What the service answers for a record: the smallest valid reply, or the part a handler wraps (`{ macros }`, `{ counts }`). */
function replyFor(record: DeskRecord): unknown {
  const json = z.toJSONSchema(record.output, { io: 'output', unrepresentable: 'any' }) as Schema;
  const reply = smallest(json, (json.$defs ?? {}) as Record<string, Schema>);
  if (record.path === 'caseFile' || record.path === 'escalate') return CASE_FILE;
  if (record.path === 'macros') return (reply as { macros: Json }).macros;
  if (record.path === 'viewsCounts') return (reply as { counts: Json }).counts;
  return reply;
}

/** The one refusal every service method throws next; none means each answers `reply`. */
let planted: Error | null = null;
let reply: unknown = null;
const answer = () => {
  if (planted) throw planted;
  return reply;
};
const service = <T>() => new Proxy({}, { get: () => async () => answer() }) as T;

const supportRouter = createSupportRouter(
  service<SupportService>(),
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  service<DeskMacros>(),
  undefined,
  undefined,
  null,
  undefined,
  null,
  undefined,
  undefined,
  service<DeskRouting>(),
  undefined,
  service<TicketLinks>(),
);
const app = Fastify();

beforeAll(async () => {
  vi.stubEnv('PROCEDURE_REFUSALS_STRICT', '1');
  await app.register(fastifyTRPCPlugin, {
    prefix: '/trpc',
    trpcOptions: { router: supportRouter, createContext: ({ req }: { req: unknown }) => edgeContext(req as never) },
  });
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await app.close();
});

async function send(record: DeskRecord, input: unknown) {
  reply = replyFor(record);
  const url = `/trpc/${record.path}${record.kind === 'query' && input !== undefined ? `?input=${encodeURIComponent(JSON.stringify(input))}` : ''}`;
  return record.kind === 'query'
    ? app.inject({ method: 'GET', url, headers: agent() })
    : app.inject({
        method: 'POST',
        url,
        headers: { ...agent(), 'content-type': 'application/json' },
        payload: input === undefined ? '' : JSON.stringify(input),
      });
}

type Mounted = { _def: { inputs: unknown[]; output?: unknown } };
const mounted = (path: string): Mounted | undefined =>
  (Reflect.get(Reflect.get(supportRouter, '_def') as object, 'procedures') as Record<string, Mounted>)[path];

const HTTP: Record<RefusalStatus, number> = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  PRECONDITION_FAILED: 412,
  TOO_MANY_REQUESTS: 429,
  SERVICE_UNAVAILABLE: 503,
  TIMEOUT: 408,
  PAYLOAD_TOO_LARGE: 413,
};

/** The doors whose `support.macro_*` refusals come from the macro book (`MacroError`); everywhere else a code is a `SupportError`. */
const MACRO_DOORS = new Set(['macroApply', 'signatureSet']);
const typedError = (record: DeskRecord, code: string): Error =>
  MACRO_DOORS.has(record.path) && code.startsWith('support.macro_') ? new MacroError(code) : new SupportError(`refused: ${code}`, code);

const cases = SUPPORT_DESK_PROCEDURES.flatMap((record) =>
  record.samples.map((sample: ProcedureSample, i) => ({
    record,
    sample,
    label: `${record.name} #${i} ${sample.verdict} ${JSON.stringify(sample.input)}`,
  })),
);
const refusals = SUPPORT_DESK_PROCEDURES.flatMap((record) =>
  Object.entries(record.refusals).map(([code, status]) => ({ record, code, status, label: `${record.name} ${code}` })),
);

describe("svc-support's operator desk is mounted from its records", () => {
  it.each(SUPPORT_DESK_PROCEDURES)('$name is mounted at its path with its own input and output', (record) => {
    expect(record.service).toBe('svc-support');
    const procedure = mounted(record.path);
    expect(procedure, `${record.path} is not on the support router`).toBeDefined();
    if (record.samples.every((s: ProcedureSample) => s.input === undefined)) expect(procedure!._def.inputs).toEqual([]);
    else expect(procedure!._def.inputs).toContain(record.input);
    expect(procedure!._def.output).toBe(record.output);
  });

  it.each(cases)('$label', async ({ record, sample }) => {
    const res = await send(record, sample.input);
    if (sample.verdict === 'refuse') expect(res.statusCode, res.body).toBe(400);
    else expect(res.statusCode, res.body).toBe(200);
  });

  it.each(refusals)('$label leaves with the status its record names', async ({ record, code, status }) => {
    const accepted: ProcedureSample = record.samples.find((s: ProcedureSample) => s.verdict === 'accept')!;
    planted = typedError(record, code);
    try {
      const res = await send(record, accepted.input);
      expect(res.statusCode, res.body).toBe(HTTP[status]);
    } finally {
      planted = null;
    }
  });

  it('a refusal the record does not list fails the strict check instead of leaving', async () => {
    planted = new SupportError('refused', 'support.view_cap_reached');
    try {
      const res = await send(
        SUPPORT_DESK_PROCEDURES.find((r) => r.path === 'claim')!,
        { ticketId: ID },
      );
      expect(res.statusCode, res.body).toBe(500);
      expect(res.body).toContain('does not list it');
    } finally {
      planted = null;
    }
  });

  it('an agent without support:ops is refused before any handler runs', async () => {
    const raw = encodePrincipal({
      sub: OPERATOR,
      userId: OPERATOR,
      sid: '33333333-3333-4333-8333-333333333333',
      scopes: ['support:read', 'support:write'],
      tier: 'basic',
      mfa: false,
      expiresAt: new Date('2099-01-01T00:00:00Z'),
    } as Principal);
    const res = await app.inject({
      method: 'GET',
      url: `/trpc/staffList`,
      headers: {
        'x-intafaced-principal': raw,
        'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
        'x-intafaced-region': 'DE',
      },
    });
    expect(res.statusCode, res.body).toBe(403);
  });
});
