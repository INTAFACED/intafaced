import { z } from 'zod';
import { defineProcedure } from './procedure.js';
import { queueResultSchema } from './support-call-schemas.js';
import { jsonValueSchema } from './procedure-strict-schema.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-support `listQueue.*`, one record per call: svc-support mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-support', module: 'support', transport: 'trpc' } as const;

/** Stage-2 — prioritised operator queue (open/pending only). */
export const SUPPORT_LIST_QUEUE = defineProcedure({
  ...base,
  name: 'support.listQueue',
  kind: 'query',
  path: 'listQueue',
  access: { caller: 'scope', scope: 'support:ops' },
  refusals: {},
  input: z
    .object({
      /**
       * Page size. Optional here so omit reaches the service named
       * refuse (`support.queue_list_limit_unset`) instead of a Zod
       * "Required" that looks like a typo. Blank is not 100; pass 100
       * explicitly when that is the page you want.
       */
      limit: z.number().int().positive().max(500).optional(),
      /** Only tickets carrying this label. */
      label: z.string().max(200).optional(),
      filter: jsonValueSchema.optional(),
      sort: jsonValueSchema.nullable().optional(),
      q: z.string().max(200).optional(),
    })
    .optional(),
  output: queueResultSchema,
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});
