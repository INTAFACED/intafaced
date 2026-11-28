import { z } from 'zod';
import { defineProcedure } from './procedure.js';
import { rail, saved, typed } from './bank-rail-sends-procedures.js';
import { assetIdSchema } from './asset-id.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-bank `railSends.*`, one record per call: svc-bank mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-bank', module: 'bank', transport: 'trpc' } as const;

export const requestId = z.string().guid();

export const intent = z
  .object({
    requestId: z.string(),
    fromSpaceId: z.string(),
    assetId: assetIdSchema,
    amount: z.string(),
    rail,
    recipient: z.string(),
    status: z.literal('refused'),
    refusalCode: z.string(),
    createdAt: z.string(),
  })
  .strict();

/** Ask to send, behind the step-up scope. The request id is the business key of one ask. */
export const BANK_RAIL_SENDS_SEND = defineProcedure({
  ...base,
  name: 'bank.railSends.send',
  kind: 'mutation',
  path: 'railSends.send',
  access: { caller: 'scope', scope: 'trade:withdraw', module: 'bank' },
  refusals: {},
  input: z.union([z.object({ requestId, ...typed }).strict(), z.object({ requestId, ...saved }).strict()]),
  checks: { at_most_eight_keys: { at: 'input|0.recipient', says: 'at most eight keys' } },
  output: intent,
  samples: [
    {
      verdict: 'accept',
      input: {
        requestId: '22222222-2222-4222-8222-222222222222',
        fromSpaceId: '22222222-2222-4222-8222-222222222222',
        amount: '1.50',
        rail: 'ach',
        recipient: { holderName: 'Ada TEST', routingNumber: '021000021', accountNumber: '000123456789', accountType: 'checking' },
      },
    },
    { verdict: 'refuse', input: 42 },
    {
      verdict: 'refuse',
      by: 'at_most_eight_keys',
      input: {
        requestId: '22222222-2222-4222-8222-222222222222',
        fromSpaceId: '22222222-2222-4222-8222-222222222222',
        amount: '1.50',
        rail: 'ach',
        recipient: { k1: 'x', k2: 'x', k3: 'x', k4: 'x', k5: 'x', k6: 'x', k7: 'x', k8: 'x', k9: 'x' },
      },
    },
  ],
});
