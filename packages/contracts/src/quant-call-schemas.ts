import { z } from 'zod';
import { QUANT_STUDIO_LIST_LIMIT_CAP } from './quant-studio-procedures.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** The schemas svc-quant's records share, moved from the service so the records and every caller read one copy. */

/** The largest page, published with `studio.list`'s record. */
export const STUDIO_LIST_LIMIT_CAP = QUANT_STUDIO_LIST_LIMIT_CAP;

export const strategyMetadata = z.object({
  id: z.string(),
  accountId: z.string().guid().nullable(),
  name: z.string(),
  language: z.literal('javascript'),
  environment: z.enum(['paper', 'backtest', 'shadow']),
  kind: z.enum(['paper', 'simulated']),
  claimLabel: z.enum(['Paper — not live performance', 'Historical simulation — not a forecast', 'Shadow — not live performance']),
  live: z.literal(false),
  simulated: z.literal(true),
});

export const previewActInputSchema = z.discriminatedUnion('room', [
  z.object({ room: z.literal('editor'), action: z.enum(['compile', 'debug', 'step', 'profile']) }).strict(),
  z.object({ room: z.literal('tester'), action: z.enum(['start']) }).strict(),
  z.object({ room: z.literal('optimise'), action: z.enum(['start', 'stop', 'resume', 'export']) }).strict(),
]);
