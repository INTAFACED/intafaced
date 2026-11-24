import { defineProcedure } from './procedure.js';
import { academySendCourseMessageInputSchema, academySendCourseMessageResultSchema } from './academy-course-messages.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-academy `sendCourseMessage.*`, one record per call: svc-academy mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-academy', module: 'academy', transport: 'trpc' } as const;

/** AC-rooms-04: write to the course team of a course the caller is enrolled in; the mail copy names vendor.email. */
export const ACADEMY_SEND_COURSE_MESSAGE = defineProcedure({
  ...base,
  name: 'academy.sendCourseMessage',
  kind: 'mutation',
  path: 'sendCourseMessage',
  access: { caller: 'scope', scope: 'academy:write', module: 'academy' },
  refusals: {
    'academy.course_not_found': 'NOT_FOUND',
    'academy.enrolment_required': 'FORBIDDEN',
    'academy.message_limit_unset': 'PRECONDITION_FAILED',
    'academy.message_too_long': 'BAD_REQUEST',
    'academy.request_reused': 'CONFLICT',
  },
  input: academySendCourseMessageInputSchema,
  output: academySendCourseMessageResultSchema,
  samples: [
    { verdict: 'accept', input: { courseSlug: 'placeholder', body: 'placeholder', clientRequestId: 'placeholder' } },
    { verdict: 'refuse', input: 42 },
  ],
});
