import { z } from 'zod';
import { defineProcedure, NO_INPUT } from './procedure.js';

/**
 * The demo environment a bot trades in (J-cex-spot-15 #8): a configured venue whose own proof level is not live, so it
 * holds TEST assets only. The bot reads it here, then trades on it through the same doors as anywhere else
 * (`/api/v1/venue/prepare` and `/submit` with this `venueId`), signed by its agent permission; every prepare and submit
 * answer names the environment it was made in. The venue keeps the TEST balances; our ledger posts nothing for it.
 * With no TEST venue configured (a live deployment) there is no demo, and the door refuses `trade.demo_unavailable`.
 *
 * Served by svc-trade's user-venue door (`services/svc-trade/src/venue/user-venue-rest.ts`). Refusals are the door's
 * CCXT-style `{ code, message, intafacedCode }` bodies, by status.
 */
export const TRADE_VENUE_DEMO = defineProcedure({
  name: 'trade.venue.demo',
  service: 'svc-trade',
  transport: 'http',
  method: 'GET',
  path: '/api/v1/venue/demo',
  access: { caller: 'scope', scope: 'trade:read' },
  refusals: {
    'trade.user_venue_off': 'NOT_FOUND',
    'trade.demo_unavailable': 'SERVICE_UNAVAILABLE',
  },
  input: NO_INPUT,
  output: z
    .object({
      environment: z.literal('demo'),
      venueId: z.string().min(1),
      displayName: z.string().min(1),
      /** The venue's own proof level: never `live`. */
      proofLevel: z
        .string()
        .min(1)
        .refine((level) => level !== 'live', 'a demo venue is never live'),
      /** Every asset and figure in the demo is TEST. */
      label: z.literal('TEST'),
      /** What our ledger records for a demo trade: nothing. */
      ledger: z.literal('none'),
    })
    .strict(),
  outputChecks: { notLive: { at: 'output.proofLevel', says: 'a demo venue is never live' } },
  samples: [{ verdict: 'accept' }],
});
