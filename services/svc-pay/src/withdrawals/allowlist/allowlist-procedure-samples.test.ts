import Fastify from 'fastify';
import { fastifyTRPCPlugin } from '@trpc/server/adapters/fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { PAY_ALLOWLIST_PROCEDURES } from '@intafaced/contracts/pay-allowlist-procedures';
import type { ProcedureSample, RefusalStatus } from '@intafaced/contracts/procedure';
import { AllowlistError, type AllowlistErrorCode } from './errors.js';
import { createAllowlistRouter } from './router.js';
import type { AllowlistService } from './service.js';

/**
 * The mounted side of each `allowlist.*` record. Its path is on the router with the record's own input and output
 * parsers; each sample, sent through the production adapter by a caller the record admits, reaches its verdict (a refused
 * sample is answered 400, an accepted one 200); and every refusal the record lists leaves with the status it names, under
 * the strict check that fails on a refusal the record does not list. The record's zod schema and its JSON export run the
 * same samples in `@intafaced/contracts` (`procedure-registry.test.ts`).
 */

const SECRET = 'a-pay-allowlist-samples-edge-secret-long-enough';
const USER = '11111111-1111-4111-8111-111111111111';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-pay' });
type AllowlistRecord = (typeof PAY_ALLOWLIST_PROCEDURES)[number];

function signedIn(): Record<string, string> {
  const principal = {
    sub: USER,
    userId: USER,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes: ['trade:read', 'trade:write', 'trade:withdraw'],
    tier: 'full',
    mfa: true,
    expiresAt: new Date('2099-01-01T00:00:00Z'),
  } as Principal;
  const raw = encodePrincipal(principal);
  return { 'x-intafaced-principal': raw, 'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'), 'x-intafaced-region': 'DE' };
}

const change = {
  id: '33333333-3333-4333-8333-333333333333',
  userId: USER,
  op: 'add' as const,
  entryId: null,
  subject: { group: 'external_wallet' as const, assetId: 'USDC', address: '0x1111111111111111111111111111111111111111', label: 'Cold' },
  requestHash: 'a'.repeat(64),
  teamAccountId: '44444444-4444-4444-8444-444444444444',
  requiredApprovals: 2,
  approvalCount: 0,
  approvedByMe: false,
  status: 'waiting' as const,
  failureCode: null,
  createdAt: '2026-11-20T00:00:00.000Z',
  decidedAt: null,
};
const entry = {
  id: '55555555-5555-4555-8555-555555555555',
  userId: USER,
  group: 'external_wallet' as const,
  assetId: 'USDC',
  address: '0x1111111111111111111111111111111111111111',
  label: 'Cold',
  state: 'active' as const,
  createdBy: USER,
  suspendedReason: null,
  createdAt: '2026-11-20T00:00:00.000Z',
  lastUsedAt: null,
};
const mode = { userId: USER, enabled: true, setAt: '2026-11-20T00:00:00.000Z' };
const policy = { userId: USER, enabled: true, assetId: 'USDC', maxAmount: '250.5', setAt: '2026-11-20T00:00:00.000Z' };

/** What each method answers when it answers: a valid reply of its record. */
const replies: Record<string, unknown> = {
  mode,
  policy,
  setMode: { mode, change: { ...change, op: 'mode_off', subject: {} } },
  proposePolicy: { ...change, op: 'onetime_policy', subject: { enabled: true, assetId: 'USDC', maxAmount: '250.5' } },
  proposeAdd: change,
  proposeDelete: { ...change, op: 'delete', entryId: entry.id },
  approve: change,
  reject: change,
  cancel: change,
  get: change,
  listEntries: [entry],
  listChanges: [change],
  listForTeam: [change],
};
/** The one refusal the service throws next, by method; none means it answers. */
const next = new Map<string, AllowlistErrorCode>();
const service = new Proxy(
  {},
  {
    get: (_target, method: string) => async () => {
      const code = next.get(method);
      if (code !== undefined) throw new AllowlistError(code, `refused: ${code}`);
      return replies[method];
    },
  },
) as AllowlistService;
const methodOf = (record: AllowlistRecord) => record.path.split('.')[1]!;
const app = Fastify();
const allowlistRouter = createAllowlistRouter(service);

beforeAll(async () => {
  // A test stack, as the wire replay runs: the screening gate is not what these samples test.
  vi.stubEnv('APP_ENV', 'test');
  vi.stubEnv('PROCEDURE_REFUSALS_STRICT', '1');
  await app.register(fastifyTRPCPlugin, {
    prefix: '/trpc',
    trpcOptions: { router: allowlistRouter, createContext: ({ req }: { req: unknown }) => edgeContext(req as never) },
  });
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await app.close();
});

async function send(record: AllowlistRecord, input: unknown) {
  const url = `/trpc/${record.path}${record.kind === 'query' && input !== undefined ? `?input=${encodeURIComponent(JSON.stringify(input))}` : ''}`;
  return record.kind === 'query'
    ? app.inject({ method: 'GET', url, headers: signedIn() })
    : app.inject({
        method: 'POST',
        url,
        headers: { ...signedIn(), 'content-type': 'application/json' },
        payload: input === undefined ? '' : JSON.stringify(input),
      });
}

type Mounted = { _def: { inputs: unknown[]; output?: unknown } };
const mounted = (path: string): Mounted | undefined =>
  (Reflect.get(Reflect.get(allowlistRouter, '_def') as object, 'procedures') as Record<string, Mounted>)[path];

const HTTP: Record<RefusalStatus, number> = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  PRECONDITION_FAILED: 412,
  TOO_MANY_REQUESTS: 429,
  SERVICE_UNAVAILABLE: 503,
};

const cases = PAY_ALLOWLIST_PROCEDURES.flatMap((record) =>
  record.samples.map((sample: ProcedureSample, i) => ({
    record,
    sample,
    label: `${record.name} #${i} ${sample.verdict} ${JSON.stringify(sample.input)}`,
  })),
);
const refusals = PAY_ALLOWLIST_PROCEDURES.flatMap((record) =>
  Object.entries(record.refusals).map(([code, status]) => ({
    record,
    code: code as AllowlistErrorCode,
    status,
    label: `${record.name} ${code}`,
  })),
);

describe("svc-pay's allowlist routes are mounted from their records", () => {
  it.each(PAY_ALLOWLIST_PROCEDURES)('$name is mounted at its path with its own input and output', (record) => {
    expect(record.service).toBe('svc-pay');
    const procedure = mounted(record.path);
    expect(procedure, `${record.path} is not on the allowlist router`).toBeDefined();
    expect(procedure!._def.inputs).toContain(record.input);
    expect(procedure!._def.output).toBe(record.output);
  });

  it.each(cases)('$label', async ({ record, sample }) => {
    const res = await send(record, sample.input);
    if (sample.verdict === 'refuse') expect(res.statusCode, res.body).toBe(400);
    else expect(res.statusCode, res.body).toBe(200);
  });

  it.each(refusals)('$label leaves with the status its record names', async ({ record, code, status }) => {
    const accepted = record.samples.find((s: ProcedureSample) => s.verdict === 'accept')!;
    next.set(methodOf(record), code);
    try {
      const res = await send(record, accepted.input);
      expect(res.body).toContain(code);
      expect(res.statusCode, res.body).toBe(HTTP[status]);
    } finally {
      next.clear();
    }
  });

  it('a refusal the record does not list fails the strict check instead of leaving', async () => {
    next.set('get', 'allowlist.quorum_unset');
    try {
      const res = await send(
        PAY_ALLOWLIST_PROCEDURES.find((r) => r.path === 'allowlist.get')!,
        { changeId: change.id },
      );
      expect(res.statusCode, res.body).toBe(500);
      expect(res.body).toContain('does not list it');
    } finally {
      next.clear();
    }
  });
});
