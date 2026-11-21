import { z } from 'zod';
import { defineProcedure } from './procedure.js';
import { academyCourseConversationsInputSchema, academyCourseConversationSummarySchema } from './academy-course-messages.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-academy `courseConversations.*`, one record per call: svc-academy mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-academy', module: 'academy', transport: 'trpc' } as const;

/** AC-rooms-04: the caller's own conversations with course teams, newest first, each with its unread marker. */
export const ACADEMY_COURSE_CONVERSATIONS = defineProcedure({
  ...base,
  name: 'academy.courseConversations',
  kind: 'query',
  path: 'courseConversations',
  access: { caller: 'scope', scope: 'academy:read', module: 'academy' },
  refusals: {},
  input: academyCourseConversationsInputSchema,
  output: z.array(academyCourseConversationSummarySchema),
  samples: [
    { verdict: 'accept', input: { limit: 1 } },
    { verdict: 'refuse', input: 42 },
  ],
});
