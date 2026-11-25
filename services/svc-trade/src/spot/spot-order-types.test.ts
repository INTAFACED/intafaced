/**
 * GET /api/v1/order-types (J-cex-spot-15 #4): the spot types a bot reads are the ticket's, in its order, and each
 * one's example body passes the create door's own schema and is read as that kind. A type the door refuses is listed with its code.
 */
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { createOrderRequestSchema, orderTypeSchema } from '@intafaced/exchange-contract';
import { decodeVenueWire } from '@intafaced/venue-contracts';
import {
  SPOT_ORDER_TYPE_SEND,
  SPOT_ORDER_TYPES_PATH,
  SPOT_TICKET_ORDER_TYPES,
  VENUE_SPOT_ORDER_TYPE_NOT_OFFERED,
  VENUE_SPOT_OTHER_ORDER_TYPES,
  spotOrderTypesSchema,
  type SpotTicketOrderType,
} from '@intafaced/contracts/spot-order-types';
import { fakeMarket, registerPublicRest, type PublicRestDeps } from '../public-rest.js';
import { readBracketFromBody } from './bracket-place.js';
import { readOcoFromBody } from './oco-place.js';

const deps: PublicRestDeps = {
  markets: async () => [fakeMarket({ symbol: 'TEST/USDT', kind: 'spot' })],
  marketBySymbol: async () => null,
  depth: async () => ({ bids: [], asks: [], sequence: 0 }),
  publicTape: async () => [],
  candles: async () => [],
  now: () => 1_700_000_000_000,
};

const example = (id: SpotTicketOrderType) => ({ ...SPOT_ORDER_TYPE_SEND[id].send.example });

describe('spot order types', () => {
  it('serves the ticket list in its order, then trailing stop refused with the create door code', async () => {
    const app = Fastify();
    registerPublicRest(app, deps);
    await app.ready();
    const res = await app.inject({ method: 'GET', url: SPOT_ORDER_TYPES_PATH });
    await app.close();
    expect(res.statusCode).toBe(200);
    const body = spotOrderTypesSchema.parse(res.json());
    expect(body.accepted.map((row) => row.id)).toEqual([...SPOT_TICKET_ORDER_TYPES]);
    expect(body.refused).toEqual([{ id: 'trailing_stop', code: 'trade.order_type_unsupported' }]);
  });

  it.each(SPOT_TICKET_ORDER_TYPES)(
    '%s: its example body passes the create schema, with a body type and a time in force the list names',
    (id) => {
      const { send, timeInForce } = SPOT_ORDER_TYPE_SEND[id];
      for (const type of send.type) expect(orderTypeSchema.safeParse(type).success).toBe(true);
      const body = example(id);
      const parsed = createOrderRequestSchema.safeParse(body);
      expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
      expect(send.type).toContain(body.type);
      expect(timeInForce).toContain(body.timeInForce);
      // Every field the list says makes it this kind is in the example, so a bot building from the list sends it.
      for (const field of send.fields) expect(body, field).toHaveProperty(field);
    },
  );

  it('the create door reads each example as its own kind, and a plain one as none of them', () => {
    expect(readOcoFromBody(example('oco'))).toEqual({ takeProfit: { stopPrice: '90' }, stopLoss: { stopPrice: '110', price: '120' } });
    expect(readBracketFromBody(example('bracket'))?.kind).toBe('bracket');
    expect(readBracketFromBody(example('oto'))).toMatchObject({ kind: 'oto', close: { stopPrice: '110' } });
    for (const id of ['limit', 'market', 'stop_limit', 'stop_market'] as const) {
      expect(readOcoFromBody(example(id))).toBeNull();
      expect(readBracketFromBody(example(id))).toBeNull();
    }
  });

  it('when the user-venue door is on, derives accepted and refused types from the venue spot market in ticket order', async () => {
    const app = Fastify();
    registerPublicRest(app, {
      ...deps,
      venueSpotMarkets: async () => [
        { symbol: 'BTC-PERP', kind: 'perpetual', orderTypes: ['limit', 'market'], timeInForce: ['GTC', 'IOC'] },
        { symbol: 'BTC-USDC', kind: 'spot', orderTypes: ['limit', 'market'], timeInForce: ['GTC', 'IOC', 'ALO'] },
        { symbol: 'ETH-USDC', kind: 'spot', orderTypes: ['limit'], timeInForce: ['GTC', 'ALO'] },
      ],
    });
    await app.ready();

    const first = await app.inject({ method: 'GET', url: SPOT_ORDER_TYPES_PATH });
    expect(first.statusCode).toBe(200);
    const body = spotOrderTypesSchema.parse(first.json());
    expect(body.source).toBe('venue');
    expect(body.symbol).toBe('BTC-USDC');
    expect(body.accepted.map((row) => row.id)).toEqual(['limit', 'market']);
    expect(body.accepted[0]?.timeInForce).toEqual(['GTC', 'IOC', 'ALO']);
    expect(body.accepted[1]?.timeInForce).toEqual(['IOC']);
    expect(body.refused).toEqual(VENUE_SPOT_OTHER_ORDER_TYPES.map((id) => ({ id, code: VENUE_SPOT_ORDER_TYPE_NOT_OFFERED })));
    for (const row of body.accepted) {
      expect(decodeVenueWire(row.send.example)).toMatchObject({ kind: 'place_order', symbol: 'BTC-USDC', type: row.id });
    }

    const eth = await app.inject({ method: 'GET', url: `${SPOT_ORDER_TYPES_PATH}?symbol=ETH-USDC` });
    expect(eth.statusCode).toBe(200);
    const ethBody = spotOrderTypesSchema.parse(eth.json());
    expect(ethBody.symbol).toBe('ETH-USDC');
    expect(ethBody.accepted.map((row) => row.id)).toEqual(['limit']);
    expect(ethBody.accepted[0]?.timeInForce).toEqual(['GTC', 'ALO']);

    const unknown = await app.inject({ method: 'GET', url: `${SPOT_ORDER_TYPES_PATH}?symbol=NO-SUCH-PAIR` });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().intafacedCode).toBe('trade.venue.unknown_market');
    await app.close();
  });

  it('refuses 503 honestly when the venue door is on but unreachable or lists no spot market', async () => {
    const down = Fastify();
    registerPublicRest(down, {
      ...deps,
      venueSpotMarkets: async () => {
        throw new Error('venue unreachable');
      },
    });
    await down.ready();
    const downRes = await down.inject({ method: 'GET', url: SPOT_ORDER_TYPES_PATH });
    expect(downRes.statusCode).toBe(503);
    expect(downRes.json().intafacedCode).toBe('trade.venue.venue_down');
    await down.close();

    const empty = Fastify();
    registerPublicRest(empty, {
      ...deps,
      venueSpotMarkets: async () => [{ symbol: 'BTC-PERP', kind: 'perpetual', orderTypes: ['limit'], timeInForce: ['GTC'] }],
    });
    await empty.ready();
    const emptyRes = await empty.inject({ method: 'GET', url: SPOT_ORDER_TYPES_PATH });
    expect(emptyRes.statusCode).toBe(503);
    expect(emptyRes.json().intafacedCode).toBe('trade.venue.not_offered');
    await empty.close();
  });
});
