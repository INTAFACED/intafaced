import { z } from 'zod';
import { ACADEMY_COURSE_PACING } from './academy-course-release.js';

/**
 * AC-course-structure-01: a course is a record staff create on the Academy desk. Its slug is fixed at creation; its details
 * change by revision while it is a draft. A paid course carries a one-time price as a decimal string with its asset, and
 * may be saved without one, but never published without one (`academy.price_unset`). No money moves here: the price is a
 * catalogue figure the purchase slice (AC-commerce-01) will read, never a balance.
 */
export const ACADEMY_COURSE_STATES = ['draft', 'published', 'concluded', 'archived', 'deleted'] as const;
export type AcademyCourseState = (typeof ACADEMY_COURSE_STATES)[number];
export const ACADEMY_COURSE_PRICING = ['free', 'paid'] as const;
export type AcademyCoursePricing = (typeof ACADEMY_COURSE_PRICING)[number];
/** The moves the desk offers today. Conclude, archive, delete and undelete are the lifecycle's next part. */
export const ACADEMY_COURSE_MOVES = ['published'] as const;

/** Lower-case words joined by single hyphens, 3 to 64 characters: the course page's address. */
export const ACADEMY_COURSE_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const academyCourseSlugSchema = z.string().min(3).max(64).regex(ACADEMY_COURSE_SLUG);
/** A positive decimal string, at most 18 places: never a JavaScript number. */
export const ACADEMY_PRICE = /^(?:0|[1-9]\d{0,19})(?:\.\d{1,18})?$/;
export const academyPriceSchema = z
  .string()
  .regex(ACADEMY_PRICE)
  .refine((v) => /[1-9]/.test(v), { message: 'a price is more than zero' });
export const academyPriceAssetSchema = z.string().regex(/^[A-Z][A-Z0-9]{1,11}$/);

const details = {
  title: z.string().trim().min(1).max(120),
  summary: z.string().trim().max(1000).nullable(),
  /** An https image address, or null for none. The desk shows it; the service never fetches it. */
  thumbnailUrl: z.string().max(2048).url().startsWith('https://').nullable(),
  pricing: z.enum(ACADEMY_COURSE_PRICING),
  price: academyPriceSchema.nullable(),
  priceAsset: academyPriceAssetSchema.nullable(),
};

type Details = { pricing: AcademyCoursePricing; price: string | null; priceAsset: string | null };
const pricingHolds = (d: Details) => (d.price === null) === (d.priceAsset === null) && (d.pricing === 'paid' || d.price === null);
const PRICING_RULE = { message: 'a price comes with its asset, and only a paid course has one' };

/** `admin.createCourse`. A repeat with the same slug and details answers with the stored course; nothing is created twice. */
export const academyCreateCourseInputSchema = z
  .object({ slug: academyCourseSlugSchema, ...details })
  .strict()
  .refine(pricingHolds, PRICING_RULE);
export type AcademyCreateCourseInput = z.infer<typeof academyCreateCourseInputSchema>;

/** `admin.updateCourse`: the details as a whole, over the revision the editor read. The slug never changes. */
export const academyUpdateCourseInputSchema = z
  .object({ courseId: z.string().guid(), revision: z.number().int().positive(), ...details })
  .strict()
  .refine(pricingHolds, PRICING_RULE);
export type AcademyUpdateCourseInput = z.infer<typeof academyUpdateCourseInputSchema>;

/** `admin.setCourseState`: one lifecycle move over the revision the editor read, with the reason staff give. */
export const academySetCourseStateInputSchema = z
  .object({
    courseId: z.string().guid(),
    to: z.enum(ACADEMY_COURSE_MOVES),
    revision: z.number().int().positive(),
    reason: z.string().trim().min(1).max(500),
  })
  .strict();
export type AcademySetCourseStateInput = z.infer<typeof academySetCourseStateInputSchema>;

const isoInstant = z.string().datetime({ offset: true });

export const academyCourseSchema = z.object({
  id: z.string().guid(),
  slug: z.string().min(1),
  title: z.string().min(1),
  summary: z.string().nullable(),
  thumbnailUrl: z.string().nullable(),
  pricing: z.enum(ACADEMY_COURSE_PRICING),
  price: z.string().nullable(),
  priceAsset: z.string().nullable(),
  state: z.enum(ACADEMY_COURSE_STATES),
  revision: z.number().int().positive(),
  /** Items in the course's outline a learner can open (subheaders are labels and are not counted). */
  items: z.number().int().nonnegative(),
  createdBy: z.string().guid(),
  createdAt: isoInstant,
  updatedAt: isoInstant,
});
export type AcademyCourse = z.infer<typeof academyCourseSchema>;

export const ACADEMY_COURSE_EVENT_KINDS = ['created', 'updated', 'state', 'outline', 'lesson', 'topics', 'withdrawn'] as const;
export const academyCourseEventSchema = z.object({
  kind: z.enum(ACADEMY_COURSE_EVENT_KINDS),
  revision: z.number().int().positive(),
  fromState: z.enum(ACADEMY_COURSE_STATES).nullable(),
  toState: z.enum(ACADEMY_COURSE_STATES),
  actor: z.string().guid(),
  reason: z.string().nullable(),
  at: isoInstant,
});
export type AcademyCourseEvent = z.infer<typeof academyCourseEventSchema>;

/**
 * AC-course-structure-02: a course's outline is ordered sections of typed items. A `subheader` is a label inside a
 * section, not something to open; a `link` carries an https address and opens in a new tab (nothing launches a tool);
 * every other kind's content is written in the lesson editor (AC-course-structure-03). `indent` is 0 to 2.
 */
export const ACADEMY_OUTLINE_ITEM_KINDS = ['lesson', 'video', 'file', 'quiz', 'assignment', 'discussion', 'link', 'subheader'] as const;
export type AcademyOutlineItemKind = (typeof ACADEMY_OUTLINE_ITEM_KINDS)[number];

const outlineItemInput = z
  .object({
    /** A stored item keeps its id (and with it its lesson revisions); a new one has none. */
    id: z.string().guid().optional(),
    kind: z.enum(ACADEMY_OUTLINE_ITEM_KINDS),
    title: z.string().trim().min(1).max(120),
    indent: z.number().int().min(0).max(2),
    url: z.string().max(2048).url().startsWith('https://').nullable(),
  })
  .strict()
  .refine((i) => (i.kind === 'link') === (i.url !== null), { message: 'a link item has an https address, and only a link has one' });

/**
 * `admin.saveOutline`: the whole outline, over the revision the editor read. The owner's section and item limits bound
 * it; while either limit is blank the save refuses `academy.outline_limits_unset`, and nothing is defaulted.
 */
export const academySaveOutlineInputSchema = z
  .object({
    courseId: z.string().guid(),
    revision: z.number().int().positive(),
    sections: z
      .array(
        z
          .object({
            id: z.string().guid().optional(),
            title: z.string().trim().min(1).max(120),
            items: z.array(outlineItemInput).max(1000),
          })
          .strict(),
      )
      .max(1000),
  })
  .strict();
export type AcademySaveOutlineInput = z.infer<typeof academySaveOutlineInputSchema>;

export const academyOutlineItemSchema = z.object({
  id: z.string().guid(),
  kind: z.enum(ACADEMY_OUTLINE_ITEM_KINDS),
  title: z.string().min(1),
  indent: z.number().int().min(0).max(2),
  url: z.string().nullable(),
  /** The item's newest lesson revision, or null when nothing is written yet. */
  lessonRevision: z.number().int().positive().nullable(),
  /** The lesson revision learners see, or null when none is published. */
  liveRevision: z.number().int().positive().nullable(),
});
export const academyOutlineSectionSchema = z.object({
  id: z.string().guid(),
  title: z.string().min(1),
  items: z.array(academyOutlineItemSchema),
});
export type AcademyOutlineSection = z.infer<typeof academyOutlineSectionSchema>;

/** The owner's outline limits: null is "not set", and a save refuses until both are set. */
export const academyOutlineLimitsSchema = z.object({
  maxSections: z.number().int().positive().nullable(),
  maxItems: z.number().int().positive().nullable(),
});

/** `admin.course`: one course with its outline, the owner's outline limits and its history, newest first. */
export const academyCourseDetailSchema = z.object({
  course: academyCourseSchema,
  /** AC-articles-01: the topics the course is filed under, by name. */
  topics: z.array(z.lazy(() => academyTopicSchema)),
  outline: z.array(academyOutlineSectionSchema),
  limits: academyOutlineLimitsSchema,
  events: z.array(academyCourseEventSchema),
});
export type AcademyCourseDetail = z.infer<typeof academyCourseDetailSchema>;

/** `admin.courses` input. The page size is the caller's to send; a missing one refuses rather than dumping the table. */
export const academyCourseListInputSchema = z
  .object({ state: z.enum(ACADEMY_COURSE_STATES).optional(), limit: z.number().int().positive().max(500).optional() })
  .strict();
export type AcademyCourseListInput = z.infer<typeof academyCourseListInputSchema>;

/** `admin.courses`: the page asked for, newest first, and how many courses are in each state (all of them, not the page). */
export const academyCourseListSchema = z.object({
  courses: z.array(academyCourseSchema),
  counts: z.object(
    Object.fromEntries(ACADEMY_COURSE_STATES.map((s) => [s, z.number().int().nonnegative()])) as {
      [K in AcademyCourseState]: z.ZodNumber;
    },
  ),
});
export type AcademyCourseList = z.infer<typeof academyCourseListSchema>;

/**
 * AC-course-structure-03: a lesson is an outline item's content, written as ordered blocks. Every save is a new lesson
 * revision (keyed `lesson:<item>:<revision>`); revert copies an old revision into a new one. Learners see the revision
 * staff published for the item and keep it until a newer one is published. Blocks are data only: no script, embed or
 * markup is accepted, and every address is https.
 */
export const ACADEMY_LESSON_BLOCK_TYPES = ['text', 'image', 'audio', 'pdf', 'code'] as const;
export type AcademyLessonBlockType = (typeof ACADEMY_LESSON_BLOCK_TYPES)[number];
/** Outline kinds that hold no lesson: a subheader is a label and a link opens an address. */
export const ACADEMY_ITEMS_WITHOUT_LESSON = ['subheader', 'link'] as const;

const httpsUrl = z.string().max(2048).url().startsWith('https://');
const caption = z.string().trim().min(1).max(200);
export const academyLessonBlockSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), markdown: z.string().trim().min(1).max(20_000) }).strict(),
  z.object({ type: z.literal('image'), url: httpsUrl, alt: caption }).strict(),
  z.object({ type: z.literal('audio'), url: httpsUrl, title: caption }).strict(),
  z.object({ type: z.literal('pdf'), url: httpsUrl, title: caption }).strict(),
  z.object({ type: z.literal('code'), language: z.string().regex(/^[a-z0-9+#-]{1,20}$/), source: z.string().min(1).max(20_000) }).strict(),
]);
export type AcademyLessonBlock = z.infer<typeof academyLessonBlockSchema>;
export const academyLessonBlocksSchema = z.array(academyLessonBlockSchema).min(1).max(200);

/** `admin.saveLesson`: the blocks as a whole over the lesson revision the editor read (0 when nothing is written yet). */
export const academySaveLessonInputSchema = z
  .object({ itemId: z.string().guid(), revision: z.number().int().nonnegative(), blocks: academyLessonBlocksSchema })
  .strict();
export type AcademySaveLessonInput = z.infer<typeof academySaveLessonInputSchema>;

/** `admin.revertLesson`: a new revision with an older one's blocks, over the newest revision the editor read. */
export const academyRevertLessonInputSchema = z
  .object({ itemId: z.string().guid(), revision: z.number().int().positive(), toRevision: z.number().int().positive() })
  .strict();
export type AcademyRevertLessonInput = z.infer<typeof academyRevertLessonInputSchema>;

/** `admin.publishLesson`: learners see this lesson revision from now on, with the reason staff give. */
export const academyPublishLessonInputSchema = z
  .object({
    itemId: z.string().guid(),
    lessonRevision: z.number().int().positive(),
    courseRevision: z.number().int().positive(),
    reason: z.string().trim().min(1).max(500),
  })
  .strict();
export type AcademyPublishLessonInput = z.infer<typeof academyPublishLessonInputSchema>;

/**
 * `admin.withdrawLesson`: learners stop seeing the lesson (no revision is live) over the course revision read, with a
 * reason. A featured lesson leaves the Learn hub's featured slot in the same step.
 */
export const academyWithdrawLessonInputSchema = z
  .object({ itemId: z.string().guid(), courseRevision: z.number().int().positive(), reason: z.string().trim().min(1).max(500) })
  .strict();
export type AcademyWithdrawLessonInput = z.infer<typeof academyWithdrawLessonInputSchema>;

/** `admin.duplicateItem`: a copy of a draft course's item right after it, with its newest lesson as revision 1. */
export const academyDuplicateItemInputSchema = z
  .object({ itemId: z.string().guid(), courseRevision: z.number().int().positive() })
  .strict();
export type AcademyDuplicateItemInput = z.infer<typeof academyDuplicateItemInputSchema>;

export const ACADEMY_LESSON_SOURCES = ['saved', 'reverted', 'duplicated', 'imported', 'assisted'] as const;
export const academyLessonRevisionSchema = z.object({
  revision: z.number().int().positive(),
  source: z.enum(ACADEMY_LESSON_SOURCES),
  /** The revision a revert copied, or null. */
  fromRevision: z.number().int().positive().nullable(),
  /** The item a duplicate was copied from, or null. */
  fromItemId: z.string().guid().nullable(),
  blocks: academyLessonBlocksSchema,
  actor: z.string().guid(),
  at: isoInstant,
});
export type AcademyLessonRevision = z.infer<typeof academyLessonRevisionSchema>;

/** `admin.lesson`: one item with every lesson revision, newest first, and which one learners see. */
export const academyLessonSchema = z.object({
  courseId: z.string().guid(),
  courseTitle: z.string().min(1),
  courseState: z.enum(ACADEMY_COURSE_STATES),
  courseRevision: z.number().int().positive(),
  item: academyOutlineItemSchema,
  revisions: z.array(academyLessonRevisionSchema),
  /** The owner's lesson import size limit in bytes (`ACADEMY_LESSON_IMPORT_MAX_BYTES`), or null when it is not set. */
  importMaxBytes: z.number().int().positive().nullable(),
  /** The assistant draft waiting for a person to accept or discard it, or null. It is never what learners see. */
  draft: z
    .object({
      basedOnRevision: z.number().int().nonnegative(),
      kind: z.literal('template'),
      blocks: academyLessonBlocksSchema,
      createdBy: z.string().guid(),
      createdAt: isoInstant,
    })
    .nullable(),
  /** AC-articles-01: whether this lesson is the Learn hub's featured article. */
  featured: z.boolean(),
});
export type AcademyLesson = z.infer<typeof academyLessonSchema>;

/**
 * `admin.importLesson`: a lesson file (`intafaced.lesson.v1`: `{ "format": "intafaced.lesson.v1", "blocks": [...] }`)
 * as a new revision over the one read. A file over the owner's size limit is refused before it is parsed
 * (`academy.import_too_large`; a blank limit refuses `academy.import_limit_unset`). A file that parses but holds an
 * unknown block type or a bad block answers with a report naming each one, and nothing is created.
 */
export const ACADEMY_LESSON_FORMAT = 'intafaced.lesson.v1';
export const academyImportLessonInputSchema = z
  .object({ itemId: z.string().guid(), revision: z.number().int().nonnegative(), document: z.string().max(1_048_576) })
  .strict();
export type AcademyImportLessonInput = z.infer<typeof academyImportLessonInputSchema>;
export const academyImportProblemSchema = z.object({
  /** The block's place in the file, from 1, or null for the file as a whole. */
  block: z.number().int().positive().nullable(),
  problem: z.string().min(1),
});
export const academyImportLessonResultSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('imported'), lesson: academyLessonSchema }),
  z.object({ outcome: z.literal('invalid'), problems: z.array(academyImportProblemSchema).min(1), lesson: academyLessonSchema }),
]);
export type AcademyImportLessonResult = z.infer<typeof academyImportLessonResultSchema>;

/**
 * AC-course-structure-04: the authoring assistant. `template` drafts a lesson from the course's own structure (its
 * title, section and neighbours) with headings to fill in, and needs no provider. `model` is the model-backed path: it
 * refuses `owner.decision` while the owner has not chosen a provider, and copy never names one. A draft is keyed
 * `draft:<item>:<revision>:<kind>` and goes nowhere until a person accepts it, which writes a new lesson revision.
 */
export const ACADEMY_ASSISTANT_PATHS = ['template', 'model'] as const;
export const academyAssistantDraftInputSchema = z
  .object({ itemId: z.string().guid(), revision: z.number().int().nonnegative(), path: z.enum(ACADEMY_ASSISTANT_PATHS) })
  .strict();
export type AcademyAssistantDraftInput = z.infer<typeof academyAssistantDraftInputSchema>;

/** `admin.decideDraft`: a person accepts (a new lesson revision, with them as the actor) or discards the open draft. */
export const academyDecideDraftInputSchema = z
  .object({
    itemId: z.string().guid(),
    basedOnRevision: z.number().int().nonnegative(),
    kind: z.literal('template'),
    decision: z.enum(['accept', 'discard']),
  })
  .strict();
export type AcademyDecideDraftInput = z.infer<typeof academyDecideDraftInputSchema>;

/**
 * AC-videos-02: a course item's video, caption files and handouts. Every file goes to our own object store through a
 * signed upload: an intent first (keyed `media:<item>:<kind>:<sha256>`, so the same file resumes the same row), then the
 * bytes, then a confirm in which svc-academy reads the stored object back and checks its size and leading bytes against
 * what was declared (`academy.file_type_mismatch`). The owner's limits (size, video types, handout types) are blank until
 * set, and a blank one refuses `academy.upload_limits_unset`. Captions are SRT or WebVTT per video and language, checked
 * line by line.
 */
export const ACADEMY_MEDIA_KINDS = ['video', 'handout'] as const;
export type AcademyMediaKind = (typeof ACADEMY_MEDIA_KINDS)[number];
const mimeType = z.string().regex(/^[a-z]+\/[a-z0-9.+-]+$/);

export const academyUploadLimitsSchema = z.object({
  maxBytes: z.number().int().positive().nullable(),
  videoTypes: z.array(mimeType).nullable(),
  handoutTypes: z.array(mimeType).nullable(),
});
export type AcademyUploadLimits = z.infer<typeof academyUploadLimitsSchema>;

export const academyMediaSchema = z.object({
  id: z.string().guid(),
  kind: z.enum(ACADEMY_MEDIA_KINDS),
  fileName: z.string().min(1),
  contentType: mimeType,
  bytes: z.number().int().positive(),
  state: z.enum(['pending', 'ready', 'refused']),
  /** Why a confirm refused the stored object, or null. */
  refusal: z.string().nullable(),
  createdAt: isoInstant,
  /** A short-lived signed address to view a ready file, or null. */
  url: z.string().url().nullable(),
});
export type AcademyMedia = z.infer<typeof academyMediaSchema>;

export const academyItemCaptionSchema = z.object({
  language: z.string().min(2),
  label: z.string().min(1),
  format: z.enum(['srt', 'vtt']),
  cues: z.number().int().positive(),
  firstCue: z.string(),
});

/**
 * `admin.itemMedia`: one item's uploads (newest first), the owner's upload limits, the item's current video (the newest
 * checked one, or null) and that video's caption languages. Captions belong to one video, so a re-cut starts with none.
 */
export const academyItemMediaSchema = z.object({
  itemId: z.string().guid(),
  videoId: z.string().guid().nullable(),
  limits: academyUploadLimitsSchema,
  media: z.array(academyMediaSchema),
  captions: z.array(academyItemCaptionSchema),
});
export type AcademyItemMedia = z.infer<typeof academyItemMediaSchema>;

/** `admin.mediaUploadIntent`: what the browser declares before sending a byte. */
export const academyMediaIntentInputSchema = z
  .object({
    itemId: z.string().guid(),
    kind: z.enum(ACADEMY_MEDIA_KINDS),
    fileName: z.string().trim().min(1).max(200),
    contentType: mimeType,
    bytes: z.number().int().positive(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
export type AcademyMediaIntentInput = z.infer<typeof academyMediaIntentInputSchema>;
export const academyMediaIntentSchema = z.object({
  media: academyMediaSchema,
  /** The signed address to PUT the bytes to, or null when this file is already stored and confirmed. */
  uploadUrl: z.string().url().nullable(),
});
export type AcademyMediaIntent = z.infer<typeof academyMediaIntentSchema>;

export const academyConfirmMediaInputSchema = z.object({ mediaId: z.string().guid() }).strict();

/** `admin.setItemCaptions`: one language's SRT or WebVTT file for the item's current video. */
export const academySetItemCaptionsInputSchema = z
  .object({
    itemId: z.string().guid(),
    language: z.string().regex(/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/),
    label: z.string().trim().min(1).max(60),
    format: z.enum(['srt', 'vtt']),
    text: z.string().max(524_288),
  })
  .strict();
export type AcademySetItemCaptionsInput = z.infer<typeof academySetItemCaptionsInputSchema>;
export const academySetItemCaptionsResultSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('saved'), media: academyItemMediaSchema }),
  /** The first line that is not a caption, with its number, and nothing stored. */
  z.object({ outcome: z.literal('invalid'), problem: z.string().min(1), media: academyItemMediaSchema }),
]);

/**
 * AC-articles-01: the Learn hub. Staff choose its featured article, a lesson learners can read (one with a revision
 * published to learners; otherwise `academy.featured_not_live`); it leaves the slot when the lesson is withdrawn. Topics
 * are staff-owned names with an address that is never an Academy tab (`academy.slug_reserved`); a course is filed under
 * some of them. The topic list is read up to the owner's limit (`ACADEMY_TOPICS_LIST_LIMIT`; blank refuses
 * `academy.topics_list_limit_unset`).
 */
export const academyTopicSchema = z.object({
  id: z.string().guid(),
  slug: z.string().min(1),
  name: z.string().min(1),
  createdAt: isoInstant,
});
export type AcademyTopic = z.infer<typeof academyTopicSchema>;

/**
 * The hub's one featured slot holds a course lesson or a curriculum item (`admin.setFeatured`), never both; choosing
 * either replaces the other. A lesson shows here while it is live in a draft or published course.
 */
export const academyFeaturedSlotSchema = z.object({
  /** The curriculum item in the slot, or null. */
  curriculum: z.object({ slug: z.string().min(1), title: z.string().min(1) }).nullable(),
  /** The featured lesson, or null. */
  lesson: z
    .object({
      itemId: z.string().guid(),
      title: z.string().min(1),
      courseId: z.string().guid(),
      courseTitle: z.string().min(1),
      courseState: z.enum(ACADEMY_COURSE_STATES),
      liveRevision: z.number().int().positive(),
    })
    .nullable(),
  reason: z.string().nullable(),
  chosenBy: z.string().guid().nullable(),
  chosenAt: isoInstant.nullable(),
});
export type AcademyFeaturedSlot = z.infer<typeof academyFeaturedSlotSchema>;

/** `admin.topics`: the topics, newest first, up to the owner's list limit (shown with them). */
export const academyTopicListSchema = z.object({
  topics: z.array(academyTopicSchema),
  limit: z.number().int().positive(),
});
export type AcademyTopicList = z.infer<typeof academyTopicListSchema>;

/** `admin.featureLesson`: this lesson fills the featured slot, with the reason staff give. */
export const academyFeatureLessonInputSchema = z.object({ itemId: z.string().guid(), reason: z.string().trim().min(1).max(500) }).strict();
export type AcademyFeatureLessonInput = z.infer<typeof academyFeatureLessonInputSchema>;

/** `admin.clearFeatured`: nothing is featured, with the reason. */
export const academyClearFeaturedInputSchema = z.object({ reason: z.string().trim().min(1).max(500) }).strict();

/** `admin.createTopic`: a topic keyed by its address; a repeat with the same name answers with the stored topic. */
export const academyCreateTopicInputSchema = z.object({ slug: academyCourseSlugSchema, name: z.string().trim().min(1).max(60) }).strict();
export type AcademyCreateTopicInput = z.infer<typeof academyCreateTopicInputSchema>;

/** `admin.setCourseTopics`: the course's topics as a whole, over the revision read. */
export const academySetCourseTopicsInputSchema = z
  .object({
    courseId: z.string().guid(),
    revision: z.number().int().positive(),
    topicIds: z.array(z.string().guid()).max(20),
  })
  .strict()
  .refine((t) => new Set(t.topicIds).size === t.topicIds.length, { message: 'a topic is named once' });
export type AcademySetCourseTopicsInput = z.infer<typeof academySetCourseTopicsInputSchema>;

/**
 * AC-catalogue-03: a course as a learner who has not enrolled sees it. Staff open it with Preview as new learner, and a
 * visitor opens it through a private link before the course is listed. It is built from the stored course and outline
 * only, never sample data, and reading it writes nothing. Each item carries its lock: `not_released` while no lesson
 * revision is published to learners; otherwise `enrol` until the reader enrols, or `enrolment_closed` while the course
 * is not published (nobody can enrol yet, or any more). A subheader is a label and has none.
 *
 * AC-release-access-01: a section may be released at an instant or some days after the reader's enrolment. Until then
 * its items carry `scheduled` for an enrolled reader, and the section carries its release: the instant in UTC (the
 * screen shows it in the reader's own time), or for a reader not yet enrolled the days after enrolling.
 */
export const ACADEMY_LEARNER_ITEM_LOCKS = ['enrol', 'enrolment_closed', 'not_released', 'scheduled'] as const;
// An enrolled reader (`authoredCourse`, signed in) sees no `enrol` lock on what is released.
export type AcademyLearnerItemLock = (typeof ACADEMY_LEARNER_ITEM_LOCKS)[number];
export const academyCourseLearnerViewSchema = z.object({
  slug: z.string().min(1),
  title: z.string().min(1),
  summary: z.string().nullable(),
  thumbnailUrl: z.string().nullable(),
  pricing: z.enum(ACADEMY_COURSE_PRICING),
  price: z.string().nullable(),
  priceAsset: z.string().nullable(),
  state: z.enum(ACADEMY_COURSE_STATES),
  /** How the course is paced; null while staff have not said. */
  pacing: z.enum(ACADEMY_COURSE_PACING).nullable(),
  sections: z.array(
    z.object({
      title: z.string().min(1),
      /** When the section opens to this reader; null when it has no release rule. */
      release: z
        .object({
          /** The instant it opens for this reader, or null while that depends on an enrolment they do not have. */
          at: isoInstant.nullable(),
          /** Days after enrolling, for a rule relative to enrolment; null for a fixed instant. */
          afterEnrolmentDays: z.number().int().positive().nullable(),
          /** Whether it is open for this reader now. */
          open: z.boolean(),
        })
        .nullable(),
      items: z.array(
        z.object({
          /** The outline item, so an open assignment links to its page (AC-assignments-01). */
          id: z.string().guid(),
          kind: z.enum(ACADEMY_OUTLINE_ITEM_KINDS),
          title: z.string().min(1),
          indent: z.number().int().min(0).max(2),
          lock: z.enum(ACADEMY_LEARNER_ITEM_LOCKS).nullable(),
        }),
      ),
    }),
  ),
});
export type AcademyCourseLearnerView = z.infer<typeof academyCourseLearnerViewSchema>;

/** The private link's secret: 32 random bytes, base64url. Only its SHA-256 is stored. */
export const academyPrivateLinkKeySchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

/** A private link as staff see it. The key itself is shown once, when the link is made, and never again. */
export const academyPrivateLinkSchema = z.object({
  id: z.string().guid(),
  reason: z.string().min(1),
  createdBy: z.string().guid(),
  createdAt: isoInstant,
  revokedBy: z.string().guid().nullable(),
  revokedAt: isoInstant.nullable(),
  revokeReason: z.string().nullable(),
});
export type AcademyPrivateLink = z.infer<typeof academyPrivateLinkSchema>;
/** `admin.privateLinks`: a course's links, newest first. */
export const academyPrivateLinkListSchema = z.array(academyPrivateLinkSchema);

export const academyCourseIdInputSchema = z.object({ courseId: z.string().guid() }).strict();

/** `admin.createPrivateLink`: a new link to the course's unlisted page, with the reason. */
export const academyCreatePrivateLinkInputSchema = z
  .object({ courseId: z.string().guid(), reason: z.string().trim().min(1).max(500) })
  .strict();
export type AcademyCreatePrivateLinkInput = z.infer<typeof academyCreatePrivateLinkInputSchema>;
/** The new link, with its key and the customer app path that opens it (shown once). */
export const academyCreatedPrivateLinkSchema = z.object({
  link: academyPrivateLinkSchema,
  key: academyPrivateLinkKeySchema,
  /** The customer app path, with the key after `#`. */
  path: z.string().startsWith('/academy/learning/course/'),
});
export type AcademyCreatedPrivateLink = z.infer<typeof academyCreatedPrivateLinkSchema>;

/** `admin.revokePrivateLink`: the link stops opening the page; a repeat answers with the revoked link. */
export const academyRevokePrivateLinkInputSchema = z
  .object({ linkId: z.string().guid(), reason: z.string().trim().min(1).max(500) })
  .strict();
export type AcademyRevokePrivateLinkInput = z.infer<typeof academyRevokePrivateLinkInputSchema>;

/**
 * `publicCourseByLink`: the unlisted page. It is a POST so the key never sits in a URL a server logs (the link carries it
 * after `#`, which browsers never send). Any slug or key that is not a live link to that course, malformed ones
 * included, gives `academy.course_not_found`, so a guess learns nothing from the refusal.
 */
export const academyCourseByLinkInputSchema = z.object({ slug: z.string().min(1).max(120), key: z.string().min(1).max(200) }).strict();
export type AcademyCourseByLinkInput = z.infer<typeof academyCourseByLinkInputSchema>;

/**
 * AC-catalogue-03: the published courses staff made, as the public catalogue lists them (most recently published first). Published is
 * listed; a course reached before that is unlisted and opens only through a private link. The page size is the
 * caller's to send.
 */
export const academyPublishedCoursesInputSchema = z.object({ limit: z.number().int().positive().max(200) }).strict();
export const academyPublishedCourseCardSchema = z.object({
  slug: z.string().min(1),
  title: z.string().min(1),
  summary: z.string().nullable(),
  thumbnailUrl: z.string().nullable(),
  pricing: z.enum(ACADEMY_COURSE_PRICING),
  price: z.string().nullable(),
  priceAsset: z.string().nullable(),
  /** Items released to learners, which an enrolled learner can open (subheaders are labels and are not counted). */
  items: z.number().int().nonnegative(),
});
export type AcademyPublishedCourseCard = z.infer<typeof academyPublishedCourseCardSchema>;
export const academyPublishedCourseListSchema = z.array(academyPublishedCourseCardSchema);

/** `publicAuthoredCourse`, `authoredCourse`, `authoredCourseEnrolment`: one course staff made, by its address. */
export const academyAuthoredCourseInputSchema = z.object({ slug: z.string().min(1).max(120) }).strict();

/** `leaveAuthoredCourse`: the enrolment that began at `enrolledAt` ends; a repeat after a lost reply is the same leave. */
export const academyLeaveAuthoredCourseInputSchema = z.object({ slug: z.string().min(1).max(120), enrolledAt: isoInstant }).strict();
export type AcademyLeaveAuthoredCourseInput = z.infer<typeof academyLeaveAuthoredCourseInputSchema>;

/**
 * AC-assignments-01: an assignment is an outline item of kind `assignment` with a brief staff set on the founder console:
 * instructions, points as a decimal string, an optional due date, and whether a text answer and a file are off, optional
 * or required. It is released to enrolled learners once its brief is saved. A learner hands in a numbered version keyed
 * `submit:<item>:<account>:<version>`, so a retry after a lost reply is the same hand-in; late is worked out on each
 * read against the due date and never stored. The course has no late rule until gradebook setup (AC-assignments-04), so
 * none is shown. No money moves here.
 */
export const ACADEMY_ANSWER_MODES = ['off', 'optional', 'required'] as const;
export type AcademyAnswerMode = (typeof ACADEMY_ANSWER_MODES)[number];
export const ACADEMY_SUBMISSION_STATES = ['draft', 'submitted', 'pending_review', 'graded', 'returned', 'withdrawn'] as const;
export type AcademySubmissionState = (typeof ACADEMY_SUBMISSION_STATES)[number];
/** Points: a decimal string above zero with at most two places, never a JavaScript number. */
export const ACADEMY_POINTS = /^(?:0|[1-9]\d{0,5})(?:\.\d{1,2})?$/;
export const academyPointsSchema = z
  .string()
  .regex(ACADEMY_POINTS)
  .refine((v) => /[1-9]/.test(v), { message: 'points are more than zero' });

const assignmentBrief = {
  instructions: z.string().trim().min(1).max(10_000),
  points: academyPointsSchema,
  /** The due date, or null for none (an author choice: no due date, nothing is late). */
  dueAt: isoInstant.nullable(),
  text: z.enum(ACADEMY_ANSWER_MODES),
  file: z.enum(ACADEMY_ANSWER_MODES),
};

/**
 * AC-assignments-03: rubrics and peer or self review. A rubric is a list of criteria, each with two to ten levels as
 * ascending decimal strings; a saved rubric is never changed, so a review keeps the criteria it was scored against. The
 * review steps run in order: peer review (each learner reviews `peerCount` classmates' work), then a self review of the
 * learner's own. A learner reviews only after handing in, is never handed their own work as a peer, and waits while no
 * classmate's work is free. Each review is keyed `peer:<assignment>:<reviewer>:<author>`; the reviewer never learns who
 * the author is. Training examples, cohort-only pairing and rubric import by file are later parts. No money moves here.
 */
export const ACADEMY_RUBRIC_LEVEL = /^(?:0|[1-9]\d{0,5})(?:\.\d{1,2})?$/;
export const ACADEMY_RUBRIC_MAX_CRITERIA = 20;
export const ACADEMY_REVIEW_MAX_PEERS = 20;
const rubricLevel = z.string().regex(ACADEMY_RUBRIC_LEVEL);
/** Levels as typed: "0", "1.5". Ascending, no two alike; compared as decimals, never as JavaScript numbers. */
const ascending = (levels: readonly string[]) => levels.every((level, i) => i === 0 || decimalCompare(levels[i - 1]!, level) < 0);
/** A rubric level in hundredths, exactly: "1.5" is 150n. */
const levelHundredths = (level: string) => {
  const [whole, fraction = ''] = level.split('.');
  return BigInt(whole!) * 100n + BigInt(`${fraction}00`.slice(0, 2));
};
/** -1, 0 or 1 for two rubric levels, compared as exact decimals. */
export function decimalCompare(a: string, b: string): number {
  const left = levelHundredths(a);
  const right = levelHundredths(b);
  return left === right ? 0 : left < right ? -1 : 1;
}
export const academyRubricCriterionSchema = z
  .object({ name: z.string().trim().min(1).max(120), levels: z.array(rubricLevel).min(2).max(10) })
  .strict()
  .refine((c) => ascending(c.levels), { message: 'levels go up, with no two alike', path: ['levels'] });
export type AcademyRubricCriterion = z.infer<typeof academyRubricCriterionSchema>;
export const academyRubricSchema = z.object({
  id: z.string().guid(),
  criteria: z.array(academyRubricCriterionSchema).min(1).max(ACADEMY_RUBRIC_MAX_CRITERIA),
});
export type AcademyRubric = z.infer<typeof academyRubricSchema>;

/** An assignment's review steps as staff see them, with who is waiting. Null until first saved. */
export const academyReviewStepsSchema = z.object({
  /** 0 until first saved; each save is the next revision. */
  revision: z.number().int().nonnegative(),
  peer: z.boolean(),
  /** Reviews each learner gives; null is not set, and a course with peer review on and no count is not published. */
  peerCount: z.number().int().min(1).max(ACADEMY_REVIEW_MAX_PEERS).nullable(),
  self: z.boolean(),
  rubric: academyRubricSchema.nullable(),
  /** Learners who handed in and still need peer reviews from classmates. */
  authorsShortOfReviews: z.number().int().nonnegative(),
  /** Learners who owe peer reviews while no classmate's work is free for them: the waiting list. */
  reviewersWaiting: z.number().int().nonnegative(),
});
export type AcademyReviewSteps = z.infer<typeof academyReviewStepsSchema>;

/** `admin.assignment`: an assignment item as staff see it. `brief` is null until it is first saved. */
export const academyAdminAssignmentSchema = z.object({
  itemId: z.string().guid(),
  courseId: z.string().guid(),
  title: z.string().min(1),
  /** 0 until the brief is first saved; each save is the next revision. */
  revision: z.number().int().nonnegative(),
  brief: z.object(assignmentBrief).nullable(),
  savedBy: z.string().guid().nullable(),
  savedAt: isoInstant.nullable(),
  /** Set when staff withdrew it: learners can no longer hand in, and what they handed in stays readable to them. */
  withdrawnAt: isoInstant.nullable(),
  withdrawReason: z.string().nullable(),
  /** Learners who handed in at least once. */
  learnersHandedIn: z.number().int().nonnegative(),
  /** AC-assignments-03: the review steps and rubric; null until first saved. */
  review: academyReviewStepsSchema.nullable(),
});
export type AcademyAdminAssignment = z.infer<typeof academyAdminAssignmentSchema>;

/** `admin.saveAssignment`: the brief, over the revision read (a stale one refuses `academy.revision_stale`). */
export const academySaveAssignmentInputSchema = z
  .object({ itemId: z.string().guid(), revision: z.number().int().nonnegative(), ...assignmentBrief })
  .strict()
  .refine((v) => v.text !== 'off' || v.file !== 'off', { message: 'a learner hands in text, a file or both', path: ['text'] });
export type AcademySaveAssignmentInput = z.infer<typeof academySaveAssignmentInputSchema>;

/** `admin.withdrawAssignment`: learners can no longer hand in; the reason is kept. */
export const academyWithdrawAssignmentInputSchema = z
  .object({ itemId: z.string().guid(), reason: z.string().trim().min(1).max(500) })
  .strict();
export type AcademyWithdrawAssignmentInput = z.infer<typeof academyWithdrawAssignmentInputSchema>;

/** A file a learner handed in, as they see it. Its bytes are never served inline. */
export const academySubmissionFileSchema = z.object({
  id: z.string().guid(),
  fileName: z.string().min(1),
  contentType: z.string().min(1),
  bytes: z.number().int().positive(),
});
export type AcademySubmissionFile = z.infer<typeof academySubmissionFileSchema>;

export const academySubmissionSchema = z.object({
  version: z.number().int().positive(),
  state: z.enum(ACADEMY_SUBMISSION_STATES),
  text: z.string().nullable(),
  file: academySubmissionFileSchema.nullable(),
  submittedAt: isoInstant,
  /** Handed in after the due date, worked out on this read. */
  late: z.boolean(),
});
export type AcademySubmission = z.infer<typeof academySubmissionSchema>;

/** AC-assignments-02: the grade on the learner's newest graded hand-in, as they see it: never the grader. */
export const academyLearnerGradeSchema = z.object({
  version: z.number().int().positive(),
  /** The grade event shown: 1 for the first grade, higher after a change. Mark as read names it. */
  n: z.number().int().positive(),
  score: z.string(),
  points: z.string(),
  comment: z.string().nullable(),
  gradedAt: isoInstant,
  /** When the learner marked this grade's feedback read; null until then. */
  readAt: isoInstant.nullable(),
});
export type AcademyLearnerGrade = z.infer<typeof academyLearnerGradeSchema>;

/** `assignment`: an assignment as the enrolled learner sees it, with their own hand-ins, newest first. */
export const academyAssignmentInputSchema = z.object({ itemId: z.string().guid() }).strict();
export const academyAssignmentViewSchema = z.object({
  itemId: z.string().guid(),
  courseSlug: z.string().min(1),
  courseTitle: z.string().min(1),
  title: z.string().min(1),
  ...assignmentBrief,
  /** The course's late rule; null while the course has none. */
  lateRule: z.string().nullable(),
  /**
   * The upload limits for a file answer: the smaller of the owner's size limit and the inline bound, and the owner's
   * types. A null field is not set by the owner, and a file is refused until it is.
   */
  fileLimits: z.object({ maxBytes: z.number().int().positive().nullable(), types: z.array(z.string()).nullable() }),
  withdrawnAt: isoInstant.nullable(),
  submissions: z.array(academySubmissionSchema),
  /** AC-assignments-02: the grade on the newest graded hand-in, released when staff save it; null before. */
  grade: academyLearnerGradeSchema.nullable(),
  /** The version the next hand-in takes; a retry of a lost hand-in sends the version it was made with. */
  nextVersion: z.number().int().positive(),
  /** AC-release-access-02: this learner's own later due date, with the reason staff gave; null when they have none. */
  extension: z.object({ dueAt: isoInstant, reason: z.string().min(1) }).nullable(),
});
export type AcademyAssignmentView = z.infer<typeof academyAssignmentViewSchema>;

/**
 * The most a learner's file carries inline through the customer API: 768 KiB, whose base64 fits a 1 MiB request body.
 * A transport bound, not an owner value: the page shows the smaller of it and the owner's upload limit.
 */
export const ACADEMY_ASSIGNMENT_FILE_INLINE_MAX_BYTES = 786_432;

/** `uploadAssignmentFile`: a file for the next hand-in, its bytes in base64; the same file again is the same row. */
export const academyUploadAssignmentFileInputSchema = z
  .object({
    itemId: z.string().guid(),
    fileName: z.string().trim().min(1).max(200),
    contentType: z.string().trim().min(1).max(100),
    contentBase64: z
      .string()
      .min(1)
      .max(Math.ceil(ACADEMY_ASSIGNMENT_FILE_INLINE_MAX_BYTES / 3) * 4),
  })
  .strict();
export type AcademyUploadAssignmentFileInput = z.infer<typeof academyUploadAssignmentFileInputSchema>;

/** `submitAssignment`: version `version` of the caller's hand-in, keyed `submit:<item>:<account>:<version>`. */
export const academySubmitAssignmentInputSchema = z
  .object({
    itemId: z.string().guid(),
    version: z.number().int().positive(),
    text: z.string().max(20_000).nullable(),
    fileId: z.string().guid().nullable(),
  })
  .strict();
export type AcademySubmitAssignmentInput = z.infer<typeof academySubmitAssignmentInputSchema>;

/** `admin.saveReviewSteps`: the steps and the rubric, over the revision read. A rubric is needed when any step is on. */
export const academySaveReviewStepsInputSchema = z
  .object({
    itemId: z.string().guid(),
    revision: z.number().int().nonnegative(),
    peer: z.boolean(),
    peerCount: z.number().int().min(1).max(ACADEMY_REVIEW_MAX_PEERS).nullable(),
    self: z.boolean(),
    criteria: z.array(academyRubricCriterionSchema).max(ACADEMY_RUBRIC_MAX_CRITERIA),
  })
  .strict();
export type AcademySaveReviewStepsInput = z.infer<typeof academySaveReviewStepsInputSchema>;

export const ACADEMY_REVIEW_STAGES = ['off', 'hand_in_first', 'peer', 'waiting', 'self', 'done'] as const;
export type AcademyReviewStage = (typeof ACADEMY_REVIEW_STAGES)[number];

/** Work handed to the learner to review: a classmate's under an alias, or their own for the self review. */
export const academyReviewTaskSchema = z.object({
  id: z.string().guid(),
  kind: z.enum(['peer', 'self']),
  /** The n-th classmate's work this learner was handed, as their alias; null on the self review. Never the author's account. */
  ordinal: z.number().int().positive().nullable(),
  text: z.string().nullable(),
  /** The file handed in; its name only on the self review, since a classmate's file name can name them. */
  file: z.object({ fileName: z.string().min(1).nullable(), contentType: z.string().min(1), bytes: z.number().int().positive() }).nullable(),
  criteria: z.array(academyRubricCriterionSchema).min(1),
});
export type AcademyReviewTask = z.infer<typeof academyReviewTaskSchema>;

/** `peerReview` and `submitPeerReview`: where the caller is in the review steps, with the work to review now. */
export const academyReviewStateSchema = z.object({
  itemId: z.string().guid(),
  stage: z.enum(ACADEMY_REVIEW_STAGES),
  peer: z.boolean(),
  peerCount: z.number().int().positive().nullable(),
  self: z.boolean(),
  peerDone: z.number().int().nonnegative(),
  selfDone: z.boolean(),
  task: academyReviewTaskSchema.nullable(),
});
export type AcademyReviewState = z.infer<typeof academyReviewStateSchema>;

/** `peerReview`: the caller's review stage; hands them the next classmate's work when one is due and free. */
export const academyPeerReviewInputSchema = z.object({ itemId: z.string().guid() }).strict();

/** `peerReviewFile`: the file of work handed to the caller to review, its bytes in base64 (at most the inline bound). */
export const academyPeerReviewFileInputSchema = z.object({ itemId: z.string().guid(), taskId: z.string().guid() }).strict();
export const academyPeerReviewFileSchema = z.object({
  contentType: z.string().min(1),
  bytes: z.number().int().positive(),
  contentBase64: z.string().min(1),
});
export type AcademyPeerReviewFile = z.infer<typeof academyPeerReviewFileSchema>;

/** `submitPeerReview`: one level per criterion, in the rubric's order; the same marks again answer as stored. */
export const academySubmitPeerReviewInputSchema = z
  .object({
    itemId: z.string().guid(),
    taskId: z.string().guid(),
    marks: z.array(rubricLevel).min(1).max(ACADEMY_RUBRIC_MAX_CRITERIA),
  })
  .strict();
export type AcademySubmitPeerReviewInput = z.infer<typeof academySubmitPeerReviewInputSchema>;

/**
 * AC-assignments-02: staff grade a hand-in with a score and comment. A grade is an append-only trail keyed
 * `grade:<submission>:<n>`; the newest event is the grade. Changing a grade is an override and needs a reason
 * (`academy.reason_required`). A grader holds a lease on the hand-in for the owner's lease length while grading; another
 * grader is refused `academy.grader_locked`, and with the length blank grading refuses `academy.grader_lease_unset`.
 * Graders see learners under a per-assignment alias, never their name or account, and a learner never sees who graded.
 * A grade is released to the learner when it is saved. Bulk grading by file is `admin.bulkGrade`; removing a response is a
 * later part.
 */
/** A score: a decimal string from 0 with at most two places, never above the assignment's points (`academy.grade_invalid`). */
/** A score is written as points are, so any score up to the points is one. */
export const ACADEMY_SCORE = ACADEMY_POINTS;
export const academyGradingQueueInputSchema = z.object({ itemId: z.string().guid() }).strict();
export const academyGradingRowSchema = z.object({
  submissionId: z.string().guid(),
  /** "Learner 3": stable per assignment, by first hand-in. Never the learner's name or account. */
  alias: z.number().int().positive(),
  version: z.number().int().positive(),
  submittedAt: isoInstant,
  late: z.boolean(),
  text: z.string().nullable(),
  file: z.object({ fileName: z.string().min(1), contentType: z.string().min(1), bytes: z.number().int().positive() }).nullable(),
  /** Peer reviews this hand-in received, and their mean total as a decimal string (null with none). */
  peerReviews: z.object({ received: z.number().int().nonnegative(), meanTotal: z.string().nullable() }),
  grade: z
    .object({ score: z.string(), comment: z.string().nullable(), gradedAt: isoInstant, overrides: z.number().int().nonnegative() })
    .nullable(),
  /** The event number the next grade on this hand-in takes. */
  nextN: z.number().int().positive(),
  lease: z.object({ mine: z.boolean(), expiresAt: isoInstant }).nullable(),
});
export type AcademyGradingRow = z.infer<typeof academyGradingRowSchema>;
export const academyGradingQueueSchema = z.object({
  itemId: z.string().guid(),
  courseId: z.string().guid(),
  title: z.string().min(1),
  points: z.string(),
  /** The owner's grader lease length in seconds; null is not set, and grading refuses until it is. */
  leaseSeconds: z.number().int().positive().nullable(),
  rows: z.array(academyGradingRowSchema),
});
export type AcademyGradingQueue = z.infer<typeof academyGradingQueueSchema>;

/** `admin.openGrading`: take (or renew) the lease on one hand-in; answers with the queue. */
export const academyOpenGradingInputSchema = z.object({ itemId: z.string().guid(), submissionId: z.string().guid() }).strict();
export type AcademyOpenGradingInput = z.infer<typeof academyOpenGradingInputSchema>;

/** `admin.gradeSubmission`: grade event `n` on a hand-in; the same `n` again answers as stored. */
export const academyGradeSubmissionInputSchema = z
  .object({
    itemId: z.string().guid(),
    submissionId: z.string().guid(),
    n: z.number().int().positive(),
    score: z.string().regex(ACADEMY_SCORE),
    comment: z.string().trim().max(5000).nullable(),
    reason: z.string().trim().min(1).max(500).nullable(),
  })
  .strict();
export type AcademyGradeSubmissionInput = z.infer<typeof academyGradeSubmissionInputSchema>;

/**
 * `admin.bulkGrade`: a CSV file of grades for one assignment, a header `learner,score,comment,reason` and one row per
 * learner by the alias graders see ("Learner 3" or "3"), never an account. Good rows apply as grade events keyed
 * `grade:<submission>:<file hash>`; each bad row is listed with its line and refusal code. The file is stored by the
 * sha256 of its text: the same file again is `repeated`, grades no row twice, and applies only a row refused before whose
 * cause has cleared (another grader's hold ran out), so with nothing cleared it changes nothing. A header that is not
 * the one above, or a file with no rows, refuses `academy.bulk_file_invalid` before anything applies.
 */
export const ACADEMY_BULK_GRADE_FILE_MAX_CHARS = 262_144;
export const academyBulkGradeInputSchema = z
  .object({
    itemId: z.string().guid(),
    fileName: z.string().trim().min(1).max(200),
    csv: z.string().min(1).max(ACADEMY_BULK_GRADE_FILE_MAX_CHARS),
  })
  .strict();
export type AcademyBulkGradeInput = z.infer<typeof academyBulkGradeInputSchema>;
export const academyBulkGradeResultSchema = z.object({
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  fileName: z.string().min(1),
  at: isoInstant,
  /** True when this file was uploaded before on this assignment. */
  repeated: z.boolean(),
  /** Rows this upload graded now; on a repeat, the rows it already graded count in `applied` but not here. */
  changed: z.number().int().nonnegative(),
  /** Every row this file has graded, now or on an earlier upload of it. */
  applied: z.array(z.object({ line: z.number().int().positive(), alias: z.number().int().positive(), score: z.string() })),
  rejected: z.array(
    z.object({
      line: z.number().int().positive(),
      /** The alias the row named, when it named one that reads as an alias. */
      alias: z.number().int().positive().nullable(),
      code: z.string().min(1),
      message: z.string().min(1),
    }),
  ),
  queue: academyGradingQueueSchema,
});
export type AcademyBulkGradeResult = z.infer<typeof academyBulkGradeResultSchema>;

/** `markFeedbackRead`: the caller read grade event `n` on version `version`; a repeat answers as stored. */
export const academyMarkFeedbackReadInputSchema = z
  .object({ itemId: z.string().guid(), version: z.number().int().positive(), n: z.number().int().positive() })
  .strict();
export type AcademyMarkFeedbackReadInput = z.infer<typeof academyMarkFeedbackReadInputSchema>;
