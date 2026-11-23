import { z } from 'zod';
import { defineProcedure } from './procedure.js';
import { amountSchema, assetIdSchema, checkoutSessionView } from './pay-call-schemas.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-pay `checkout.*`, one record per call: svc-pay mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-pay', module: 'pay', transport: 'trpc' } as const;

/**
 * Poll a session by its OWN token.
 *
 * A separate token from the link's, because a link is a many-payer
 * capability and a session is one payer's: addressing sessions by the link
 * token would let anybody holding the URL read a stranger's checkout.
 */
export const PAY_CHECKOUT_STATUS = defineProcedure({
  ...base,
  name: 'pay.checkout.status',
  kind: 'query',
  path: 'checkout.status',
  access: { caller: 'public' },
  refusals: {},
  input: z.object({ sessionToken: z.string().min(8).max(200) }),
  output: checkoutSessionView,
  samples: [
    { verdict: 'accept', input: { sessionToken: 'placeholder' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const PAY_CHECKOUT_OPEN = defineProcedure({
  ...base,
  name: 'pay.checkout.open',
  kind: 'mutation',
  path: 'checkout.open',
  access: { caller: 'public' },
  refusals: {},
  input: z.object({
    token: z.string().min(8).max(200),
    /** Honoured only on a link that fixes no amount. Otherwise ignored. */
    amount: amountSchema.optional(),
    /** Honoured only on a link that fixes no currency. Otherwise ignored. */
    assetId: assetIdSchema.optional(),
    /** Payer-stated ISO country. Blank → pay.routing_input_missing. Not a rail id. */
    geoCountry: z.string().max(8).optional(),
    /** Method (`crypto`/`card`), never a rail adapter id. */
    method: z.string().max(32).optional(),
    /** RC-merchant-09: the name on the bank account a bank transfer comes from. Checked by the service. */
    payerName: z.string().max(1000).optional(),
  }),
  output: z.object({ sessionToken: z.string(), session: checkoutSessionView }),
  samples: [
    { verdict: 'accept', input: { token: 'placeholder' } },
    { verdict: 'refuse', input: 42 },
  ],
});
