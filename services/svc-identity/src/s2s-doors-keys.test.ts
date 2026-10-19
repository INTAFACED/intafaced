import { generateKeyPairSync } from 'node:crypto';
import Fastify, { type FastifyRequest } from 'fastify';
import { fastifyTRPCPlugin } from '@trpc/server/adapters/fastify';
import { describe, expect, it } from 'vitest';
import {
  createServiceSigner,
  createServiceVerifier,
  currentAuthorityInputSchema,
  retainRawBody,
  router,
  serviceAuthHeadersForBody,
  serviceProcedure,
  type Keyring,
  type ServiceAuthMode,
  type ServiceName,
} from '@intafaced/contracts';
import { createIdentityRequestContext } from './controls/founder-context.js';
import { registerApiKeyOwnershipRoute } from './auth/api-key-ownership-route.js';
import { registerBusinessDirectoryRoutes, BUSINESS_DIRECTORY_HANDLES_PATH } from './business-directory.js';
import { registerNavigatorSessionRoutes, NAVIGATOR_SESSION_PATH } from './agents/navigator-session-routes.js';
import { registerClosureFinalize } from './closure/closure-job.js';
import type { AccountClosureService } from './closure/closure-service.js';

/**
 * Identity's inbound doors name the caller from its own service key once S2S is on. Keys here are generated per
 * run. The per-purpose secrets (owner, ws and edge authority) are replaced by checking the key's own name.
 */
const INTERNAL = 'identity-internal-secret-long-enough-for-hmac';
const WS = 'identity-ws-authority-secret-long-enough-for-hmac';
const EDGE = 'identity-edge-authority-secret-long-enough-hmac';
const TRADE = 'identity-trade-admission-secret-long-enough-hmac';
const USER = '11111111-1111-4111-8111-111111111111';
const API_KEY = '22222222-2222-4222-8222-222222222222';
const SERVICES = [
  'svc-ws',
  'svc-edge',
  'svc-trade',
  'svc-pay',
  'svc-bank',
  'svc-ops',
  'svc-matching',
] as const satisfies readonly ServiceName[];

function keyFor(service: ServiceName) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const pkcs8 = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url');
  const x = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url');
  return { pkcs8, entry: { kid: `${service}.a`, svc: service, use: 's2s' as const, x } };
}

function fleet() {
  const keys = SERVICES.map((service) => [service, keyFor(service)] as const);
  const keyring: Keyring = keys.map(([, k]) => k.entry);
  const signers = Object.fromEntries(
    keys.map(([service, k]) => [service, createServiceSigner({ service, kid: k.entry.kid, privateKey: k.pkcs8, keyring })]),
  ) as Record<(typeof SERVICES)[number], ReturnType<typeof createServiceSigner>>;
  return { signers, verifier: () => createServiceVerifier({ self: 'svc-identity', keyring }) };
}

type Fleet = ReturnType<typeof fleet>;
const keyed = (f: Fleet, service: (typeof SERVICES)[number], method: string, path: string, body?: string) => ({
  ...(body === undefined ? {} : { 'content-type': 'application/json' }),
  ...f.signers[service].headers({
    audience: 'svc-identity',
    method,
    url: new URL(`http://identity.test${path}`),
    body,
    ...(body === undefined ? {} : { context: { contentType: 'application/json' } }),
  }),
});
const legacy = (service: string, secret: string, body: string) => ({
  'content-type': 'application/json',
  ...serviceAuthHeadersForBody(service, secret, body),
});

function build(f: Fleet, mode: ServiceAuthMode | undefined) {
  const s2s = mode ? { verifier: f.verifier(), mode } : undefined;
  const config = {
    secret: 'identity-edge-principal-signing-key-long-enough',
    serviceName: 'svc-identity',
    internalSecret: INTERNAL,
    privateAuthoritySecret: WS,
    edgeAuthoritySecret: EDGE,
    operationAdmissionSecrets: { 'svc-trade': TRADE },
    ...(s2s ? { serviceVerifier: s2s.verifier, s2sMode: s2s.mode } : {}),
  };
  const createContext = createIdentityRequestContext(config);
  const calls: string[] = [];
  const routes = router({
    accountControls: router({
      currentAuthority: serviceProcedure.input(currentAuthorityInputSchema).mutation(() => ({ ok: true })),
      operatorEntitlement: serviceProcedure.mutation(() => ({ ok: true })),
    }),
    operationAdmission: router({ decide: serviceProcedure.mutation(() => ({ ok: true })) }),
    apiKeys: router({ exchange: serviceProcedure.mutation(() => ({ ok: true })) }),
    rank: router({ awardXp: serviceProcedure.mutation(() => ({ ok: true })) }),
  });
  const app = Fastify();
  retainRawBody(app);
  registerApiKeyOwnershipRoute(app, {
    ...config,
    s2s,
    installRawBody: false,
    door: {
      async getApiKeyOwnership() {
        return {
          id: API_KEY,
          userId: USER,
          revoked: false,
          ipAllowlist: [],
          productScopes: [],
          originAllowlist: [],
          domainWhitelist: [],
          requireSignature: false,
          requireNonEmptyIpAllowlist: false,
        };
      },
    },
  });
  registerBusinessDirectoryRoutes(app, {
    internalSecret: INTERNAL,
    s2s,
    installRawBody: false,
    store: {
      async handlesOf() {
        return [{ userId: USER, handle: 'Ada' }];
      },
      async findActiveByHandle() {
        return null;
      },
      async findActiveByEmail() {
        return null;
      },
    },
  });
  registerNavigatorSessionRoutes(app, {
    internalSecret: INTERNAL,
    s2s,
    store: { readSession: async () => null } as never,
    bodyBind: 'require',
    installRawBody: false,
  });
  registerClosureFinalize(app, {
    secret: INTERNAL,
    s2s,
    closure: {
      async finalize() {
        calls.push('finalize');
        return { finalized: 0 };
      },
    } as unknown as AccountClosureService,
  });
  void app.register(fastifyTRPCPlugin, {
    prefix: '/trpc',
    trpcOptions: { router: routes, createContext: ({ req }: { req: FastifyRequest }) => createContext(req) },
  });
  return { app, calls };
}

const AUTHORITY = JSON.stringify({ userId: USER, credential: { kind: 'api_key', apiKeyId: API_KEY } });
const trpc = (procedure: string, body = '{}') => ({ path: `/trpc/${procedure}`, body });

describe('identity plain doors with service keys', () => {
  it('names the caller from its key and still accepts the shared secret in dual', async () => {
    const f = fleet();
    const { app } = build(f, 'dual');
    const body = JSON.stringify({ userIds: [USER] });
    const path = BUSINESS_DIRECTORY_HANDLES_PATH;
    const viaKey = await app.inject({ method: 'POST', url: path, payload: body, headers: keyed(f, 'svc-bank', 'POST', path, body) });
    expect(viaKey.statusCode).toBe(200);
    const viaSecret = await app.inject({ method: 'POST', url: path, payload: body, headers: legacy('svc-bank', INTERNAL, body) });
    expect(viaSecret.statusCode).toBe(200);
    await app.close();
  });

  it('keypair refuses the shared secret everywhere; unwired keeps the old behaviour and ignores a key', async () => {
    const f = fleet();
    const path = BUSINESS_DIRECTORY_HANDLES_PATH;
    const body = JSON.stringify({ userIds: [USER] });
    const strict = build(f, 'keypair');
    expect(
      (await strict.app.inject({ method: 'POST', url: path, payload: body, headers: legacy('svc-bank', INTERNAL, body) })).statusCode,
    ).toBe(401);
    expect(
      (await strict.app.inject({ method: 'POST', url: path, payload: body, headers: keyed(f, 'svc-bank', 'POST', path, body) })).statusCode,
    ).toBe(200);
    await strict.app.close();
    const off = build(f, undefined);
    expect(
      (await off.app.inject({ method: 'POST', url: path, payload: body, headers: keyed(f, 'svc-bank', 'POST', path, body) })).statusCode,
    ).toBe(401);
    expect(
      (await off.app.inject({ method: 'POST', url: path, payload: body, headers: legacy('svc-bank', INTERNAL, body) })).statusCode,
    ).toBe(200);
    await off.app.close();
  });

  it('the caller is the key owner: the directory still answers only svc-bank', async () => {
    const f = fleet();
    const { app } = build(f, 'keypair');
    const path = BUSINESS_DIRECTORY_HANDLES_PATH;
    const body = JSON.stringify({ userIds: [USER] });
    const other = await app.inject({ method: 'POST', url: path, payload: body, headers: keyed(f, 'svc-ops', 'POST', path, body) });
    expect(other.statusCode).toBe(403);
    await app.close();
  });

  it('a replayed key-signed call and a call for another body are refused', async () => {
    const f = fleet();
    const { app } = build(f, 'keypair');
    const path = BUSINESS_DIRECTORY_HANDLES_PATH;
    const body = JSON.stringify({ userIds: [USER] });
    const once = keyed(f, 'svc-bank', 'POST', path, body);
    expect((await app.inject({ method: 'POST', url: path, payload: body, headers: once })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: path, payload: body, headers: once })).statusCode).toBe(401);
    const swapped = JSON.stringify({ userIds: [API_KEY] });
    expect(
      (await app.inject({ method: 'POST', url: path, payload: swapped, headers: keyed(f, 'svc-bank', 'POST', path, body) })).statusCode,
    ).toBe(401);
    await app.close();
  });

  it('a key-signed call that fails does not fall back to the shared secret it also carries', async () => {
    const f = fleet();
    const { app } = build(f, 'dual');
    const path = BUSINESS_DIRECTORY_HANDLES_PATH;
    const body = JSON.stringify({ userIds: [USER] });
    const stale = keyed(f, 'svc-bank', 'POST', path, '{"userIds":[]}');
    const both = { ...stale, ...serviceAuthHeadersForBody('svc-bank', INTERNAL, body), 'content-type': 'application/json' };
    expect((await app.inject({ method: 'POST', url: path, payload: body, headers: both })).statusCode).toBe(401);
    await app.close();
  });

  it('navigator session and the closure job accept a key and refuse the shared secret in keypair', async () => {
    const f = fleet();
    const { app, calls } = build(f, 'keypair');
    const nav = `${NAVIGATOR_SESSION_PATH}/s1`;
    const viaKey = await app.inject({ method: 'GET', url: nav, headers: keyed(f, 'svc-edge', 'GET', nav) });
    expect(viaKey.statusCode).toBe(503);
    const viaSecret = await app.inject({ method: 'GET', url: nav, headers: legacy('svc-edge', INTERNAL, '') });
    expect(viaSecret.statusCode).toBe(401);
    const job = '/internal/jobs/finalize-account-closures';
    const body = '{"limit":5}';
    expect((await app.inject({ method: 'POST', url: job, payload: body, headers: legacy('svc-ops', INTERNAL, body) })).statusCode).toBe(
      401,
    );
    expect(calls).toEqual([]);
    expect(
      (await app.inject({ method: 'POST', url: job, payload: body, headers: keyed(f, 'svc-ops', 'POST', job, body) })).statusCode,
    ).toBe(200);
    expect(calls).toEqual(['finalize']);
    await app.close();
  });

  it('api-key ownership: a key-signed svc-ws or svc-edge read works with no body and is refused with one', async () => {
    const f = fleet();
    const { app } = build(f, 'keypair');
    const path = `/internal/api-keys/${API_KEY}`;
    for (const reader of ['svc-ws', 'svc-edge', 'svc-trade'] as const) {
      expect((await app.inject({ method: 'GET', url: path, headers: keyed(f, reader, 'GET', path) })).statusCode, reader).toBe(200);
    }
    const body = '{"x":1}';
    const withBody = await app.inject({
      method: 'GET',
      url: path,
      payload: body,
      headers: keyed(f, 'svc-ws', 'GET', path, body),
    });
    expect(withBody.statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: path, headers: legacy('svc-ws', WS, '') })).statusCode).toBe(401);
    await app.close();
  });
});

describe('identity tRPC door with service keys', () => {
  const post = async (app: ReturnType<typeof build>['app'], headers: Record<string, string>, t: ReturnType<typeof trpc>) =>
    (await app.inject({ method: 'POST', url: t.path, payload: t.body, headers })).statusCode;

  it('currentAuthority is open to a key named svc-ws or svc-edge, and to no other service', async () => {
    const f = fleet();
    const { app } = build(f, 'keypair');
    const t = trpc('accountControls.currentAuthority', AUTHORITY);
    expect(await post(app, keyed(f, 'svc-ws', 'POST', t.path, t.body), t)).toBe(200);
    expect(await post(app, keyed(f, 'svc-edge', 'POST', t.path, t.body), t)).toBe(200);
    expect(await post(app, keyed(f, 'svc-trade', 'POST', t.path, t.body), t)).toBe(401);
    expect(await post(app, legacy('svc-ws', WS, t.body), t)).toBe(401);
    await app.close();
  });

  it('operationAdmission.decide is open to svc-trade and svc-pay keys only', async () => {
    const f = fleet();
    const { app } = build(f, 'keypair');
    const t = trpc('operationAdmission.decide');
    expect(await post(app, keyed(f, 'svc-trade', 'POST', t.path, t.body), t)).toBe(200);
    expect(await post(app, keyed(f, 'svc-pay', 'POST', t.path, t.body), t)).toBe(200);
    expect(await post(app, keyed(f, 'svc-bank', 'POST', t.path, t.body), t)).toBe(401);
    expect(await post(app, legacy('svc-trade', TRADE, t.body), t)).toBe(401);
    await app.close();
  });

  it('the signed API-key exchange is open to the svc-edge key only', async () => {
    const f = fleet();
    const { app } = build(f, 'keypair');
    const t = trpc('apiKeys.exchange');
    expect(await post(app, keyed(f, 'svc-edge', 'POST', t.path, t.body), t)).toBe(200);
    expect(await post(app, keyed(f, 'svc-ws', 'POST', t.path, t.body), t)).toBe(401);
    await app.close();
  });

  it('dual keeps the per-purpose secrets working for legacy callers, and a bad key never falls back to them', async () => {
    const f = fleet();
    const { app } = build(f, 'dual');
    const t = trpc('accountControls.currentAuthority', AUTHORITY);
    expect(await post(app, legacy('svc-ws', WS, t.body), t)).toBe(200);
    expect(await post(app, legacy('svc-ws', INTERNAL, t.body), t)).toBe(401);
    const stale = keyed(f, 'svc-ws', 'POST', t.path, '{"other":1}');
    const both = { ...stale, ...serviceAuthHeadersForBody('svc-ws', WS, t.body), 'content-type': 'application/json' };
    expect(await post(app, both, t)).toBe(401);
    await app.close();
  });

  it('a generic service procedure names the caller from its key and the shared secret works only in dual', async () => {
    const f = fleet();
    const t = trpc('rank.awardXp');
    const dual = build(f, 'dual');
    expect(await post(dual.app, keyed(f, 'svc-trade', 'POST', t.path, t.body), t)).toBe(200);
    expect(await post(dual.app, legacy('svc-trade', INTERNAL, t.body), t)).toBe(200);
    await dual.app.close();
    const strict = build(f, 'keypair');
    expect(await post(strict.app, legacy('svc-trade', INTERNAL, t.body), t)).toBe(401);
    expect(await post(strict.app, keyed(f, 'svc-trade', 'POST', t.path, t.body), t)).toBe(200);
    await strict.app.close();
  });

  it('operator entitlement (body-bound read) takes a key and refuses a replay', async () => {
    const f = fleet();
    const { app } = build(f, 'keypair');
    const t = trpc('accountControls.operatorEntitlement');
    const once = keyed(f, 'svc-bank', 'POST', t.path, t.body);
    expect(await post(app, once, t)).toBe(200);
    expect(await post(app, once, t)).toBe(401);
    await app.close();
  });
});
