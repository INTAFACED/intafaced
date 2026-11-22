import { z } from 'zod';
import { assetIdSchema } from './asset-id.js';
import { defineProcedure, NO_INPUT } from './procedure.js';
import { hold } from './bank-call-schemas.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-bank `partnerHolds.*`, one record per call, written from its router while its Rust port is in flight: every app caller calls it by its record, and the router keeps its own schemas until the port's switch. */

const base = { service: 'svc-bank', module: 'bank', transport: 'trpc' } as const;

export const BANK_PARTNER_HOLDS = defineProcedure({
  ...base,
  name: 'bank.partnerHolds',
  kind: 'query',
  path: 'partnerHolds',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: {},
  input: NO_INPUT,
  output: z.discriminatedUnion('held', [
    z.object({ held: z.literal(false) }),
    z.object({
      held: z.literal(true),
      label: z.string(),
      reported: z.boolean(),
      asOf: z.string().nullable(),
      balances: z.array(
        z.object({
          assetId: assetIdSchema,
          balance: z.string().nullable(),
          balanceAsOf: z.string().nullable(),
          heldBack: z.string().nullable(),
          withdrawable: z.string().nullable(),
        }),
      ),
      holds: z.array(hold),
      released: z.array(hold.extend({ releasedAt: z.string() })),
    }),
  ]),
  samples: [{ verdict: 'accept' }],
});
