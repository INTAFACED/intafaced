import { z } from 'zod';
import { defineProcedure, NO_INPUT } from './procedure.js';

/**
 * svc-academy's records. The first is the one call another service makes: svc-agents' read of the curriculum spine for
 * the AI Coach. svc-academy serves the door from this record (`curriculum/internal-curriculum.ts`) and svc-agents calls
 * it through it (`coach/academy-curriculum-source.ts`).
 *
 * Its refusal is the door's own `{ error, code }` body.
 */

const text = z.string().min(1);

export const ACADEMY_INTERNAL_CURRICULUM = defineProcedure({
  name: 'academy.internal.curriculum',
  service: 'svc-academy',
  transport: 'http',
  method: 'GET',
  path: '/internal/curriculum',
  access: { caller: 'service', callers: ['svc-agents'] },
  refusals: { 'academy.unauthenticated': 'UNAUTHORIZED' },
  input: NO_INPUT,
  output: z.object({
    /** Slug and title only: never a lesson body. */
    items: z.array(z.object({ slug: text, title: text })),
    /** The licensed library is not in this repo, so the wire can never claim it. */
    licensedLibraryImported: z.literal(false),
    source: z.literal('platform-spine'),
  }),
  samples: [{ verdict: 'accept' }],
});
