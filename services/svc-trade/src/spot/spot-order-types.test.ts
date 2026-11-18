/**
 * GET /api/v1/order-types (J-cex-spot-15 #4): the spot types a bot reads are the ticket's, in its order, and each
 * one's example body passes the create door's own schema and is read as that kind. A type the door refuses is listed with its code.
 */
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { createOrderRequestSchema, orderTypeSchema } from '@intafaced/exchange-contract';
import {
  SPOT_ORDER_TYPE_SEND,
  SPOT_ORDER_TYPES_PATH,
  SPOT_TICKET_ORDER_TYPES,
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
});
