/** AC-analytics-01 and -02: the procedures need the operator scope, a change needs admin:write, and a refusal keeps its code. */
import { describe, expect, it } from 'vitest';
import { router } from '@intafaced/contracts';
import { edgeCallers, expectRefusal } from '@intafaced/service-kit/testing';
import { analyticsRefusals, type LearnerSummaries } from './learner-summaries.js';
import type { ReportTasks } from './report-tasks.js';
import { analyticsProcedures } from './analytics-router.js';

const TASK = '44444444-4444-4444-8444-444444444444';
const callers = edgeCallers({ serviceName: 'svc-academy', scopes: ['admin:read', 'admin:write'] });
const summaries = {
  page: async () => analyticsRefusals.refuse('academy.learner_summaries_list_limit_unset'),
} as unknown as LearnerSummaries;
const reports = {
  list: async () => analyticsRefusals.refuse('academy.report_tasks_list_limit_unset'),
  request: async () => analyticsRefusals.refuse('academy.report_retention_unset'),
  abort: async () => analyticsRefusals.refuse('academy.report_not_abortable'),
  delete: async () => analyticsRefusals.refuse('academy.report_not_found'),
  file: async () => analyticsRefusals.refuse('academy.report_expired'),
} as unknown as ReportTasks;
const app = router(analyticsProcedures(summaries, reports));

describe('analytics procedures', () => {
  it('refuse a learner, and a read-only operator any change', async () => {
    const learner = app.createCaller(callers.signed({ scopes: ['academy:read'] }));
    await expect(learner.learnerSummaries({})).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(learner.reportTasks()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const reader = app.createCaller(callers.signed({ scopes: ['admin:read'] }));
    await expect(reader.requestReport({ kind: 'learners', tag: null, n: 1 })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(reader.abortReport({ taskId: TASK })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(reader.deleteReport({ taskId: TASK })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(app.createCaller(callers.forged()).reportFile({ taskId: TASK })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('send each refusal code and its status to the console', async () => {
    const founder = app.createCaller(callers.signed());
    await expectRefusal(founder.learnerSummaries({}), 'academy.learner_summaries_list_limit_unset', 'PRECONDITION_FAILED');
    await expectRefusal(founder.reportTasks(), 'academy.report_tasks_list_limit_unset', 'PRECONDITION_FAILED');
    await expectRefusal(
      founder.requestReport({ kind: 'learners', tag: null, n: 1 }),
      'academy.report_retention_unset',
      'PRECONDITION_FAILED',
    );
    await expectRefusal(founder.abortReport({ taskId: TASK }), 'academy.report_not_abortable', 'CONFLICT');
    await expectRefusal(founder.deleteReport({ taskId: TASK }), 'academy.report_not_found', 'NOT_FOUND');
    await expectRefusal(founder.reportFile({ taskId: TASK }), 'academy.report_expired', 'PRECONDITION_FAILED');
  });
});
