import Fastify from 'fastify';
import { fastifyTRPCPlugin } from '@trpc/server/adapters/fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { IDENTITY_OAUTH_PROCEDURES } from '@intafaced/contracts/identity-oauth-procedures';
import type { OAuthApp } from '@intafaced/contracts/oauth';
import type { ProcedureSample } from '@intafaced/contracts/procedure';
import { createOAuthRouter } from './oauth-router.js';
import { OAuthService } from './oauth.js';

/**
 * The mounted side of each OAuth record's samples: sent through the production adapter by a caller the record admits, a
 * refused sample is answered 400 (the input is malformed), an accepted one never is. The record's zod schema and its JSON
 * export run the same samples in `@intafaced/contracts` (`procedure-registry.test.ts`).
 */

const SECRET = 'an-identity-samples-edge-secret-long-enough';
const USER = '11111111-1111-4111-8111-111111111111';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-identity' });

function signedIn(): Record<string, string> {
  const principal = {
    sub: USER,
    userId: USER,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes: ['identity:read', 'identity:write', 'admin:compliance'],
    tier: 'none',
    mfa: true,
    expiresAt: new Date('2099-01-01T00:00:00Z'),
  } as Principal;
  const raw = encodePrincipal(principal);
  return { 'x-intafaced-principal': raw, 'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'), 'x-intafaced-region': 'DE' };
}

const app: OAuthApp = {
  id: '22222222-2222-4222-8222-222222222222',
  clientId: 'ifc_sample',
  name: 'Sample app',
  description: null,
  logoUrl: null,
  redirectUrls: ['https://app.example.test/callback'],
  scopes: ['identity:read'],
  confidential: true,
  status: 'approved',
  createdAt: '2026-11-21T00:00:00.000Z',
  secretRolledAt: null,
};
/** The real class with no database: each method a sample reaches answers a valid reply. */
const service = Object.assign(Object.create(OAuthService.prototype) as OAuthService, {
  registerApp: async () => ({ app, clientSecret: null }),
  listApps: async () => [app],
  rollSecret: async () => ({ app, clientSecret: null }),
  reviewQueue: async () => [{ ...app, developerUserId: USER }],
  reviewApp: async () => app,
  preview: async () => ({ appName: app.name, appDescription: null, logoUrl: null, developerOwnAccount: false, scopes: app.scopes }),
  decide: async () => ({ redirectTo: 'https://app.example.test/callback?code=c&state=s' }),
  lifetimes: () => ({ codeTtlSeconds: null, accessTokenTtlSeconds: null }),
  exchange: async () => ({ accessToken: 'ifca_sample', tokenType: 'Bearer' as const, expiresIn: 3600, scope: app.scopes }),
});
const server = Fastify();

beforeAll(async () => {
  // A test stack, as the wire replay runs: the screening gate is not what these samples test.
  vi.stubEnv('APP_ENV', 'test');
  await server.register(fastifyTRPCPlugin, {
    prefix: '/trpc',
    trpcOptions: { router: createOAuthRouter(service), createContext: ({ req }: { req: unknown }) => edgeContext(req as never) },
  });
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await server.close();
});

const cases = IDENTITY_OAUTH_PROCEDURES.flatMap((record) =>
  record.samples.map((sample: ProcedureSample, i) => ({
    record,
    sample,
    label: `${record.name} #${i} ${sample.verdict} ${JSON.stringify(sample.input)}`,
  })),
);

describe("svc-identity's OAuth routes reach each record sample's verdict", () => {
  it.each(cases)('$label', async ({ record, sample }) => {
    const input = sample.input;
    const url = `/trpc/${record.path}${record.kind === 'query' && input !== undefined ? `?input=${encodeURIComponent(JSON.stringify(input))}` : ''}`;
    const res =
      record.kind === 'query'
        ? await server.inject({ method: 'GET', url, headers: signedIn() })
        : await server.inject({
            method: 'POST',
            url,
            headers: { ...signedIn(), 'content-type': 'application/json' },
            payload: input === undefined ? '' : JSON.stringify(input),
          });
    if (sample.verdict === 'refuse') expect(res.statusCode, res.body).toBe(400);
    else expect(res.statusCode, res.body).toBe(200);
  });
});
