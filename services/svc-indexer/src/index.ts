import Fastify from 'fastify';
import { createDb } from '@intafaced/db';
import { createEdgeContext } from '@intafaced/contracts';
import { checkAccess, edgeTrustFromEnv } from '@intafaced/config';
import { env } from './env.js';
import { NullChainSource } from './chain/memory-source.js';
import { EvmChainSource } from './chain/evm/source.js';
import { startTokenBackfill } from './explorer/token-backfill.js';
import { parseExplorerListLimit } from './explorer/blocks.js';
import { parseTxDropWindow } from './explorer/tx.js';
import { PostgresProjectionStore } from './projection/postgres-store.js';
import { Indexer } from './indexer.js';
import { shutdownIndexer } from './shutdown.js';
import { createIndexerRouter, type ChainProbe } from './router.js';
import { registerIndexerPublicHttp } from './public-http.js';
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
 * svc-indexer — chain → Postgres read models for `apps/web` (§17.5).
 *
 * The Protocol Plane keeps its state on chain, not in our ledger. A UI cannot
 * query a chain fast enough to render an order book, so this service follows
 * chain state and projects it into tables the app can query. It is the read
 * path, and only the read path.
 *
 * Three things this boot deliberately does not do:
 *
 *   · it loads no private key. A read model originates no transaction
 *   · it opens no ledger connection. This plane posts nothing — `custody-scan`
 *     asserts it and `sovereignty.test.ts` asserts it again
 *   · it does not invent a chain. Blank `INDEXER_RPC_URL` / `INDEXER_VENUE_ADDRESS`
 *     refuse at env load rather than inventing `http://evm:8545` or the fixture
 *     CLOB. `NullChainSource` remains for tests; boot uses the operator-named RPC.
 */

const db = createDb({ url: env.DATABASE_URL, schema: 'indexer', max: env.DATABASE_POOL_MAX, ssl: env.DATABASE_SSL }, {});

// The read model must exist before we claim to serve it — a missing table here
// is a missed migration, and it should fail at boot rather than on a user's
// first request.
const [table] = await db.sql<Array<{ exists: boolean }>>`
  SELECT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'indexer' AND table_name = 'blocks'
  ) AS exists
`;
if (!table?.exists) {
  throw new Error('indexer.blocks is missing — run migrations before starting svc-indexer');
}

const store = new PostgresProjectionStore(db.sql, env.INDEXER_CHAIN_ID);

/**
 * THE CHAIN THE OPERATOR NAMED.
 *
 * `INDEXER_RPC_URL` and `INDEXER_VENUE_ADDRESS` are required at env load.
 * Boot constructs `EvmChainSource`. SOCKET §13 `socket.evm-rpc` is closed:
 * real blocks, real hashes, real logs pulled by block hash, real reorg
 * detection. What remains open is `socket.clob-contracts` — no audited venue
 * emits the ABI in `chain/evm/abi.ts` yet, and `contracts/dev/DevVenue.sol` is
 * a test fixture that says so.
 *
 * Inventing `http://evm:8545` or the Anvil fixture address would mean a
 * machine follows a chain / CLOB nobody chose. `EvmChainSource` still refuses
 * an operator-set zero venue: `eth_getLogs` against `0x0` returns `[]` rather
 * than failing, which is an empty book nobody would ever question.
 * `NullChainSource` is the test stand-in when a suite does not mount an RPC.
 */
const evmSource = env.INDEXER_RPC_URL
  ? new EvmChainSource({
      chainId: env.INDEXER_CHAIN_ID,
      rpcUrl: env.INDEXER_RPC_URL,
      venue: env.INDEXER_VENUE_ADDRESS as `0x${string}`,
    })
  : null;
const source = evmSource ?? new NullChainSource(env.INDEXER_CHAIN_ID);
const chainSource = evmSource ? 'evm' : 'null';

/**
 * The live staleness probe behind `status.chain`.
 *
 * With no chain configured this still answers — it reports `kind: 'null'` and
 * says why in `reason`. "We were never given a chain" and "the chain is down"
 * are different facts and a surface that renders them identically is one that
 * will eventually render a stale book as a current one.
 */
const chainProbe: () => Promise<ChainProbe> = evmSource
  ? () => evmSource.probe()
  : async () => ({
      kind: 'null',
      rpcUrl: null,
      venue: null,
      reachable: false,
      observedChainId: null,
      chainHeight: null,
      venueDeployed: false,
      refusalCode: 'indexer.chain_not_configured',
      reason:
        'INDEXER_RPC_URL is not set, so this service is following no chain. Everything it serves is whatever ' +
        'was projected before, and nothing is advancing it. (SOCKET §13 socket.evm-rpc)',
    });

let ingestEnabled = env.INDEXER_INGEST_ENABLED;

const app = Fastify({ logger: { level: env.LOG_LEVEL }, maxParamLength: 5_000 });

const indexer = new Indexer({
  source,
  store,
  finalityDepth: env.INDEXER_FINALITY_DEPTH,
  batchSize: env.INDEXER_BATCH_SIZE,
  startHeight: env.INDEXER_START_HEIGHT,
  ingestEnabled: () => ingestEnabled,
  onError: (err, context) => app.log.error({ err, context }, 'indexer sync error'),
});

export const appRouter = createIndexerRouter({
  store,
  indexer,
  chainId: env.INDEXER_CHAIN_ID,
  finalityDepth: env.INDEXER_FINALITY_DEPTH,
  ingestEnabled: () => ingestEnabled,
  chainSource,
  chainProbe,
  venue: evmSource ? env.INDEXER_VENUE_ADDRESS : null,
  rpcUrl: env.INDEXER_RPC_URL || null,
  claimLiveClob: env.APP_ENV === 'prod',
  explorer: {
    listLimit: parseExplorerListLimit(env.INDEXER_EXPLORER_LIST_LIMIT),
    blocks: (q) => store.explorerBlocks(q),
    atHeight: (h) => store.explorerAtHeight(h),
    block: (q) => store.explorerBlock(q),
  },
  txs: {
    dropWindow: parseTxDropWindow(env.INDEXER_TX_DROP_WINDOW_SECONDS),
    indexed: (hash) => store.explorerTx(hash),
    pendingSince: (hash) => store.explorerTxPendingSince(hash),
    notePending: (hash, at) => store.noteExplorerTxPending(hash, at),
    lookup: (hash) => (evmSource ? evmSource.lookupExplorerTx(hash) : Promise.resolve(null)),
  },
  txList: (q) => store.explorerTxList(q),
  address: {
    txs: (q) => store.explorerAddressTxs(q),
    tokensBySymbol: (q) => store.explorerTokensBySymbol(q),
  },
});
export type AppRouter = typeof appRouter;

// Built before the listener opens: a service that cannot authenticate the edge
// must fail to start, not start and serve every request as anonymous
// (docs/decisions/mount-boundary.md).
const edgeContext = createEdgeContext({ secret: env.EDGE_PRINCIPAL_SECRET, ...edgeTrustFromEnv(env), serviceName: env.SERVICE_NAME });

await registerIndexerPublicHttp(app, {
  indexer,
  appRouter,
  serviceName: env.SERVICE_NAME,
  ingestEnabled: () => ingestEnabled,
  venue: evmSource ? env.INDEXER_VENUE_ADDRESS : null,
  claimLiveClob: env.APP_ENV === 'prod',
  dbPing: async () => {
    await db.sql`SELECT 1`;
  },
  createContext: ({ req }) => edgeContext(req),
  onTrpcError({ path, error }) {
    app.log.error({ path, err: error }, 'trpc error');
  },
});

/**
 * §22, asserted at boot rather than assumed.
 *
 * If a future edit ever makes this module custodial, or moves it off the
 * protocol plane, the service refuses to start instead of quietly beginning to
 * gate users who were promised they would never be gated.
 * This probe isolates the custody/plane invariant; actual request gates keep
 * their strict region and screening policy.
 */
const sovereignty = checkAccess({
  module: 'indexer',
  plane: 'protocol',
  region: 'XX',
  kycTier: 'none',
  regionFailClosed: false,
  screeningFailClosed: false,
});
if (sovereignty.code !== 'allowed.permissionless') {
  throw new Error(
    `THE SOVEREIGNTY LAW IS BROKEN (§22): checkAccess for module "indexer" on the protocol plane ` +
      `returned "${sovereignty.code}", not "allowed.permissionless". Refusing to start.`,
  );
}

/**
 * A boot-time chain check that LOGS rather than throws.
 *
 * Deliberate. Refusing to start would crash-loop a compose stack racing `evm`.
 * The process stays up, `/health` stays green, `status` names the refusal.
 * After a failed pass, data paths and `/ready` refuse so a last projection
 * is not served as live (D26-P1-I3 + serving-refuse lastError).
 */
if (evmSource) {
  const probe = await chainProbe();
  if (probe.reachable && probe.venueDeployed) {
    app.log.info({ ...probe }, 'chain reachable, venue deployed — projecting');
  } else {
    app.log.error({ ...probe }, 'chain not usable at boot — the projection cannot advance until this clears');
  }
}

indexer.start(env.INDEXER_POLL_INTERVAL_MS);

// Tokens that emitted only before the token read existed get their metadata once (D-explorer-03).
const tokenBackfill = evmSource
  ? startTokenBackfill(
      {
        unread: (limit) => store.explorerTokensUnread(limit),
        read: (addresses) => evmSource.readTokenMeta(addresses),
        write: (tokens, height) => store.writeExplorerTokenFacts(tokens, height),
      },
      app.log,
      60_000,
    )
  : null;

await app.listen({ host: env.HTTP_HOST, port: env.HTTP_PORT });
app.log.info(
  {
    port: env.HTTP_PORT,
    chainId: env.INDEXER_CHAIN_ID,
    chainSource,
    rpcUrl: env.INDEXER_RPC_URL || null,
    venue: evmSource ? env.INDEXER_VENUE_ADDRESS : null,
    startHeight: env.INDEXER_START_HEIGHT,
    finalityDepth: env.INDEXER_FINALITY_DEPTH,
  },
  'svc-indexer ready — non-custodial, permissionless, read-only',
);

/** The kill-switch surface `apps/admin` reaches (§14 admin controls). */
export function setIngestEnabled(next: boolean): void {
  ingestEnabled = next;
}

let shutdownPromise: Promise<void> | undefined;
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    // The token backfill only retries a read; stopping it first means no new pass starts against a closing pool.
    tokenBackfill?.stop();
    // SIGTERM followed by SIGINT shares the same drain and close sequence.
    void (shutdownPromise ??= shutdownIndexer({
      stopAndDrain: () => indexer.stopAndDrain(),
      closeApp: () => app.close(),
      closeDb: () => db.close(),
      logError: (err, message) => app.log.error({ err }, message),
      exit: (code) => process.exit(code),
    }));
  });
}
