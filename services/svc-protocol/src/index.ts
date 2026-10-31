import Fastify from 'fastify';
import { fastifyTRPCPlugin, type FastifyTRPCPluginOptions } from '@trpc/server/adapters/fastify';
import { createDb } from '@intafaced/db';
import { createEdgeContext } from '@intafaced/contracts';
import { JetStreamEventBus } from '@intafaced/events';
import { checkAccess, edgeTrustFromEnv } from '@intafaced/config';
import type { Address } from 'viem';
import { env } from './env.js';
import { protocolGasPosture, venueVaultFromKek } from './chain/policy-surface.js';
import * as schema from './db/schema.js';
import { PostgresAccountStore } from './db/postgres-store.js';
import { chainIdentityReader } from './chain/identity.js';
import { AccountRegistry } from './accounts/registry.js';
import { ProtocolChain } from './chain/client.js';
import { CHAIN_PUBLIC_TEXT, classifyChainError, isZeroAddress } from './chain/availability.js';
import { SessionRelay } from './session/relay.js';
import { ChainObserver } from './events.js';
import { protocolHealthHonesty } from './health-honesty.js';
import { createPeers } from './blockers/peers.js';
import { createProtocolRouter, type ProtocolRouter } from './router.js';
import { parseGasPercentileSetting } from './chain/gas-price.js';
import { badgeChainIsMainnet, badgeChainIsRestartable, badgeWindowFromSetting, noBadgeSigner } from './nft/founding-badge.js';
import { PostgresBadgeStore } from './nft/founding-badge.pg.js';
import { representationFromSetting } from './representation/representation.js';
import { PostgresRepresentationStore } from './representation/representation.pg.js';
import { walletSessionFromSetting } from './address-book/session.js';
import { PostgresAddressBookStore } from './address-book/book.pg.js';
import { challengeTtlFromSetting } from './listing/ownership.js';
import { PostgresListingStore } from './listing/ownership.pg.js';
import { badgeApprovalConsumer } from './nft/founding-badge-approval.js';
import { loadNetworkRegistry } from './networks/registry.js';
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
 * svc-protocol — the Protocol Plane's smart account layer (§17.4, §17.5).
 *
 * Boot order: database, bus, chain, then the server. Nothing serves a request
 * until every dependency it needs is proven up.
 *
 * Two things this boot deliberately does not do:
 *   · it loads no private key, because there is no transaction this service is
 *     entitled to originate on a user's account
 *   · it opens no ledger connection, because this plane posts nothing
 */

const db = createDb({ url: env.DATABASE_URL, schema: 'protocol', max: env.DATABASE_POOL_MAX, ssl: env.DATABASE_SSL }, schema);

// The read model must exist before we claim to serve it — a missing table here
// is a missed migration, and it should fail at boot rather than on a user's
// first request.
for (const tableName of [
  'smart_accounts',
  'founding_badge_claims',
  'founding_badge_list',
  'founding_badge_mint_clears',
  'signing_representations',
  'wallet_contacts',
  'wallet_groups',
  'wallet_group_members',
  'listing_challenges',
  'listing_ownership_proofs',
]) {
  const [table] = await db.sql<Array<{ exists: boolean }>>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'protocol' AND table_name = ${tableName}
    ) AS exists
  `;
  if (!table?.exists) {
    throw new Error(`protocol.${tableName} is missing — run migrations before starting svc-protocol`);
  }
}

const bus = await JetStreamEventBus.connect({
  servers: env.NATS_URL,
  producer: env.SERVICE_NAME,
  streamPrefix: env.NATS_STREAM_PREFIX,
  ownedStreams: ['protocol'],
});

const chain = new ProtocolChain({
  chainId: env.PROTOCOL_CHAIN_ID,
  rpcUrl: env.PROTOCOL_RPC_URL,
  entryPoint: env.PROTOCOL_ENTRYPOINT_ADDRESS as Address,
  factory: env.PROTOCOL_FACTORY_ADDRESS as Address,
  implementation: env.PROTOCOL_IMPLEMENTATION_ADDRESS as Address,
  tokenFactory: env.PROTOCOL_TOKEN_FACTORY_ADDRESS as Address,
  ...(env.PROTOCOL_BUNDLER_URL ? { bundlerUrl: env.PROTOCOL_BUNDLER_URL } : {}),
});

/** S-A10/A11 — stated at boot; sponsorship refuses until Nitro funds a deposit. */
const gasPosture = protocolGasPosture({ bundlerUrl: env.PROTOCOL_BUNDLER_URL });

/** S-L6 — wrap missing until HSM/Nitro; withdrawal keys never enter the vault. */
const venueVault = venueVaultFromKek(env.PROTOCOL_VENUE_VAULT_WRAP);

/** One chain identity reader for the process, so the registry, the badge and listing see a restart together. */
const chainIdentity = chainIdentityReader(chain);

const registry = new AccountRegistry(
  new PostgresAccountStore(db.drizzle),
  {
    chainId: env.PROTOCOL_CHAIN_ID,
    factory: env.PROTOCOL_FACTORY_ADDRESS as Address,
    implementation: env.PROTOCOL_IMPLEMENTATION_ADDRESS as Address,
  },
  // A deployment seen on a TEST chain since started again is not one on this chain (chain/identity.ts).
  chainIdentity,
);

const relay = new SessionRelay(chain);

let relayEnabled = env.PROTOCOL_RELAY_ENABLED;

// Raw APP_ENV, not the schema's default: an unset APP_ENV must not pass for the local test stack.
const representationSetting = representationFromSetting(
  env.PROTOCOL_REPRESENTATION_VERSION,
  env.PROTOCOL_REPRESENTATION_TEXT,
  process.env.APP_ENV,
);

// Raw APP_ENV again: a TEST session secret refuses to boot anywhere but the local test stack.
const walletSessionSetting = walletSessionFromSetting(
  env.PROTOCOL_WALLET_SESSION_SECRET,
  env.PROTOCOL_WALLET_SESSION_TTL_SECONDS,
  env.PROTOCOL_WALLET_SESSION_ORIGINS,
  process.env.APP_ENV,
);
const listingChallengeTtl = challengeTtlFromSetting(env.PROTOCOL_LISTING_CHALLENGE_TTL_SECONDS, process.env.APP_ENV);

export const appRouter = createProtocolRouter({
  chainIdentity,
  opsWindowSeconds: () => env.PROTOCOL_OPS_WINDOW_SECONDS,
  gasPercentiles: () => parseGasPercentileSetting(env.PROTOCOL_GAS_PERCENTILES, env.PROTOCOL_GAS_HISTORY_BLOCKS),
  chain,
  registry,
  relay,
  relayEnabled: () => relayEnabled,
  ammFactoryAddress: () => env.PROTOCOL_AMM_FACTORY_ADDRESS as `0x${string}`,
  swapSlippageBps: () => env.PROTOCOL_SWAP_SLIPPAGE_BPS,
  swapQuoteTtlSeconds: () => env.PROTOCOL_SWAP_QUOTE_TTL_SECONDS,
  swapConfirmations: () => env.PROTOCOL_SWAP_CONFIRMATIONS,
  swapFeeCapWei: () => env.PROTOCOL_SWAP_MAX_FEE_PER_GAS_WEI,
  priceSetting: () =>
    env.PROTOCOL_PRICE_USD_TOKENS && env.PROTOCOL_PRICE_MIN_RESERVE_USD !== null
      ? { usdTokens: env.PROTOCOL_PRICE_USD_TOKENS, minReserveUsd: env.PROTOCOL_PRICE_MIN_RESERVE_USD }
      : null,
  tokensQuoteToken: () => env.PROTOCOL_TOKENS_QUOTE_TOKEN,
  probeTimeoutMs: () => env.PROTOCOL_PEER_TIMEOUT_MS,
  listing: {
    store: new PostgresListingStore(db.sql),
    ttlSeconds: () => listingChallengeTtl,
  },
  representation: {
    store: new PostgresRepresentationStore(db.sql),
    setting: () => representationSetting,
  },
  addressBook: {
    store: new PostgresAddressBookStore(db.sql),
    session: () => walletSessionSetting,
    maxContacts: () => env.PROTOCOL_ADDRESS_BOOK_MAX_CONTACTS,
    maxGroups: () => env.PROTOCOL_WALLET_GROUPS_MAX,
  },
  badge: {
    store: new PostgresBadgeStore(db.sql),
    minter: noBadgeSigner,
    window: () => badgeWindowFromSetting(env.PROTOCOL_BADGE_WINDOW_OPENS_AT, env.PROTOCOL_BADGE_WINDOW_CLOSES_AT),
    mainnet: () => badgeChainIsMainnet(env.PROTOCOL_CHAIN_ID, loadNetworkRegistry()),
    // Raw APP_ENV: only the local test stack (or a `local` chain) resets a claim when the chain starts again.
    restartable: () => badgeChainIsRestartable(env.PROTOCOL_CHAIN_ID, loadNetworkRegistry(), process.env.APP_ENV),
    approvals: badgeApprovalConsumer(env.IDENTITY_URL, env.INTERNAL_SERVICE_SECRET),
    stuckMintAgeSeconds: () => env.PROTOCOL_BADGE_STUCK_MINT_AGE_SECONDS,
  },
  peers: createPeers({
    indexer: { url: env.INDEXER_URL, timeoutMs: env.PROTOCOL_PEER_TIMEOUT_MS },
    dex: { url: env.DEX_URL, timeoutMs: env.PROTOCOL_PEER_TIMEOUT_MS },
  }),
});
export type AppRouter = typeof appRouter;

// Built before the listener opens: a service that cannot authenticate the edge
// must fail to start, not start and serve every request as anonymous.
const edgeContext = createEdgeContext({ secret: env.EDGE_PRINCIPAL_SECRET, ...edgeTrustFromEnv(env), serviceName: env.SERVICE_NAME });

const app = Fastify({ logger: { level: env.LOG_LEVEL }, maxParamLength: 5_000 });

const observer = new ChainObserver({
  chain,
  bus,
  registry,
  onError: (err, context) => app.log.error({ err, context }, 'chain observer error'),
});

app.get('/health', async () =>
  protocolHealthHonesty({
    relayEnabled,
    factoryConfigured: !isZeroAddress(env.PROTOCOL_FACTORY_ADDRESS) && !isZeroAddress(env.PROTOCOL_IMPLEMENTATION_ADDRESS),
    venueVaultConfigured: venueVault !== null,
  }),
);

/**
 * Readiness is about the chain, not about us: a service that cannot read the
 * chain cannot answer any question a user has, so it leaves the rotation.
 */
app.get('/ready', async (_req, reply) => {
  try {
    await chain.client.getBlockNumber();
    return { ready: true };
  } catch (err) {
    const refusal = classifyChainError(err, 'ready', env.PROTOCOL_RPC_URL);
    return reply.code(503).send({ ready: false, code: refusal.code, reason: CHAIN_PUBLIC_TEXT[refusal.code] });
  }
});

/**
 * §22, asserted at boot rather than assumed.
 *
 * If a future edit ever makes this module custodial, or moves it off the
 * protocol plane, the service refuses to start instead of quietly beginning to
 * gate users who were promised they would never be gated.
 * This startup probe isolates the custody/plane invariant from deployment
 * screening and region policy. Request access still uses the strict defaults.
 */
const sovereignty = checkAccess({
  module: 'protocol',
  plane: 'protocol',
  region: 'XX',
  kycTier: 'none',
  regionFailClosed: false,
  screeningFailClosed: false,
});
if (sovereignty.code !== 'allowed.permissionless') {
  throw new Error(
    `THE SOVEREIGNTY LAW IS BROKEN (§22): checkAccess for module "protocol" on the protocol plane ` +
      `returned "${sovereignty.code}", not "allowed.permissionless". Refusing to start.`,
  );
}

// Mount the public API. Built router + edgeContext without this registration is
// a healthy empty door: edge routes /api/protocol here, web calls /trpc, and
// nothing answers (full audit L6-1, 2026-07-29).
await app.register(fastifyTRPCPlugin, {
  prefix: '/trpc',
  trpcOptions: {
    router: appRouter,
    createContext: ({ req }) => edgeContext(req),
  } satisfies FastifyTRPCPluginOptions<AppRouter>['trpcOptions'],
});

observer.start();

await app.listen({ host: env.HTTP_HOST, port: env.HTTP_PORT });
app.log.info(
  {
    port: env.HTTP_PORT,
    chainId: env.PROTOCOL_CHAIN_ID,
    factory: env.PROTOCOL_FACTORY_ADDRESS,
    trpc: true,
    bundlerSubmitVia: gasPosture.bundler.submitVia,
    sponsorship: gasPosture.sponsorshipSample.allow ? 'open' : gasPosture.sponsorshipSample.reason,
  },
  'svc-protocol ready — non-custodial, permissionless',
);

/** The kill-switch surface `apps/admin` reaches (§14 admin controls). */
export function setRelayEnabled(next: boolean): void {
  relayEnabled = next;
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    void (async () => {
      observer.stop();
      await app.close();
      await bus.close();
      await db.close();
      process.exit(0);
    })();
  });
}
