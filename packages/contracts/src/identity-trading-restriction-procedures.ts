import { z } from 'zod';
import { defineProcedure, NO_INPUT } from './procedure.js';

/**
 * Whether identity holds a trading restriction on one person now (J-support-public-20 #7): a support agent's account
 * freeze from the customer's request (`trading_restrictions`), or a staff close with a grace date, which ends trading
 * first. The same facts identity's operation decision refuses `trade.account_restricted` on, read by a door that places
 * an order without that decision: svc-trade's user-venue door, which relays the person's own signed venue order and
 * holds none of their money. Read per order; the caller keeps no copy, and refuses when it can't be read.
 *
 * Its refusals are the door's own `{ error, code }` bodies, by status.
 */
export const IDENTITY_TRADING_RESTRICTION = defineProcedure({
  name: 'identity.tradingRestriction',
  service: 'svc-identity',
  transport: 'http',
  method: 'GET',
  path: '/internal/trading-restriction/:userId',
  params: z.object({ userId: z.string().uuid() }),
  access: { caller: 'service', callers: ['svc-trade'] },
  refusals: {
    'identity.unauthenticated': 'UNAUTHORIZED',
    'identity.forbidden': 'FORBIDDEN',
    'identity.account_not_found': 'NOT_FOUND',
    'identity.trading_restriction_unavailable': 'SERVICE_UNAVAILABLE',
  },
  input: NO_INPUT,
  output: z.object({
    userId: z.string().uuid(),
    /** True while a new order is refused for this person by identity (`trade.account_restricted`). */
    restricted: z.boolean(),
  }),
  samples: [{ verdict: 'accept' }],
});
