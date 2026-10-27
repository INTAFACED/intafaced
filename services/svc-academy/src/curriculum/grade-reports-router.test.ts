/** AC-assignments-04, report part: the procedures need the operator scope, and a refusal keeps its code on the wire. */
import { describe, expect, it } from 'vitest';
import { router } from '@intafaced/contracts';
import { edgeCallers, expectRefusal } from '@intafaced/service-kit/testing';
import { gradeReportRefusals, type GradeReports } from './grade-reports.js';
import { gradeReportProcedures } from './grade-reports-router.js';

const COURSE = '44444444-4444-4444-8444-444444444444';
const callers = edgeCallers({ serviceName: 'svc-academy', scopes: ['admin:read', 'admin:write'] });
const blank = {
  make: async () => gradeReportRefusals.refuse('academy.report_limit_unset'),
  list: async () => ({ courseId: COURSE, reports: [] }),
  file: async () => gradeReportRefusals.refuse('academy.report_not_found'),
} as unknown as GradeReports;
const app = router(gradeReportProcedures(blank));

describe('grade report procedures', () => {
  it('refuse a caller without the operator scope', async () => {
    const learner = app.createCaller(callers.signed({ scopes: ['academy:read'] }));
    await expect(learner.courseGradeReports({ courseId: COURSE })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(app.createCaller(callers.forged()).makeGradeReport({ courseId: COURSE, n: 1 })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });

  it('send the refusal code and its status to the console', async () => {
    const founder = app.createCaller(callers.signed());
    await expectRefusal(founder.makeGradeReport({ courseId: COURSE, n: 1 }), 'academy.report_limit_unset', 'PRECONDITION_FAILED');
    await expectRefusal(founder.gradeReportFile({ courseId: COURSE, n: 1 }), 'academy.report_not_found', 'NOT_FOUND');
    await expect(founder.courseGradeReports({ courseId: COURSE })).resolves.toEqual({ courseId: COURSE, reports: [] });
  });
});
