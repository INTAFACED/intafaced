import { z } from 'zod';
import { defineProcedure, type Refusals } from './procedure.js';

/**
 * The person's own order labels on their own venue account (J-derivatives-04 #2), read from svc-trade's own record of
 * the orders they signed, and nothing from the venue.
 *
 * Where the door names the venue's public read endpoint (the live test network), the person's browser reads their own
 * open orders and orders by client id from the venue itself, so the reads count against their IP and not the box's one.
 * The venue does not know a label: the browser adds each from this list, by the order's venue client order id, the
 * way the door adds them to the orders it reads (`withOwnOrderLabel`, venue-contracts). Only this person's own signed
 * orders are listed: another person's wallet address lists none.
 */

const base = { service: 'svc-trade', module: 'trade', transport: 'trpc' } as const;
const READ = { caller: 'scope', scope: 'trade:read', module: 'trade' } as const;

const refuse = (map: Record<string, 'BAD_REQUEST' | 'SERVICE_UNAVAILABLE'>): Refusals => Object.freeze(map);

export const venueOrderLabelsSchema = z.object({
  labels: z.array(z.object({ venueClientOrderId: z.string(), label: z.string() })),
});

const OWNER = '0x1111111111111111111111111111111111111111';

/** Every label this person set on an order they signed for `owner`'s main account on the door's venue. */
export const VENUE_ORDER_LABELS_LIST = defineProcedure({
  ...base,
  name: 'trade.venueOrderLabels.list',
  kind: 'query',
  path: 'venueOrderLabels.list',
  access: READ,
  refusals: refuse({ 'trade.user_venue_off': 'SERVICE_UNAVAILABLE', 'trade.venue_request_invalid': 'BAD_REQUEST' }),
  input: z.object({ owner: z.string().max(64) }),
  output: venueOrderLabelsSchema,
  samples: [
    { verdict: 'accept', input: { owner: OWNER } },
    { verdict: 'refuse', input: { owner: 7 } },
    { verdict: 'refuse', input: {} },
  ],
});
