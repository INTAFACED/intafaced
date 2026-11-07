import { z } from 'zod';
import { ACADEMY_CURRICULUM_KINDS, ACADEMY_CURRICULUM_PATHS } from './academy-catalogue.js';

/**
 * J-academy-14, the staff desk for one learner (AC-enrolment-03, AC-progress-03, AC-release-access-02, AC-access-grants-01).
 *
 * The learner page: access, enrolments, internal notes, tags, every item's progress with its history and attempts, and
 * the audit of every staff change. Profile and sign-in statistics are identity's, read by the console through identity's
 * own `learnerCard` read; the academy stores none. Reads need `admin:read`; every change needs `admin:write` and a
 * reason, and refuses `academy.permission_denied` without it, so a read-only support session can open the page and change
 * nothing. Internal notes and staff names never reach a learner's own reads. No money moves here.
 */

const isoInstant = z.string().datetime({ offset: true });
const account = z.string().guid();
/** A reason as typed; blank is refused by svc-academy with `academy.reason_required`, never defaulted. */
const reasonAsTyped = z.string().max(500);
/** The console's own key for one press, so a replay after a lost reply answers with the stored change. */
const requestKey = z.string().trim().min(1).max(200);

export const ACADEMY_LEARNER_TAG_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;
const tagName = z.string().trim().regex(ACADEMY_LEARNER_TAG_PATTERN);

export const ACADEMY_ACCESS_GRANT_SOURCES = ['free', 'purchase', 'staff', 'bundle', 'membership'] as const;
export const ACADEMY_ACCESS_GRANT_STATES = ['granted', 'expired', 'revoked'] as const;
export const ACADEMY_ACCESS_GRANT_EVENTS = ['granted', 'expired', 'revoked', 'reinstated'] as const;

/** One access record. `id` null: the learner's free enrolment, which is its own record and never expires. */
export const academyLearnerGrantSchema = z.object({
  id: z.string().guid().nullable(),
  pathSlug: z.enum(ACADEMY_CURRICULUM_PATHS),
  source: z.enum(ACADEMY_ACCESS_GRANT_SOURCES),
  reason: z.string().nullable(),
  startsAt: isoInstant,
  expiresAt: isoInstant.nullable(),
  state: z.enum(ACADEMY_ACCESS_GRANT_STATES),
  events: z.array(
    z.object({
      n: z.number().int().positive(),
      kind: z.enum(ACADEMY_ACCESS_GRANT_EVENTS),
      reason: z.string().nullable(),
      /** Null for the expiry, which the academy records itself when the date has passed. */
      actorId: account.nullable(),
      expiresAt: isoInstant.nullable(),
      at: isoInstant,
    }),
  ),
});
export type AcademyLearnerGrant = z.infer<typeof academyLearnerGrantSchema>;

export const ACADEMY_LEARNER_AUDIT_KINDS = [
  'note_added',
  'tag_added',
  'tag_removed',
  'marked_complete',
  'quiz_attempt_voided',
  'extension_granted',
  'grant_granted',
  'grant_expired',
  'grant_reinstated',
] as const;

/** `admin.learner`: the learner page as svc-academy holds it. */
export const academyLearnerPageSchema = z.object({
  userId: account,
  /** Whether this session may change anything here (it holds `admin:write`); the console shows no change control without it. */
  canChange: z.boolean(),
  enrolments: z.array(z.object({ pathSlug: z.enum(ACADEMY_CURRICULUM_PATHS), enrolledAt: isoInstant, leftAt: isoInstant.nullable() })),
  access: z.array(academyLearnerGrantSchema),
  notes: z.array(z.object({ n: z.number().int().positive(), body: z.string().min(1), authorId: account, at: isoInstant })),
  tags: z.array(z.object({ tag: z.string().min(1), addedBy: account, addedAt: isoInstant })),
  audit: z.array(
    z.object({
      kind: z.enum(ACADEMY_LEARNER_AUDIT_KINDS),
      at: isoInstant,
      /** Null only for the expiry the academy records itself. */
      actorId: account.nullable(),
      reason: z.string().nullable(),
      /** What changed, in words. */
      detail: z.string(),
    }),
  ),
});
export type AcademyLearnerPage = z.infer<typeof academyLearnerPageSchema>;

export const academyLearnerInputSchema = z.object({ userId: account }).strict();

/** `admin.learnerProgress`: every item of each course the learner is or was enrolled in. */
export const academyLearnerProgressSchema = z.object({
  userId: account,
  canChange: z.boolean(),
  courses: z.array(
    z.object({
      pathSlug: z.enum(ACADEMY_CURRICULUM_PATHS),
      items: z.array(
        z.object({
          slug: z.string().min(1),
          title: z.string().min(1),
          kind: z.enum(ACADEMY_CURRICULUM_KINDS),
          /** `undone`: completed once and then undone, with the tombstone kept in `history`. */
          status: z.enum(['completed', 'not_started', 'undone']),
          completedAt: isoInstant.nullable(),
          history: z.array(z.object({ event: z.enum(['completed', 'undone']), at: isoInstant })),
          /** The item's own due date for everyone, and this learner's own date when staff moved it. */
          dueAt: isoInstant.nullable(),
          extension: z
            .object({ until: isoInstant, reason: z.string().min(1), grantedBy: account, grantedAt: isoInstant, revision: z.number().int() })
            .nullable(),
          quiz: z
            .object({
              attemptLimit: z.number().int().positive().nullable(),
              /** Attempts that still count against the limit (voided ones do not). */
              counted: z.number().int().nonnegative(),
              attempts: z.array(
                z.object({
                  attemptId: z.string().guid(),
                  score: z.number().int().nonnegative(),
                  maxScore: z.number().int().nonnegative(),
                  passed: z.boolean(),
                  submittedAt: isoInstant,
                  voided: z.object({ at: isoInstant, by: account, reason: z.string().min(1) }).nullable(),
                }),
              ),
            })
            .nullable(),
        }),
      ),
    }),
  ),
});
export type AcademyLearnerProgress = z.infer<typeof academyLearnerProgressSchema>;

/** `admin.addLearnerNote`: an internal note. Never returned to the learner. */
export const academyAddLearnerNoteInputSchema = z.object({ userId: account, body: z.string().trim().min(1).max(2000), key: requestKey }).strict();

/** `admin.markCompleteFor`: staff record an item complete for the learner, with a reason. */
export const academyMarkCompleteForInputSchema = z
  .object({ userId: account, itemSlug: z.string().trim().min(1).max(120), reason: reasonAsTyped, key: requestKey })
  .strict();

/** `admin.voidQuizAttempt`: one finished attempt no longer counts, so the learner may retake within the rules left. */
export const academyVoidQuizAttemptInputSchema = z.object({ userId: account, attemptId: z.string().guid(), reason: reasonAsTyped }).strict();

/** `admin.grantLearnerExtension`: this learner's own later date on an item with a window. */
export const academyGrantLearnerExtensionInputSchema = z
  .object({ userId: account, itemSlug: z.string().trim().min(1).max(120), until: isoInstant, reason: reasonAsTyped, key: requestKey })
  .strict();

/** `admin.grantAccess`: a staff access record for a course, with a reason and an optional end. */
export const academyGrantAccessInputSchema = z
  .object({ userId: account, pathSlug: z.enum(ACADEMY_CURRICULUM_PATHS), reason: reasonAsTyped, expiresAt: isoInstant.nullable() })
  .strict();

/** `admin.reinstateAccess`: the same record granted again (`reinstate:<grant>:<n>`), with a reason and an optional new end. */
export const academyReinstateAccessInputSchema = z
  .object({ userId: account, grantId: z.string().guid(), reason: reasonAsTyped, expiresAt: isoInstant.nullable(), n: z.number().int().positive() })
  .strict();

/** `admin.tagLearners` and `admin.untagLearner`: a keyword on one or many learners. Tags are never renamed. */
export const academyTagLearnersInputSchema = z.object({ userIds: z.array(account).min(1).max(200), tag: tagName, reason: reasonAsTyped }).strict();
export const academyUntagLearnerInputSchema = z.object({ userId: account, tag: tagName, reason: reasonAsTyped }).strict();

/** `admin.learnerTags`: every tag with how many learners carry it. */
export const academyLearnerTagsSchema = z.array(z.object({ tag: z.string().min(1), learners: z.number().int().nonnegative() }));

/** `admin.learners`: the learners report, filtered by tag when one is named. */
export const academyLearnersInputSchema = z.object({ tag: tagName.optional(), limit: z.number().int().min(1).max(200).optional() }).strict();
export const academyLearnersSchema = z.object({
  tag: z.string().nullable(),
  rows: z.array(
    z.object({
      userId: account,
      paths: z.array(z.enum(ACADEMY_CURRICULUM_PATHS)),
      tags: z.array(z.string().min(1)),
    }),
  ),
});
export type AcademyLearners = z.infer<typeof academyLearnersSchema>;

export const academyLearnerChangeSchema = z.object({ userId: account, done: z.string().min(1) });
export type AcademyLearnerChange = z.infer<typeof academyLearnerChangeSchema>;
