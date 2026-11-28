import { z } from 'zod';
import { defineProcedure } from './procedure.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-academy `.*`, one record per call: svc-academy mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-academy', module: 'academy', transport: 'trpc' } as const;

export const enrollmentOut = z.object({
  userId: z.string().guid(),
  pathSlug: z.string(),
  enrolledAt: z.iso.datetime({ offset: true }),
});

export const leaveOut = enrollmentOut.extend({ leftAt: z.iso.datetime({ offset: true }) });

export const ACADEMY_LEAVE_CERT_PATH = defineProcedure({
  ...base,
  name: 'academy.leaveCertPath',
  kind: 'mutation',
  path: 'leaveCertPath',
  access: { caller: 'scope', scope: 'academy:write', module: 'academy' },
  refusals: { 'academy.cert_invalid': 'BAD_REQUEST', 'academy.enrollment_not_found': 'NOT_FOUND' },
  input: z.object({ pathSlug: z.string().min(1).max(64), clientRequestId: z.string().min(1).max(200) }),
  output: leaveOut,
  samples: [
    { verdict: 'accept', input: { pathSlug: 'foundations', clientRequestId: 'leave:foundations:sample' } },
    { verdict: 'refuse', input: 42 },
  ],
});
