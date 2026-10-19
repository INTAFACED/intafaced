import Fastify from 'fastify';
import { fastifyTRPCPlugin, type FastifyTRPCPluginOptions } from '@trpc/server/adapters/fastify';
import { edgeTrustFromEnv } from '@intafaced/config';
import { createEdgeContext } from '@intafaced/contracts';
import { SealedHouseTenantRegistry } from '@intafaced/execution-house-tenant';
import { registerProcessHooks, startTelemetry } from '@intafaced/telemetry';
import { env } from './env.js';
import { installOmsWriteRawBody } from './oms-write-hmac.js';
import { loadMatchingVenueHalt } from './oms-matching-venue-halt.js';
import { createExecutionApprovalClient } from './operator-desk.js';
import { createExecutionRouter, type ExecutionRouter } from './router.js';
import { registerStartBasketDoor } from './oms-basket-http.js';
import { registerKillParentDoor } from './oms-kill-parent-http.js';
import {
  FileAlgoPauseStore,
  FileApprovedAlgoParentStore,
  algoParentJournalPath,
  algoPauseJournalPath,
  requireExecutionEmsStorePath,
} from './file-algo-store.js';
import {
  FileFillAssignStore,
  FileFillConfirmStore,
  FileManualFillStore,
  fillAssignJournalPath,
  fillConfirmJournalPath,
  manualFillJournalPath,
} from './file-fill-store.js';
import { registerOmsDisplayQtyDoor } from './oms-iceberg-http.js';
import { registerOmsPegDoor } from './oms-peg-http.js';
import { registerOmsOcoDoor } from './oms-oco-http.js';
import { registerOmsBuyingPowerDoor } from './oms-buying-power-http.js';
import { registerOmsMmpDoor } from './oms-mmp-http.js';
import { registerOmsCareDoor } from './oms-care-http.js';
import { registerOmsKillDoor } from './oms-kill-http.js';
import { registerOmsTcaDoor } from './oms-tca-http.js';
import { registerOmsPaperDoor } from './oms-paper-http.js';
import { registerOmsMultivenueDoor } from './oms-multivenue-http.js';
import { buildExecutionVenueAccountMapsWithOperatorSupplement } from './venue-account-adapters.js';
import {
  buildExecutionVenueTradeMapsWithOperatorSupplement,
  describeExecutionVenueCredentialBoard,
  parseExecutionVenueIds,
  unionExecutionVenueIds,
} from './venue-adapters.js';
import { buildExecutionVenueMarketMapsWithPublicMdSupplement } from './venue-market-adapters.js';
import { buildTradeBookSnapshotMap } from './trade-book-snapshot.js';
import { FileEmsOrderStore } from './file-ems-order-store.js';
import { buildExecutionReadyResponse } from './ready-response.js';
import { createCaptureLakeRuntime } from './capture-lake-runtime.js';
import { finishSignalShutdown } from './signal-shutdown.js';

registerProcessHooks(
  startTelemetry({
    serviceName: env.SERVICE_NAME,
    endpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT,
    enabled: env.OTEL_ENABLED,
    environment: env.APP_ENV,
  }),
);

/**
 * svc-execution — house tenancy (D26-P0-01) + OMS plan/execute (D26-P1-X3).
 *
 * External spot venues construct adapters from EXECUTION_VENUE_IDS + per-venue EXECUTION_VENUE_{ID}_* credentials.
 * /ready reports constructed/configured + unprobed (this process does not ping venues).
 * Internal-book legs use the same OMS route and an explicitly injected submit adapter; no second book is created here.
 * In-memory sealed registry.
 */
const registry = new SealedHouseTenantRegistry();
const executionVenueIds = parseExecutionVenueIds(env.EXECUTION_VENUE_IDS);
const venueTradeMaps = buildExecutionVenueTradeMapsWithOperatorSupplement(executionVenueIds);
const venueAccountMaps = buildExecutionVenueAccountMapsWithOperatorSupplement(executionVenueIds);
const venueMarketMaps = buildExecutionVenueMarketMapsWithPublicMdSupplement(executionVenueIds);
const venueCredentialBoard = describeExecutionVenueCredentialBoard(
  unionExecutionVenueIds(executionVenueIds, venueTradeMaps.operatorSupplementVenueIds, venueAccountMaps.operatorSupplementVenueIds),
);
const emsStorePath = requireExecutionEmsStorePath(env.EXECUTION_EMS_STORE_PATH);
const emsStore = new FileEmsOrderStore(emsStorePath);
const tradeBookSnapshot = buildTradeBookSnapshotMap(env.TRADE_URL);
const captureLakeRuntime = createCaptureLakeRuntime(env);
const snapshotByVenue = captureLakeRuntime.wrapSnapshotMap({
  ...venueMarketMaps.snapshotByVenue,
  ...tradeBookSnapshot,
});
captureLakeRuntime.start();
const algoJobs = { enabled: env.EXECUTION_ALGO_JOBS_ENABLED };
const matchingVenueHalt = () => loadMatchingVenueHalt({ matchingUrl: env.MATCHING_URL });
const parentStore = new FileApprovedAlgoParentStore(algoParentJournalPath(emsStorePath));
const pauseStore = new FileAlgoPauseStore(algoPauseJournalPath(emsStorePath));
const fillConfirmStore = new FileFillConfirmStore(fillConfirmJournalPath(emsStorePath));
const manualFillStore = new FileManualFillStore(manualFillJournalPath(emsStorePath));
const fillAssignStore = new FileFillAssignStore(fillAssignJournalPath(emsStorePath));
const appRouter = createExecutionRouter(
  registry,
  venueTradeMaps.submitByVenue,
  venueTradeMaps.cancelByVenue,
  venueTradeMaps.fetchByVenue,
  venueTradeMaps.openOrdersByVenue,
  venueAccountMaps.balancesByVenue,
  venueAccountMaps.positionsByVenue,
  venueAccountMaps.railsByVenue,
  venueMarketMaps.fundingByVenue,
  venueMarketMaps.borrowByVenue,
  venueMarketMaps.latencyByVenue,
  venueMarketMaps.marketsByVenue,
  snapshotByVenue,
  emsStore,
  captureLakeRuntime.lake,
  pauseStore,
  parentStore,
  algoJobs,
  undefined, // paper default off
  fillConfirmStore,
  manualFillStore,
  fillAssignStore,
  matchingVenueHalt,
  env.MATCHING_URL,
  undefined,
  env.IDENTITY_URL && process.env.INTERNAL_SERVICE_SECRET && process.env.INTERNAL_SERVICE_SECRET.length >= 32
    ? createExecutionApprovalClient(env.IDENTITY_URL, process.env.INTERNAL_SERVICE_SECRET)
    : undefined,
);
const internalSecret = process.env.INTERNAL_SERVICE_SECRET;
const edgeContext = createEdgeContext({
  secret: env.EDGE_PRINCIPAL_SECRET,
  ...edgeTrustFromEnv(env),
  serviceName: env.SERVICE_NAME,
  ...(internalSecret && internalSecret.length >= 32 ? { internalSecret } : {}),
});

const app = Fastify({ logger: { level: env.LOG_LEVEL }, maxParamLength: 5_000 });
installOmsWriteRawBody(app);

app.get('/health', async () => ({ ok: true, service: env.SERVICE_NAME }));
app.get('/ready', async () =>
  buildExecutionReadyResponse({
    emsStorePath,
    tradeUrl: env.TRADE_URL ?? '',
    venueTradeConstructedVenueIds: venueTradeMaps.wiredVenueIds,
    operatorSupplementVenueIds: venueTradeMaps.operatorSupplementVenueIds,
    operatorAccountSupplementVenueIds: venueAccountMaps.operatorSupplementVenueIds,
    publicMdSupplementVenueIds: venueMarketMaps.publicMdSupplementVenueIds,
    venueCredentialBoard,
    venueAccountConstructedVenueIds: venueAccountMaps.wiredVenueIds,
    venueMarketConstructedVenueIds: venueMarketMaps.wiredVenueIds,
    emsAckCount: emsStore.list().length,
  }),
);

await app.register(fastifyTRPCPlugin, {
  prefix: '/trpc',
  trpcOptions: {
    router: appRouter,
    createContext: ({ req }) => edgeContext(req),
  } satisfies FastifyTRPCPluginOptions<ExecutionRouter>['trpcOptions'],
});

registerStartBasketDoor(app, {
  edgeContext,
  jobs: algoJobs,
  matchingVenueHalt,
  matchingUrl: env.MATCHING_URL,
  internalSecret,
});

registerOmsDisplayQtyDoor(app, {
  edgeContext,
  internalSecret,
});

registerOmsPegDoor(app, {
  edgeContext,
  internalSecret,
});
registerOmsOcoDoor(app, { edgeContext, internalSecret });
registerOmsBuyingPowerDoor(app, { edgeContext, internalSecret });
registerOmsMmpDoor(app, { edgeContext, internalSecret });
registerOmsCareDoor(app, { edgeContext, internalSecret });
registerOmsKillDoor(app, { edgeContext, emsStore, matchingVenueHalt, internalSecret });
registerKillParentDoor(app, {
  edgeContext,
  parentStore,
  pauseStore,
  emsStore,
  cancelByVenue: venueTradeMaps.cancelByVenue,
  matchingUrl: env.MATCHING_URL,
  internalSecret,
});
registerOmsTcaDoor(app, { edgeContext, emsStore, captureLake: captureLakeRuntime.lake, internalSecret });
registerOmsPaperDoor(app, { edgeContext, internalSecret });
registerOmsMultivenueDoor(app, { edgeContext, wiredVenueIds: venueTradeMaps.wiredVenueIds, internalSecret });

await app.listen({ host: env.HTTP_HOST, port: env.HTTP_PORT });
app.log.info({ port: env.HTTP_PORT }, 'svc-execution ready');

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    void finishSignalShutdown({
      stop: () => captureLakeRuntime.stop(),
      close: () => app.close(),
      exit: (code) => {
        process.exit(code);
      },
    });
  });
}
