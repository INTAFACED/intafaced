/**
 * AC-assignments-04, report part: the founder console's grade report procedures. Operator only (`admin:*`, module
 * academy); the maker is the caller's own id from the edge-signed principal. Refusals keep their code on the wire.
 */
import {
  academyGradeReportFileInputSchema,
  academyGradeReportFileSchema,
  academyGradeReportSchema,
  academyGradeReportsSchema,
  academyMakeGradeReportInputSchema,
  academyCourseGradebookInputSchema,
  scopedProcedure,
} from '@intafaced/contracts';
import { gradeReportRefusals, type GradeReports } from './grade-reports.js';

const { guard } = gradeReportRefusals;

export function gradeReportProcedures(reports: GradeReports) {
  return {
    courseGradeReports: scopedProcedure('admin:read', { module: 'academy' })
      .input(academyCourseGradebookInputSchema)
      .output(academyGradeReportsSchema)
      .query(({ input }) => guard(() => reports.list(input.courseId))),

    makeGradeReport: scopedProcedure('admin:write', { module: 'academy' })
      .input(academyMakeGradeReportInputSchema)
      .output(academyGradeReportSchema)
      .mutation(({ input, ctx }) => guard(() => reports.make({ ...input, operatorId: ctx.principal!.userId, now: new Date() }))),

    gradeReportFile: scopedProcedure('admin:read', { module: 'academy' })
      .input(academyGradeReportFileInputSchema)
      .output(academyGradeReportFileSchema)
      .query(({ input }) => guard(() => reports.file(input.courseId, input.n))),
  };
}
