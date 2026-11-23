import { expect } from './journey.mjs';
import { api } from './stack.mjs';

// Orders on our own TEST book through the customer's own API (svc-trade private REST), as the own-book journeys place
// and read them.

/** Places one order on `symbol` for `who`: a new order answers 201 Created; any other answer is a refusal to read. */
export async function placeOwnOrder(who, symbol, body) {
  const res = await (await api(who)).post('/api/v1/orders', { symbol, timeInForce: 'GTC', ...body });
  expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(201);
  return res.body;
}

/** The fills of one of `who`'s own orders, as their own API lists them. */
export async function ownOrderFills(who, id) {
  const { status, body } = await (await api(who)).get(`/api/v1/orders/${id}/trades?limit=100`);
  expect(status, JSON.stringify(body).slice(0, 300)).toBe(200);
  return Array.isArray(body) ? body : (body.trades ?? body.items ?? []);
}
