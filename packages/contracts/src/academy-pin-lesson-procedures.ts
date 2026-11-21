import { z } from 'zod';
import { defineProcedure } from './procedure.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-academy `pinLesson.*`, one record per call: svc-academy mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-academy', module: 'academy', transport: 'trpc' } as const;

/** Pin a curriculum lesson to the room page (RC-academy-06). Host only; a repeat keeps its first place. */
export const ACADEMY_PIN_LESSON = defineProcedure({
  ...base,
  name: 'academy.pinLesson',
  kind: 'mutation',
  path: 'pinLesson',
  access: { caller: 'scope', scope: 'academy:write', module: 'academy' },
  refusals: {
    'academy.curriculum_not_found': 'NOT_FOUND',
    'academy.not_host': 'FORBIDDEN',
    'academy.room_not_found': 'NOT_FOUND',
    'academy.slug_reserved': 'BAD_REQUEST',
  },
  input: z.object({ roomId: z.string().guid(), itemSlug: z.string().min(1).max(120) }),
  output: z.object({ ok: z.literal(true) }),
  samples: [
    { verdict: 'accept', input: { roomId: '33333333-3333-4333-8333-333333333333', itemSlug: 'placeholder' } },
    { verdict: 'refuse', input: 42 },
  ],
});
