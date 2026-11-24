import { z } from 'zod';
import { defineProcedure } from './procedure.js';
import { academyQuizSchema } from './academy-catalogue.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-academy `assessment.*`, one record per call: svc-academy mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-academy', module: 'academy', transport: 'trpc' } as const;

export const ACADEMY_ASSESSMENT_GET = defineProcedure({
  ...base,
  name: 'academy.assessment.get',
  kind: 'query',
  path: 'assessment.get',
  access: { caller: 'scope', scope: 'academy:read', module: 'academy' },
  refusals: { 'academy.assessment_unpublished': 'PRECONDITION_FAILED', 'academy.pass_mark_unset': 'PRECONDITION_FAILED' },
  input: z.object({ slug: z.string().min(1).max(120) }),
  output: academyQuizSchema,
  samples: [
    { verdict: 'accept', input: { slug: 'placeholder' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const ACADEMY_ASSESSMENT_ATTEMPTS = defineProcedure({
  ...base,
  name: 'academy.assessment.attempts',
  kind: 'query',
  path: 'assessment.attempts',
  access: { caller: 'scope', scope: 'academy:read', module: 'academy' },
  refusals: { 'academy.assessment_unpublished': 'PRECONDITION_FAILED' },
  input: z.object({ slug: z.string().min(1).max(120) }),
  output: z.array(
    // While the quiz's results are hidden (AC-progress-02) an attempt carries `hiddenUntil` and no score.
    z.object({
      slug: z.string(),
      score: z.number().int().nullable(),
      maxScore: z.number().int().nullable(),
      pass: z.boolean().nullable(),
      submittedAt: z.iso.datetime({ offset: true }),
      hiddenUntil: z.iso.datetime({ offset: true }).nullable(),
    }),
  ),
  samples: [
    { verdict: 'accept', input: { slug: 'placeholder' } },
    { verdict: 'refuse', input: 42 },
  ],
});
