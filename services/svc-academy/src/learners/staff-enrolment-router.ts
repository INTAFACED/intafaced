/**
 * J-academy-15: the founder console's staff enrolment, invitation, course email and learner export procedures, on the
 * admin router (reads `admin:read`, changes `admin:write`, module academy), and the learner's own course email switch
 * (`academy:read` / `academy:write`). The actor is the caller's own id from the edge-signed principal, never the body.
 * Refusals keep their code on the wire.
 */
import {
  academyBulkEmailDetailSchema,
  academyBulkEmailInputSchema,
  academyBulkEmailsInputSchema,
  academyBulkEmailsSchema,
  academyBulkEnrolInputSchema,
  academyBulkEnrolSchema,
  academyCourseEmailsInputSchema,
  academyCourseEmailsSchema,
  academyCourseInvitationsInputSchema,
  academyCourseInvitationsSchema,
  academyInviteToCourseInputSchema,
  academyInviteToCourseSchema,
  academyReportFileInputSchema,
  academyReportFileSchema,
  academyReportTasksSchema,
  academyRequestLearnerExportInputSchema,
  academyRequestLearnerExportSchema,
  academySendBulkEmailInputSchema,
  academySendBulkEmailSchema,
  academySetCourseEmailsInputSchema,
  academyStaffEnrolInputSchema,
  academyStaffEnrolmentsInputSchema,
  academyStaffEnrolmentsSchema,
  academyStaffEnrolSchema,
  scopedProcedure,
} from '@intafaced/contracts';
import { staffEnrolmentRefusals, type StaffEnrolment } from './staff-enrolment.js';

const { guard } = staffEnrolmentRefusals;
const read = () => scopedProcedure('admin:read', { module: 'academy' });
const write = () => scopedProcedure('admin:write', { module: 'academy' });
/** How many rows a history list shows: the newest first. */
const HISTORY = 100;

export function staffEnrolmentProcedures(staff: StaffEnrolment) {
  return {
    staffEnrol: write()
      .input(academyStaffEnrolInputSchema)
      .output(academyStaffEnrolSchema)
      .mutation(({ input, ctx }) => guard(() => staff.enrol({ ...input, actorId: ctx.principal!.userId }))),

    staffEnrolments: read()
      .input(academyStaffEnrolmentsInputSchema.optional())
      .output(academyStaffEnrolmentsSchema)
      .query(({ input }) => guard(() => staff.events({ ...(input ?? {}), limit: HISTORY }))),

    bulkEnrol: write()
      .input(academyBulkEnrolInputSchema)
      .output(academyBulkEnrolSchema)
      .mutation(({ input, ctx }) => guard(() => staff.bulkEnrol({ ...input, actorId: ctx.principal!.userId }))),

    inviteToCourse: write()
      .input(academyInviteToCourseInputSchema)
      .output(academyInviteToCourseSchema)
      .mutation(({ input, ctx }) => guard(() => staff.invite({ ...input, actorId: ctx.principal!.userId }))),

    courseInvitations: read()
      .input(academyCourseInvitationsInputSchema.optional())
      .output(academyCourseInvitationsSchema)
      .query(({ input }) => guard(() => staff.invitations({ ...(input ?? {}), limit: HISTORY }))),

    sendBulkEmail: write()
      .input(academySendBulkEmailInputSchema)
      .output(academySendBulkEmailSchema)
      .mutation(({ input, ctx }) => guard(() => staff.sendBulkEmail({ ...input, actorId: ctx.principal!.userId }))),

    bulkEmails: read()
      .input(academyBulkEmailsInputSchema.optional())
      .output(academyBulkEmailsSchema)
      .query(({ input }) => guard(() => staff.bulkEmails({ ...(input ?? {}), limit: HISTORY }))),

    bulkEmail: read()
      .input(academyBulkEmailInputSchema)
      .output(academyBulkEmailDetailSchema)
      .query(({ input }) => guard(() => staff.bulkEmail(input.id))),

    requestLearnerExport: write()
      .input(academyRequestLearnerExportInputSchema)
      .output(academyRequestLearnerExportSchema)
      .mutation(({ input, ctx }) => guard(() => staff.requestLearnerExport({ ...input, actorId: ctx.principal!.userId }))),

    reportTasks: read()
      .output(academyReportTasksSchema)
      .query(() => guard(() => staff.reports({ limit: HISTORY }))),

    reportFile: read()
      .input(academyReportFileInputSchema)
      .output(academyReportFileSchema)
      .query(({ input }) => guard(() => staff.reportFile(input.id))),
  };
}

/** The learner's own switch for one course's email. */
export function courseEmailProcedures(staff: StaffEnrolment) {
  return {
    courseEmails: scopedProcedure('academy:read', { module: 'academy' })
      .input(academyCourseEmailsInputSchema)
      .output(academyCourseEmailsSchema)
      .query(({ input, ctx }) => guard(() => staff.courseEmails(ctx.principal!.userId, input.slug))),

    setCourseEmails: scopedProcedure('academy:write', { module: 'academy' })
      .input(academySetCourseEmailsInputSchema)
      .output(academyCourseEmailsSchema)
      .mutation(({ input, ctx }) => guard(() => staff.setCourseEmails({ userId: ctx.principal!.userId, path: input.slug, on: input.on }))),
  };
}
