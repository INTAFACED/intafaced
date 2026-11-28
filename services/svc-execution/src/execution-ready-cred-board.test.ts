import { afterEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { parseAmount } from '@intafaced/ledger-client';
import { bootExecution } from './testing/boot.js';
import type { FileEmsOrderStore } from './file-ems-order-store.js';
import { InMemoryEmsOrderStore } from './oms-ems-store.js';
import { describeExecutionSpine } from './oms-spine.js';
import { buildExecutionReadyResponse } from './ready-response.js';
import { buildTradeBookSnapshotMap } from './trade-book-snapshot.js';
import { buildExecutionVenueAccountMapsWithOperatorSupplement } from './venue-account-adapters.js';
import {
  buildExecutionVenueTradeMapsWithOperatorSupplement,
  describeExecutionVenueCredentialBoard,
  parseExecutionVenueIds,
  unionExecutionVenueIds,
} from './venue-adapters.js';
import { buildExecutionVenueMarketMapsWithPublicMdSupplement } from './venue-market-adapters.js';
import { executionSorMountVsTrackerBoardCard, executionSorTrackerBackendDoneBarMet } from './mount-vs-tracker.js';

/**
 * The boot this file checks: one execution venue with its own keys, one operator-only supplement venue, a trade URL
 * and a port. Fixture values only.
 */
const BOOT_ENV = {
  EXECUTION_VENUE_IDS: 'binance-spot',
  EXECUTION_VENUE_BINANCE_SPOT_API_KEY: 'fixture-key',
  EXECUTION_VENUE_BINANCE_SPOT_API_SECRET: 'fixture-secret',
  VENUE_AGGREGATION_OKX_SPOT_API_KEY: 'k',
  VENUE_AGGREGATION_OKX_SPOT_API_SECRET: 's',
  VENUE_AGGREGATION_OKX_SPOT_PASSPHRASE: 'p',
  TRADE_URL: 'http://trade.test:4004',
  HTTP_HOST: '127.0.0.1',
  HTTP_PORT: '4919',
};

/** `createExecutionRouter`'s parameters, in its order. */
const ROUTER_PARAMS = [
  'registry',
  'submitByVenue',
  'cancelByVenue',
  'fetchByVenue',
  'openOrdersByVenue',
  'balancesByVenue',
  'positionsByVenue',
  'railsByVenue',
  'fundingByVenue',
  'borrowByVenue',
  'latencyByVenue',
  'marketsByVenue',
  'snapshotByVenue',
  'emsStore',
  'captureLake',
] as const;

type BootFacts = Awaited<ReturnType<typeof readBoot>>;

/** Boot the real entrypoint once with BOOT_ENV, and what the same builders make of the same environment. */
async function readBoot() {
  const booted = await bootExecution(BOOT_ENV);
  try {
    // The classes as the booted module graph holds them (the boot loads its own copy of every module).
    const { SealedHouseTenantRegistry } = await import('@intafaced/execution-house-tenant');
    const { CaptureLake } = await import('@intafaced/venue-adapter');
    const { FileEmsOrderStore: BootedFileEmsOrderStore } = await import('./file-ems-order-store.js');
    const ids = parseExecutionVenueIds(BOOT_ENV.EXECUTION_VENUE_IDS);
    const trade = buildExecutionVenueTradeMapsWithOperatorSupplement(ids);
    const account = buildExecutionVenueAccountMapsWithOperatorSupplement(ids);
    const market = buildExecutionVenueMarketMapsWithPublicMdSupplement(ids);
    const expectedReady = (emsAckCount: number) =>
      buildExecutionReadyResponse({
        emsStorePath: booted.emsStorePath,
        tradeUrl: BOOT_ENV.TRADE_URL,
        venueTradeConstructedVenueIds: trade.wiredVenueIds,
        operatorSupplementVenueIds: trade.operatorSupplementVenueIds,
        operatorAccountSupplementVenueIds: account.operatorSupplementVenueIds,
        publicMdSupplementVenueIds: market.publicMdSupplementVenueIds,
        venueCredentialBoard: describeExecutionVenueCredentialBoard(
          unionExecutionVenueIds(ids, trade.operatorSupplementVenueIds, account.operatorSupplementVenueIds),
        ),
        venueAccountConstructedVenueIds: account.wiredVenueIds,
        venueMarketConstructedVenueIds: market.wiredVenueIds,
        emsAckCount,
      });
    const args = Object.fromEntries(ROUTER_PARAMS.map((name, i) => [name, booted.routerArgs[i]])) as Record<
      (typeof ROUTER_PARAMS)[number],
      unknown
    >;
    const keys = (map: unknown) => Object.keys(map as object).sort();
    const health = await booted.app.inject({ method: 'GET', url: '/health' });
    const readyAtBoot = await booted.app.inject({ method: 'GET', url: '/ready' });
    const policy = await booted.app.inject({ method: 'GET', url: '/trpc/execution.policy' });
    // One acknowledgement through the store the router was handed: /ready counts it.
    (args.emsStore as FileEmsOrderStore).record({
      clientOrderId: 'boot-ack-1',
      venueId: 'binance-spot',
      symbol: 'BTC/USDT',
      side: 'buy',
      execution: {
        venueId: 'binance-spot',
        venueOrderId: 'v-1',
        filledAmount: parseAmount('1'),
        averagePrice: parseAmount('100'),
        feeAmount: parseAmount('0'),
        feeAsset: 'USDT',
        status: 'filled',
        executedAt: new Date('2026-08-22T00:00:00.000Z'),
      },
    });
    const readyAfterAck = await booted.app.inject({ method: 'GET', url: '/ready' });
    return {
      health: { status: health.statusCode, body: health.json() },
      readyAtBoot: { status: readyAtBoot.statusCode, body: readyAtBoot.json() },
      readyAfterAck: readyAfterAck.json(),
      expectedReadyAtBoot: expectedReady(0),
      expectedReadyAfterAck: expectedReady(1),
      policy: { status: policy.statusCode, body: policy.json() },
      args,
      argKeys: {
        submitByVenue: keys(args.submitByVenue),
        cancelByVenue: keys(args.cancelByVenue),
        fetchByVenue: keys(args.fetchByVenue),
        openOrdersByVenue: keys(args.openOrdersByVenue),
        balancesByVenue: keys(args.balancesByVenue),
        positionsByVenue: keys(args.positionsByVenue),
        railsByVenue: keys(args.railsByVenue),
        fundingByVenue: keys(args.fundingByVenue),
        borrowByVenue: keys(args.borrowByVenue),
        latencyByVenue: keys(args.latencyByVenue),
        marketsByVenue: keys(args.marketsByVenue),
        snapshotByVenue: keys(args.snapshotByVenue),
      },
      expectedKeys: {
        submitByVenue: keys(trade.submitByVenue),
        cancelByVenue: keys(trade.cancelByVenue),
        fetchByVenue: keys(trade.fetchByVenue),
        openOrdersByVenue: keys(trade.openOrdersByVenue),
        balancesByVenue: keys(account.balancesByVenue),
        positionsByVenue: keys(account.positionsByVenue),
        railsByVenue: keys(account.railsByVenue),
        fundingByVenue: keys(market.fundingByVenue),
        borrowByVenue: keys(market.borrowByVenue),
        latencyByVenue: keys(market.latencyByVenue),
        marketsByVenue: keys(market.marketsByVenue),
        snapshotByVenue: keys({ ...market.snapshotByVenue, ...buildTradeBookSnapshotMap(BOOT_ENV.TRADE_URL) }),
      },
      kinds: {
        registry: args.registry instanceof SealedHouseTenantRegistry,
        emsStore: args.emsStore instanceof BootedFileEmsOrderStore,
        captureLake: args.captureLake instanceof CaptureLake,
      },
      listenArgs: booted.listenArgs,
      signalCounts: { SIGTERM: booted.signalHandlers.SIGTERM.length, SIGINT: booted.signalHandlers.SIGINT.length },
    };
  } finally {
    await booted.close();
  }
}

let bootFacts: Promise<BootFacts> | undefined;

/**
 * What the booted entrypoint serves and wires, checked against what the same builders make of the same environment:
 * /health, /ready (every field, the credential board over the supplement union, the EMS count from the store it
 * handed the router), the tRPC mount, the router's registry, venue maps, EMS store and capture lake, the listen
 * address and the shutdown signals. A blank EMS path refuses to boot.
 */
async function expectBootWired(): Promise<void> {
  bootFacts ??= readBoot();
  const facts = await bootFacts;
  expect(facts.health).toEqual({ status: 200, body: { ok: true, service: 'svc-execution' } });
  expect(facts.readyAtBoot.status).toBe(200);
  expect(facts.readyAtBoot.body).toEqual(JSON.parse(JSON.stringify(facts.expectedReadyAtBoot)));
  expect(facts.readyAfterAck).toEqual(JSON.parse(JSON.stringify(facts.expectedReadyAfterAck)));
  expect(facts.readyAtBoot.body.venueCredentialBoard.configuredVenueIds).toEqual(['binance-spot', 'okx-spot']);
  expect(facts.readyAtBoot.body.tradeBookSnapshotVenue).toMatchObject({ status: 'configured', probe: 'unprobed' });
  expect(facts.policy).toEqual({
    status: 200,
    body: { result: { data: JSON.parse(JSON.stringify(describeExecutionSpine())) } },
  });
  expect(facts.kinds).toEqual({ registry: true, emsStore: true, captureLake: true });
  expect(facts.argKeys).toEqual(facts.expectedKeys);
  expect(facts.argKeys.submitByVenue).toContain('binance-spot');
  expect(facts.argKeys.snapshotByVenue).toContain('intafaced-spot');
  expect(facts.listenArgs).toEqual({ host: BOOT_ENV.HTTP_HOST, port: Number(BOOT_ENV.HTTP_PORT) });
  expect(facts.signalCounts).toEqual({ SIGTERM: 1, SIGINT: 1 });
}

describe('execution boot refuses a blank EMS store path', () => {
  it('blank EXECUTION_EMS_STORE_PATH stops the boot with the named refusal', async () => {
    const refused = await bootExecution({ ...BOOT_ENV, EXECUTION_EMS_STORE_PATH: '' }).then(
      () => null,
      (err: unknown) => err,
    );
    const { ExecutionAlgoStorePathUnsetError } = await import('./file-algo-store.js');
    expect(refused).toBeInstanceOf(ExecutionAlgoStorePathUnsetError);
  });
});

const apps: FastifyInstance[] = [];

afterEach(async () => {
  while (apps.length) {
    const app = apps.pop();
    if (app) await app.close();
  }
});

describe('execution ready venue credential board (D33)', () => {
  it('/ready exposes venueCredentialBoard from describeExecutionVenueCredentialBoard', async () => {
    await expectBootWired();
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
  it('index wires account and public MD supplement venue ids on /ready', async () => {
    await expectBootWired();
  });
});

describe('execution /ready boot trade supplement fields (D45)', () => {
  it('index wires trade supplement venue ids on /ready', async () => {
    await expectBootWired();
  });
});

describe('execution /ready boot credential board union (D47)', () => {
  it('index wires supplement union into describeExecutionVenueCredentialBoard', async () => {
    await expectBootWired();
  });
});

describe('execution /ready boot credential board on ready (D48)', () => {
  it('index passes venueCredentialBoard into buildExecutionReadyResponse on /ready', async () => {
    await expectBootWired();
  });
});

describe('execution /ready boot constructed venue ids (D49)', () => {
  it('index wires trade, account, and market constructed venue ids on /ready', async () => {
    await expectBootWired();
  });
});

describe('execution /ready boot ems and trade url (D50)', () => {
  it('index passes emsAckCount and tradeUrl into buildExecutionReadyResponse on /ready', async () => {
    await expectBootWired();
  });
});

describe('execution /ready boot venue map builders (D51)', () => {
  it('index wires parseExecutionVenueIds and supplement map builders on boot', async () => {
    await expectBootWired();
  });
});

describe('execution boot trade book snapshot wiring (D52)', () => {
  it('index wires buildTradeBookSnapshotMap into createExecutionRouter snapshotByVenue', async () => {
    await expectBootWired();
  });
});

describe('execution boot ems store wiring (D53)', () => {
  it('index wires FileEmsOrderStore into createExecutionRouter — blank path fail-closed', async () => {
    await expectBootWired();
  });
});

describe('execution boot sealed registry wiring (D54)', () => {
  it('index wires SealedHouseTenantRegistry and public MD supplement into boot', async () => {
    await expectBootWired();
  });
});

describe('execution boot router venue maps wiring (D55)', () => {
  it('index passes trade, account, and market maps into createExecutionRouter', async () => {
    await expectBootWired();
  });
});

describe('execution boot trpc and edge context wiring (D57)', () => {
  it('index registers fastifyTRPCPlugin with appRouter, market maps, and createEdgeContext', async () => {
    await expectBootWired();
  });
});

describe('execution boot health and credential union (D59)', () => {
  it('index exposes /health and /ready and wires unionExecutionVenueIds into credential board', async () => {
    await expectBootWired();
  });
});

describe('execution boot open orders and rails wiring (D61)', () => {
  it('index passes openOrdersByVenue and railsByVenue into createExecutionRouter', async () => {
    await expectBootWired();
  });
});

describe('execution boot listen and venue ids parsing (D63)', () => {
  it('index parses execution venue ids and listens on HTTP_PORT', async () => {
    await expectBootWired();
  });
});

describe('execution boot index wiring complete (D65)', () => {
  it('index wires registry, venue maps, ems store, trpc, health, ready, and listen', async () => {
    await expectBootWired();
  });
});

describe('execution ready response fields complete (D67)', () => {
  it('buildExecutionReadyResponse exposes venue trade, account, market, and ems ack fields', async () => {
    await expectBootWired();
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
  it('index passes funding, borrow, latency, markets, and snapshot maps into createExecutionRouter', async () => {
    await expectBootWired();
  });
});

describe('execution boot trpc mount complete (D70)', () => {
  it('index registers trpc with edge context and graceful shutdown on boot', async () => {
    await expectBootWired();
    // Whole request, not `{ headers, id }`: the S2S body-bind needs req.body.
  });
});

describe('execution boot ready and health complete (D72)', () => {
  it('index wires health, ready, credential board union, and ems store path on boot', async () => {
    await expectBootWired();
  });
});

describe('execution boot ready and mount cert complete (D74)', () => {
  it('boot wiring and execution.sor mount-vs-tracker cert both green on tip', async () => {
    await expectBootWired();
    expect(executionSorTrackerBackendDoneBarMet()).toBe(true);
    expect(executionSorMountVsTrackerBoardCard()).toMatchObject({
      tracker: 'execution.sor',
      backendDoneBarMet: true,
      mountComplete: true,
      gaps: 0,
    });
  });
});

describe('execution boot and sor mount — D75 denon complete', () => {
  it('health/ready boot, credential board, EMS store, and mount cert board all green', async () => {
    await expectBootWired();
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
    expect(describeExecutionVenueCredentialBoard(['okx-spot'], {}).inventsCredentials).toBe(false);
  });
});

describe('execution boot and sor mount — D77 denon complete', () => {
  it('boot source wiring and execution.sor mount cert full board green', async () => {
    await expectBootWired();
    expect(executionSorTrackerBackendDoneBarMet()).toBe(true);
    expect(executionSorMountVsTrackerBoardCard()).toMatchObject({
      tracker: 'execution.sor',
      doors: 4,
      doorsMounted: 4,
      gaps: 0,
      backendDoneBarMet: true,
      mountComplete: true,
    });
  });
});

describe('execution boot and sor mount — D79 denon complete', () => {
  it('health/ready boot, EMS stores, credential board, and mount cert all green', async () => {
    await expectBootWired();
    expect(executionSorTrackerBackendDoneBarMet()).toBe(true);
    expect(executionSorMountVsTrackerBoardCard()).toMatchObject({
      tracker: 'execution.sor',
      backendDoneBarMet: true,
      mountComplete: true,
      gaps: 0,
    });
    expect(describeExecutionVenueCredentialBoard([], {}).inventsCredentials).toBe(false);
  });
});

describe('execution boot and sor mount — D82 denon complete', () => {
  it('health/ready boot, EMS stores, credential board, and mount cert all green', async () => {
    await expectBootWired();
    expect(executionSorTrackerBackendDoneBarMet()).toBe(true);
    expect(executionSorMountVsTrackerBoardCard().backendDoneBarMet).toBe(true);
    expect(describeExecutionVenueCredentialBoard([], {}).inventsCredentials).toBe(false);
  });
});

describe('execution boot and sor mount — D84 denon complete', () => {
  it('health/ready boot, EMS stores, credential board, and mount cert all green', async () => {
    await expectBootWired();
    expect(executionSorTrackerBackendDoneBarMet()).toBe(true);
    expect(executionSorMountVsTrackerBoardCard()).toMatchObject({
      tracker: 'execution.sor',
      backendDoneBarMet: true,
      mountComplete: true,
      gaps: 0,
    });
    expect(describeExecutionVenueCredentialBoard([], {}).inventsCredentials).toBe(false);
  });
});

describe('execution boot and sor mount — D86 denon complete', () => {
  it('health/ready boot, EMS stores, credential board, and mount cert all green', async () => {
    await expectBootWired();
    expect(executionSorTrackerBackendDoneBarMet()).toBe(true);
    expect(executionSorMountVsTrackerBoardCard().backendDoneBarMet).toBe(true);
    expect(describeExecutionVenueCredentialBoard([], {}).inventsCredentials).toBe(false);
  });
});

describe('execution boot and sor mount — D88 denon complete', () => {
  it('health/ready boot, EMS stores, credential board, and mount cert all green', async () => {
    await expectBootWired();
    expect(executionSorTrackerBackendDoneBarMet()).toBe(true);
    expect(executionSorMountVsTrackerBoardCard()).toMatchObject({
      tracker: 'execution.sor',
      backendDoneBarMet: true,
      mountComplete: true,
      gaps: 0,
    });
    expect(describeExecutionVenueCredentialBoard([], {}).inventsCredentials).toBe(false);
  });
});

describe('execution boot and sor mount — D90 denon complete', () => {
  it('health/ready boot, EMS stores, credential board, and mount cert all green', async () => {
    await expectBootWired();
    expect(executionSorTrackerBackendDoneBarMet()).toBe(true);
    expect(executionSorMountVsTrackerBoardCard().backendDoneBarMet).toBe(true);
    expect(describeExecutionVenueCredentialBoard([], {}).inventsCredentials).toBe(false);
  });
});

describe('execution boot and sor mount — D92 denon complete', () => {
  it('health/ready boot, EMS stores, credential board, and mount cert all green', async () => {
    await expectBootWired();
    expect(executionSorTrackerBackendDoneBarMet()).toBe(true);
    expect(executionSorMountVsTrackerBoardCard().backendDoneBarMet).toBe(true);
    expect(describeExecutionVenueCredentialBoard([], {}).inventsCredentials).toBe(false);
  });
});

describe('execution boot and sor mount — D94 denon complete', () => {
  it('health/ready boot, EMS stores, credential board, and mount cert all green', async () => {
    await expectBootWired();
    expect(executionSorTrackerBackendDoneBarMet()).toBe(true);
    expect(executionSorMountVsTrackerBoardCard().backendDoneBarMet).toBe(true);
    expect(describeExecutionVenueCredentialBoard([], {}).inventsCredentials).toBe(false);
  });
});

describe('execution boot and sor mount — D96 denon complete', () => {
  it('health/ready boot, EMS stores, credential board, and mount cert all green', async () => {
    await expectBootWired();
    expect(executionSorTrackerBackendDoneBarMet()).toBe(true);
    expect(executionSorMountVsTrackerBoardCard().backendDoneBarMet).toBe(true);
    expect(describeExecutionVenueCredentialBoard([], {}).inventsCredentials).toBe(false);
  });
});

describe('execution boot and sor mount — D98 denon complete', () => {
  it('health/ready boot, EMS stores, credential board, and mount cert all green', async () => {
    await expectBootWired();
    expect(executionSorTrackerBackendDoneBarMet()).toBe(true);
    expect(executionSorMountVsTrackerBoardCard().backendDoneBarMet).toBe(true);
    expect(describeExecutionVenueCredentialBoard([], {}).inventsCredentials).toBe(false);
  });
});

describe('execution boot and sor mount — D100 denon complete', () => {
  it('health/ready boot, EMS stores, credential board, and mount cert all green', async () => {
    await expectBootWired();
    expect(executionSorTrackerBackendDoneBarMet()).toBe(true);
    expect(executionSorMountVsTrackerBoardCard().backendDoneBarMet).toBe(true);
    expect(describeExecutionVenueCredentialBoard([], {}).inventsCredentials).toBe(false);
  });
});

describe('execution boot and sor mount — D102 denon complete', () => {
  it('health/ready boot, EMS stores, credential board, and mount cert all green', async () => {
    await expectBootWired();
    expect(executionSorTrackerBackendDoneBarMet()).toBe(true);
    expect(executionSorMountVsTrackerBoardCard().backendDoneBarMet).toBe(true);
    expect(describeExecutionVenueCredentialBoard([], {}).inventsCredentials).toBe(false);
  });
});

describe('execution boot and sor mount — D104 denon complete', () => {
  it('health/ready boot, EMS stores, credential board, and mount cert all green', async () => {
    await expectBootWired();
    expect(executionSorTrackerBackendDoneBarMet()).toBe(true);
    expect(executionSorMountVsTrackerBoardCard().backendDoneBarMet).toBe(true);
    expect(describeExecutionVenueCredentialBoard([], {}).inventsCredentials).toBe(false);
  });
});

describe('execution boot and sor mount — D106 denon complete', () => {
  it('health/ready boot, EMS stores, credential board, and mount cert all green', async () => {
    await expectBootWired();
    expect(executionSorTrackerBackendDoneBarMet()).toBe(true);
    expect(executionSorMountVsTrackerBoardCard().backendDoneBarMet).toBe(true);
    expect(describeExecutionVenueCredentialBoard([], {}).inventsCredentials).toBe(false);
  });
});

describe('execution boot and sor mount — D108 denon complete', () => {
  it('health/ready boot, EMS stores, credential board, and mount cert all green', async () => {
    await expectBootWired();
    expect(executionSorTrackerBackendDoneBarMet()).toBe(true);
    expect(executionSorMountVsTrackerBoardCard().backendDoneBarMet).toBe(true);
    expect(describeExecutionVenueCredentialBoard([], {}).inventsCredentials).toBe(false);
  });
});

describe('execution boot and sor mount — D110 denon complete', () => {
  it('health/ready boot, EMS stores, credential board, and mount cert all green', async () => {
    await expectBootWired();
    expect(executionSorTrackerBackendDoneBarMet()).toBe(true);
    expect(executionSorMountVsTrackerBoardCard().backendDoneBarMet).toBe(true);
    expect(describeExecutionVenueCredentialBoard([], {}).inventsCredentials).toBe(false);
  });
});

describe('execution boot and sor mount — D112 denon complete', () => {
  it('health/ready boot, EMS stores, credential board, and mount cert all green', async () => {
    await expectBootWired();
    expect(executionSorTrackerBackendDoneBarMet()).toBe(true);
    expect(executionSorMountVsTrackerBoardCard().backendDoneBarMet).toBe(true);
    expect(describeExecutionVenueCredentialBoard([], {}).inventsCredentials).toBe(false);
  });
});

describe('execution boot and sor mount — D114 denon complete', () => {
  it('health/ready boot, EMS stores, credential board, and mount cert all green', async () => {
    await expectBootWired();
    expect(executionSorTrackerBackendDoneBarMet()).toBe(true);
    expect(executionSorMountVsTrackerBoardCard().backendDoneBarMet).toBe(true);
    expect(describeExecutionVenueCredentialBoard([], {}).inventsCredentials).toBe(false);
  });
});

describe('execution boot and sor mount — D116 denon complete', () => {
  it('health/ready boot, EMS stores, credential board, and mount cert all green', async () => {
    await expectBootWired();
    expect(executionSorTrackerBackendDoneBarMet()).toBe(true);
    expect(executionSorMountVsTrackerBoardCard().backendDoneBarMet).toBe(true);
    expect(describeExecutionVenueCredentialBoard([], {}).inventsCredentials).toBe(false);
  });
});

describe('execution boot and sor mount — D118 denon complete', () => {
  it('health/ready boot, EMS stores, credential board, and mount cert all green', async () => {
    await expectBootWired();
    expect(executionSorTrackerBackendDoneBarMet()).toBe(true);
    expect(executionSorMountVsTrackerBoardCard().backendDoneBarMet).toBe(true);
    expect(describeExecutionVenueCredentialBoard([], {}).inventsCredentials).toBe(false);
  });
});

describe('execution boot and sor mount — D120 denon complete', () => {
  it('health/ready boot, EMS stores, credential board, and mount cert all green', async () => {
    await expectBootWired();
    expect(executionSorTrackerBackendDoneBarMet()).toBe(true);
    expect(executionSorMountVsTrackerBoardCard().backendDoneBarMet).toBe(true);
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
