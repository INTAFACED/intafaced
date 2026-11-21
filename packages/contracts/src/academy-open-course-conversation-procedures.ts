import { defineProcedure } from './procedure.js';
import { academyCourseConversationInputSchema, academyCourseConversationSchema } from './academy-course-messages.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-academy `openCourseConversation.*`, one record per call: svc-academy mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-academy', module: 'academy', transport: 'trpc' } as const;

/** AC-rooms-04: open one of the caller's conversations, which marks it read on their side. */
export const ACADEMY_OPEN_COURSE_CONVERSATION = defineProcedure({
  ...base,
  name: 'academy.openCourseConversation',
  kind: 'mutation',
  path: 'openCourseConversation',
  access: { caller: 'scope', scope: 'academy:write', module: 'academy' },
  refusals: { 'academy.conversation_not_found': 'NOT_FOUND' },
  input: academyCourseConversationInputSchema,
  output: academyCourseConversationSchema,
  samples: [
    { verdict: 'accept', input: { conversationId: '33333333-3333-4333-8333-333333333333', limit: 1 } },
    { verdict: 'refuse', input: 42 },
  ],
});
