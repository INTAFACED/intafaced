import Fastify from 'fastify';
import { fastifyTRPCPlugin } from '@trpc/server/adapters/fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { IDENTITY_RECIPIENTS_PROCEDURES } from '@intafaced/contracts/identity-recipients-procedures';
import type { ProcedureSample } from '@intafaced/contracts/procedure';
import { createSavedRecipientsRouter } from './saved-recipients.router.js';
import { SavedRecipientService } from './saved-recipients.js';

/**
 * The mounted side of each saved-recipient record's samples: sent through the production adapter by a caller the record
 * admits, a refused sample is answered 400 (the input is malformed), an accepted one never is. The record's zod schema
 * and its JSON export run the same samples in `@intafaced/contracts` (`procedure-registry.test.ts`).
 */

const SECRET = 'an-identity-samples-edge-secret-long-enough';
const USER = '11111111-1111-4111-8111-111111111111';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-identity' });

function signedIn(): Record<string, string> {
  const principal = {
    sub: USER,
    userId: USER,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes: ['identity:read', 'identity:write'],
    tier: 'none',
    mfa: false,
    expiresAt: new Date('2099-01-01T00:00:00Z'),
  } as Principal;
  const raw = encodePrincipal(principal);
  return { 'x-intafaced-principal': raw, 'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'), 'x-intafaced-region': 'DE' };
}

const saved = { handle: 'alice', label: 'Alice', addedAt: '2026-11-19T00:00:00.000Z' };
/** The real class with no database: each method a sample reaches answers a valid reply. */
const service = Object.assign(Object.create(SavedRecipientService.prototype) as SavedRecipientService, {
  list: async () => [saved],
  add: async () => saved,
  remove: async () => ({ removed: true, handle: 'alice' }),
});
const app = Fastify();

beforeAll(async () => {
  // A test stack, as the wire replay runs: the screening gate is not what these samples test.
  vi.stubEnv('APP_ENV', 'test');
  await app.register(fastifyTRPCPlugin, {
    prefix: '/trpc',
    trpcOptions: { router: createSavedRecipientsRouter(service), createContext: ({ req }: { req: unknown }) => edgeContext(req as never) },
  });
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await app.close();
});

const cases = IDENTITY_RECIPIENTS_PROCEDURES.flatMap((record) =>
  record.samples.map((sample: ProcedureSample, i) => ({
    record,
    sample,
    label: `${record.name} #${i} ${sample.verdict} ${JSON.stringify(sample.input)}`,
  })),
);

describe("svc-identity's saved-recipient routes reach each record sample's verdict", () => {
  it.each(cases)('$label', async ({ record, sample }) => {
    const input = sample.input;
    const url = `/trpc/${record.path}${record.kind === 'query' && input !== undefined ? `?input=${encodeURIComponent(JSON.stringify(input))}` : ''}`;
    const res =
      record.kind === 'query'
        ? await app.inject({ method: 'GET', url, headers: signedIn() })
        : await app.inject({
            method: 'POST',
            url,
            headers: { ...signedIn(), 'content-type': 'application/json' },
            payload: input === undefined ? '' : JSON.stringify(input),
          });
    if (sample.verdict === 'refuse') expect(res.statusCode, res.body).toBe(400);
    else expect(res.statusCode, res.body).toBe(200);
  });
});
