import { NOT_MINE, mockContext, refuse } from '../mock/shared.mjs';

export { NOT_MINE, mockContext, refuse };
import { createAnalyticsMock } from './analytics/mock.mjs';
import { createDevelopersMock } from './developers/mock.mjs';
import { createReportsMock } from './reports/mock.mjs';

/** The stand-in answers for the developers, reports and analytics pages, as one part for `portal.mock.mjs`. */
export function createSettingsBMock(ctx) {
  const parts = [createDevelopersMock(ctx), createReportsMock(ctx), createAnalyticsMock(ctx)];
  return {
    async handle(procedure, input, route) {
      for (const part of parts) {
        const answered = await part.handle(procedure, input, route);
        if (answered !== NOT_MINE) return answered;
      }
      return NOT_MINE;
    },
  };
}
