/**
 * J-academy-14: the staff desk procedures for one learner, on the admin router. Every one needs `admin:read` with module
 * academy on an operator session; a change needs `admin:write` as well and refuses `academy.permission_denied` without it,
 * so a read-only support session can read the page and change nothing. The actor is the caller's own id from the
 * edge-signed principal, never the body.
 */
import { z } from 'zod';
import {
  academyAddLearnerNoteInputSchema,
  academyGrantAccessInputSchema,
  academyGrantLearnerExtensionInputSchema,
  academyLearnerChangeSchema,
  academyLearnerInputSchema,
  academyLearnerPageSchema,
  academyLearnerProgressSchema,
  academyLearnersInputSchema,
  academyLearnersSchema,
  academyLearnerTagsSchema,
  academyMarkCompleteForInputSchema,
  academyReinstateAccessInputSchema,
  academyTagLearnersInputSchema,
  academyUntagLearnerInputSchema,
  academyVoidQuizAttemptInputSchema,
  scopedProcedure,
  type Context,
} from '@intafaced/contracts';
import { AcademyError } from '../errors.js';
import type { AcademyService } from '../academy-service.js';

type Guard = <T>(fn: () => Promise<T>) => Promise<T>;

const read = () => scopedProcedure('admin:read', { module: 'academy' });

/** Whether this session may change a learner's record: it holds `admin:write`. */
export function mayChange(ctx: Context): boolean {
  return ctx.principal?.scopes.includes('admin:write') === true;
}

/** The actor of a change, refused by name when the session may only read. */
function changer(ctx: Context): string {
  if (!mayChange(ctx))
    throw new AcademyError('academy.permission_denied this session may read a learner but not change one (admin:write)', 'academy.permission_denied');
  return ctx.principal!.userId;
}

const LEARNERS_REPORT_DEFAULT = 200;

export function learnerDeskProcedures(academy: AcademyService, guard: Guard) {
  const desk = academy.learners;
  return {
    learner: read()
      .input(academyLearnerInputSchema)
      .output(academyLearnerPageSchema)
      .query(({ input, ctx }) => guard(() => desk.page(input.userId, mayChange(ctx)))),

    learnerProgress: read()
      .input(academyLearnerInputSchema)
      .output(academyLearnerProgressSchema)
      .query(({ input, ctx }) => guard(() => desk.progress(input.userId, mayChange(ctx)))),

    learners: read()
      .input(academyLearnersInputSchema)
      .output(academyLearnersSchema)
      .query(({ input }) => guard(() => desk.learners({ tag: input.tag, limit: input.limit ?? LEARNERS_REPORT_DEFAULT }))),

    learnerTags: read()
      .output(academyLearnerTagsSchema)
      .query(() => guard(() => desk.tags())),

    addLearnerNote: read()
      .input(academyAddLearnerNoteInputSchema)
      .output(academyLearnerChangeSchema)
      .mutation(({ input, ctx }) =>
        guard(async () => {
          const { n } = await desk.addNote({ ...input, actorId: changer(ctx) });
          return { userId: input.userId, done: `internal note ${n} saved` };
        }),
      ),

    markCompleteFor: read()
      .input(academyMarkCompleteForInputSchema)
      .output(academyLearnerChangeSchema)
      .mutation(({ input, ctx }) => guard(() => academy.staffMarkComplete({ ...input, operatorId: changer(ctx) }))),

    voidQuizAttempt: read()
      .input(academyVoidQuizAttemptInputSchema)
      .output(academyLearnerChangeSchema)
      .mutation(({ input, ctx }) =>
        guard(async () => {
          await desk.voidAttempt({ ...input, actorId: changer(ctx) });
          return { userId: input.userId, done: 'quiz attempt voided' };
        }),
      ),

    grantLearnerExtension: read()
      .input(academyGrantLearnerExtensionInputSchema)
      .output(academyLearnerChangeSchema)
      .mutation(({ input, ctx }) =>
        guard(async () => {
          const operatorId = changer(ctx);
          const granted = await academy.grantItemExtension({
            userId: input.userId,
            itemSlug: input.itemSlug,
            reason: input.reason,
            extendedUntil: new Date(input.until),
            clientRequestId: input.key,
            operatorId,
          });
          return { userId: input.userId, done: `due date moved for the learner (revision ${granted.revision})` };
        }),
      ),

    grantAccess: read()
      .input(academyGrantAccessInputSchema)
      .output(academyLearnerChangeSchema)
      .mutation(({ input, ctx }) =>
        guard(async () => {
          await desk.grantAccess({
            userId: input.userId,
            pathSlug: input.pathSlug,
            reason: input.reason,
            expiresAt: input.expiresAt === null ? null : new Date(input.expiresAt),
            actorId: changer(ctx),
          });
          return { userId: input.userId, done: 'access granted' };
        }),
      ),

    reinstateAccess: read()
      .input(academyReinstateAccessInputSchema)
      .output(academyLearnerChangeSchema)
      .mutation(({ input, ctx }) =>
        guard(async () => {
          await desk.reinstate({
            userId: input.userId,
            grantId: input.grantId,
            reason: input.reason,
            expiresAt: input.expiresAt === null ? null : new Date(input.expiresAt),
            n: input.n,
            actorId: changer(ctx),
          });
          return { userId: input.userId, done: 'access reinstated' };
        }),
      ),

    tagLearners: read()
      .input(academyTagLearnersInputSchema)
      .output(z.object({ added: z.number().int().nonnegative() }))
      .mutation(({ input, ctx }) => guard(() => desk.tag({ ...input, actorId: changer(ctx) }))),

    untagLearner: read()
      .input(academyUntagLearnerInputSchema)
      .output(academyLearnerChangeSchema)
      .mutation(({ input, ctx }) =>
        guard(async () => {
          const { removed } = await desk.untag({ ...input, actorId: changer(ctx) });
          return { userId: input.userId, done: removed ? `tag ${input.tag} removed` : `the learner did not carry ${input.tag}` };
        }),
      ),
  };
}
