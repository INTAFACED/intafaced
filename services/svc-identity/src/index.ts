import Fastify from 'fastify';
import postgres from 'postgres';
import { fastifyTRPCPlugin, type FastifyTRPCPluginOptions } from '@trpc/server/adapters/fastify';
import { createEdgeContext, mergeRouters, verifyServiceHeaders } from '@intafaced/contracts';
import { JetStreamEventBus } from '@intafaced/events';
import { env } from './env.js';
import { AuthService } from './auth/auth-service.js';
import { PlaceDoor } from './auth/place-door.js';
import { registerApiKeyOwnershipRoute } from './auth/api-key-ownership-route.js';
import { assertProdTotpKey } from './auth/totp-crypto.js';
import { RankService } from './rank/rank-service.js';
import { ReferralService } from './affiliates/referral-service.js';
import { ShareService } from './affiliates/share-service.js';
import { FreezeService } from './affiliates/freeze-service.js';
import { SqlAccrualStore } from './affiliates/accrual-store.js';
import { parseAccrualTierLawJson } from './affiliates/commission-rate-law.js';
import { createLedgerClient } from './ledger-client.js';
import { assertArgon2Available, argon2Available } from './auth/passwords.js';
import { createIdentityRouter } from './router.js';
import { createApiKeyIpRouter } from './api-key-ip-router.js';
import { createApiKeyOriginRouter } from './api-key-origin-router.js';
import { createApiKeyAccountRouter } from './api-key-account-router.js';
import { createApiKeyRotateRouter } from './api-key-rotate-router.js';
import { createApiKeyExpireRouter } from './api-key-expire-router.js';
import { createApiKeyRevokeAllRouter } from './api-key-revoke-all-router.js';
import { createSessionRevokeAllRouter } from './session-revoke-all-router.js';
import { createSessionRevokeRouter } from './session-revoke-router.js';
import { createListSessionsRouter } from './list-sessions-router.js';
import { createPanicRevokeRouter } from './panic-revoke-router.js';
import { createApiKeyProductRouter } from './api-key-product-router.js';
import { createDisableUserRouter } from './disable-user-router.js';
import { createOrgRouter } from './org-router.js';
import { createEnrollPasskeyRouter } from './enroll-passkey-router.js';
import { createVerifyPasskeyRouter } from './verify-passkey-router.js';
import { installDisabledMintRefuse } from './auth/disable-user.js';
import { installPasskeyMintRefuse } from './auth/mint-api-key-passkey.js';
import { installApiKeyIpExchange, requestIpAls } from './auth/auth-service-ip.js';
import { installApiKeyProductExchange, requestProductAls } from './auth/auth-service-product.js';
import { installApiKeyAccountExchange } from './auth/bind-api-key-account.js';
import { bootKycVault } from './kyc/boot-vault.js';
import { SqlWaitlistStore } from './waitlist/waitlist-store.js';
import { WaitlistService } from './waitlist/waitlist-service.js';
import { registerAffiliateProducerAccrue } from './affiliates/producer-accrue.js';
import { registerAffiliateProducerPayout } from './affiliates/producer-payout.js';
import { createNavigatorSessionStore } from './agents/navigator-session-store.js';
import { registerNavigatorSessionRoutes } from './agents/navigator-session-routes.js';
import { subscribeBlueprintProfileEvents, subscribeXpEvents } from './events.js';
import { registerProcessHooks, startTelemetry } from '@intafaced/telemetry';

// §9 — register the TracerProvider before the first span is created.
// `@opentelemetry/api` alone is a no-op: without this call every span in
// ./tracing.ts is built, tagged and then discarded before it reaches the
// collector. Tracers grabbed at module scope resolve lazily through the proxy
// provider, so registering here still captures them.
registerProcessHooks(
  startTelemetry({
    serviceName: env.SERVICE_NAME,
    endpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT,
    enabled: env.OTEL_ENABLED,
    environment: env.APP_ENV,
  }),
);

/**
 * svc-identity — one account, one verification, one rank (§4.1).
 *
 * Graph W1-C: mount tRPC; verify edge-signed principal (mount-boundary #48).
 * Blueprint cascade: subscribe to blueprintCreated/Deleted so profiles.blueprint_id
 * tracks svc-blueprint without writing across service tables (§2 / §7.2).
 * XP: subscribe to xpEarned, so awards published by svc-p2p and svc-trade reach
 * rank_state. Until this consumer existed they reached nothing — see ./events.ts.
 */

if (env.APP_ENV === 'prod') {
  await assertArgon2Available();
  // TOTP secrets must not sit base32-plaintext in prod; refuse boot without key.
  assertProdTotpKey(env);
}

const sql = postgres(env.DATABASE_URL, {
  max: env.DATABASE_POOL_MAX,
  ssl: env.DATABASE_SSL ? 'require' : false,
  connection: { search_path: 'identity,public', application_name: env.SERVICE_NAME },
  onnotice: () => undefined,
});

await sql`SELECT 1 FROM users LIMIT 1`.catch(() => {
  throw new Error('identity schema is missing — run migrations before starting svc-identity');
});

const bus = await JetStreamEventBus.connect({
  servers: env.NATS_URL,
  producer: env.SERVICE_NAME,
  streamPrefix: env.NATS_STREAM_PREFIX,
  ownedStreams: ['identity'],
});

const rank = new RankService(sql, bus);
await rank.seedTiers();

/** §7.2 cascade — must be wired before traffic; durable consumers catch up on restart. */
const blueprintSubs = await subscribeBlueprintProfileEvents(bus, sql);

/**
 * XP from every other module. Wired here rather than inside `RankService`
 * because the service is also called directly by our own auth flows and by
 * `awardXp` over tRPC — the bus is a fourth caller of the same method, not a
 * different way of writing rank_state.
 *
 * `identity` is our own stream, so this cannot fail on a stream that does not
 * exist yet; svc-p2p and svc-trade publish into it.
 */
const xpSub = await subscribeXpEvents(bus, rank);

const auth = new AuthService(
  sql,
  bus,
  rank,
  {
    secret: env.JWT_ACCESS_SECRET,
    issuer: env.JWT_ISSUER,
    audience: env.JWT_AUDIENCE,
    accessTtlSeconds: env.JWT_ACCESS_TTL_SECONDS,
    refreshTtlSeconds: env.JWT_REFRESH_TTL_SECONDS,
  },
  {
    rpID: env.WEBAUTHN_RP_ID,
    rpName: env.WEBAUTHN_RP_NAME,
    origin: env.WEBAUTHN_ORIGIN.split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  },
  env.IDENTITY_TOTP_SECRET_KEY,
  undefined,
  undefined,
  env.IDENTITY_MAX_SUB_ACCOUNTS,
);

const placeDoor = new PlaceDoor(sql);

const referral = new ReferralService(sql);
const share = new ShareService(sql);
const freeze = new FreezeService(sql);
const accruals = new SqlAccrualStore(sql);
/** Fail boot on malformed owner rates — never invent commission percentages. */
const accrualTierLaw = parseAccrualTierLawJson(env.IDENTITY_AFFILIATE_ACCRUAL_TIERS_JSON);

/**
 * The affiliate payout rail. Compose sets LEDGER_URL to in-network svc-ledger.
 * Absent (non-compose / omitted) → payout refuses `affiliate.payout.ledger_unwired`
 * rather than reporting a payment it could not make. No localhost default.
 */
const ledger = env.LEDGER_URL ? createLedgerClient(env.LEDGER_URL, env.INTERNAL_SERVICE_SECRET) : undefined;

/**
 * §10 KYC encrypted vault. Unset IDENTITY_KYC_DOC_KEY → vault null (procedures
 * named-refuse `[kyc_doc.unwired]`). Set but invalid → boot throws `kyc_doc.key_missing`
 * (not a silent missing store). Never invent a key. Live vendor webhook remains Class X.
 */
const vault = bootKycVault(sql, env.IDENTITY_KYC_DOC_KEY);

const waitlist = new WaitlistService(new SqlWaitlistStore(sql), {
  drop: env.LAUNCH_DROP,
  env: {
    INTAFACED_FLAG_WAITLIST_ENABLED: env.INTAFACED_FLAG_WAITLIST_ENABLED,
    INTAFACED_FLAG_REFERRAL_QUEUE: env.INTAFACED_FLAG_REFERRAL_QUEUE,
  },
});

installApiKeyIpExchange(auth, sql);
installApiKeyAccountExchange(auth, sql);
installApiKeyProductExchange(auth, sql);
installDisabledMintRefuse(auth, sql);
installPasskeyMintRefuse(auth, sql);

export const appRouter = mergeRouters(
  createIdentityRouter(auth, rank, {
    registrationOpen: env.REGISTRATION_OPEN,
    webauthnEnabled: env.WEBAUTHN_ENABLED,
    referral,
    share,
    freeze,
    accruals,
    accrualTierLaw,
    ledger,
    ...(vault ?? {}),
    waitlist,
  }),
  createApiKeyIpRouter(sql, auth),
  createApiKeyOriginRouter(sql, auth),
  createApiKeyAccountRouter(sql, auth),
  createApiKeyRotateRouter(sql, auth),
  createApiKeyExpireRouter(sql),
  createApiKeyRevokeAllRouter(sql),
  createSessionRevokeAllRouter(sql),
  createSessionRevokeRouter(sql),
  createListSessionsRouter(sql),
  createPanicRevokeRouter(sql),
  createApiKeyProductRouter(sql, auth),
  createDisableUserRouter(sql),
  createOrgRouter(sql),
  createEnrollPasskeyRouter(sql, {
    rpId: env.WEBAUTHN_RP_ID,
    rpName: env.WEBAUTHN_RP_NAME,
    origin: env.WEBAUTHN_ORIGIN,
  }),
  createVerifyPasskeyRouter(sql, {
    rpId: env.WEBAUTHN_RP_ID,
    rpName: env.WEBAUTHN_RP_NAME,
    origin: env.WEBAUTHN_ORIGIN,
  }),
);
export type AppRouter = typeof appRouter;

const edgeContext = createEdgeContext({
  secret: env.EDGE_PRINCIPAL_SECRET,
  serviceName: env.SERVICE_NAME,
  internalSecret: env.INTERNAL_SERVICE_SECRET,
});

const app = Fastify({ logger: { level: env.LOG_LEVEL }, maxParamLength: 5_000 });

app.addHook('onRequest', (req, _reply, done) => {
  const rawIp = req.headers['x-forwarded-for'] ?? req.headers['x-real-ip'];
  const forwarded = Array.isArray(rawIp) ? rawIp[0] : rawIp;
  const clientIp = typeof forwarded === 'string' ? forwarded.split(',')[0]?.trim() : undefined;
  const rawProduct = req.headers['x-product'];
  const productHeader = Array.isArray(rawProduct) ? rawProduct[0] : rawProduct;
  const clientProduct = typeof productHeader === 'string' ? productHeader.trim() : undefined;
  requestIpAls.run(clientIp || undefined, () => {
    requestProductAls.run(clientProduct || undefined, () => done());
  });
});

app.get('/health', async () => ({ ok: true, service: env.SERVICE_NAME }));
app.get('/ready', async () => ({ ready: true, argon2: await argon2Available() }));

/**
 * D26-P1-O2: fee producers (svc-trade / svc-pay) accrue under owner rate law.
 * Same durable store as affiliates.accrue — no ledger post. Body-bound S2S.
 */
registerAffiliateProducerAccrue(app, {
  internalSecret: env.INTERNAL_SERVICE_SECRET,
  referral,
  freeze,
  accruals,
  accrualTierLaw,
});

registerAffiliateProducerPayout(app, {
  internalSecret: env.INTERNAL_SERVICE_SECRET,
  freeze,
  accruals,
  accrualTierLaw,
  ledger,
  // Accrue already installed retainRawBody on this instance.
  installRawBody: false,
});

const navigatorSessionStore = createNavigatorSessionStore(sql);
registerNavigatorSessionRoutes(app, { internalSecret: env.INTERNAL_SERVICE_SECRET, store: navigatorSessionStore });

/**
 * Service-to-service rank perks (svc-trade reads at order accept).
 * Authenticated by the shared service secret — same control as bank jobs (#62).
 * Previously unauthenticated (full audit L2-3).
 */
app.get<{ Params: { userId: string } }>('/internal/rank/:userId/perks', async (req, reply) => {
  if (verifyServiceHeaders(req.headers, env.INTERNAL_SERVICE_SECRET).service === null) {
    return reply.code(401).send({ error: 'service credentials required', code: 'identity.unauthenticated' });
  }
  return rank.perks(req.params.userId);
});

/**
 * Service-to-service sub-account ownership (svc-trade placeOrder gate).
 * Fail-closed at the caller: missing credentials → 401; unknown id → 404.
 * Body is the published `subAccountOwnershipSchema` contract.
 */
app.get<{ Params: { subAccountId: string } }>('/internal/sub-accounts/:subAccountId', async (req, reply) => {
  if (verifyServiceHeaders(req.headers, env.INTERNAL_SERVICE_SECRET).service === null) {
    return reply.code(401).send({ error: 'service credentials required', code: 'identity.unauthenticated' });
  }
  const row = await auth.getSubAccountOwnership(req.params.subAccountId);
  if (!row) {
    return reply.code(404).send({ error: 'sub-account not found', code: 'identity.sub_account_not_found' });
  }
  return row;
});

/**
 * Service-to-service API key ownership (place gate).
 * Fail-closed at the caller: missing credentials → 401; unknown id → 404.
 * Body is the published `apiKeyOwnershipSchema` contract (no permission scopes).
 * Bind lists ride as extra JSON fields so WS/edge live-check can read them.
 */
registerApiKeyOwnershipRoute(app, { door: placeDoor, internalSecret: env.INTERNAL_SERVICE_SECRET });

/**
 * Service-to-service session ownership (place gate).
 * Fail-closed at the caller: missing credentials → 401; unknown id → 404.
 * Body is the published `sessionOwnershipSchema` contract (includes revoked:true).
 */
app.get<{ Params: { sessionId: string } }>('/internal/sessions/:sessionId', async (req, reply) => {
  if (verifyServiceHeaders(req.headers, env.INTERNAL_SERVICE_SECRET).service === null) {
    return reply.code(401).send({ error: 'service credentials required', code: 'identity.unauthenticated' });
  }
  const row = await placeDoor.getSessionOwnership(req.params.sessionId);
  if (!row) {
    return reply.code(404).send({ error: 'session not found', code: 'identity.session_not_found' });
  }
  return row;
});

/**
 * Service-to-service account state (svc-support's grounding read).
 *
 * Three fields — status and KYC tier — published as `accountStateSchema`. It is
 * an S2S route and not a `scopedProcedure` for the same reason `/internal/rank`
 * is: the caller is svc-support acting for an operator who is NOT the account
 * holder, and the tRPC surface would need a user principal svc-support does not
 * hold. Making identity accept "trust me, this is a support person" instead
 * would be granting an authority no scope defines.
 *
 * Unknown user → 404, which the caller renders as "not read". It must never
 * render as an account in good standing.
 */
app.get<{ Params: { userId: string } }>('/internal/account/:userId', async (req, reply) => {
  if (verifyServiceHeaders(req.headers, env.INTERNAL_SERVICE_SECRET).service === null) {
    return reply.code(401).send({ error: 'service credentials required', code: 'identity.unauthenticated' });
  }
  const state = await auth.accountState(req.params.userId);
  if (!state) {
    return reply.code(404).send({ error: 'account not found', code: 'identity.account_not_found' });
  }
  return state;
});

await app.register(fastifyTRPCPlugin, {
  prefix: '/trpc',
  trpcOptions: {
    router: appRouter,
    createContext: ({ req }) => {
      const base = edgeContext({ headers: req.headers, id: req.id });
      // Origin for apiKeys.exchange domain_whitelist (edge-forwarded; not body).
      const raw = req.headers.origin ?? req.headers['x-forwarded-origin'];
      const clientOrigin = Array.isArray(raw) ? raw[0] : raw;
      return clientOrigin ? { ...base, clientOrigin } : base;
    },
  } satisfies FastifyTRPCPluginOptions<AppRouter>['trpcOptions'],
});

await app.listen({ host: env.HTTP_HOST, port: env.HTTP_PORT });
app.log.info(
  { port: env.HTTP_PORT, argon2: await argon2Available(), registrationOpen: env.REGISTRATION_OPEN, trpc: true },
  'svc-identity ready',
);

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    void (async () => {
      await app.close();
      await Promise.all([...blueprintSubs, xpSub].map((s) => s.unsubscribe()));
      await bus.close();
      await sql.end({ timeout: 5 });
      process.exit(0);
    })();
  });
}
