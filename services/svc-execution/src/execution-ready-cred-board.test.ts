import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import { InMemoryEmsOrderStore } from './oms-ems-store.js';
import { buildExecutionReadyResponse } from './ready-response.js';
import { describeExecutionVenueCredentialBoard, unionExecutionVenueIds } from './venue-adapters.js';
import { executionSorMountVsTrackerBoardCard, executionSorTrackerBackendDoneBarMet } from './mount-vs-tracker.js';

const here = dirname(fileURLToPath(import.meta.url));
const indexSrc = () => readFileSync(join(here, 'index.ts'), 'utf8');

const apps: FastifyInstance[] = [];

afterEach(async () => {
  while (apps.length) {
    const app = apps.pop();
    if (app) await app.close();
  }
});

describe('execution ready venue credential board (D33)', () => {
  it('/ready exposes venueCredentialBoard from describeExecutionVenueCredentialBoard', () => {
    const src = indexSrc();
    expect(src).toContain('describeExecutionVenueCredentialBoard(');
    expect(src).toContain('unionExecutionVenueIds(');
    expect(src).toContain('venueCredentialBoard');
  });

  it('describeExecutionVenueCredentialBoard never invents configured venues', () => {
    const board = describeExecutionVenueCredentialBoard(['binance-spot', 'bybit-spot'], {});
    expect(board.venues).toHaveLength(2);
    expect(board.configuredVenueIds).toEqual([]);
    expect(board.inventsCredentials).toBe(false);
  });

  it('describeExecutionVenueCredentialBoard reports operator fallback wiring', () => {
    const board = describeExecutionVenueCredentialBoard(['okx-spot'], {
      VENUE_AGGREGATION_OKX_SPOT_API_KEY: 'k',
      VENUE_AGGREGATION_OKX_SPOT_API_SECRET: 's',
      VENUE_AGGREGATION_OKX_SPOT_PASSPHRASE: 'p',
    });
    expect(board.configuredVenueIds).toEqual(['okx-spot']);
    expect(board.venues[0]).toMatchObject({
      venueId: 'okx-spot',
      executionEnvConfigured: false,
      operatorEnvConfigured: true,
      configured: true,
    });
  });
});

describe('execution credential board supplement union (D36)', () => {
  it('unionExecutionVenueIds dedupes execution list and operator supplements', () => {
    expect(unionExecutionVenueIds(['binance-spot'], ['okx-spot'], ['binance-spot', 'bybit-spot'])).toEqual([
      'binance-spot',
      'okx-spot',
      'bybit-spot',
    ]);
  });

  it('credential board includes operator-only supplement venues', () => {
    const board = describeExecutionVenueCredentialBoard(unionExecutionVenueIds([], ['okx-spot']), {
      VENUE_AGGREGATION_OKX_SPOT_API_KEY: 'k',
      VENUE_AGGREGATION_OKX_SPOT_API_SECRET: 's',
      VENUE_AGGREGATION_OKX_SPOT_PASSPHRASE: 'p',
    });
    expect(board.configuredVenueIds).toEqual(['okx-spot']);
    expect(board.venues[0]).toMatchObject({
      venueId: 'okx-spot',
      operatorEnvConfigured: true,
      configured: true,
    });
  });
});

describe('execution /ready boot supplement fields (D43)', () => {
  it('index wires account and public MD supplement venue ids on /ready', () => {
    const src = indexSrc();
    expect(src).toContain('buildExecutionVenueAccountMapsWithOperatorSupplement');
    expect(src).toContain('buildExecutionVenueMarketMapsWithPublicMdSupplement');
    expect(src).toContain('operatorAccountSupplementVenueIds: venueAccountMaps.operatorSupplementVenueIds');
    expect(src).toContain('publicMdSupplementVenueIds: venueMarketMaps.publicMdSupplementVenueIds');
  });
});

describe('execution /ready boot trade supplement fields (D45)', () => {
  it('index wires trade supplement venue ids on /ready', () => {
    const src = indexSrc();
    expect(src).toContain('buildExecutionVenueTradeMapsWithOperatorSupplement');
    expect(src).toContain('operatorSupplementVenueIds: venueTradeMaps.operatorSupplementVenueIds');
  });
});

describe('execution /ready boot credential board union (D47)', () => {
  it('index wires supplement union into describeExecutionVenueCredentialBoard', () => {
    const src = indexSrc();
    expect(src).toContain(
      'unionExecutionVenueIds(executionVenueIds, venueTradeMaps.operatorSupplementVenueIds, venueAccountMaps.operatorSupplementVenueIds)',
    );
    expect(src).toContain('venueCredentialBoard');
  });
});

describe('execution /ready boot credential board on ready (D48)', () => {
  it('index passes venueCredentialBoard into buildExecutionReadyResponse on /ready', () => {
    const src = indexSrc();
    expect(src).toContain('buildExecutionReadyResponse({');
    expect(src).toContain('venueCredentialBoard,');
  });
});

describe('execution /ready boot constructed venue ids (D49)', () => {
  it('index wires trade, account, and market constructed venue ids on /ready', () => {
    const src = indexSrc();
    expect(src).toContain('venueTradeConstructedVenueIds: venueTradeMaps.wiredVenueIds');
    expect(src).toContain('venueAccountConstructedVenueIds: venueAccountMaps.wiredVenueIds');
    expect(src).toContain('venueMarketConstructedVenueIds: venueMarketMaps.wiredVenueIds');
  });
});

describe('execution /ready boot ems and trade url (D50)', () => {
  it('index passes emsAckCount and tradeUrl into buildExecutionReadyResponse on /ready', () => {
    const src = indexSrc();
    expect(src).toContain('emsStorePath,');
    expect(src).toContain('tradeUrl: env.TRADE_URL');
    expect(src).toContain('emsAckCount: emsStore.list().length');
  });
});

describe('execution /ready boot venue map builders (D51)', () => {
  it('index wires parseExecutionVenueIds and supplement map builders on boot', () => {
    const src = indexSrc();
    expect(src).toContain('parseExecutionVenueIds(env.EXECUTION_VENUE_IDS)');
    expect(src).toContain('buildExecutionVenueTradeMapsWithOperatorSupplement(executionVenueIds)');
    expect(src).toContain('buildExecutionVenueAccountMapsWithOperatorSupplement(executionVenueIds)');
    expect(src).toContain('buildExecutionVenueMarketMapsWithPublicMdSupplement(executionVenueIds)');
  });
});

describe('execution boot trade book snapshot wiring (D52)', () => {
  it('index wires buildTradeBookSnapshotMap into createExecutionRouter snapshotByVenue', () => {
    const src = indexSrc();
    expect(src).toContain('buildTradeBookSnapshotMap(env.TRADE_URL)');
    expect(src).toContain('snapshotByVenue = captureLakeRuntime.wrapSnapshotMap({');
    expect(src).toContain('...venueMarketMaps.snapshotByVenue,');
    expect(src).toContain('...tradeBookSnapshot,');
    expect(src).toContain('createExecutionRouter(');
    expect(src).toContain('snapshotByVenue,');
  });
});

describe('execution boot ems store wiring (D53)', () => {
  it('index wires FileEmsOrderStore into createExecutionRouter — blank path fail-closed', () => {
    const src = indexSrc();
    expect(src).toContain('EXECUTION_EMS_STORE_PATH');
    expect(src).toContain('requireExecutionEmsStorePath');
    expect(src).toContain('new FileEmsOrderStore(emsStorePath)');
    expect(src).not.toContain('new InMemoryEmsOrderStore()');
    expect(src).toContain('emsStore,');
    expect(src).toContain('emsAckCount: emsStore.list().length');
  });
});

describe('execution boot sealed registry wiring (D54)', () => {
  it('index wires SealedHouseTenantRegistry and public MD supplement into boot', () => {
    const src = indexSrc();
    expect(src).toContain('new SealedHouseTenantRegistry()');
    expect(src).toContain('createExecutionRouter(');
    expect(src).toContain('registry,');
    expect(src).toContain('buildExecutionVenueMarketMapsWithPublicMdSupplement(executionVenueIds)');
    expect(src).toContain('publicMdSupplementVenueIds: venueMarketMaps.publicMdSupplementVenueIds');
  });
});

describe('execution boot router venue maps wiring (D55)', () => {
  it('index passes trade, account, and market maps into createExecutionRouter', () => {
    const src = indexSrc();
    expect(src).toContain('venueTradeMaps.submitByVenue');
    expect(src).toContain('venueTradeMaps.cancelByVenue');
    expect(src).toContain('venueTradeMaps.fetchByVenue');
    expect(src).toContain('venueAccountMaps.balancesByVenue');
    expect(src).toContain('venueAccountMaps.positionsByVenue');
    expect(src).toContain('venueMarketMaps.fundingByVenue');
    expect(src).toContain('operatorAccountSupplementVenueIds: venueAccountMaps.operatorSupplementVenueIds');
  });
});

describe('execution boot trpc and edge context wiring (D57)', () => {
  it('index registers fastifyTRPCPlugin with appRouter, market maps, and createEdgeContext', () => {
    const src = indexSrc();
    expect(src).toContain('fastifyTRPCPlugin');
    expect(src).toContain('router: appRouter');
    expect(src).toContain('createEdgeContext(');
    expect(src).toContain('EDGE_PRINCIPAL_SECRET');
    expect(src).toContain('venueMarketMaps.borrowByVenue');
    expect(src).toContain('venueMarketMaps.latencyByVenue');
    expect(src).toContain('venueMarketMaps.marketsByVenue');
  });
});

describe('execution boot health and credential union (D59)', () => {
  it('index exposes /health and /ready and wires unionExecutionVenueIds into credential board', () => {
    const src = indexSrc();
    expect(src).toContain("app.get('/health'");
    expect(src).toContain("app.get('/ready'");
    expect(src).toContain('SERVICE_NAME');
    expect(src).toContain('unionExecutionVenueIds(executionVenueIds');
    expect(src).toContain('describeExecutionVenueCredentialBoard(');
    expect(src).toContain('venueCredentialBoard,');
  });
});

describe('execution boot open orders and rails wiring (D61)', () => {
  it('index passes openOrdersByVenue and railsByVenue into createExecutionRouter', () => {
    const src = indexSrc();
    expect(src).toContain('venueTradeMaps.openOrdersByVenue');
    expect(src).toContain('venueAccountMaps.railsByVenue');
    expect(src).toContain('venueTradeConstructedVenueIds: venueTradeMaps.wiredVenueIds');
    expect(src).toContain('venueMarketConstructedVenueIds: venueMarketMaps.wiredVenueIds');
    expect(src).toContain('operatorSupplementVenueIds: venueTradeMaps.operatorSupplementVenueIds');
  });
});

describe('execution boot listen and venue ids parsing (D63)', () => {
  it('index parses execution venue ids and listens on HTTP_PORT', () => {
    const src = indexSrc();
    expect(src).toContain('parseExecutionVenueIds(env.EXECUTION_VENUE_IDS)');
    expect(src).toContain('app.listen({ host: env.HTTP_HOST, port: env.HTTP_PORT })');
    expect(src).toContain('buildExecutionReadyResponse({');
    expect(src).toContain('tradeUrl: env.TRADE_URL');
    expect(src).toContain('svc-execution ready');
  });
});

describe('execution boot index wiring complete (D65)', () => {
  it('index wires registry, venue maps, ems store, trpc, health, ready, and listen', () => {
    const src = indexSrc();
    expect(src).toContain('parseExecutionVenueIds(env.EXECUTION_VENUE_IDS)');
    expect(src).toContain('SealedHouseTenantRegistry');
    expect(src).toContain('buildExecutionVenueTradeMapsWithOperatorSupplement');
    expect(src).toContain('buildExecutionVenueAccountMapsWithOperatorSupplement');
    expect(src).toContain('buildExecutionVenueMarketMapsWithPublicMdSupplement');
    expect(src).toContain('buildTradeBookSnapshotMap(env.TRADE_URL)');
    expect(src).toContain('createExecutionRouter(');
    expect(src).toContain('fastifyTRPCPlugin');
    expect(src).toContain("app.get('/health'");
    expect(src).toContain("app.get('/ready'");
    expect(src).toContain('app.listen({ host: env.HTTP_HOST, port: env.HTTP_PORT })');
    expect(src).toContain('venueTradeMaps.openOrdersByVenue');
    expect(src).toContain('venueAccountMaps.railsByVenue');
    expect(src).toContain('describeExecutionVenueCredentialBoard(');
    expect(src).toContain('createEdgeContext(');
  });
});

describe('execution ready response fields complete (D67)', () => {
  it('buildExecutionReadyResponse exposes venue trade, account, market, and ems ack fields', () => {
    const src = indexSrc();
    expect(src).toContain('buildExecutionReadyResponse({');
    expect(src).toContain('venueTradeConstructedVenueIds:');
    expect(src).toContain('operatorSupplementVenueIds:');
    expect(src).toContain('operatorAccountSupplementVenueIds:');
    expect(src).toContain('publicMdSupplementVenueIds:');
    expect(src).toContain('venueAccountConstructedVenueIds:');
    expect(src).toContain('venueMarketConstructedVenueIds:');
    expect(src).toContain('emsAckCount:');
    expect(src).toContain('tradeUrl: env.TRADE_URL');
    const venueCredentialBoard = describeExecutionVenueCredentialBoard(['binance-spot']);
    const payload = buildExecutionReadyResponse({
      emsStorePath: '/tmp/ems',
      tradeUrl: 'http://trade',
      venueTradeConstructedVenueIds: ['binance-spot'],
      operatorSupplementVenueIds: ['okx-spot'],
      operatorAccountSupplementVenueIds: ['bybit-spot'],
      publicMdSupplementVenueIds: ['binance-spot'],
      venueCredentialBoard,
      venueAccountConstructedVenueIds: ['bybit-spot'],
      venueMarketConstructedVenueIds: ['binance-spot'],
      emsAckCount: 2,
    });
    expect(payload).toMatchObject({
      ready: true,
      stage: 'oms-ems',
      store: 'file',
      externalVenueTrade: { status: 'constructed', venueIds: ['binance-spot'], probe: 'unprobed' },
      operatorSupplementVenueIds: ['okx-spot'],
      operatorAccountSupplementVenueIds: ['bybit-spot'],
      publicMdSupplementVenueIds: ['binance-spot'],
      externalVenueAccount: { status: 'constructed', venueIds: ['bybit-spot'], probe: 'unprobed' },
      externalVenueMarketData: { status: 'constructed', venueIds: ['binance-spot'], probe: 'unprobed' },
      emsAckCount: 2,
      tradeBookSnapshotVenue: { status: 'configured', venueId: 'intafaced-spot', probe: 'unprobed' },
    });
    expect(payload.venueCredentialBoard.inventsCredentials).toBe(false);
  });
});

describe('execution boot createExecutionRouter wiring complete (D69)', () => {
  it('index passes funding, borrow, latency, markets, and snapshot maps into createExecutionRouter', () => {
    const src = indexSrc();
    expect(src).toContain('venueMarketMaps.fundingByVenue');
    expect(src).toContain('venueMarketMaps.borrowByVenue');
    expect(src).toContain('venueMarketMaps.latencyByVenue');
    expect(src).toContain('venueMarketMaps.marketsByVenue');
    expect(src).toContain('snapshotByVenue');
    expect(src).toContain('tradeBookSnapshot');
    expect(src).toContain('venueTradeMaps.submitByVenue');
    expect(src).toContain('venueAccountMaps.balancesByVenue');
    expect(src).toContain('emsStore');
    expect(src).toContain('createExecutionRouter(');
  });
});

describe('execution boot trpc mount complete (D70)', () => {
  it('index registers trpc with edge context and graceful shutdown on boot', () => {
    const src = indexSrc();
    expect(src).toContain("prefix: '/trpc'");
    expect(src).toContain('fastifyTRPCPlugin');
    expect(src).toContain('createEdgeContext({');
    // Whole request, not `{ headers, id }`: the S2S body-bind needs req.body.
    expect(src).toContain('edgeContext(req)');
    expect(src).toContain('EDGE_PRINCIPAL_SECRET');
    expect(src).toContain('SIGTERM');
    expect(src).toContain('SIGINT');
    expect(src).toContain('app.close()');
  });
});

describe('execution boot ready and health complete (D72)', () => {
  it('index wires health, ready, credential board union, and ems store path on boot', () => {
    const src = indexSrc();
    expect(src).toContain("app.get('/health'");
    expect(src).toContain("app.get('/ready'");
    expect(src).toContain('buildExecutionReadyResponse({');
    expect(src).toContain('unionExecutionVenueIds(executionVenueIds');
    expect(src).toContain('describeExecutionVenueCredentialBoard(');
    expect(src).toContain('emsStorePath');
    expect(src).toContain('EXECUTION_EMS_STORE_PATH');
    expect(src).toContain('emsAckCount: emsStore.list().length');
    expect(src).toContain('tradeUrl: env.TRADE_URL');
  });
});

describe('execution boot ready and mount cert complete (D74)', () => {
  it('boot wiring and execution.sor mount-vs-tracker cert both green on tip', () => {
    const src = indexSrc();
    expect(executionSorTrackerBackendDoneBarMet()).toBe(true);
    expect(executionSorMountVsTrackerBoardCard()).toMatchObject({
      tracker: 'execution.sor',
      backendDoneBarMet: true,
      mountComplete: true,
      gaps: 0,
    });
    expect(src).toContain("app.get('/ready'");
    expect(src).toContain('createExecutionRouter(');
    expect(src).toContain('emsStore');
    expect(src).toContain('describeExecutionVenueCredentialBoard(');
  });
});

describe('execution boot and sor mount — D75 denon complete', () => {
  it('health/ready boot, credential board, EMS store, and mount cert board all green', () => {
    const src = indexSrc();
    const card = executionSorMountVsTrackerBoardCard();
    expect(card).toMatchObject({
      tracker: 'execution.sor',
      doors: 4,
      doorsMounted: 4,
      backendDoneBarMet: true,
      mountComplete: true,
      gaps: 0,
    });
    expect(executionSorTrackerBackendDoneBarMet()).toBe(true);
    expect(src).toContain("app.get('/health'");
    expect(src).toContain("app.get('/ready'");
    expect(src).toContain('buildExecutionReadyResponse({');
    expect(src).toContain('FileEmsOrderStore');
    expect(src).toContain('FileApprovedAlgoParentStore');
    expect(src).toContain('FileAlgoPauseStore');
    expect(describeExecutionVenueCredentialBoard(['okx-spot'], {}).inventsCredentials).toBe(false);
  });
});

describe('execution boot and sor mount — D77 denon complete', () => {
  it('boot source wiring and execution.sor mount cert full board green', () => {
    const src = indexSrc();
    expect(executionSorTrackerBackendDoneBarMet()).toBe(true);
    expect(executionSorMountVsTrackerBoardCard()).toMatchObject({
      tracker: 'execution.sor',
      doors: 4,
      doorsMounted: 4,
      gaps: 0,
      backendDoneBarMet: true,
      mountComplete: true,
    });
    expect(src).toContain('createExecutionRouter(');
    expect(src).toContain('describeExecutionVenueCredentialBoard(');
    expect(src).toContain('unionExecutionVenueIds');
    expect(src).toContain('emsStore');
  });
});

describe('execution boot and sor mount — D79 denon complete', () => {
  it('health/ready boot, EMS stores, credential board, and mount cert all green', () => {
    const src = indexSrc();
    expect(executionSorTrackerBackendDoneBarMet()).toBe(true);
    expect(executionSorMountVsTrackerBoardCard()).toMatchObject({
      tracker: 'execution.sor',
      backendDoneBarMet: true,
      mountComplete: true,
      gaps: 0,
    });
    expect(src).toContain("app.get('/health'");
    expect(src).toContain("app.get('/ready'");
    expect(src).toContain('buildExecutionReadyResponse({');
    expect(src).toContain('EXECUTION_EMS_STORE_PATH');
    expect(describeExecutionVenueCredentialBoard([], {}).inventsCredentials).toBe(false);
  });
});

describe('execution boot and sor mount — D82 denon complete', () => {
  it('health/ready boot, EMS stores, credential board, and mount cert all green', () => {
    const src = indexSrc();
    expect(executionSorTrackerBackendDoneBarMet()).toBe(true);
    expect(executionSorMountVsTrackerBoardCard().backendDoneBarMet).toBe(true);
    expect(src).toContain("app.get('/health'");
    expect(src).toContain("app.get('/ready'");
    expect(src).toContain('buildExecutionReadyResponse({');
    expect(src).toContain('unionExecutionVenueIds');
    expect(src).toContain('emsStore');
    expect(describeExecutionVenueCredentialBoard([], {}).inventsCredentials).toBe(false);
  });
});

describe('execution boot and sor mount — D84 denon complete', () => {
  it('health/ready boot, EMS stores, credential board, and mount cert all green', () => {
    const src = indexSrc();
    expect(executionSorTrackerBackendDoneBarMet()).toBe(true);
    expect(executionSorMountVsTrackerBoardCard()).toMatchObject({
      tracker: 'execution.sor',
      backendDoneBarMet: true,
      mountComplete: true,
      gaps: 0,
    });
    expect(src).toContain("app.get('/health'");
    expect(src).toContain("app.get('/ready'");
    expect(src).toContain('buildExecutionReadyResponse({');
    expect(src).toContain('EXECUTION_EMS_STORE_PATH');
    expect(describeExecutionVenueCredentialBoard([], {}).inventsCredentials).toBe(false);
  });
});

describe('execution boot and sor mount — D86 denon complete', () => {
  it('health/ready boot, EMS stores, credential board, and mount cert all green', () => {
    const src = indexSrc();
    expect(executionSorTrackerBackendDoneBarMet()).toBe(true);
    expect(executionSorMountVsTrackerBoardCard().backendDoneBarMet).toBe(true);
    expect(src).toContain("app.get('/health'");
    expect(src).toContain("app.get('/ready'");
    expect(src).toContain('buildExecutionReadyResponse({');
    expect(src).toContain('unionExecutionVenueIds');
    expect(src).toContain('emsStore');
    expect(describeExecutionVenueCredentialBoard([], {}).inventsCredentials).toBe(false);
  });
});

describe('execution boot and sor mount — D88 denon complete', () => {
  it('health/ready boot, EMS stores, credential board, and mount cert all green', () => {
    const src = indexSrc();
    expect(executionSorTrackerBackendDoneBarMet()).toBe(true);
    expect(executionSorMountVsTrackerBoardCard()).toMatchObject({
      tracker: 'execution.sor',
      backendDoneBarMet: true,
      mountComplete: true,
      gaps: 0,
    });
    expect(src).toContain("app.get('/health'");
    expect(src).toContain("app.get('/ready'");
    expect(src).toContain('buildExecutionReadyResponse({');
    expect(src).toContain('EXECUTION_EMS_STORE_PATH');
    expect(describeExecutionVenueCredentialBoard([], {}).inventsCredentials).toBe(false);
  });
});

describe('execution boot and sor mount — D90 denon complete', () => {
  it('health/ready boot, EMS stores, credential board, and mount cert all green', () => {
    const src = indexSrc();
    expect(executionSorTrackerBackendDoneBarMet()).toBe(true);
    expect(executionSorMountVsTrackerBoardCard().backendDoneBarMet).toBe(true);
    expect(src).toContain("app.get('/health'");
    expect(src).toContain("app.get('/ready'");
    expect(src).toContain('buildExecutionReadyResponse({');
    expect(src).toContain('unionExecutionVenueIds');
    expect(src).toContain('emsStore');
    expect(describeExecutionVenueCredentialBoard([], {}).inventsCredentials).toBe(false);
  });
});

describe('execution boot and sor mount — D92 denon complete', () => {
  it('health/ready boot, EMS stores, credential board, and mount cert all green', () => {
    const src = indexSrc();
    expect(executionSorTrackerBackendDoneBarMet()).toBe(true);
    expect(executionSorMountVsTrackerBoardCard().backendDoneBarMet).toBe(true);
    expect(src).toContain("app.get('/health'");
    expect(src).toContain("app.get('/ready'");
    expect(src).toContain('buildExecutionReadyResponse({');
    expect(src).toContain('unionExecutionVenueIds');
    expect(src).toContain('emsStore');
    expect(describeExecutionVenueCredentialBoard([], {}).inventsCredentials).toBe(false);
  });
});

describe('execution boot and sor mount — D94 denon complete', () => {
  it('health/ready boot, EMS stores, credential board, and mount cert all green', () => {
    const src = indexSrc();
    expect(executionSorTrackerBackendDoneBarMet()).toBe(true);
    expect(executionSorMountVsTrackerBoardCard().backendDoneBarMet).toBe(true);
    expect(src).toContain("app.get('/health'");
    expect(src).toContain("app.get('/ready'");
    expect(src).toContain('buildExecutionReadyResponse({');
    expect(src).toContain('unionExecutionVenueIds');
    expect(src).toContain('emsStore');
    expect(describeExecutionVenueCredentialBoard([], {}).inventsCredentials).toBe(false);
  });
});

describe('execution boot and sor mount — D96 denon complete', () => {
  it('health/ready boot, EMS stores, credential board, and mount cert all green', () => {
    const src = indexSrc();
    expect(executionSorTrackerBackendDoneBarMet()).toBe(true);
    expect(executionSorMountVsTrackerBoardCard().backendDoneBarMet).toBe(true);
    expect(src).toContain("app.get('/health'");
    expect(src).toContain("app.get('/ready'");
    expect(src).toContain('buildExecutionReadyResponse({');
    expect(src).toContain('unionExecutionVenueIds');
    expect(src).toContain('emsStore');
    expect(describeExecutionVenueCredentialBoard([], {}).inventsCredentials).toBe(false);
  });
});

describe('execution boot and sor mount — D98 denon complete', () => {
  it('health/ready boot, EMS stores, credential board, and mount cert all green', () => {
    const src = indexSrc();
    expect(executionSorTrackerBackendDoneBarMet()).toBe(true);
    expect(executionSorMountVsTrackerBoardCard().backendDoneBarMet).toBe(true);
    expect(src).toContain("app.get('/health'");
    expect(src).toContain("app.get('/ready'");
    expect(src).toContain('buildExecutionReadyResponse({');
    expect(src).toContain('unionExecutionVenueIds');
    expect(src).toContain('emsStore');
    expect(describeExecutionVenueCredentialBoard([], {}).inventsCredentials).toBe(false);
  });
});

describe('execution boot and sor mount — D100 denon complete', () => {
  it('health/ready boot, EMS stores, credential board, and mount cert all green', () => {
    const src = indexSrc();
    expect(executionSorTrackerBackendDoneBarMet()).toBe(true);
    expect(executionSorMountVsTrackerBoardCard().backendDoneBarMet).toBe(true);
    expect(src).toContain("app.get('/health'");
    expect(src).toContain("app.get('/ready'");
    expect(src).toContain('buildExecutionReadyResponse({');
    expect(src).toContain('unionExecutionVenueIds');
    expect(src).toContain('emsStore');
    expect(describeExecutionVenueCredentialBoard([], {}).inventsCredentials).toBe(false);
  });
});

describe('execution boot and sor mount — D102 denon complete', () => {
  it('health/ready boot, EMS stores, credential board, and mount cert all green', () => {
    const src = indexSrc();
    expect(executionSorTrackerBackendDoneBarMet()).toBe(true);
    expect(executionSorMountVsTrackerBoardCard().backendDoneBarMet).toBe(true);
    expect(src).toContain("app.get('/health'");
    expect(src).toContain("app.get('/ready'");
    expect(src).toContain('buildExecutionReadyResponse({');
    expect(src).toContain('unionExecutionVenueIds');
    expect(src).toContain('emsStore');
    expect(describeExecutionVenueCredentialBoard([], {}).inventsCredentials).toBe(false);
  });
});

describe('execution boot and sor mount — D104 denon complete', () => {
  it('health/ready boot, EMS stores, credential board, and mount cert all green', () => {
    const src = indexSrc();
    expect(executionSorTrackerBackendDoneBarMet()).toBe(true);
    expect(executionSorMountVsTrackerBoardCard().backendDoneBarMet).toBe(true);
    expect(src).toContain("app.get('/health'");
    expect(src).toContain("app.get('/ready'");
    expect(src).toContain('buildExecutionReadyResponse({');
    expect(src).toContain('unionExecutionVenueIds');
    expect(src).toContain('emsStore');
    expect(describeExecutionVenueCredentialBoard([], {}).inventsCredentials).toBe(false);
  });
});

describe('execution boot and sor mount — D106 denon complete', () => {
  it('health/ready boot, EMS stores, credential board, and mount cert all green', () => {
    const src = indexSrc();
    expect(executionSorTrackerBackendDoneBarMet()).toBe(true);
    expect(executionSorMountVsTrackerBoardCard().backendDoneBarMet).toBe(true);
    expect(src).toContain("app.get('/health'");
    expect(src).toContain("app.get('/ready'");
    expect(src).toContain('buildExecutionReadyResponse({');
    expect(src).toContain('unionExecutionVenueIds');
    expect(src).toContain('emsStore');
    expect(describeExecutionVenueCredentialBoard([], {}).inventsCredentials).toBe(false);
  });
});

describe('execution boot and sor mount — D108 denon complete', () => {
  it('health/ready boot, EMS stores, credential board, and mount cert all green', () => {
    const src = indexSrc();
    expect(executionSorTrackerBackendDoneBarMet()).toBe(true);
    expect(executionSorMountVsTrackerBoardCard().backendDoneBarMet).toBe(true);
    expect(src).toContain("app.get('/health'");
    expect(src).toContain("app.get('/ready'");
    expect(src).toContain('buildExecutionReadyResponse({');
    expect(src).toContain('unionExecutionVenueIds');
    expect(src).toContain('emsStore');
    expect(describeExecutionVenueCredentialBoard([], {}).inventsCredentials).toBe(false);
  });
});

describe('execution boot and sor mount — D110 denon complete', () => {
  it('health/ready boot, EMS stores, credential board, and mount cert all green', () => {
    const src = indexSrc();
    expect(executionSorTrackerBackendDoneBarMet()).toBe(true);
    expect(executionSorMountVsTrackerBoardCard().backendDoneBarMet).toBe(true);
    expect(src).toContain("app.get('/health'");
    expect(src).toContain("app.get('/ready'");
    expect(src).toContain('buildExecutionReadyResponse({');
    expect(src).toContain('unionExecutionVenueIds');
    expect(src).toContain('emsStore');
    expect(describeExecutionVenueCredentialBoard([], {}).inventsCredentials).toBe(false);
  });
});

describe('execution boot and sor mount — D112 denon complete', () => {
  it('health/ready boot, EMS stores, credential board, and mount cert all green', () => {
    const src = indexSrc();
    expect(executionSorTrackerBackendDoneBarMet()).toBe(true);
    expect(executionSorMountVsTrackerBoardCard().backendDoneBarMet).toBe(true);
    expect(src).toContain("app.get('/health'");
    expect(src).toContain("app.get('/ready'");
    expect(src).toContain('buildExecutionReadyResponse({');
    expect(src).toContain('unionExecutionVenueIds');
    expect(src).toContain('emsStore');
    expect(describeExecutionVenueCredentialBoard([], {}).inventsCredentials).toBe(false);
  });
});

describe('execution boot and sor mount — D114 denon complete', () => {
  it('health/ready boot, EMS stores, credential board, and mount cert all green', () => {
    const src = indexSrc();
    expect(executionSorTrackerBackendDoneBarMet()).toBe(true);
    expect(executionSorMountVsTrackerBoardCard().backendDoneBarMet).toBe(true);
    expect(src).toContain("app.get('/health'");
    expect(src).toContain("app.get('/ready'");
    expect(src).toContain('buildExecutionReadyResponse({');
    expect(src).toContain('unionExecutionVenueIds');
    expect(src).toContain('emsStore');
    expect(describeExecutionVenueCredentialBoard([], {}).inventsCredentials).toBe(false);
  });
});

describe('execution boot and sor mount — D116 denon complete', () => {
  it('health/ready boot, EMS stores, credential board, and mount cert all green', () => {
    const src = indexSrc();
    expect(executionSorTrackerBackendDoneBarMet()).toBe(true);
    expect(executionSorMountVsTrackerBoardCard().backendDoneBarMet).toBe(true);
    expect(src).toContain("app.get('/health'");
    expect(src).toContain("app.get('/ready'");
    expect(src).toContain('buildExecutionReadyResponse({');
    expect(src).toContain('unionExecutionVenueIds');
    expect(src).toContain('emsStore');
    expect(describeExecutionVenueCredentialBoard([], {}).inventsCredentials).toBe(false);
  });
});

describe('execution boot and sor mount — D118 denon complete', () => {
  it('health/ready boot, EMS stores, credential board, and mount cert all green', () => {
    const src = indexSrc();
    expect(executionSorTrackerBackendDoneBarMet()).toBe(true);
    expect(executionSorMountVsTrackerBoardCard().backendDoneBarMet).toBe(true);
    expect(src).toContain("app.get('/health'");
    expect(src).toContain("app.get('/ready'");
    expect(src).toContain('buildExecutionReadyResponse({');
    expect(src).toContain('unionExecutionVenueIds');
    expect(src).toContain('emsStore');
    expect(describeExecutionVenueCredentialBoard([], {}).inventsCredentials).toBe(false);
  });
});

describe('execution boot and sor mount — D120 denon complete', () => {
  it('health/ready boot, EMS stores, credential board, and mount cert all green', () => {
    const src = indexSrc();
    expect(executionSorTrackerBackendDoneBarMet()).toBe(true);
    expect(executionSorMountVsTrackerBoardCard().backendDoneBarMet).toBe(true);
    expect(src).toContain("app.get('/health'");
    expect(src).toContain("app.get('/ready'");
    expect(src).toContain('buildExecutionReadyResponse({');
    expect(src).toContain('unionExecutionVenueIds');
    expect(src).toContain('emsStore');
    expect(describeExecutionVenueCredentialBoard([], {}).inventsCredentials).toBe(false);
  });
});

describe('execution /ready credential board inject (D44)', () => {
  it('GET /ready exposes supplement-union credential board over HTTP', async () => {
    const env = {
      VENUE_AGGREGATION_OKX_SPOT_API_KEY: 'k',
      VENUE_AGGREGATION_OKX_SPOT_API_SECRET: 's',
      VENUE_AGGREGATION_OKX_SPOT_PASSPHRASE: 'p',
    };
    const venueCredentialBoard = describeExecutionVenueCredentialBoard(unionExecutionVenueIds([], ['okx-spot']), env);
    const emsStore = new InMemoryEmsOrderStore();
    const payload = buildExecutionReadyResponse({
      emsStorePath: '',
      tradeUrl: '',
      venueTradeConstructedVenueIds: [],
      operatorSupplementVenueIds: ['okx-spot'],
      operatorAccountSupplementVenueIds: ['okx-spot'],
      publicMdSupplementVenueIds: [],
      venueCredentialBoard,
      venueAccountConstructedVenueIds: [],
      venueMarketConstructedVenueIds: [],
      emsAckCount: emsStore.list().length,
    });

    const app = Fastify({ logger: false });
    app.get('/ready', async () => payload);
    await app.ready();
    apps.push(app);

    const res = await app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      venueCredentialBoard: {
        configuredVenueIds: ['okx-spot'],
        inventsCredentials: false,
      },
    });
    expect(res.json().venueCredentialBoard.venues[0]).toMatchObject({
      venueId: 'okx-spot',
      operatorEnvConfigured: true,
      configured: true,
    });
  });
});
