/**
 * GET /api/v1/order-types (J-cex-spot-15 #4): the spot types a bot reads are the ticket's, in its order, and each
 * one's `send` is a body the create door really reads as that kind. A type the door refuses is listed with its code.
 */
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { orderTypeSchema } from '@intafaced/exchange-contract';
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

/** A body that carries exactly the fields a type's `send` names, the way a bot would build it from the list. */
function bodyOf(id: SpotTicketOrderType): Record<string, unknown> {
  const { send } = SPOT_ORDER_TYPE_SEND[id];
  const body: Record<string, unknown> = { symbol: 'TEST/USDT', side: 'buy', amount: '1', type: send.type[0], clientOrderId: `t:${id}` };
  for (const field of send.fields) {
    if (field === 'bracket' || field === 'oto') body[field] = true;
    else if (field === 'takeProfit' || field === 'stopLoss' || field === 'close') body[field] = { price: '10', stopPrice: '9' };
    else body[field] = '10';
  }
  if (id === 'oto') body.close = { price: '12' };
  return body;
}

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

  it.each(SPOT_TICKET_ORDER_TYPES)('%s: its body type is one the create schema takes', (id) => {
    for (const type of SPOT_ORDER_TYPE_SEND[id].send.type) expect(orderTypeSchema.safeParse(type).success).toBe(true);
  });

  it('the create door reads each listed body as its own kind, and a plain one as none of them', () => {
    expect(readOcoFromBody(bodyOf('oco'))).not.toBeNull();
    expect(readBracketFromBody(bodyOf('bracket'))?.kind).toBe('bracket');
    expect(readBracketFromBody(bodyOf('oto'))?.kind).toBe('oto');
    for (const id of ['limit', 'market', 'stop_limit', 'stop_market'] as const) {
      expect(readOcoFromBody(bodyOf(id))).toBeNull();
      expect(readBracketFromBody(bodyOf(id))).toBeNull();
    }
  });
});
