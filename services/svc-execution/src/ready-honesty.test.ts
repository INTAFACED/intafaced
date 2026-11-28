/**
 * GET /ready must not sell constructed adapters / env keys / nonempty TRADE_URL as wired live venues.
 * createAdapter + keys is constructed. Env keys are configured. This process does not ping venues.
 */
import { describe, expect, it } from 'vitest';
import { bootExecution } from './testing/boot.js';
import {
  EXECUTION_TRADE_BOOK_UNPROBED,
  EXECUTION_VENUE_UNPROBED,
  buildExecutionReadyResponse,
  constructedVenueHonesty,
  tradeBookSnapshotHonesty,
} from './ready-response.js';
import { describeExecutionVenueCredentialBoard } from './venue-adapters.js';

function readyPayload(over: Partial<Parameters<typeof buildExecutionReadyResponse>[0]> = {}) {
  return buildExecutionReadyResponse({
    emsStorePath: '',
    tradeUrl: '',
    venueTradeConstructedVenueIds: [],
    operatorSupplementVenueIds: [],
    operatorAccountSupplementVenueIds: [],
    publicMdSupplementVenueIds: [],
    venueCredentialBoard: describeExecutionVenueCredentialBoard([]),
    venueAccountConstructedVenueIds: [],
    venueMarketConstructedVenueIds: [],
    emsAckCount: 0,
    ...over,
  });
}

describe('execution /ready honesty — constructed is not wired', () => {
  it('constructed adapters are constructed + unprobed, never wired/live', () => {
    const body = readyPayload({
      venueTradeConstructedVenueIds: ['binance-spot'],
      venueAccountConstructedVenueIds: ['okx-spot'],
      venueMarketConstructedVenueIds: ['bybit-spot'],
      tradeUrl: 'http://trade.example',
    });
    expect(body.externalVenueTrade).toEqual({
      status: 'constructed',
      venueIds: ['binance-spot'],
      probe: 'unprobed',
      code: EXECUTION_VENUE_UNPROBED,
    });
    expect(body.externalVenueAccount).toEqual({
      status: 'constructed',
      venueIds: ['okx-spot'],
      probe: 'unprobed',
      code: EXECUTION_VENUE_UNPROBED,
    });
    expect(body.externalVenueMarketData).toEqual({
      status: 'constructed',
      venueIds: ['bybit-spot'],
      probe: 'unprobed',
      code: EXECUTION_VENUE_UNPROBED,
    });
    expect(body.tradeBookSnapshotVenue).toEqual({
      status: 'configured',
      venueId: 'intafaced-spot',
      probe: 'unprobed',
      code: EXECUTION_TRADE_BOOK_UNPROBED,
    });
    expect(JSON.stringify(body)).not.toMatch(/wired|live/i);
  });

  it('blank adapters and TRADE_URL are absent, still unprobed', () => {
    const body = readyPayload();
    expect(body.externalVenueTrade).toEqual(constructedVenueHonesty([]));
    expect(body.externalVenueTrade.status).toBe('absent');
    expect(body.tradeBookSnapshotVenue).toEqual(tradeBookSnapshotHonesty(''));
    expect(body.tradeBookSnapshotVenue.status).toBe('absent');
    expect(JSON.stringify(body)).not.toMatch(/wired|live/i);
  });

  it('credential board reports env keys as configured + unprobed, not wired', () => {
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
      probe: 'unprobed',
      inventsCredentials: false,
    });
    const body = readyPayload({ venueCredentialBoard: board });
    expect(JSON.stringify(body)).not.toMatch(/wired|live/i);
    expect(JSON.stringify(board)).not.toMatch(/wired/);
  });

  it('ready-response.ts and /ready boot never stamp wired/live', async () => {
    // Every adapter the booted host can construct: a trade venue with its own keys, operator keys, a trade URL.
    const booted = await bootExecution({
      EXECUTION_VENUE_IDS: 'binance-spot,okx-spot',
      EXECUTION_VENUE_BINANCE_SPOT_API_KEY: 'fixture-key',
      EXECUTION_VENUE_BINANCE_SPOT_API_SECRET: 'fixture-secret',
      VENUE_AGGREGATION_OKX_SPOT_API_KEY: 'k',
      VENUE_AGGREGATION_OKX_SPOT_API_SECRET: 's',
      VENUE_AGGREGATION_OKX_SPOT_PASSPHRASE: 'p',
      TRADE_URL: 'http://trade.test:4004',
    });
    let body: Record<string, unknown>;
    try {
      body = (await booted.app.inject({ method: 'GET', url: '/ready' })).json();
    } finally {
      await booted.close();
    }
    expect(JSON.stringify(body)).not.toMatch(/wired|live/i);
    for (const key of ['externalVenueTrade', 'externalVenueAccount', 'externalVenueMarketData'] as const) {
      const honesty = body[key] as { status: string; venueIds: string[] };
      expect(honesty, key).toEqual(constructedVenueHonesty(honesty.venueIds));
      expect(honesty.status, key).not.toBe('absent');
    }
    expect(body.tradeBookSnapshotVenue).toEqual(tradeBookSnapshotHonesty('http://trade.test:4004'));
    const board = body.venueCredentialBoard as { venues: Array<{ probe: string }> };
    expect(board.venues.length).toBeGreaterThan(0);
    expect(board.venues.every((venue) => venue.probe === 'unprobed')).toBe(true);
    for (const legacy of ['venueTradeWiredVenueIds', 'venueAccountWiredVenueIds', 'venueMarketWiredVenueIds']) {
      expect(body).not.toHaveProperty(legacy);
    }
  });
});
